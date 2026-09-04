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
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";

const BASE = "eip155:8453";
const baseUrl = process.argv[2] ?? "https://ai.oliverkiss.com";

// Probe bodies only. The route list itself is fetched from the live
// catalogue, which is generated from the payment config -- a hardcoded copy
// here would silently stop announcing any route added later, which is exactly
// how three vault routes went unlisted.
const PROBE_BODIES = {
  "/once-key": { namespace: "bazaar-probe", action_key: "probe" },
  "/compress": { text: "hello world" },
  "/pdf-parse": { url: "https://example.com/a.pdf" },
  "/scrape": { url: "https://example.com" },
  "/vault/store": { namespace: "bazaar-probe", key: "k", ciphertext: "c" },
  "/vault/retrieve": { namespace: "bazaar-probe", key: "k" },
  "/vault/delete": { namespace: "bazaar-probe", key: "k" },
  "/vault/exists": { namespace: "bazaar-probe", key: "k" },
};

const catalogue = await fetch(`${baseUrl}/`, {
  headers: { Accept: "application/json" },
}).then((r) => r.json());

const PAID_ROUTES = catalogue.endpoints
  .filter((e) => e.price.startsWith("$"))
  .map((e) => ({ path: e.path, body: PROBE_BODIES[e.path] ?? {} }));

console.log(`Announcing ${PAID_ROUTES.length} paid routes from the live catalogue`);

const account = privateKeyToAccount(generatePrivateKey());
console.log(`Throwaway signer: ${account.address} (never funded)\n`);

// Spend controls default to a $1 cap, which silently refuses to announce the
// $5 and $25 credit packs. Disabled here because the signer is a throwaway key
// that is never funded: every payment is expected to fail on balance, and the
// announcement is the only purpose.
const client = x402Client.fromConfig({
  schemes: [{ network: BASE, client: new ExactEvmScheme(toClientEvmSigner(account)) }],
  spendControls: false,
});
const http = new x402HTTPClient(client);

for (const route of PAID_ROUTES) {
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

    console.log(
      `${route.path}: ${paid.status} ${JSON.stringify(parsed).slice(0, 160)}`,
    );
  } catch (err) {
    console.log(`${route.path}: ERROR ${err.message}`);
  }
}
