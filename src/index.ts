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
import vaultHandler from "./handlers/vault";
import { landingPage } from "./pages/landing";

// Re-export the Durable Object classes so wrangler can find them
export { OnceKey } from "./durable-objects/once-key";
export { Vault } from "./durable-objects/vault";

const app = new Hono<{ Bindings: Env }>();

// ── Global middleware ─────────────────────────────────────────────
app.use("*", cors());

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
          price: "free",
          description: "Store an encrypted item (client-side encryption)",
        },
        {
          path: "/vault/retrieve",
          method: "POST",
          price: "$0.02",
          description: "Retrieve an encrypted item",
        },
        {
          path: "/vault/delete",
          method: "POST",
          price: "free",
          description: "Delete an encrypted item",
        },
        {
          path: "/vault/exists",
          method: "POST",
          price: "free",
          description: "Check if an encrypted item exists",
        },
      ],
    });
  }

  // Serve HTML landing page for browsers
  return c.html(landingPage());
});

// ── Health check (free) ───────────────────────────────────────────
app.get("/health", (c) => c.json({ status: "ok" }));

// ── Route handlers ────────────────────────────────────────────────
app.route("/once-key", onceKeyHandler);
app.route("/scrape", webScraperHandler);
app.route("/pdf-parse", pdfParserHandler);
app.route("/compress", tokenCompressorHandler);
app.route("/vault", vaultHandler);

// ── Export with x402 payment layer ────────────────────────────────
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
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
      "/vault/retrieve": {
        accepts: {
          scheme: "exact",
          network: BASE,
          payTo: env.X402_PAY_TO,
          price: "$0.02",
        },
        description: "Retrieve an encrypted item from the vault",
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
            },
            required: ["namespace", "key"],
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

    // Public, no-signup facilitator supporting Base mainnet ("exact" scheme).
    // No API key required — a drop-in replacement if you later switch to
    // the CDP Facilitator (which additionally unlocks Bazaar auto-indexing).
    const facilitatorClient = new HTTPFacilitatorClient({
      url: env.FACILITATOR_URL ?? "https://facilitator.xpay.sh",
    });
    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register(BASE, new ExactEvmScheme())
      .registerExtension(bazaarResourceServerExtension);

    const httpServer = new x402HTTPResourceServer(resourceServer, routes);
    const paymentMiddleware = paymentMiddlewareFromHTTPServer(httpServer);

    // Create a wrapper app that applies payment middleware then delegates
    const gatedApp = new Hono<{ Bindings: Env }>();
    gatedApp.use("*", paymentMiddleware);
    gatedApp.route("/", app);

    return gatedApp.fetch(request, env, ctx);
  },
};
