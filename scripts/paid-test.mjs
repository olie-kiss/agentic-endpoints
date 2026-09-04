/**
 * Make one real, paid call against a live endpoint.
 *
 * This is the last unproven step in the whole system: settlement. Everything
 * up to it is already confirmed working -- the facilitator verifies our
 * signatures and rejects them only for lack of funds.
 *
 * SECURITY
 * --------
 * Use a THROWAWAY wallet funded with a dollar or two. Never use a key that
 * holds anything you would mind losing. The key is read from the environment
 * and is never logged, echoed, or written to disk by this script.
 *
 *   export X402_TEST_PRIVATE_KEY=0x...
 *   node scripts/paid-test.mjs [/compress] [baseUrl]
 *
 * Or put X402_TEST_PRIVATE_KEY in .dev.vars, which is gitignored:
 *   set -a && . ./.dev.vars && set +a && node scripts/paid-test.mjs
 */
import { createPublicClient, http as viemHttp, formatUnits } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";

const BASE = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));

/**
 * Sign and submit from an empty wallet on purpose.
 *
 * Settlement needs real USDC, but everything in front of it does not: the
 * challenge, the scheme and network match, the EIP-3009 signature, the
 * facilitator round trip and its verdict are all exercised by a payment that
 * is perfectly valid apart from being unbacked. A rejection that names the
 * balance is therefore a passing result — it proves the only thing left
 * untested is the broadcast itself. A 500, a timeout, or a complaint about
 * the signature or the network is a real bug, and one that would otherwise
 * have been found by the first paying customer.
 */
const allowUnfunded = flags.has("--allow-unfunded");

const path = args[0] ?? "/compress";
const baseUrl = args[1] ?? "https://ai.oliverkiss.com";

const BODIES = {
  "/compress": {
    text: "The x402 protocol lets autonomous agents pay for API calls with stablecoins over plain HTTP. A server answers 402 with a price; the agent signs a payment and retries. No accounts, no API keys, no invoices.",
    target_tokens: 20,
  },
  "/once-key": { namespace: "first-sale", action_key: "hello-world" },
  "/scrape": { url: "https://example.com" },
};

const key = process.env.X402_TEST_PRIVATE_KEY;
if (!key) {
  if (!allowUnfunded) {
    console.error(
      "X402_TEST_PRIVATE_KEY is not set.\n" +
        "Use a throwaway wallet holding only a dollar or two,\n" +
        "or pass --allow-unfunded to test the pipeline with a generated key.",
    );
    process.exit(1);
  }
}

// With --allow-unfunded and no key supplied, mint a random one. It never
// touches disk and never holds anything, so there is nothing to protect.
const privateKey = key ?? generatePrivateKey();
const account = privateKeyToAccount(privateKey);
const chain = createPublicClient({ chain: base, transport: viemHttp() });

// Check funds before signing anything, so a dry wallet gives a clear message
// instead of an opaque verification failure.
const [balance, gas] = await Promise.all([
  chain.readContract({
    address: USDC,
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
  }),
  chain.getBalance({ address: account.address }),
]);

console.log(`Payer:   ${account.address}`);
console.log(`USDC:    $${formatUnits(balance, 6)}`);
console.log(`ETH:     ${formatUnits(gas, 18)} (not needed — the facilitator pays gas)`);
console.log(`Target:  ${baseUrl}${path}\n`);

if (balance === 0n && !allowUnfunded) {
  console.error("This wallet holds no USDC on Base. Fund it and re-run.");
  process.exit(1);
}

if (balance === 0n) {
  console.log(
    "Running unfunded: expecting the facilitator to reject this payment for\n" +
      "insufficient funds, and nothing else.\n",
  );
}

const client = new x402Client().register(
  BASE,
  new ExactEvmScheme(toClientEvmSigner(account)),
);
const http = new x402HTTPClient(client);

const init = {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(BODIES[path] ?? {}),
};

const challenge = await fetch(`${baseUrl}${path}`, init);
if (challenge.status !== 402) {
  console.error(`Expected 402, got ${challenge.status}`);
  process.exit(1);
}

const paymentRequired = http.getPaymentRequiredResponse(
  (name) => challenge.headers.get(name),
  await challenge.clone().json().catch(() => undefined),
);

const price = paymentRequired.accepts?.[0]?.amount;
console.log(`Price:   ${price} USDC base units ($${Number(price) / 1e6})`);
console.log("Signing payment authorization...\n");

const payload = await http.createPaymentPayload(paymentRequired);
const paid = await fetch(`${baseUrl}${path}`, {
  ...init,
  headers: { ...init.headers, ...http.encodePaymentSignatureHeader(payload) },
});

const body = await paid.clone().json().catch(() => ({}));
console.log(`Response: ${paid.status}`);
console.log(JSON.stringify(body, null, 2).slice(0, 800));

/**
 * Under x402 v2 the reason for a refusal travels in the `payment-required`
 * header, not the body — the body of a 402 is legitimately empty. Reading the
 * body alone reported "unknown failure" for a perfectly well-explained
 * rejection, which is how a working system gets mistaken for a broken one.
 */
const challengeHeader = paid.headers.get("payment-required");
let refusal;
if (challengeHeader) {
  try {
    refusal = JSON.parse(Buffer.from(challengeHeader, "base64").toString());
    if (refusal.error) console.log(`\nFacilitator verdict: ${refusal.error}`);
  } catch {
    console.log("\nCould not decode the payment-required header.");
  }
}

const settleHeader = paid.headers.get("payment-response");
if (settleHeader) {
  const settle = JSON.parse(Buffer.from(settleHeader, "base64").toString());
  console.log("\nSettlement:", JSON.stringify(settle, null, 2).slice(0, 600));
  if (settle.transaction) {
    console.log(`\nOn-chain: https://basescan.org/tx/${settle.transaction}`);
  }
}

if (paid.status === 200 && settleHeader) {
  console.log("\n✅ Paid call settled. Check the receiving wallet.");
} else if (balance === 0n) {
  // An unfunded run has exactly one acceptable failure. Anything else means
  // the payment path is broken for funded buyers too.
  const verdict = refusal?.error ?? "";

  if (paid.status === 402 && verdict.includes("insufficient_balance")) {
    console.log(
      "\n✅ Pipeline verified end to end, short of the broadcast.\n" +
        "   The challenge, the EIP-3009 signature, the scheme and network\n" +
        "   match and the facilitator round trip all work. It refused only\n" +
        "   because the wallet is empty, which is the correct answer.",
    );
  } else {
    console.log(
      `\n❌ Unexpected rejection (${paid.status}, ${verdict || "no verdict"}).\n` +
        "   An empty wallet should be refused for insufficient balance.\n" +
        "   Being refused for any other reason means a funded buyer would\n" +
        "   likely be refused too.",
    );
    process.exit(1);
  }
} else {
  console.log("\n⚠️  Not settled. The x402 middleware cancels settlement on any status >= 400.");
}
