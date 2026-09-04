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
import creditsHandler, { creditsStub } from "./handlers/credits";
import { hashToken, timingSafeEqual } from "./lib/utils";
import {
  buildLlmsTxt,
  buildOpenApi,
  buildRobotsTxt,
  buildSitemap,
} from "./lib/discovery";
import type { Outcome, StatsSummary, Slo } from "./durable-objects/stats";
import {
  alert,
  alertFailure,
  readState,
  recordFailure,
  scanForPayments,
  shouldAlertOnFailure,
} from "./lib/revenue";
import vaultHandler from "./handlers/vault";
import { landingPage } from "./pages/landing";

// Re-export the Durable Object classes so wrangler can find them
export { OnceKey } from "./durable-objects/once-key";
export { Vault } from "./durable-objects/vault";
export { Credits } from "./durable-objects/credits";
export { Stats } from "./durable-objects/stats";

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
    // Generated from the payment config rather than hand-written, so the
    // advertised price is by construction the price actually charged. The
    // previous hand-maintained copy drifted and told agents three paid vault
    // routes were free.
    const paid = Object.entries(buildRoutes(c.env)).map(([route, config]) => {
      const [method, path] = /^[A-Z]+\s/.test(route)
        ? route.split(/\s+/)
        : ["POST", route];

      const cfg = config as {
        accepts?: { price?: string };
        description?: string;
      };

      return {
        path,
        method,
        price: cfg.accepts?.price ?? "unknown",
        description: cfg.description ?? "",
      };
    });

    return c.json({
      name: "agentic-endpoints",
      version: "1.0.0",
      protocol: "x402",
      payment: {
        per_call: "Send X-PAYMENT (x402, USDC on Base) with each request.",
        prepaid:
          "Or buy credits once at POST /credits/buy and send X-Credit-Token instead — no per-call signature.",
      },
      endpoints: [
        ...paid,
        {
          path: "/credits/balance",
          method: "POST",
          price: "free",
          description: "Check a credit balance (requires X-Credit-Token)",
        },
        {
          path: "/mcp",
          method: "POST",
          price: "free to list, per-tool price to call",
          description:
            "Remote MCP server (Streamable HTTP). tools/list is free; each tool re-enters the paid route above.",
        },
        {
          path: "/revenue",
          method: "GET",
          price: "free",
          description:
            "On-chain USDC received by this service, read from Base. Proof it transacts.",
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
  return c.html(landingPage(buildRoutes(c.env)));
});

// ── Health check (free) ───────────────────────────────────────────
app.get("/health", (c) => c.json({ status: "ok" }));

/**
 * Machine-readable descriptions of the service.
 *
 * The intended customer is a program that has never been told this service
 * exists, and it will not read the landing page. All three documents are
 * generated from the same route table that decides what is charged, so a
 * price can never be advertised here that the payment gate does not honour.
 */
app.get("/openapi.json", (c) =>
  c.json(buildOpenApi(buildRoutes(c.env), new URL(c.req.url).origin)),
);

app.get("/llms.txt", (c) =>
  c.text(buildLlmsTxt(buildRoutes(c.env), new URL(c.req.url).origin)),
);

/**
 * Replaces Cloudflare's default, which is boilerplate with no directives at
 * all. Most sites publish this to keep crawlers out; here being read by a
 * model is the entire point.
 */
app.get("/robots.txt", (c) =>
  c.text(buildRobotsTxt(new URL(c.req.url).origin)),
);

app.get("/sitemap.xml", (c) =>
  c.body(buildSitemap(new URL(c.req.url).origin), 200, {
    "Content-Type": "application/xml; charset=utf-8",
  }),
);

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
app.route("/credits", creditsHandler);

/**
 * Free: revenue is read from the chain, so publishing it costs nothing and
 * gives both the operator and a prospective caller evidence the service is
 * actually transacting.
 */
/**
 * Demand telemetry, published rather than kept private.
 *
 * An agent deciding whether to depend on a paid service has no way to tell a
 * working product from an abandoned one, so usage counts are worth more in
 * the open than hidden. Aggregates only: no addresses, no tokens, no bodies.
 */
app.get("/stats", async (c) => {
  return c.json(await statsStub(c.env).summary());
});

/**
 * Reliability evidence for a machine deciding whether to depend on this.
 *
 * An agent choosing between paid APIs cannot tell a maintained service from
 * an abandoned one, and no other x402 endpoint publishes anything to help it.
 * Everything here is derived from recorded behaviour, and reports null rather
 * than a flattering default when there is not yet enough data.
 */
app.get("/status", async (c) => {
  return c.json(await statsStub(c.env).slo());
});

app.get("/revenue", async (c) => {
  const state = await readState(c.env);

  return c.json({
    address: c.env.X402_PAY_TO,
    asset: "USDC",
    network: "base-mainnet",
    lifetime_usdc: state.totalUsdc,
    payment_count: state.paymentCount,
    first_payment_at: state.firstPaymentAt,
    last_payment_at: state.lastPaymentAt,
    last_scanned_block: state.lastBlock,
    recent: state.recent,

    // Published so that "no sales" and "the watcher is broken" are never
    // reported as the same thing.
    monitor: {
      healthy: state.consecutiveFailures === 0 && state.lastSuccessAt !== null,
      last_run_at: state.lastRunAt,
      last_success_at: state.lastSuccessAt,
      consecutive_failures: state.consecutiveFailures,
      last_error: state.lastError,
    },
    explorer: `https://basescan.org/address/${c.env.X402_PAY_TO}`,
  });
});

// Free: tool discovery must be reachable or no MCP client can find us. The
// tools themselves re-enter through the paid HTTP routes, dispatched in-process
// rather than fetched over the public hostname: a loopback subrequest would
// cost an extra round trip, be unreachable from tests, and re-run the limiter.
app.use("/mcp", async (c, next) => {
  c.set("dispatch", (req: Request) => {
    req.headers.set(INTERNAL_HEADER, internalDispatchToken());
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
 * The single source of truth for what is paid and how much.
 *
 * Everything that needs to know about pricing derives from this: the
 * payment gate, the credit debit, the public catalogue and the discovery
 * metadata. Keeping a second hand-maintained list was not a hypothetical
 * risk -- it shipped three vault routes for free, and later advertised them
 * as free after they had been priced.
 */
const BASE_MAINNET = "eip155:8453" as const;
const BASE_SEPOLIA = "eip155:84532" as const;

/**
 * Which chain the payment gate demands and the facilitator settles on.
 *
 * Configurable for exactly one reason: settlement is the only part of this
 * pipeline that has never been proven, and proving it on mainnet costs real
 * money. Base Sepolia costs nothing and the Circle faucet needs no account,
 * which matters here. Mainnet stays the default, so an unset or misspelled
 * var can only fail towards charging real USDC, never towards accepting
 * worthless testnet tokens for real work.
 */
export function networkFor(env: Env): typeof BASE_MAINNET | typeof BASE_SEPOLIA {
  return env.X402_NETWORK === BASE_SEPOLIA ? BASE_SEPOLIA : BASE_MAINNET;
}

function buildRoutes(env: Env): RoutesConfig {
  const BASE = networkFor(env);
  return {
    "/once-key": {
      accepts: {
        scheme: "exact",
        network: BASE,
        payTo: env.X402_PAY_TO,
        price: "$0.001",
      },
      description:
        "Atomic idempotency witness — claim an action exactly once, record " +
        "its result, and replay that result to every later caller",
      extensions: declareDiscoveryExtension({
        bodyType: "json",
        input: {
          namespace: "invoices",
          action_key: "charge-order-1042",
          ttl: 86400,
          lease_ttl: 300,
        },
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
            namespace_token: {
              type: "string",
              description:
                "Owner token issued on the first claim in a namespace; " +
                "required on every later request",
            },
            lease_ttl: {
              type: "number",
              description:
                "Seconds you have to call /once-key/complete before the " +
                "claim is treated as abandoned and another caller may take " +
                "it over. Omit to hold the claim for its full ttl.",
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
            lease_expires_at: "2026-01-01T00:05:00.000Z",
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
        input: { url: "https://example.com", format: "text" },
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
        input: { url: "https://example.com/report.pdf" },
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
        input: {
          text: "Long input text to be compressed before it is sent to a model.",
          target_tokens: 100,
          strategy: "extractive",
        },
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
        input: {
          namespace: "agent-secrets",
          key: "openai-api-key",
          ciphertext: "base64-of-your-client-side-encrypted-bytes",
          alg: "AES-GCM",
          ttl: 604800,
        },
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
        input: {
          namespace: "agent-secrets",
          key: "openai-api-key",
          namespace_token: "the token returned by your first store",
        },
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

    /**
     * Prepaid packs. Priced above the per-call routes on purpose: this is
     * the only place a buyer commits real money in one go, and the bonus is
     * what makes committing rational for them.
     */
    "/credits/buy": {
      accepts: {
        scheme: "exact",
        network: BASE,
        payTo: env.X402_PAY_TO,
        price: "$5.00",
      },
      description:
        "Buy $6.00 of prepaid credit for $5.00 (20% bonus). Returns a credit token; send it as X-Credit-Token on any paid endpoint to be debited at list price with no per-call payment signature.",
      extensions: declareDiscoveryExtension({
        bodyType: "json",
        input: {},
        inputSchema: { type: "object", properties: {} },
        output: {
          example: {
            credit_token: "ae_...",
            balance_usd: "6.000000",
            paid: "$5.00",
            bonus: "20%",
          },
        },
      }),
    },
    "/credits/buy-25": {
      accepts: {
        scheme: "exact",
        network: BASE,
        payTo: env.X402_PAY_TO,
        price: "$25.00",
      },
      description:
        "Buy $32.50 of prepaid credit for $25.00 (30% bonus). Returns a credit token; send it as X-Credit-Token on any paid endpoint to be debited at list price with no per-call payment signature.",
      extensions: declareDiscoveryExtension({
        bodyType: "json",
        input: {},
        inputSchema: { type: "object", properties: {} },
        output: {
          example: {
            credit_token: "ae_...",
            balance_usd: "32.500000",
            paid: "$25.00",
            bonus: "30%",
          },
        },
      }),
    },
    "/vault/list": {
      accepts: {
        scheme: "exact",
        network: BASE,
        payTo: env.X402_PAY_TO,
        price: "$0.001",
      },
      description:
        "List the keys held in a vault namespace with their metadata, without returning any ciphertext (requires the namespace_token)",
      extensions: declareDiscoveryExtension({
        bodyType: "json",
        input: {
          namespace: "agent-secrets",
          namespace_token: "the token returned by your first store",
        },
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string", description: "Vault isolation scope" },
            namespace_token: {
              type: "string",
              description: "One-time token issued when the namespace was claimed",
            },
          },
          required: ["namespace", "namespace_token"],
        },
        output: {
          example: {
            status: "listed",
            count: 1,
            items: [
              {
                key: "openai-api-key",
                alg: "aes-256-gcm",
                size_bytes: 184,
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
                expires_at: null,
              },
            ],
          },
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
        input: {
          namespace: "agent-secrets",
          key: "openai-api-key",
          namespace_token: "the token returned by your first store",
        },
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
        input: {
          namespace: "agent-secrets",
          key: "openai-api-key",
          namespace_token: "the token returned by your first store",
        },
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
}

/**
 * Marks a request that this Worker generated for itself. The MCP handler
 * re-enters the pipeline to reach the paid routes; without this the caller
 * would be metered twice for a single tool call.
 */
const INTERNAL_HEADER = "X-Internal-Dispatch";

/**
 * A per-isolate value the caller cannot guess.
 *
 * This was a constant "1", so anyone could send the header themselves and skip
 * the rate limiter and every usage counter — the only controls standing in
 * front of the free endpoints. The marker has to be unforgeable because it is
 * an exemption, not a hint.
 *
 * Generated lazily: Workers forbids random values in global scope.
 */
let internalToken: string | undefined;

function internalDispatchToken(): string {
  if (internalToken === undefined) internalToken = crypto.randomUUID();
  return internalToken;
}

function isInternalDispatch(request: Request): boolean {
  const marker = request.headers.get(INTERNAL_HEADER);
  return marker !== null && timingSafeEqual(marker, internalDispatchToken());
}

/**
 * The payment gate and the router must agree on what path was requested.
 *
 * `new URL(request.url).pathname` keeps percent-escapes; Hono's router decodes
 * them before matching. That disagreement made the paid-path test fail open:
 * `/compr%65ss` did not match any route key, returned early as a "free" path,
 * and was then dispatched by Hono to the real `/compress` handler with the
 * x402 middleware, the credit debit and the facilitator pre-flight all skipped.
 *
 * Percent-encoding carries no meaning for these static ASCII routes, so an
 * encoded path is never a legitimate client — it is someone probing for
 * exactly this gap. Rejecting is safer than decoding, because decoding can
 * still disagree with the router (`/compress%2Ffoo` decodes to a path Hono
 * routes elsewhere) and any disagreement is another instance of this bug.
 */
function canonicalPath(request: Request): string | null {
  const raw = new URL(request.url).pathname;
  if (!raw.includes("%")) return raw;
  return null;
}

/**
 * Rate limiting in two tiers: anonymous, then paying.
 *
 * A single anonymous budget was billing customers for a throttle aimed at
 * abusers — someone who prepaid $25 was cut off at the same 60 requests a
 * minute as unauthenticated traffic, which is the opposite of what they paid
 * for.
 *
 * The higher tier is only reachable with a credit token the ledger actually
 * recognises. Checking the header alone would have made the limit optional
 * for everyone, since the header is attacker-controlled and free to invent.
 *
 * The paid limiter is still keyed by IP rather than by token. Keyed by token,
 * a forged random token would mint a fresh budget on every request and the
 * balance lookup behind it would become an amplification vector — unbounded
 * storage reads for the cost of a header. Keyed by IP, the number of lookups
 * an address can force is capped by the paid limit itself.
 */
export async function withinRateLimit(
  request: Request,
  env: Env,
  ip: string,
): Promise<boolean> {
  const { success } = await env.FREE_RATE_LIMITER.limit({ key: ip });
  if (success) return true;

  const token = request.headers.get("X-Credit-Token");
  if (!token) return false;

  const { success: paidBudget } = await env.PAID_RATE_LIMITER.limit({ key: ip });
  if (!paidBudget) return false;

  try {
    const tokenHash = await hashToken(token);
    const ledger = await creditsStub(env, tokenHash).balance(tokenHash);

    // An exhausted balance is not a customer any more. Their next request is
    // going to be refused for lack of funds regardless, so it does not earn
    // the elevated allowance.
    return ledger !== null && ledger.balance_micros > 0;
  } catch (err) {
    // Fail closed: an unreadable ledger must not hand out the higher tier.
    console.error("Paid-tier rate limit check failed:", err);
    return false;
  }
}

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  {
    // x402 route pricing config — maps route patterns to payment requirements,
    // plus Bazaar discovery metadata so agents can find and call these routes
    // automatically via the x402 Bazaar catalog.
    const routes = buildRoutes(env);

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
    const internal = isInternalDispatch(request);
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const success = internal ? true : await withinRateLimit(request, env, ip);
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
    const path = canonicalPath(request);
    if (path === null) {
      return Response.json(
        {
          error: "Not found",
          detail: "Percent-encoded paths are not accepted. Use the literal path.",
        },
        { status: 404 },
      );
    }
    const isPaidPath = Object.keys(routes).some(
      (route) => route.replace(/^[A-Z]+\s+/, "") === path,
    );
    if (!isPaidPath) {
      return app.fetch(request, env, ctx);
    }

    /**
     * Prepaid credits, checked before the x402 gate.
     *
     * Requiring a signed payment on every request caps revenue at whatever a
     * buyer will tolerate signing: $1,000 at $0.005 a call is 200,000
     * signatures. A credit token lets the same work be sold once, in an
     * amount worth the transaction.
     */
    const creditToken = request.headers.get("X-Credit-Token");
    if (creditToken && path !== "/credits/buy" && path !== "/credits/buy-25") {
      const priced = (routes as Record<string, unknown>)[path] ??
        (routes as Record<string, unknown>)[`POST ${path}`];
      const priceMicros = parsePriceMicros(
        (priced as { accepts?: { price?: string } })?.accepts?.price,
      );

      if (priceMicros !== null) {
        return spendCredits(request, env, ctx, creditToken, priceMicros);
      }
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
        .register(networkFor(env), new ExactEvmScheme())
        .registerExtension(bazaarResourceServerExtension);

      const httpServer = new x402HTTPResourceServer(resourceServer, routes);
      const paymentMiddleware = paymentMiddlewareFromHTTPServer(httpServer);

      const wrapper = new Hono<{ Bindings: Env }>();

      wrapper.use("*", paymentMiddleware);
      wrapper.route("/", app);
      gatedApp = wrapper;
    }

    const response = await gatedApp.fetch(request, env, ctx);

    /**
     * Advertise the prepaid option on the payment challenge — the one response
     * every would-be buyer is guaranteed to see.
     *
     * Added as a header rather than injected into the challenge body: that
     * body is what facilitators and strict x402 parsers consume, and it is
     * what got these routes indexed. A non-standard field there could cost the
     * only distribution channel currently working, which is not a trade worth
     * making for a marketing line.
     */
    if (response.status === 402 && !path.startsWith("/credits/")) {
      const headers = new Headers(response.headers);
      headers.set(
        "X-Credits-Available",
        "Prepay to skip per-call signatures: $5 buys $6.00, $25 buys $32.50. POST /credits/buy",
      );

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return response;
  }
}

/**
 * Converts an x402 price string to integer micro-dollars.
 *
 * The route config is the single source of truth for pricing, so credits are
 * debited at exactly the advertised price and the two can never disagree.
 * Parsed digit-wise rather than via parseFloat: $0.001 has no exact binary
 * representation, and a ledger that drifts by rounding is not a ledger.
 */
function parsePriceMicros(price: string | undefined): number | null {
  if (!price) return null;

  const match = /^\$(\d+)(?:\.(\d{1,6}))?$/.exec(price.trim());
  if (!match) return null;

  const whole = Number(match[1]);
  const frac = Number((match[2] ?? "").padEnd(6, "0"));
  return whole * 1_000_000 + frac;
}

/**
 * Serves a paid route from a prepaid balance instead of an on-chain payment.
 *
 * Debits before the work and refunds if the work fails, so an outage cannot
 * bill a customer for nothing. Charging after success instead would let a
 * caller run unlimited concurrent requests against a balance that has not yet
 * been reduced.
 */
async function spendCredits(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
  priceMicros: number,
): Promise<Response> {
  const tokenHash = await hashToken(token);
  const account = creditsStub(env, tokenHash);
  const result = await account.spend(tokenHash, priceMicros);

  if (!result.ok) {
    if (result.reason === "unknown") {
      return Response.json(
        {
          error: "invalid_credit_token",
          detail:
            "No such credit account. Buy credits at POST /credits/buy, or omit X-Credit-Token to pay per call with x402.",
        },
        { status: 401 },
      );
    }

    return Response.json(
      {
        error: "insufficient_credit",
        detail: "Credit balance too low for this call. Top up at POST /credits/buy.",
        balance_usd: result.ledger?.balance_usd ?? "0.000000",
        required_usd: (priceMicros / 1_000_000).toFixed(6),
        top_up: "https://ai.oliverkiss.com/credits/buy",
      },
      { status: 402 },
    );
  }

  let response: Response;
  try {
    response = await app.fetch(request, env, ctx);
  } catch (err) {
    console.error("Credit-funded request threw, refunding:", err);
    ctx.waitUntil(account.refund(tokenHash, priceMicros));
    throw err;
  }

  // Any status >= 400 means the request was refused rather than served, so
  // the customer keeps their credit.
  //
  // This used to bill 4xx, reasoning that refunding it would make malformed
  // input a free way to probe the service. That protection was never real:
  // an x402 caller already gets every 4xx for nothing, because the middleware
  // cancels settlement above 399. All the rule actually did was charge
  // prepaid customers — the ones who committed money up front — for errors
  // that per-call customers get free. The same request now costs the same
  // whichever way it was paid for, and abusive volume is a rate-limiting
  // problem, which is handled before any of this.
  if (response.status >= 400) {
    ctx.waitUntil(account.refund(tokenHash, priceMicros));
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("X-Credit-Balance", result.ledger.balance_usd);
  headers.set("X-Credit-Charged", (priceMicros / 1_000_000).toFixed(6));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Sweeps the chain for USDC arriving at the receiving address.
 *
 * Errors are logged rather than rethrown: the watermark only advances on a
 * successful scan, so a transient RPC failure is picked up by the next tick
 * with nothing missed.
 */
async function handleScheduled(
  _event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  // Recorded first and unconditionally. A heartbeat written only after a
  // successful revenue scan would turn "the chain RPC is down" into a
  // reported outage of this service.
  ctx.waitUntil(statsStub(env).heartbeat());

  // The testnet deployment shares production's MONITOR namespace, so a scan
  // from there would advance the real revenue watermark past blocks nobody
  // had examined, and any payment in the gap would go unrecorded for good.
  // Its cron is already empty; this is the guard for the day someone
  // redeploys without noticing that triggers are inherited per environment.
  if (env.ENVIRONMENT === "testnet") {
    console.log("Skipping revenue scan: testnet shares production KV.");
    return;
  }

  try {
    const { state, newPayments } = await scanForPayments(env);

    if (newPayments.length > 0) {
      console.log(
        `Revenue: ${newPayments.length} new payment(s), lifetime $${state.totalUsdc}`,
      );
      ctx.waitUntil(alert(env, newPayments, state));
    }
  } catch (err) {
    console.error("Revenue scan failed:", err);

    // Persist the failure. A console line alone dies with the invocation, and
    // a monitor that is silently blind reads exactly like a monitor reporting
    // no sales.
    try {
      const state = await recordFailure(env, err);
      if (shouldAlertOnFailure(state)) {
        ctx.waitUntil(alertFailure(env, state));
      }
    } catch (nested) {
      console.error("Could not record revenue scan failure:", nested);
    }
  }
}

export default { fetch: withStats, scheduled: handleScheduled };

const FREE_PATHS = new Set([
  "/",
  "/health",
  "/mcp",
  "/revenue",
  "/stats",
  "/status",
  "/credits/balance",
  // Counted individually rather than lumped into "other": a hit on one of
  // these is a machine reading the documentation, which is the earliest
  // visible sign that anything has discovered the service at all.
  "/llms.txt",
  "/openapi.json",
  "/robots.txt",
  "/sitemap.xml",
]);

/**
 * Endpoints that exist to answer "is anyone using this". If looking at them
 * counted as usage, they would always say yes.
 */
const OPERATOR_PATHS = new Set(["/stats", "/revenue", "/health"]);

/**
 * Decides how one request should be counted, or that it should not be.
 *
 * Kept pure and separate from the request path so it can be tested against
 * every status and route directly. The recording itself is deliberately
 * asynchronous, and a test that drove this through a real request could only
 * ever assert on that race.
 */
export function classify(
  path: string,
  status: number,
  isPaid: boolean,
): { bucket: string; outcome: Outcome } | null {
  if (OPERATOR_PATHS.has(path)) return null;

  return {
    // Unknown paths collapse into one bucket, so a stranger cannot grow the
    // stats table without bound by requesting random URLs.
    bucket: isPaid || FREE_PATHS.has(path) ? path : "other",
    outcome:
      status === 402
        ? "challenged"
        : // A rejected token or an unclaimed key is the service working, not
          // failing. Folding those into one "error" count makes correct
          // behaviour read as unreliability on the public status page, which
          // is the opposite of what publishing it is for.
          status >= 500
          ? "error"
          : status >= 400
            ? "client_error"
            : isPaid
              ? "paid"
              : "free",
  };
}

function isKnownPaidPath(env: Env, path: string): boolean {
  return Object.keys(buildRoutes(env)).some(
    (route) => route.replace(/^[A-Z]+\s+/, "") === path,
  );
}

export function statsStub(env: Env) {
  // A single named instance: these are service-wide totals, and sharding them
  // would mean merging shards on every read for no benefit at this volume.
  return env.STATS.get(env.STATS.idFromName("global")) as unknown as {
    record(path: string, outcome: Outcome, durationMs?: number): Promise<void>;
    summary(): Promise<StatsSummary>;
    slo(): Promise<Slo>;
    heartbeat(): Promise<void>;
  };
}

/**
 * Counts the request, then answers it.
 *
 * Recording happens after the response is produced and is handed to
 * waitUntil, so measurement can never slow down or break a paying request —
 * telemetry that can take the service down is worse than no telemetry. A
 * failure to count is logged and swallowed for the same reason.
 */
async function withStats(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const started = Date.now();
  const response = await handleRequest(request, env, ctx);

  // Internal MCP dispatch re-enters the pipeline; counting it would double
  // every tool call and invent traffic that never existed.
  if (isInternalDispatch(request)) return response;

  try {
    const path = new URL(request.url).pathname;
    const counted = classify(path, response.status, isKnownPaidPath(env, path));
    if (counted) {
      ctx.waitUntil(
        statsStub(env).record(
          counted.bucket,
          counted.outcome,
          Date.now() - started,
        ),
      );
    }
  } catch (err) {
    console.error("Failed to record request stats:", err);
  }

  return response;
}
