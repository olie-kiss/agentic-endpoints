/**
 * Trigger PayAI Bazaar indexing without spending anything.
 *
 * PayAI catalogues a resource when it sees the Bazaar metadata on /verify,
 * not only on /settle. So a payment attempt that is well-formed but cannot
 * possibly succeed is enough to get listed.
 *
 * This signs an EIP-3009 authorization with a freshly generated key that has
 * never held funds. Verification fails on insufficient balance, no
 * transaction is broadcast, and nothing is spent. The signature authorizes a
 * transfer to your own payTo address, so it is worthless to anyone else.
 *
 *   node scripts/trigger-indexing.mjs [baseUrl]
 */
import { privateKeyToAccount } from "viem/accounts";
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
    const first = (e) => (e.path === "/vault/store" ? 0 : 1);
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

// Spend controls default to a $1 cap, which silently refuses to announce the
// $5 and $25 credit packs. Disabled here because the signer is a throwaway key
// that is never funded: every payment is expected to fail on balance, and the
// announcement is the only purpose.
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

const serviceOf = (path) =>
  path.startsWith("/vault/") ? "vault" : path.split("/")[1];

for (const route of PAID_ROUTES) {
  const service = serviceOf(route.path);
  if (route.body.namespace !== undefined || service === "vault") {
    route.body.namespace = PROBE_NS;
    if (tokens[service]) route.body.namespace_token = tokens[service];
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
