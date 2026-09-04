import { Hono } from "hono";
import type { Env } from "../types";

/**
 * Remote MCP server (Streamable HTTP) exposing the paid endpoints as tools.
 *
 * Distribution, not a second product: the same handlers, the same wallet, the
 * same Durable Objects. This just makes them reachable from MCP clients and
 * publishable to the MCP Registry, which verifies ownership through the
 * domain rather than through any financial account.
 *
 * Protocol revision 2026-07-28 removed the `initialize` handshake, protocol
 * sessions and the GET stream endpoint, so every request is self-contained.
 * That maps exactly onto a Worker, which has no connection state to keep.
 * The older initialize-based revisions are still answered, because real
 * clients in the wild lag the spec.
 *
 * Discovery (`tools/list`) is free. Every tool that performs work is paid,
 * and a call without payment returns the x402 challenge as a structured
 * result so an agent knows the exact price, asset and address. Handing out
 * free `scrape` or `pdf_parse` calls would reopen the bandwidth-amplification
 * hole that pricing the vault routes just closed.
 */

const LATEST_PROTOCOL = "2026-07-28";
const SUPPORTED_PROTOCOLS = [LATEST_PROTOCOL, "2025-11-25", "2025-06-18", "2025-03-26"];

/** Clients that omit the version header predate it; the spec allows this. */
const ASSUMED_LEGACY_PROTOCOL = "2025-03-26";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";

interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** Backing HTTP route. Every one of these is payment-gated. */
  path: string;
  price: string;
  inputSchema: Record<string, unknown>;
}

const str = (description: string) => ({ type: "string", description });

const NAMESPACE_TOKEN = str(
  "One-time token issued by the first call that claimed this namespace. Required for every later call.",
);

const TOOLS: ToolDef[] = [
  {
    name: "once_key_claim",
    title: "Claim an action exactly once",
    description:
      "Atomic idempotency witness. Claims a {namespace, action_key} pair exactly once, so a fleet of agents cannot perform the same side effect twice. Returns claimed, duplicate, or conflict. Use this before any non-idempotent action such as sending an email, charging a card, or posting an order. Backed by a strongly consistent Durable Object; this is not something an agent can safely reimplement locally.",
    path: "/once-key",
    price: "$0.001",
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope, e.g. your application name"),
        action_key: str("Stable identifier for the action being claimed"),
        payload_sha256: str(
          "Optional hash of the action payload. If it differs from the stored hash, the result is a conflict.",
        ),
        namespace_token: NAMESPACE_TOKEN,
        ttl: { type: "integer", description: "Claim lifetime in seconds (default 86400)" },
      },
      required: ["namespace", "action_key"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_store",
    title: "Store an encrypted secret",
    description:
      "Store client-side encrypted data. This service never sees plaintext and cannot decrypt it. The first store claims the namespace and returns a namespace_token shown only once.",
    path: "/vault/store",
    price: "$0.02",
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope"),
        key: str("Item key"),
        ciphertext: str("Encrypt before sending. Plaintext here would be a mistake."),
        alg: str("Algorithm label recorded alongside the item (default aes-256-gcm)"),
        ttl: { type: "integer", description: "Item lifetime in seconds" },
        namespace_token: NAMESPACE_TOKEN,
      },
      required: ["namespace", "key", "ciphertext"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_retrieve",
    title: "Retrieve an encrypted secret",
    description: "Retrieve a previously stored ciphertext. Requires the namespace_token.",
    path: "/vault/retrieve",
    price: "$0.02",
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope"),
        key: str("Item key"),
        namespace_token: NAMESPACE_TOKEN,
      },
      required: ["namespace", "key", "namespace_token"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_exists",
    title: "Test whether a key exists",
    description:
      "Check for a key without returning its ciphertext. Requires the namespace_token.",
    path: "/vault/exists",
    price: "$0.001",
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope"),
        key: str("Item key"),
        namespace_token: NAMESPACE_TOKEN,
      },
      required: ["namespace", "key", "namespace_token"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_delete",
    title: "Delete a stored secret",
    description: "Permanently delete an item. Requires the namespace_token.",
    path: "/vault/delete",
    price: "$0.005",
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope"),
        key: str("Item key"),
        namespace_token: NAMESPACE_TOKEN,
      },
      required: ["namespace", "key", "namespace_token"],
      additionalProperties: false,
    },
  },
  {
    name: "pdf_parse",
    title: "Extract text from a PDF",
    description:
      "Extract text from a PDF by URL. Handles compressed streams, PDF 1.5+ object streams and ToUnicode CMaps, and reports encrypted or image-only documents honestly instead of returning garbage.",
    path: "/pdf-parse",
    price: "$0.01",
    inputSchema: {
      type: "object",
      properties: {
        url: str("HTTPS URL of the PDF"),
        max_pages: { type: "integer", description: "Optional page cap" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "scrape",
    title: "Fetch a page as text or markdown",
    description:
      "Fetch a URL and return readable text or markdown, optionally narrowed by CSS selector. Requests to private, loopback and link-local addresses are refused, and every redirect hop is re-validated.",
    path: "/scrape",
    price: "$0.005",
    inputSchema: {
      type: "object",
      properties: {
        url: str("HTTPS URL to fetch"),
        format: {
          type: "string",
          enum: ["text", "markdown", "html"],
          description: "Output format (default text)",
        },
        selector: str("Optional CSS selector to extract just part of the page"),
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "compress",
    title: "Compress text to a token budget",
    description:
      "Reduce text to fit a token budget, preserving whole sentences and reporting before/after token estimates.",
    path: "/compress",
    price: "$0.005",
    inputSchema: {
      type: "object",
      properties: {
        text: str("Text to compress"),
        target_tokens: { type: "integer", description: "Approximate token budget" },
        strategy: {
          type: "string",
          enum: ["extractive", "truncate"],
          description: "Compression strategy (default extractive)",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

/**
 * Dispatches a request back through the full request pipeline in-process, so
 * tool calls pass the same payment gate, body cap and validation as a direct
 * HTTP caller. Injected by the router to avoid an import cycle.
 */
export type Dispatcher = (request: Request) => Promise<Response>;

const app = new Hono<{ Bindings: Env; Variables: { dispatch: Dispatcher } }>();

/** JSON-RPC error, returned with an HTTP status the spec pins to the case. */
function rpcError(
  id: unknown,
  code: number,
  message: string,
  status: number,
  data?: unknown,
) {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } },
    { status },
  );
}

function rpcResult(id: unknown, result: Record<string, unknown>) {
  return Response.json({ jsonrpc: "2.0", id, result });
}

/**
 * The GET stream endpoint was removed in 2026-07-28, but clients still probe
 * it. Answering 405 rather than 404 tells them the endpoint exists and only
 * the method is wrong.
 */
app.get("/", (c) =>
  c.json(
    {
      error: "Method not allowed",
      detail: `This MCP endpoint accepts POST only. Protocol ${LATEST_PROTOCOL} removed the GET stream endpoint.`,
    },
    405,
    { Allow: "POST" },
  ),
);

app.post("/", async (c) => {
  /**
   * DNS-rebinding defence required by the transport spec. A remote server on
   * a public domain is a weaker target than a localhost one, but a browser
   * page must still not be able to drive this endpoint from another origin.
   */
  const origin = c.req.header("Origin");
  if (origin) {
    let ok = false;
    try {
      const o = new URL(origin);
      ok = o.origin === new URL(c.req.url).origin || o.protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) {
      return rpcError(null, -32600, "Invalid Origin", 403);
    }
  }

  let body: {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
  try {
    body = await c.req.json();
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }

  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body.id, -32600, "Invalid Request", 400);
  }

  const { id, method, params = {} } = body;
  const isNotification = id === undefined;

  // The header is the routable mirror of the body field; the body is
  // authoritative. A mismatch means an intermediary rewrote one of them.
  const headerVersion = c.req.header("MCP-Protocol-Version");
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const bodyVersion = typeof meta[META_VERSION] === "string" ? (meta[META_VERSION] as string) : undefined;

  if (headerVersion && bodyVersion && headerVersion !== bodyVersion) {
    return rpcError(id, -32600, "HeaderMismatch", 400, {
      header: headerVersion,
      body: bodyVersion,
    });
  }

  const version = headerVersion ?? bodyVersion ?? ASSUMED_LEGACY_PROTOCOL;
  if (!SUPPORTED_PROTOCOLS.includes(version)) {
    return rpcError(id, -32600, "UnsupportedProtocolVersionError", 400, {
      supported: SUPPORTED_PROTOCOLS,
      requested: version,
    });
  }

  // Notifications get no response body at all.
  if (isNotification) {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    /**
     * Retained for clients on initialize-based revisions. Servers on the
     * current spec have no handshake, but answering keeps older clients
     * working instead of failing at connect time.
     */
    case "initialize":
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(version) ? version : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "agentic-endpoints",
          title: "Agentic Endpoints",
          version: "1.0.0",
        },
        instructions:
          "Pay-per-call utilities for autonomous agents, settled in USDC on Base via x402. tools/list is free. Every tool that does work is paid; calling one without payment returns the price and payment address.",
      });

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        resultType: "complete",
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: `${t.description} Costs ${t.price} in USDC on Base, paid via the x402 protocol.`,
          inputSchema: t.inputSchema,
        })),
        // The catalogue is identical for every caller and changes only on
        // deploy, so it is safe for clients to cache and share.
        ttlMs: 300_000,
        cacheScope: "public",
      });

    case "tools/call": {
      const name = params.name as string | undefined;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return rpcError(id, -32602, `Unknown tool: ${name}`, 400);
      }

      const args = (params.arguments ?? {}) as Record<string, unknown>;

      /**
       * Re-enter the pipeline so the call passes the payment middleware and
       * the body cap exactly as a direct HTTP caller would. Reimplementing
       * the gate here would be a second code path to keep in sync, and the
       * first one to drift.
       */
      const target = new URL(c.req.url);
      target.pathname = tool.path;
      target.search = "";

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const payment = c.req.header("X-PAYMENT");
      if (payment) headers["X-PAYMENT"] = payment;

      const upstream = await c.var.dispatch(
        new Request(target.toString(), {
          method: "POST",
          headers,
          body: JSON.stringify(args),
        }),
      );

      const text = await upstream.text();

      if (upstream.status === 402) {
        const challenge = decodeChallenge(upstream.headers.get("payment-required"));
        const accept = challenge?.accepts?.[0];

        return rpcResult(id, {
          resultType: "complete",
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "payment_required",
                  message: `${tool.name} costs ${tool.price}. Pay with the x402 protocol and retry, or call ${target} directly with an X-PAYMENT header.`,
                  price: tool.price,
                  resource: target.toString(),
                  x402: accept
                    ? {
                        scheme: accept.scheme,
                        network: accept.network,
                        asset: accept.asset,
                        payTo: accept.payTo,
                        amount: accept.amount,
                      }
                    : undefined,
                  docs: new URL("/", c.req.url).toString(),
                },
                null,
                2,
              ),
            },
          ],
        });
      }

      return rpcResult(id, {
        resultType: "complete",
        isError: !upstream.ok,
        content: [{ type: "text", text }],
      });
    }

    default:
      // The spec pins unknown methods to 404 so they are distinguishable
      // from a host that does not serve MCP at all.
      return rpcError(id, -32601, `Method not found: ${method}`, 404);
  }
});

interface Challenge {
  accepts?: Array<{
    scheme?: string;
    network?: string;
    asset?: string;
    payTo?: string;
    amount?: string;
  }>;
}

function decodeChallenge(header: string | null): Challenge | null {
  if (!header) return null;
  try {
    return JSON.parse(atob(header)) as Challenge;
  } catch {
    return null;
  }
}

export default app;
export { TOOLS };
