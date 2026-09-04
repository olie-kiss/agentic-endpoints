import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddlewareFromHTTPServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type RoutesConfig,
} from "@x402/core/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";

import type { Env } from "./types";
import onceKeyHandler from "./handlers/once-key";
import webScraperHandler from "./handlers/web-scraper";
import pdfParserHandler from "./handlers/pdf-parser";
import tokenCompressorHandler from "./handlers/token-compressor";
import mcpHandler, { type Dispatcher } from "./handlers/mcp";
import vaultHandler from "./handlers/vault";
import { landingPage } from "./pages/landing";

// Re-export the Durable Object classes so wrangler can find them
export { OnceKey } from "./durable-objects/once-key";
export { Vault } from "./durable-objects/vault";

const app = new Hono<{ Bindings: Env; Variables: { dispatch: Dispatcher } }>();

// ── Global middleware ─────────────────────────────────────────────
app.use("*", cors());

/**
 * Reject oversized request bodies before anything tries to buffer them.
 * Every handler here reads the full body into memory, so an unbounded
 * payload is a cheap way to burn our CPU and memory limits.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB


// Vault writes additionally consume durable storage, so they cost more
// than CPU time and get their own tighter budget.
app.use("/vault/store", async (c, next) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.WRITE_RATE_LIMITER.limit({ key: ip });
  if (!success) {
    return c.json(
      {
        error: "Rate limit exceeded",
        detail: "Too many vault writes. Retry shortly.",
      },
      429,
      { "Retry-After": "60" },
    );
  }
  return next();
});

// ── Health / discovery ────────────────────────────────────────────
app.get("/", (c) => {
  const accept = c.req.header("Accept") ?? "";

  // Serve JSON for machines (explicit JSON accept or no-accept curl-style)
  if (
    accept.includes("application/json") &&
    !accept.includes("text/html")
  ) {
    return c.json({
      name: "agentic-endpoints",
      version: "1.0.0",
      protocol: "x402",
      endpoints: [
        {
          path: "/once-key",
          method: "POST",
          price: "$0.001",
          description:
            "Atomic idempotency witness — claim a key exactly once",
        },
        {
          path: "/scrape",
          method: "POST",
          price: "$0.005",
          description: "Pay-per-query web scraping and text extraction",
        },
        {
          path: "/pdf-parse",
          method: "POST",
          price: "$0.01",
          description: "PDF text extraction from URL",
        },
        {
          path: "/compress",
          method: "POST",
          price: "$0.005",
          description: "Token compression / context reduction for LLMs",
        },
        {
          path: "/vault/store",
          method: "POST",
          price: "$0.02",
          description:
            "Store an encrypted item (client-side encryption). The first write to a namespace returns a one-time namespace_token required for all later operations.",
        },
        {
          path: "/vault/retrieve",
          method: "POST",
          price: "$0.02",
          description: "Retrieve an encrypted item (requires namespace_token)",
        },
        {
          path: "/vault/delete",
          method: "POST",
          price: "$0.005",
          description: "Delete an encrypted item (requires namespace_token)",
        },
        {
          path: "/vault/exists",
          method: "POST",
          price: "$0.001",
          description:
            "Check if an encrypted item exists (requires namespace_token)",
        },
        {
          path: "/mcp",
          method: "POST",
          price: "free to list, per-tool price to call",
          description:
            "Remote MCP server (Streamable HTTP). tools/list is free; each tool re-enters the paid route above and returns its x402 payment demand until paid.",
        },
        {
          path: "/",
          method: "GET",
          price: "free",
          description: "Service discovery (this document)",
        },
        {
          path: "/health",
          method: "GET",
          price: "free",
          description: "Health check",
        },
      ],
    });
  }

  // Serve HTML landing page for browsers
  return c.html(landingPage());
});

// ── Health check (free) ───────────────────────────────────────────
app.get("/health", (c) => c.json({ status: "ok" }));

/**
 * One stable error shape for every failure, including malformed JSON and
 * unexpected exceptions. Callers are autonomous agents: without this, a bad
 * body produced a Hono HTML/text error while handlers produced JSON, so
 * clients had no single contract to parse.
 */
app.onError((err, c) => {
  if (err instanceof SyntaxError) {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  console.error("unhandled_error", {
    path: c.req.path,
    method: c.req.method,
    message: err.message,
  });

  return c.json({ error: "Internal error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found", path: c.req.path }, 404));

// ── Route handlers ────────────────────────────────────────────────
app.route("/once-key", onceKeyHandler);
app.route("/scrape", webScraperHandler);
app.route("/pdf-parse", pdfParserHandler);
app.route("/compress", tokenCompressorHandler);
app.route("/vault", vaultHandler);

// Free: tool discovery must be reachable or no MCP client can find us. The
// tools themselves re-enter through the paid HTTP routes, dispatched in-process
// rather than fetched over the public hostname: a loopback subrequest would
// cost an extra round trip, be unreachable from tests, and re-run the limiter.
app.use("/mcp", async (c, next) => {
  c.set("dispatch", (req: Request) => {
    req.headers.set(INTERNAL_HEADER, "1");
    // Hono models ExecutionContext structurally and lags the workers-types
    // definition; it is the same object at runtime.
    return handleRequest(req, c.env, c.executionCtx as unknown as ExecutionContext);
  });
  await next();
});
app.route("/mcp", mcpHandler);

// ── Export with x402 payment layer ────────────────────────────────

/**
 * Built lazily on the first request and reused for the isolate's lifetime.
 * The x402 middleware performs a facilitator handshake at construction time,
 * so this must not be rebuilt per request.
 */
let gatedApp: Hono<{ Bindings: Env }> | null = null;

/**
 * Marks a request that this Worker generated for itself. The MCP handler
 * re-enters the pipeline to reach the paid routes; without this the caller
 * would be metered twice for a single tool call.
 */
const INTERNAL_HEADER = "X-Internal-Dispatch";

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  {
    const BASE = "eip155:8453"; // Base mainnet

    // x402 route pricing config — maps route patterns to payment requirements,
    // plus Bazaar discovery metadata so agents can find and call these routes
    // automatically via the x402 Bazaar catalog.
    const routes: RoutesConfig = {
      "/once-key": {
        accepts: {
          scheme: "exact",
          network: BASE,
          payTo: env.X402_PAY_TO,
          price: "$0.001",
        },
        description: "Atomic idempotency witness",
        extensions: declareDiscoveryExtension({
          bodyType: "json",
          inputSchema: {
            type: "object",
            properties: {
              namespace: {
                type: "string",
                description: "Isolation scope for the claimed key",
              },
              action_key: {
                type: "string",
                description: "Unique key to claim exactly once",
              },
              payload_sha256: {
                type: "string",
                description: "Optional hash of the payload for conflict detection",
              },
              ttl: {
                type: "number",
                description: "Claim lifetime in seconds (default 86400)",
              },
            },
            required: ["namespace", "action_key"],
          },
          output: {
            example: {
              status: "claimed",
              namespace: "my-app",
              action_key: "order-12345",
              claimed_at: "2026-01-01T00:00:00.000Z",
              expires_at: "2026-01-02T00:00:00.000Z",
              receipt: "abc123...",
            },
          },
        }),
      },
      "/scrape": {
        accepts: {
          scheme: "exact",
          network: BASE,
          payTo: env.X402_PAY_TO,
          price: "$0.005",
        },
        description: "Web scraping and text extraction",
        extensions: declareDiscoveryExtension({
          bodyType: "json",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "URL to scrape" },
              selector: {
                type: "string",
                description: "Optional CSS selector to extract",
              },
              format: {
                type: "string",
                enum: ["text", "markdown", "html"],
                description: "Output format (default text)",
              },
            },
            required: ["url"],
          },
          output: {
            example: {
              url: "https://example.com",
              title: "Example Domain",
              content: "This domain is for use in examples...",
              format: "text",
              extracted_at: "2026-01-01T00:00:00.000Z",
            },
          },
        }),
      },
      "/pdf-parse": {
        accepts: {
          scheme: "exact",
          network: BASE,
          payTo: env.X402_PAY_TO,
          price: "$0.01",
        },
        description: "PDF text extraction",
        extensions: declareDiscoveryExtension({
          bodyType: "json",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "URL of the PDF" },
              pages: {
                type: "array",
                items: { type: "number" },
                description: "Specific pages to extract (default: all)",
              },
            },
            required: ["url"],
          },
          output: {
            example: {
              url: "https://example.com/doc.pdf",
              page_count: 3,
              pages: [{ page: 1, text: "..." }],
              extracted_at: "2026-01-01T00:00:00.000Z",
            },
          },
        }),
      },
      "/compress": {
        accepts: {
          scheme: "exact",
          network: BASE,
          payTo: env.X402_PAY_TO,
          price: "$0.005",
        },
        description: "Token compression for LLMs",
        extensions: declareDiscoveryExtension({
          bodyType: "json",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string", description: "Text to compress" },
              target_tokens: {
                type: "number",
                description: "Target token count",
              },
              strategy: {
                type: "string",
                enum: ["extractive", "truncate"],
                description: "Compression strategy (default extractive)",
              },
            },
            required: ["text"],
          },
          output: {
            example: {
              original_length: 5000,
              compressed_length: 1200,
              ratio: 0.24,
              text: "...",
              strategy: "extractive",
            },
          },
        }),
      },
      "/vault/store": {
        accepts: {
          scheme: "exact",
          network: BASE,
          payTo: env.X402_PAY_TO,
          price: "$0.02",
        },
        description:
          "Store an encrypted item in the vault. The first store claims the namespace and returns a one-time namespace_token.",
        extensions: declareDiscoveryExtension({
          bodyType: "json",
          inputSchema: {
            type: "object",
            properties: {
              namespace: { type: "string", description: "Vault isolation scope" },
              key: { type: "string", description: "Item key" },
              ciphertext: {
                type: "string",
                description:
                  "Client-side encrypted payload. This service never sees plaintext.",
              },
              alg: {
                type: "string",
                description: "Encryption algorithm label (default aes-256-gcm)",
              },
              ttl: {
                type: "number",
                description: "Optional lifetime in seconds",
              },
              namespace_token: {
                type: "string",
                description:
                  "Required once the namespace has been claimed by a first store",
              },
            },
            required: ["namespace", "key", "ciphertext"],
          },
          output: {
            example: {
              status: "stored",
              namespace: "my-app",
              key: "secret-1",
              alg: "aes-256-gcm",
              size_bytes: 128,
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              expires_at: null,
              namespace_token: "shown-once-on-first-store",
              receipt: "abc123...",
            },
          },
        }),
      },

      "/vault/delete": {
        accepts: {
          scheme: "exact",
          network: BASE,
          payTo: env.X402_PAY_TO,
          price: "$0.005",
        },
        description:
          "Delete an item from the vault (requires the namespace_token)",
        extensions: declareDiscoveryExtension({
          bodyType: "json",
          inputSchema: {
            type: "object",
            properties: {
              namespace: { type: "string", description: "Vault isolation scope" },
              key: { type: "string", description: "Item key to delete" },
              namespace_token: {
                type: "string",
                description: "One-time token issued when the namespace was claimed",
              },
            },
            required: ["namespace", "key", "namespace_token"],
          },
          output: {
            example: { status: "deleted", namespace: "my-app", key: "secret-1" },
          },
        }),
      },

      "/vault/exists": {
        accepts: {
          scheme: "exact",
          network: BASE,
          payTo: env.X402_PAY_TO,
          price: "$0.001",
        },
        description:
          "Check whether a key exists in the vault without returning its ciphertext (requires the namespace_token)",
        extensions: declareDiscoveryExtension({
          bodyType: "json",
          inputSchema: {
            type: "object",
            properties: {
              namespace: { type: "string", description: "Vault isolation scope" },
              key: { type: "string", description: "Item key to test" },
              namespace_token: {
                type: "string",
                description: "One-time token issued when the namespace was claimed",
              },
            },
            required: ["namespace", "key", "namespace_token"],
          },
          output: {
            example: { exists: true, namespace: "my-app", key: "secret-1" },
          },
        }),
      },

      "/vault/retrieve": {
        accepts: {
          scheme: "exact",
          network: BASE,
          payTo: env.X402_PAY_TO,
          price: "$0.02",
        },
        description:
          "Retrieve an encrypted item from the vault (requires the namespace_token issued at claim time)",
        extensions: declareDiscoveryExtension({
          bodyType: "json",
          inputSchema: {
            type: "object",
            properties: {
              namespace: {
                type: "string",
                description: "Vault isolation scope",
              },
              key: { type: "string", description: "Item key to retrieve" },
              namespace_token: {
                type: "string",
                description:
                  "One-time token issued by the first /vault/store call that claimed this namespace",
              },
            },
            required: ["namespace", "key", "namespace_token"],
          },
          output: {
            example: {
              status: "retrieved",
              namespace: "my-app",
              key: "secret-1",
              ciphertext: "base64-encoded-ciphertext",
              alg: "aes-256-gcm",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              expires_at: null,
              receipt: "abc123...",
            },
          },
        }),
      },
    };

    /**
     * These checks run on every request, before anything that could depend
     * on the payment facilitator. An oversized body, a rate-limited caller
     * and an unknown path all have correct answers that do not require us to
     * price anything, so an upstream outage must not turn them into 503s.
     */
    const declared = request.headers.get("Content-Length");
    if (declared && Number(declared) > MAX_BODY_BYTES) {
      return Response.json(
        {
          error: "Request body too large",
          detail: `Maximum body size is ${MAX_BODY_BYTES} bytes.`,
        },
        { status: 413 },
      );
    }

    /**
     * Metered ahead of the payment middleware, which answers 402 without
     * calling next(): metering behind it counted nothing for exactly the
     * unpaid traffic it was meant to bound. An X-PAYMENT header is
     * unverified attacker-controlled input here and grants no exemption.
     */
    const internal = request.headers.get(INTERNAL_HEADER) === "1";
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = internal
      ? { success: true }
      : await env.FREE_RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return Response.json(
        {
          error: "Rate limit exceeded",
          detail: "Too many requests. Retry shortly.",
        },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    }

    // Free and unknown paths never touch the x402 stack.
    const path = new URL(request.url).pathname;
    const isPaidPath = Object.keys(routes).some(
      (route) => route.replace(/^[A-Z]+\s+/, "") === path,
    );
    if (!isPaidPath) {
      return app.fetch(request, env, ctx);
    }

    // Public, no-signup facilitator supporting Base mainnet ("exact" scheme).
    //
    // PayAI, not xpay.sh: xpay's /supported advertises `"extensions": []`, so
    // it silently discards the Bazaar metadata this server attaches to every
    // 402. Registering bazaarResourceServerExtension against xpay produced no
    // discovery at all. PayAI advertises the `bazaar` extension and operates
    // its own catalog at /discovery/resources, indexing on /verify as well as
    // /settle — so a route can be listed before it has ever been paid.
    //
    // Free for the first 1,000 settlements, then $0.001 each. This is a
    // separate catalog from Coinbase's CDP Bazaar, which still requires a
    // payment settled through the CDP Facilitator and has no submission API.
    //
    // Built once per isolate rather than per request: constructing the
    // middleware eagerly calls facilitator.getSupported(), so rebuilding it
    // on every request fired one outbound subrequest to the facilitator for
    // every inbound request, including free ones and 404s.
    if (!gatedApp) {
      const facilitatorClient = new HTTPFacilitatorClient({
        url: env.FACILITATOR_URL ?? "https://facilitator.payai.network",
      });

      // Pre-flight the facilitator. The x402 middleware loads supported
      // payment kinds on construction and, when that fails, answers every
      // request with a bare 500 that an agent cannot distinguish from a bug
      // in its own request. Worse, memoizing that instance would pin the
      // failure for the lifetime of the isolate. Checking here lets us
      // return an honest, retryable 503 and rebuild on the next request.
      try {
        await facilitatorClient.getSupported();
      } catch (err) {
        console.error("Facilitator unreachable:", err);

        // Only paid paths reach here, so there is nothing serviceable to
        // fall back to; free routes were already answered above.
        return Response.json(
          {
            error: "Payment facilitator unavailable",
            detail:
              "Cannot verify payments right now. Retry shortly. Free endpoints (/ and /health) are unaffected.",
          },
          { status: 503, headers: { "Retry-After": "30" } },
        );
      }
      const resourceServer = new x402ResourceServer(facilitatorClient)
        .register(BASE, new ExactEvmScheme())
        .registerExtension(bazaarResourceServerExtension);

      const httpServer = new x402HTTPResourceServer(resourceServer, routes);
      const paymentMiddleware = paymentMiddlewareFromHTTPServer(httpServer);

      const wrapper = new Hono<{ Bindings: Env }>();

      wrapper.use("*", paymentMiddleware);
      wrapper.route("/", app);
      gatedApp = wrapper;
    }

    return gatedApp.fetch(request, env, ctx);
  }
}

export default { fetch: handleRequest };
