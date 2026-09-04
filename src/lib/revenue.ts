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
}

export const EMPTY_STATE: MonitorState = {
  lastBlock: 0,
  totalUsdc: 0,
  paymentCount: 0,
  firstPaymentAt: null,
  lastPaymentAt: null,
  recent: [],
};

const STATE_KEY = "revenue:state";

function rpcUrl(env: Env): string {
  return env.BASE_RPC_URL ?? "https://mainnet.base.org";
}

async function rpc<T>(env: Env, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl(env), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!res.ok) {
    throw new Error(`Base RPC ${method} returned HTTP ${res.status}`);
  }

  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`Base RPC ${method}: ${body.error.message}`);
  if (body.result === undefined) throw new Error(`Base RPC ${method}: empty result`);

  return body.result;
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

  if (state.lastBlock === 0) {
    const initial = { ...state, lastBlock: head };
    await env.MONITOR.put(STATE_KEY, JSON.stringify(initial));
    return { state: initial, newPayments: [] };
  }

  if (head <= state.lastBlock) return { state, newPayments: [] };

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
  };

  await env.MONITOR.put(STATE_KEY, JSON.stringify(next));

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

  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    console.error("Revenue alert failed to send:", err);
  }
}
