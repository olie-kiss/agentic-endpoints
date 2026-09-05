import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http as viemHttp, formatUnits } from "viem";
import { base, baseSepolia } from "viem/chains";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";

/**
 * Announce every paid route to the PayAI Bazaar by paying for it once.
 *
 * This script used to sign from an unfunded throwaway key, on the belief
 * that merely reaching /verify was enough to list a resource. It is not.
 * Confirmed on Base Sepolia on 2026-09-04: a route appears in
 * /discovery/resources only after a payment for it actually settles, and
 * appears within seconds of that. So this now spends real money, one call
 * per route, and every payment is the price of being findable at all.
 *
 * Usage:
 *   X402_TEST_PRIVATE_KEY=0x... node scripts/trigger-indexing.mjs [url] [--testnet]
 */
const TESTNET = process.argv.includes("--testnet");
const BASE = TESTNET ? "eip155:84532" : "eip155:8453";
const INCLUDE_CREDITS = process.argv.includes("--include-credits");

const baseUrl =
  process.argv.slice(2).find((a) => !a.startsWith("--")) ??
  "https://ai.oliverkiss.com";

// Probe bodies only. The route list itself is fetched from the live
// catalogue, which is generated from the payment config -- a hardcoded copy
// here would silently stop announcing any route added later, which is exactly
// how three vault routes went unlisted.
const PROBE_BODIES = {
  "/once-key": { namespace: "bazaar-probe", action_key: "probe" },
  "/compress": { text: "hello world" },
  // A real PDF that serves to a datacentre IP. The original placeholder
  // 404ed and the obvious W3C replacement answers 403 to the Worker, so
  // /pdf-parse returned 502 either way: it never settled, and was the one
  // route that could not be announced no matter how often this ran.
  "/pdf-parse": {
    url: "https://pdfobject.com/pdf/sample.pdf",
  },
  "/scrape": { url: "https://example.com" },
  "/vault/store": { namespace: "bazaar-probe", key: "k", ciphertext: "c" },
  "/vault/retrieve": { namespace: "bazaar-probe", key: "k" },
  "/vault/delete": { namespace: "bazaar-probe", key: "k" },
  "/vault/exists": { namespace: "bazaar-probe", key: "k" },
  "/vault/list": { namespace: "bazaar-probe" },
  // Meetings. import must settle first: it claims the namespace AND returns
  // the meeting_id that get/delete need, and without either they are refused
  // before any payment and never list.
  "/meetings/import": {
    namespace: "bazaar-probe",
    title: "Bazaar probe",
    visibility: "queryable",
    transcript: "A short probe transcript announcing this route to the Bazaar.",
  },
  "/meetings/search": { namespace: "bazaar-probe", query: "probe" },
  "/meetings/get": { namespace: "bazaar-probe" },
  "/meetings/list": { namespace: "bazaar-probe" },
  "/meetings/delete": { namespace: "bazaar-probe" },
};

/** Namespace used by the vault probes, unique per run so a leftover token
 * from an earlier announcement cannot lock this one out of its own writes. */
const PROBE_NS = `bazaar-probe-${Date.now().toString(36)}`;

const catalogue = await fetch(`${baseUrl}/`, {
  headers: { Accept: "application/json" },
}).then((r) => r.json());

/**
 * Credit packs are $5 and $25 and are excluded by default.
 *
 * Every other route costs under two cents, so announcing the whole utility
 * catalogue is pocket change; announcing the credit packs as well costs $30
 * and buys credit only we can spend. Opt in with --include-credits.
 */
const PAID_ROUTES = catalogue.endpoints
  .filter((e) => e.price.startsWith("$"))
  .filter((e) => INCLUDE_CREDITS || !e.path.startsWith("/credits/"))
  // Cheapest first, so a wallet that runs dry does so having listed the most
  // routes it could afford. The one exception is /vault/store: it is the
  // most expensive vault route but it issues the namespace token the others
  // need, and without it they are refused 403, never settle, and never list.
  .sort((a, b) => {
    // /vault/store and /meetings/import are not the cheapest, but each issues
    // the namespace token every other route in its service needs. Run them
    // first or the rest are refused, never settle, and never list.
    const first = (e) =>
      e.path === "/vault/store" || e.path === "/meetings/import" ? 0 : 1;
    return (
      first(a) - first(b) ||
      parseFloat(a.price.slice(1)) - parseFloat(b.price.slice(1))
    );
  })
  .map((e) => ({
    path: e.path,
    price: parseFloat(e.price.slice(1)),
    body: { ...(PROBE_BODIES[e.path] ?? {}) },
  }));

const budget = PAID_ROUTES.reduce((sum, r) => sum + r.price, 0);
console.log(
  `Announcing ${PAID_ROUTES.length} routes on ${TESTNET ? "Base Sepolia" : "Base mainnet"}\n` +
    `Total cost: $${budget.toFixed(3)}\n`,
);

const key = process.env.X402_TEST_PRIVATE_KEY;
if (!key) {
  console.error(
    "X402_TEST_PRIVATE_KEY is not set.\n\n" +
      "Indexing requires payments that actually settle, so this needs a\n" +
      "funded wallet. Use a throwaway holding only what the run costs.",
  );
  process.exit(1);
}

const account = privateKeyToAccount(key);
console.log(`Payer: ${account.address}\n`);

/**
 * Refuse to start unless the wallet can cover the whole run.
 *
 * Every route is announced by a payment that settles, so a wallet that runs
 * dry midway leaves the catalogue half-populated: the routes before the last
 * successful payment are listed, the rest are not, and nothing in the output
 * distinguishes "not announced yet" from "announced and later dropped". The
 * failure is also expensive to diagnose, because a re-run re-pays for every
 * route that already succeeded. Checking the balance once, up front, turns a
 * partial spend into a refusal that costs nothing.
 */
const USDC = TESTNET
  ? "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
  : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

try {
  const balance = await createPublicClient({
    chain: TESTNET ? baseSepolia : base,
    transport: viemHttp(),
  }).readContract({
    address: USDC,
    abi: [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ],
    functionName: "balanceOf",
    args: [account.address],
  });

  const usdc = Number(formatUnits(balance, 6));
  console.log(`Balance: $${usdc.toFixed(6)} USDC on ${TESTNET ? "Base Sepolia" : "Base"}\n`);

  if (usdc < budget) {
    console.error(
      `Balance $${usdc.toFixed(6)} does not cover the $${budget.toFixed(3)} this run costs.\n\n` +
        `Send USDC to ${account.address} on ${TESTNET ? "Base Sepolia" : "Base"} and re-run.\n` +
        "Refusing to start rather than announce some routes and not others.",
    );
    process.exit(1);
  }
} catch (err) {
  // A balance that cannot be read is not a balance of zero. Failing open here
  // would spend real money on the strength of a network error, so this stops
  // and says which of the two happened.
  console.error(
    `Could not read the USDC balance for ${account.address}: ${err.message}\n\n` +
      "This is a check failure, not an empty wallet. Refusing to spend until\n" +
      "the balance is known. Re-run when the RPC is reachable.",
  );
  process.exit(1);
}

// Spend controls default to a $1 cap, which silently refuses to announce the
// $5 and $25 credit packs. Disabled here because the preflight check above
// has already bounded the spend: it refuses to start unless the balance
// covers the printed budget, and the wallet is a throwaway funded with only
// what this run costs. That bound is the real spend control.
const client = x402Client.fromConfig({
  schemes: [{ network: BASE, client: new ExactEvmScheme(toClientEvmSigner(account)) }],
  spendControls: false,
});
const http = new x402HTTPClient(client);

/**
 * Namespace tokens, kept per service rather than in one variable.
 *
 * This matters because settlement is cancelled on any status at or above
 * 400: a vault call with no valid token is refused 403, never pays, and so
 * never lists — the routes that most need announcing would be the ones
 * silently skipped. The first vault write claims a namespace and the rest
 * present its token.
 *
 * They are stored separately because the vault and once-key own their
 * namespaces independently and issue unrelated tokens. Holding one variable
 * meant once-key's token overwrote the vault's, and every vault route after
 * it was refused with a token belonging to a different service.
 */
const tokens = {};

/** Ids of records created by a probe, so later routes in the same service can
 *  address something that actually exists. */
const ids = {};

const serviceOf = (path) =>
  path.startsWith("/vault/") ? "vault" : path.split("/")[1];

for (const route of PAID_ROUTES) {
  const service = serviceOf(route.path);
  if (route.body.namespace !== undefined || service === "vault") {
    route.body.namespace = PROBE_NS;
    if (tokens[service]) route.body.namespace_token = tokens[service];
  }

  // /meetings/get and /meetings/delete are refused with 400 before any
  // payment unless they name a real meeting, so they can only be announced
  // using the id returned by the import above.
  if (ids[service] && route.body.meeting_id === undefined) {
    route.body.meeting_id = ids[service];
  }

  const url = `${baseUrl}${route.path}`;
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(route.body),
  };

  try {
    const challenge = await fetch(url, init);
    if (challenge.status !== 402) {
      console.log(`${route.path}: expected 402, got ${challenge.status}`);
      continue;
    }

    const paymentRequired = http.getPaymentRequiredResponse(
      (name) => challenge.headers.get(name),
      await challenge.clone().json().catch(() => undefined),
    );

    const payload = await http.createPaymentPayload(paymentRequired);
    const headers = http.encodePaymentSignatureHeader(payload);

    const paid = await fetch(url, {
      ...init,
      headers: { ...init.headers, ...headers },
    });

    const parsed = await paid
      .clone()
      .json()
      .catch(() => ({}));

    if (parsed.namespace_token) tokens[service] = parsed.namespace_token;
    if (parsed.meeting_id) ids[service] = parsed.meeting_id;

    // Settlement, not the handler's answer, is what gets a route listed.
    const settled = paid.status < 400;
    console.log(
      `${settled ? "listed " : "SKIPPED"} ${route.path} ${paid.status} ` +
        `${JSON.stringify(parsed).slice(0, 110)}`,
    );
  } catch (err) {
    console.log(`${route.path}: ERROR ${err.message}`);
  }
}
