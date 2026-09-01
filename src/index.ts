import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  paymentMiddlewareFromConfig,
  type SchemeRegistration,
} from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient, type RoutesConfig } from "@x402/core/server";

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
    // x402 route pricing config — maps route patterns to payment requirements
    const routes: RoutesConfig = {
      "/once-key": {
        accepts: {
          scheme: "exact",
          network: "eip155:8453", // Base mainnet
          payTo: env.X402_PAY_TO,
          price: "$0.001",
        },
        description: "Atomic idempotency witness",
      },
      "/scrape": {
        accepts: {
          scheme: "exact",
          network: "eip155:8453",
          payTo: env.X402_PAY_TO,
          price: "$0.005",
        },
        description: "Web scraping and text extraction",
      },
      "/pdf-parse": {
        accepts: {
          scheme: "exact",
          network: "eip155:8453",
          payTo: env.X402_PAY_TO,
          price: "$0.01",
        },
        description: "PDF text extraction",
      },
      "/compress": {
        accepts: {
          scheme: "exact",
          network: "eip155:8453",
          payTo: env.X402_PAY_TO,
          price: "$0.005",
        },
        description: "Token compression for LLMs",
      },
      "/vault/retrieve": {
        accepts: {
          scheme: "exact",
          network: "eip155:8453",
          payTo: env.X402_PAY_TO,
          price: "$0.02",
        },
        description: "Retrieve an encrypted item from the vault",
      },
    };

    // Payment scheme registration (server-side verification)
    const schemes: SchemeRegistration[] = [
      {
        network: "eip155:8453", // Base mainnet
        server: new ExactEvmScheme(),
      },
    ];

    // Facilitator client (validates & settles payments)
    const facilitatorClient = new HTTPFacilitatorClient({
      url: env.FACILITATOR_URL,
    });

    // Build the payment-gated Hono app
    const paymentMiddleware = paymentMiddlewareFromConfig(
      routes,
      facilitatorClient,
      schemes,
    );

    // Create a wrapper app that applies payment middleware then delegates
    const gatedApp = new Hono<{ Bindings: Env }>();
    gatedApp.use("*", paymentMiddleware);
    gatedApp.route("/", app);

    return gatedApp.fetch(request, env, ctx);
  },
};
