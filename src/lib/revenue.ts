/**
 * Revenue monitoring.
 *
 * The server has been able to demand payment for months without anyone being
 * able to tell whether a payment ever arrived. Answering that required manually
 * poking a Base RPC endpoint, which means the first sale could land and go
 * unnoticed — and so could the failure mode where payments verify but never
 * settle.
 *
 * This watches the receiving address for USDC transfers directly on-chain,
 * which is the only account of revenue that cannot be wrong: it does not depend
 * on the facilitator being honest, on our own logging, or on the Worker having
 * been awake when the payment happened.
 */

import type { Env } from "../types";

/** USDC on Base mainnet. */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const USDC_DECIMALS = 6;

/**
 * Public nodes cap eth_getLogs ranges. Base produces a block every ~2s, so
 * even an hour-long outage stays well inside this window; anything longer is
 * caught by the catch-up loop rather than by asking for a huge range at once.
 */
const MAX_BLOCK_RANGE = 2000;

export interface Payment {
  from: string;
  amount: string;
  usdc: number;
  block: number;
  tx: string;
}

export interface MonitorState {
  lastBlock: number;
  totalUsdc: number;
  paymentCount: number;
  firstPaymentAt: string | null;
  lastPaymentAt: string | null;
  recent: Payment[];

  /**
   * Health of the monitor itself. Without this, a scan that has been failing
   * for a week is indistinguishable from a week with no sales: both report
   * zero. The whole point of the monitor is to tell those apart.
   */
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export const EMPTY_STATE: MonitorState = {
  lastBlock: 0,
  totalUsdc: 0,
  paymentCount: 0,
  firstPaymentAt: null,
  lastPaymentAt: null,
  recent: [],
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveFailures: 0,
};

const STATE_KEY = "revenue:state";

/**
 * How many consecutive failed sweeps before the operator is told. One failed
 * tick is a blip on a public RPC node; several in a row means the monitor is
 * blind and nobody would otherwise find out.
 */
const FAILURE_ALERT_THRESHOLD = 3;

/**
 * Base RPC endpoints, tried in order.
 *
 * A single public endpoint is not a dependency you can build a monitor on:
 * mainnet.base.org answers a laptop fine but rate-limits Workers with HTTP
 * 429, because every Worker in a colo shares egress IPs with everyone else's.
 * That is not an outage anyone will fix for us, so the monitor carries
 * alternatives rather than treating one provider's quota as fatal.
 */
const RPC_ENDPOINTS = [
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://1rpc.io/base",
  "https://mainnet.base.org",
];

function rpcEndpoints(env: Env): string[] {
  // An explicit override is a deliberate choice (usually a paid, authenticated
  // node) and must not be silently second-guessed by falling back to a public
  // one with different rate limits and retention.
  return env.BASE_RPC_URL ? [env.BASE_RPC_URL] : RPC_ENDPOINTS;
}

async function rpcOnce<T>(
  url: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  if (body.result === undefined) throw new Error("empty result");

  return body.result;
}

async function rpc<T>(env: Env, method: string, params: unknown[]): Promise<T> {
  const endpoints = rpcEndpoints(env);
  const failures: string[] = [];

  for (const url of endpoints) {
    try {
      return await rpcOnce<T>(url, method, params);
    } catch (err) {
      // Kept and reported together: "429" alone does not say which providers
      // were tried, and a monitor you cannot diagnose is barely a monitor.
      failures.push(`${new URL(url).host}: ${err instanceof Error ? err.message : err}`);
    }
  }

  throw new Error(`Base RPC ${method} failed on all endpoints — ${failures.join("; ")}`);
}

/** Left-pads a 20-byte address to the 32-byte width of an indexed log topic. */
function addressTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`;
}

/** Formats a USDC base-unit amount without going through float parsing. */
export function formatUsdc(raw: bigint): number {
  const divisor = 10n ** BigInt(USDC_DECIMALS);
  const whole = raw / divisor;
  const frac = raw % divisor;
  return Number(`${whole}.${frac.toString().padStart(USDC_DECIMALS, "0")}`);
}

export async function readState(env: Env): Promise<MonitorState> {
  const stored = await env.MONITOR.get<MonitorState>(STATE_KEY, "json");
  return stored ? { ...EMPTY_STATE, ...stored } : { ...EMPTY_STATE };
}

async function writeState(env: Env, state: MonitorState): Promise<void> {
  await env.MONITOR.put(STATE_KEY, JSON.stringify(state));
}

/**
 * Records that a sweep failed, so the failure survives the request that hit
 * it. Deliberately does not advance the watermark: the same blocks are
 * re-scanned next tick, so nothing is missed.
 */
export async function recordFailure(env: Env, err: unknown): Promise<MonitorState> {
  const state = await readState(env);
  const next: MonitorState = {
    ...state,
    lastRunAt: new Date().toISOString(),
    lastError: err instanceof Error ? err.message : String(err),
    consecutiveFailures: state.consecutiveFailures + 1,
  };

  await writeState(env, next);
  return next;
}

/** True when the monitor has failed often enough that it is effectively blind. */
export function shouldAlertOnFailure(state: MonitorState): boolean {
  return (
    state.consecutiveFailures >= FAILURE_ALERT_THRESHOLD &&
    state.consecutiveFailures % FAILURE_ALERT_THRESHOLD === 0
  );
}

/**
 * Scans for USDC transfers into the receiving address since the last scan and
 * folds them into the stored totals.
 *
 * On the very first run there is no watermark. It deliberately starts at the
 * current head rather than genesis: the address has no history worth
 * reconstructing, and scanning millions of blocks through a public node would
 * fail repeatedly and never establish a watermark at all.
 */
export async function scanForPayments(env: Env): Promise<{
  state: MonitorState;
  newPayments: Payment[];
}> {
  const state = await readState(env);
  const head = Number(await rpc<string>(env, "eth_blockNumber", []));

  const now0 = new Date().toISOString();

  if (state.lastBlock === 0) {
    const initial: MonitorState = {
      ...state,
      lastBlock: head,
      lastRunAt: now0,
      lastSuccessAt: now0,
      lastError: null,
      consecutiveFailures: 0,
    };
    await writeState(env, initial);
    return { state: initial, newPayments: [] };
  }

  if (head <= state.lastBlock) {
    const idle: MonitorState = {
      ...state,
      lastRunAt: now0,
      lastSuccessAt: now0,
      lastError: null,
      consecutiveFailures: 0,
    };
    await writeState(env, idle);
    return { state: idle, newPayments: [] };
  }

  const fromBlock = state.lastBlock + 1;
  const toBlock = Math.min(head, state.lastBlock + MAX_BLOCK_RANGE);

  const logs = await rpc<
    Array<{ topics: string[]; data: string; blockNumber: string; transactionHash: string }>
  >(env, "eth_getLogs", [
    {
      address: USDC_BASE,
      topics: [TRANSFER_TOPIC, null, addressTopic(env.X402_PAY_TO)],
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
    },
  ]);

  const newPayments: Payment[] = logs.map((log) => {
    const raw = BigInt(log.data);
    return {
      from: topicToAddress(log.topics[1]),
      amount: raw.toString(),
      usdc: formatUsdc(raw),
      block: Number(log.blockNumber),
      tx: log.transactionHash,
    };
  });

  const now = new Date().toISOString();
  const next: MonitorState = {
    lastBlock: toBlock,
    totalUsdc:
      Math.round((state.totalUsdc + newPayments.reduce((a, p) => a + p.usdc, 0)) * 1e6) / 1e6,
    paymentCount: state.paymentCount + newPayments.length,
    firstPaymentAt:
      state.firstPaymentAt ?? (newPayments.length > 0 ? now : null),
    lastPaymentAt: newPayments.length > 0 ? now : state.lastPaymentAt,
    recent: [...newPayments, ...state.recent].slice(0, 20),
    lastRunAt: now,
    lastSuccessAt: now,
    lastError: null,
    consecutiveFailures: 0,
  };

  await writeState(env, next);

  return { state: next, newPayments };
}

/**
 * Posts to a Discord-compatible webhook. Alerting failures must never fail the
 * scan: the watermark has already been advanced, and a missed notification is
 * far less costly than a scan that retries the same blocks forever.
 */
export async function alert(
  env: Env,
  payments: Payment[],
  state: MonitorState,
): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL || payments.length === 0) return;

  const isFirstEver = state.paymentCount === payments.length;
  const lines = payments.map(
    (p) =>
      `• **$${p.usdc.toFixed(6)} USDC** from \`${p.from}\` — [tx](https://basescan.org/tx/${p.tx})`,
  );

  const content = [
    isFirstEver
      ? "🎉 **FIRST PAYMENT EVER RECEIVED** 🎉"
      : `💰 ${payments.length} new payment${payments.length === 1 ? "" : "s"}`,
    ...lines,
    `Lifetime: **$${state.totalUsdc.toFixed(6)}** across ${state.paymentCount} payment${state.paymentCount === 1 ? "" : "s"}.`,
  ].join("\n");

  await post(env.ALERT_WEBHOOK_URL, content);
}

/**
 * Warns that the monitor itself is broken. Sent through the same webhook,
 * because an operator who is not told the watcher is blind will read its
 * silence as "no sales yet".
 */
export async function alertFailure(env: Env, state: MonitorState): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL) return;

  await post(
    env.ALERT_WEBHOOK_URL,
    [
      `⚠️ **Revenue monitor is failing** — ${state.consecutiveFailures} consecutive sweeps.`,
      `Last error: \`${state.lastError ?? "unknown"}\``,
      `Last successful sweep: ${state.lastSuccessAt ?? "never"} (block ${state.lastBlock}).`,
      "Payments are unaffected — this only means arrivals are not being noticed.",
    ].join("\n"),
  );
}

async function post(url: string, content: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    // fetch resolves on 4xx/5xx, so without this a deleted or revoked webhook
    // fails completely silently — the exact failure that costs us the alert.
    if (!res.ok) {
      console.error(
        `Alert webhook rejected the notification: HTTP ${res.status} ${await res
          .text()
          .catch(() => "")}`.trim(),
      );
    }
  } catch (err) {
    console.error("Alert webhook unreachable:", err);
  }
}
