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

const PAID_ROUTES = [
  { path: "/once-key", body: { namespace: "bazaar-probe", action_key: "probe" } },
  { path: "/compress", body: { text: "hello world" } },
  { path: "/pdf-parse", body: { url: "https://example.com/a.pdf" } },
  { path: "/scrape", body: { url: "https://example.com" } },
  {
    path: "/vault/store",
    body: { namespace: "bazaar-probe", key: "k", ciphertext: "c" },
  },
  { path: "/vault/retrieve", body: { namespace: "bazaar-probe", key: "k" } },
  { path: "/vault/delete", body: { namespace: "bazaar-probe", key: "k" } },
  { path: "/vault/exists", body: { namespace: "bazaar-probe", key: "k" } },
];

const account = privateKeyToAccount(generatePrivateKey());
console.log(`Throwaway signer: ${account.address} (never funded)\n`);

const client = new x402Client().register(
  BASE,
  new ExactEvmScheme(toClientEvmSigner(account)),
);
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
