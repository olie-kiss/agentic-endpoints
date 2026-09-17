/**
 * Deterministic stand-ins for the two third parties this service calls out to.
 *
 * The suite used to reach the real facilitator and the real Base RPC nodes.
 * Inside the Workers test runtime those connections are refused, so nine tests
 * failed for reasons that had nothing to do with the code under test — and,
 * far worse, the tests covering the payment challenge were the ones failing.
 * A suite that cannot assert the paywall answers 402 is not protecting the
 * only part of this system that earns money.
 *
 * Only these two hosts are answered. Every other request goes to the real
 * network exactly as it did before, so no test loses coverage.
 */

/** Any block past the monitor's sanity floor; the value itself is arbitrary. */
export const STUB_HEAD_BLOCK = 0x3100000;

const FACILITATOR_HOSTS = new Set([
  "facilitator.payai.network",
  "x402.org",
]);

const RPC_HOSTS = new Set([
  "base-rpc.publicnode.com",
  "base.drpc.org",
  "1rpc.io",
  "mainnet.base.org",
  "base.gateway.tenderly.co",
  "base-pokt.nodies.app",
  "base-mainnet.public.blastapi.io",
]);

/** Mirrors the live `/supported` payload closely enough for the middleware. */
const SUPPORTED = {
  kinds: [
    { x402Version: 1, scheme: "exact", network: "base-sepolia" },
    { x402Version: 1, scheme: "exact", network: "base" },
    { x402Version: 2, scheme: "exact", network: "eip155:8453" },
    { x402Version: 2, scheme: "exact", network: "eip155:84532" },
  ],
  extensions: ["bazaar"],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function rpc(request: Request): Promise<Response> {
  const { method } = (await request.json().catch(() => ({}))) as {
    method?: string;
  };

  switch (method) {
    case "eth_blockNumber":
      return json({ jsonrpc: "2.0", id: 1, result: `0x${STUB_HEAD_BLOCK.toString(16)}` });

    // balanceOf: a zero balance, so a sweep records no revenue that never
    // arrived. Tests that need a payment drive the state directly instead.
    case "eth_call":
      return json({ jsonrpc: "2.0", id: 1, result: `0x${"0".repeat(64)}` });

    case "eth_getLogs":
      return json({ jsonrpc: "2.0", id: 1, result: [] });

    default:
      return json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unstubbed" } });
  }
}

export async function handleOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (FACILITATOR_HOSTS.has(url.hostname)) {
    if (url.pathname.endsWith("/supported")) return json(SUPPORTED);

    // Nothing in the suite settles a payment; answering anything else would
    // invent a verdict the real facilitator might not give.
    return json({ error: "unstubbed facilitator route" }, 501);
  }

  if (RPC_HOSTS.has(url.hostname)) return rpc(request);

  /**
   * Everything else goes to the real network, unchanged.
   *
   * Only the two hosts above are unreachable from this runtime. Blocking the
   * rest would break tests that legitimately resolve public DNS, and quietly
   * narrow what the suite actually exercises.
   *
   * Rebuilt field by field rather than passed straight through: this handler
   * runs in Node, whose fetch cannot consume a workerd Request and rejects it
   * with "Failed to parse URL from [object Request]".
   */
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return fetch(url.toString(), {
    method: request.method,
    headers: [...request.headers],
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: "manual",
  });
}
