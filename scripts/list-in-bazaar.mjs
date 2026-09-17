/**
 * Lists this service's paid routes in the PayAI Bazaar.
 *
 * Why this exists
 * ---------------
 * The Bazaar has no registration form. The facilitator indexes a resource only
 * from a payment it processes that carries the resource's discovery
 * declaration. No buyer had ever completed one against production, so the
 * catalog had never heard of us: `/discovery/listing-status` answered "No
 * catalog row or recent write outcome exists" for every route. Not deferred,
 * not rejected — never seen.
 *
 * Why it costs nothing
 * --------------------
 * Cataloging runs on `/verify` as well as `/settle`, and verification moves no
 * funds. A first listing of a POST resource seen only through `/verify` is
 * normally deferred until its first settlement, but the catalog worker lists
 * it anyway when its own read-only probe (HEAD, then GET) answers 402 — which
 * every paid route here does. Confirmed against the live facilitator on Base
 * Sepolia: a verify-only call produced
 * `lastWrite: { status: "listed", source: "verify" }`.
 *
 * So the signing wallet must *hold* the price of each route it lists, because
 * verification checks the balance, but it never spends it. Every route below
 * $0.03 is covered by holding three cents.
 *
 * What it does not do
 * -------------------
 * It never calls `/settle` and never sends the payment to our own server, so
 * no route is invoked and no USDC moves. It does produce signed EIP-3009
 * authorizations, which are short-lived (`maxTimeoutSeconds`, 300s here) but
 * are real: treat the signing key as spendable, not as a throwaway.
 *
 * Usage
 * -----
 *   X402_TEST_PRIVATE_KEY="$(cat .mainnet-wallet)" node scripts/list-in-bazaar.mjs
 *   X402_TEST_PRIVATE_KEY="$(cat .testnet-wallet)" node scripts/list-in-bazaar.mjs \
 *     https://agentic-endpoints-testnet.oliver-835.workers.dev --testnet
 *
 * Flags: --testnet (Base Sepolia), --max-price <usd> (default 0.10),
 *        --only <path> (repeatable), --no-wait (skip the listing poll).
 */
import { createPublicClient, http as viemHttp, formatUnits } from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";

const FACILITATOR = "https://facilitator.payai.network";
const USDC = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const only = argv.reduce(
  (acc, a, i) => (a === "--only" ? [...acc, argv[i + 1]] : acc),
  [],
);

const TESTNET = flag("--testnet");
const NETWORK = TESTNET ? "eip155:84532" : "eip155:8453";
const CHAIN = TESTNET ? baseSepolia : base;
const MAX_PRICE = Number(value("--max-price", "0.10"));
const BASE_URL = (
  argv.find((a) => a.startsWith("http")) ?? "https://ai.oliverkiss.com"
).replace(/\/$/, "");

const key = process.env.X402_TEST_PRIVATE_KEY?.trim();
if (!key) {
  console.error("Set X402_TEST_PRIVATE_KEY to the signing wallet's private key.");
  process.exit(1);
}

const account = privateKeyToAccount(key);
const client = new x402Client().register(
  NETWORK,
  new ExactEvmScheme(toClientEvmSigner(account)),
);
const http = new x402HTTPClient(client);

const chain = createPublicClient({ chain: CHAIN, transport: viemHttp() });
const balance = await chain.readContract({
  address: USDC[NETWORK],
  abi: [
    {
      name: "balanceOf",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "a", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ],
  functionName: "balanceOf",
  args: [account.address],
});

const held = Number(formatUnits(balance, 6));
console.log(`Signer:  ${account.address}`);
console.log(`Network: ${NETWORK}${TESTNET ? " (Base Sepolia)" : " (Base mainnet)"}`);
console.log(`Holds:   $${held.toFixed(6)} USDC — verification checks this balance but never spends it`);
console.log(`Target:  ${BASE_URL}\n`);

const catalogue = await fetch(BASE_URL, {
  headers: { Accept: "application/json" },
}).then((r) => r.json());

const routes = (catalogue.endpoints ?? [])
  .filter((e) => typeof e.price === "string" && e.price.startsWith("$"))
  .map((e) => ({ path: e.path, usd: Number(e.price.slice(1)) }))
  .filter((e) => (only.length ? only.includes(e.path) : true))
  .sort((a, b) => a.usd - b.usd);

const affordable = routes.filter((r) => r.usd <= MAX_PRICE && r.usd <= held);
const skipped = routes.filter((r) => !affordable.includes(r));

if (affordable.length === 0) {
  console.error(
    `Nothing to list. The signer holds $${held.toFixed(6)}, and the cheapest route costs ` +
      `$${routes[0]?.usd ?? 0}. Verification needs the balance to be present, not spent.`,
  );
  process.exit(1);
}

for (const r of skipped) {
  const why = r.usd > MAX_PRICE ? `above --max-price ${MAX_PRICE}` : "exceeds the held balance";
  console.log(`skip  ${r.path.padEnd(22)} $${r.usd} (${why})`);
}

const results = [];
for (const route of affordable) {
  const label = route.path.padEnd(22);
  try {
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    };
    const challenge = await fetch(`${BASE_URL}${route.path}`, init);
    if (challenge.status !== 402) {
      console.log(`FAIL  ${label} expected 402, got ${challenge.status}`);
      results.push({ ...route, ok: false, note: `challenge ${challenge.status}` });
      continue;
    }

    const header = challenge.headers.get("payment-required");
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    if (!decoded.extensions?.bazaar) {
      console.log(`FAIL  ${label} challenge carries no bazaar declaration`);
      results.push({ ...route, ok: false, note: "no declaration" });
      continue;
    }

    const paymentRequired = http.getPaymentRequiredResponse(
      (n) => challenge.headers.get(n),
      await challenge.clone().json().catch(() => undefined),
    );
    const payload = await http.createPaymentPayload(paymentRequired);

    const res = await fetch(`${FACILITATOR}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: decoded.x402Version ?? 2,
        paymentPayload: payload,
        paymentRequirements: { ...paymentRequired.accepts[0], resource: decoded.resource },
        serverExtensions: decoded.extensions,
      }),
    });

    const body = await res.json().catch(() => ({}));
    const extHeader = res.headers.get("EXTENSION-RESPONSES");
    const ext = extHeader
      ? JSON.parse(Buffer.from(extHeader, "base64").toString("utf8"))
      : null;
    const verdict = ext?.bazaar?.status ?? ext?.bazaar?.rejectedReason ?? "no extension response";

    if (!body.isValid) {
      const why = body.invalidReason ?? body.error ?? "rejected";
      console.log(`FAIL  ${label} verify refused: ${why}`);
      results.push({ ...route, ok: false, note: why });
      continue;
    }

    console.log(`ok    ${label} verified, catalog says: ${verdict}`);
    results.push({ ...route, ok: true, note: verdict });
  } catch (err) {
    console.log(`FAIL  ${label} ${String(err).slice(0, 90)}`);
    results.push({ ...route, ok: false, note: String(err).slice(0, 90) });
  }

  // The facilitator rate-limits; pace the run rather than get throttled
  // halfway through and misreport the remainder as failures.
  await new Promise((r) => setTimeout(r, 1200));
}

const verified = results.filter((r) => r.ok);
console.log(`\n${verified.length}/${results.length} accepted for cataloging. No funds moved.`);

if (flag("--no-wait") || verified.length === 0) process.exit(verified.length ? 0 : 1);

console.log("\nWaiting for the catalog worker to probe and admit each resource...");
await new Promise((r) => setTimeout(r, 20000));

let listed = 0;
for (const route of verified) {
  const url = encodeURIComponent(`${BASE_URL}${route.path}`);
  const res = await fetch(`${FACILITATOR}/discovery/listing-status?resource=${url}`);
  const s = await res.json().catch(() => ({}));
  if (s.listed) {
    listed++;
    console.log(`listed   ${route.path.padEnd(22)} via ${s.lastWrite?.source ?? "?"}, probe ${s.lastProbe?.httpStatus ?? "?"}`);
  } else {
    const why = s.detail ?? s.hiddenReason ?? s.lastWrite?.reason ?? "pending";
    console.log(`pending  ${route.path.padEnd(22)} ${why}`);
  }
  await new Promise((r) => setTimeout(r, 400));
}

console.log(
  `\n${listed}/${verified.length} listed in the Bazaar. Anything still pending is usually ` +
    `the async probe; re-run with --no-wait skipped in a few minutes to recheck.`,
);
