import type { RoutesConfig } from "@x402/core/server";

/**
 * Machine-readable descriptions of this service, all derived from the payment
 * config rather than written by hand.
 *
 * The intended customer here is a program, not a person. A program that has
 * never been told about this service can only find it by reading something,
 * and it will not read a landing page. So the same route table that decides
 * what is charged also produces the OpenAPI document, the llms.txt summary
 * and the crawler policy. A hand-kept copy of any of them would drift, and
 * drift in this file means quoting a price the payment gate does not honour —
 * which is exactly how three vault endpoints once shipped for free.
 */

interface Described {
  path: string;
  method: string;
  price: string;
  description: string;
  inputSchema: Record<string, unknown> | undefined;
  inputExample: unknown;
  outputExample: unknown;
}

/**
 * Pulls the human-facing parts back out of the x402 route config.
 *
 * The discovery extension nests the request schema inside a JSON Schema that
 * describes the extension itself, so the useful part sits a few levels down.
 * Reaching for it defensively: a missing branch should cost one field in the
 * documentation, not throw and take out every discovery endpoint at once.
 */
export function describeRoutes(routes: RoutesConfig): Described[] {
  return Object.entries(routes).map(([key, value]) => {
    const config = value as Record<string, any>;
    const match = /^([A-Z]+)\s+(.*)$/.exec(key);

    const bazaar = config.extensions?.bazaar;
    const info = bazaar?.info;

    return {
      path: match ? match[2] : key,
      method: match ? match[1] : (info?.input?.method ?? "POST"),
      price: config.accepts?.price ?? "unknown",
      description: config.description ?? "",
      inputSchema: bazaar?.schema?.properties?.input?.properties?.body,
      inputExample: info?.input?.body,
      outputExample: info?.output?.example,
    };
  });
}

/**
 * An OpenAPI 3.1 document.
 *
 * Worth generating because it is the one description of an HTTP API that
 * agent frameworks, SDK generators and tooling already parse without being
 * taught anything specific to x402.
 */
/**
 * Free POST endpoints that are part of a paid endpoint's lifecycle.
 *
 * These are not in `routes`, because `routes` is the x402 pricing table and
 * these cost nothing. But an agent that cannot discover /once-key/complete
 * will never call it, and every key it claims will dangle with no recorded
 * result — so they have to appear in the generated documents alongside the
 * paid routes rather than being mentioned only in prose.
 */
export const FREE_POST_ENDPOINTS = [
  {
    path: "/once-key/complete",
    summary: "Record the outcome of a claimed action_key",
    description:
      "Stores the result of work performed under a claim. Later claims of " +
      "the same action_key return status \"duplicate\" together with this " +
      "result, so the caller that lost the race can continue instead of " +
      "repeating the side effect. Free: the claim price covers the whole " +
      "lifecycle. Completion is final and cannot be overwritten.",
    example: {
      namespace: "invoices",
      action_key: "charge-order-1042",
      namespace_token: "the token issued on your first claim",
      result: { charge_id: "ch_abc123", amount: 4200 },
    },
    schema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        action_key: { type: "string" },
        namespace_token: { type: "string" },
        result: {
          description: "Any JSON value, up to 16 KB once serialized.",
        },
        ttl: {
          type: "number",
          description:
            "How long to retain the result, in seconds. Default 86400.",
        },
      },
      required: ["namespace", "action_key"],
    },
  },
  {
    path: "/vault/rotate-token",
    summary: "Replace a vault namespace token",
    description:
      "Mints a new namespace_token and invalidates the current one, which " +
      "must be presented to authorize the rotation. Free on purpose: " +
      "charging for the correct response to a suspected leak is how you end " +
      "up with callers who never rotate. There is no recovery if the token " +
      "is lost — any such path would be a second way into the namespace and " +
      "would serve an attacker just as well as the owner.",
    example: {
      namespace: "agent-secrets",
      namespace_token: "your current token",
    },
    schema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        namespace_token: { type: "string" },
      },
      required: ["namespace", "namespace_token"],
    },
  },
  {
    path: "/once-key/release",
    summary: "Surrender a claim whose work failed",
    description:
      "Frees a claimed action_key so a retry can proceed immediately rather " +
      "than waiting out the lease. Free. Refuses with 409 if the key was " +
      "already completed, since releasing it would discard the recorded " +
      "result and permit a second side effect.",
    example: {
      namespace: "invoices",
      action_key: "charge-order-1042",
      namespace_token: "the token issued on your first claim",
    },
    schema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        action_key: { type: "string" },
        namespace_token: { type: "string" },
      },
      required: ["namespace", "action_key"],
    },
  },
  {
    path: "/credits/balance",
    summary: "Check a prepaid credit balance",
    description:
      "Returns the remaining balance for a credit token, and what it has " +
      "been spent on. Free, and takes no request body: the token goes in " +
      "the X-Credit-Token header. Charging a buyer to find out how much " +
      "they have left would be a good way to never sell them a second one.",
    headers: [
      {
        name: "X-Credit-Token",
        description: "The token issued by /credits/buy. Required.",
      },
    ],
    example: undefined,
    schema: undefined,
  },
] as const;

export function buildOpenApi(routes: RoutesConfig, origin: string) {
  const described = describeRoutes(routes);
  const paths: Record<string, unknown> = {};

  for (const route of described) {
    paths[route.path] = {
      [route.method.toLowerCase()]: {
        summary: route.description,
        description:
          `${route.description}. Costs ${route.price}, paid per call with ` +
          "x402 (USDC on Base), or debited from a prepaid balance by sending " +
          "an X-Credit-Token header.",
        operationId: route.path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, ""),
        requestBody: route.inputSchema
          ? {
              required: true,
              content: {
                "application/json": {
                  schema: route.inputSchema,
                  example: route.inputExample,
                },
              },
            }
          : undefined,
        responses: {
          "200": {
            description: "Success",
            content: {
              "application/json": {
                example: route.outputExample,
              },
            },
          },
          // Documented as a normal outcome rather than an error: for a paid
          // API this is the expected first response to every new caller, and
          // a client that treats it as a failure can never buy anything.
          "402": {
            description:
              "Payment required. The `payment-required` response header " +
              "carries a base64 x402 challenge naming the price, asset and " +
              "recipient. Sign it and retry with an X-PAYMENT header.",
          },
          "429": { description: "Rate limited." },
        },
      },
    };
  }

  for (const free of FREE_POST_ENDPOINTS) {
    paths[free.path] = {
      post: {
        summary: free.summary,
        description: free.description,
        operationId: free.path
          .replace(/[^a-zA-Z0-9]+/g, "_")
          .replace(/^_|_$/g, ""),
        ...(free.schema
          ? {
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: free.schema,
                    example: free.example,
                  },
                },
              },
            }
          : {}),
        ...((free as { headers?: readonly { name: string; description: string }[] })
          .headers
          ? {
              parameters: (
                free as {
                  headers: readonly { name: string; description: string }[];
                }
              ).headers.map((h) => ({
                name: h.name,
                in: "header",
                required: true,
                description: h.description,
                schema: { type: "string" },
              })),
            }
          : {}),
        responses: {
          "200": {
            description:
              "Success, or a settled refusal. Paid routes answer 200 with a " +
              'machine-readable `status` (e.g. "forbidden", "not_found", ' +
              '"precondition_failed", "conflict") rather than a 4xx, because ' +
              "any status >=400 cancels x402 settlement and would give the " +
              "answer away for free. Always branch on `status`, not on the " +
              "HTTP code.",
          },
          "400": { description: "Malformed request." },
          "404": { description: "No such record." },
          "429": { description: "Rate limited." },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "agentic-endpoints",
      version: "1.0.0",
      description:
        "Pay-per-call utilities for autonomous agents. No signup, no API " +
        "keys, no invoices: every endpoint answers HTTP 402 with a price and " +
        "serves the request once payment is signed.",
    },
    servers: [{ url: origin }],
    paths,
  };
}

/**
 * llms.txt — a plain-markdown summary at a predictable path.
 *
 * Deliberately duplicates what OpenAPI already says, because the two are read
 * by different things: a model given a URL and no tooling will do far better
 * with prose than with a schema document.
 */
export function buildLlmsTxt(routes: RoutesConfig, origin: string): string {
  const described = describeRoutes(routes);

  const lines = [
    "# agentic-endpoints",
    "",
    "> Pay-per-call HTTP utilities for autonomous AI agents. There is no",
    "> signup, no API key and no invoice. Every paid endpoint answers 402",
    "> with a price; you sign a stablecoin payment and retry.",
    "",
    "## How to pay",
    "",
    "Two options, and the same endpoints accept both:",
    "",
    "1. **Per call (x402).** Send the request. You get HTTP 402 with a",
    "   `payment-required` header holding a base64 challenge that names the",
    "   amount, the asset (USDC on Base, chain `eip155:8453`) and the",
    "   recipient. Sign an EIP-3009 authorization and retry with an",
    "   `X-PAYMENT` header. Any x402 client library does this for you.",
    "2. **Prepaid credits.** POST to /credits/buy ($5 buys $6.00) or",
    "   /credits/buy-25 ($25 buys $32.50). You get a token back once, and",
    "   only once. Send it as `X-Credit-Token` on any paid endpoint and the",
    "   list price is debited from your balance with no per-call signature.",
    "",
    "### Concurrency",
    "",
    "Paid calls issued concurrently from the same wallet are refused a",
    "noticeable fraction of the time. The facilitator will not verify",
    "overlapping authorizations from one payer, and you get an ordinary 402.",
    "",
    "A 402 means the payment did NOT happen and you were NOT charged: any",
    "status at or above 400 cancels settlement. Retrying with a fresh",
    "signature is safe and will not double-spend. Issue paid calls",
    "sequentially, or retry on 402 with a short backoff. Prepaid credits",
    "avoid this entirely, since they carry no per-call signature to verify.",
    "",
    "## Endpoints",
    "",
  ];

  for (const route of described) {
    lines.push(`### ${route.method} ${route.path} — ${route.price}`);
    lines.push("");
    lines.push(route.description);
    lines.push("");
    if (route.inputExample && Object.keys(route.inputExample as object).length) {
      lines.push("Request:");
      lines.push("```json");
      lines.push(JSON.stringify(route.inputExample, null, 2));
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("## Exactly-once workflow");
  lines.push("");
  lines.push("`/once-key` is the endpoint you cannot replace with a library,");
  lines.push("because it answers a question no single agent can answer alone:");
  lines.push("has anyone, anywhere, already done this? Use it like this:");
  lines.push("");
  lines.push("1. `POST /once-key` with your `action_key` and a `lease_ttl`.");
  lines.push("   - `claimed` — you won. Do the work.");
  lines.push("   - `in_progress` — someone else is doing it. Wait");
  lines.push("     `retry_after` seconds; do not start the work.");
  lines.push("   - `duplicate` — already done. The `result` field holds the");
  lines.push("     original outcome; use it and do not repeat the work.");
  lines.push("     `has_result` is false if no result was ever recorded, so");
  lines.push("     a null result is never mistaken for a lost one. If");
  lines.push("     `result_error` is present the stored result could not be");
  lines.push("     read back: the work DID run, so do not repeat it, but the");
  lines.push("     recorded outcome is lost.");
  lines.push("   - `held` — someone else claimed it but has not finished and");
  lines.push("     set no lease. There is no result and may never be one. Do");
  lines.push("     NOT treat this as done and do NOT do the work; the key is");
  lines.push("     locked until `expires_at`.");
  lines.push("   - `conflict` — same key, different payload hash. Your key");
  lines.push("     derivation is wrong; do not proceed.");
  lines.push("2. `POST /once-key/complete` with the `result`. Free. This is");
  lines.push("   what lets every later caller learn the outcome.");
  lines.push("3. If the work failed, `POST /once-key/release`. Free. The key");
  lines.push("   becomes immediately retryable.");
  lines.push("");
  lines.push("If you pass `lease_ttl` and then crash, the claim is released");
  lines.push("automatically once the lease lapses and the next caller takes");
  lines.push("it over with `recovered: true`. Without `lease_ttl` a claim is");
  lines.push("held until its full `ttl`, which is the safer default: nothing");
  lines.push("can ever run your side effect twice.");
  lines.push("");

  lines.push("## Free endpoints");
  lines.push("");
  lines.push(`- \`GET ${origin}/\` — this catalogue as JSON`);
  lines.push(`- \`GET ${origin}/health\` — liveness`);
  lines.push(`- \`GET ${origin}/stats\` — usage counts, published openly so you`);
  lines.push("  can tell a maintained service from an abandoned one");
  lines.push(
    `- \`GET ${origin}/status\` — uptime, error rate and latency, derived` +
      " from this service's own cron ticks and request log, so you can judge",
  );
  lines.push("  whether it is safe to route paid work through");
  lines.push(`- \`GET ${origin}/openapi.json\` — OpenAPI 3.1 description`);
  for (const free of FREE_POST_ENDPOINTS) {
    lines.push(`- \`POST ${origin}${free.path}\` — ${free.summary}`);
  }
  lines.push(`- \`${origin}/mcp\` — Model Context Protocol server (JSON-RPC)`);
  lines.push("");

  return lines.join("\n");
}

/**
 * robots.txt.
 *
 * Most sites publish this to keep crawlers out. The whole purpose of this one
 * is the opposite: the customers are automated, so being read by a model is
 * the point rather than the leak. Cloudflare serves a default file of pure
 * boilerplate with no directives at all, which grants nothing explicitly, so
 * this replaces it with a clear invitation and pointers to the two documents
 * a machine would actually want.
 */
export function buildRobotsTxt(origin: string): string {
  return [
    "# Automated clients are the intended audience of this service, not an",
    "# abuse of it. Crawl freely; the paid endpoints charge per call and are",
    "# protected by payment rather than by obscurity.",
    "",
    "User-agent: *",
    "Allow: /",
    "",
    "# Cloudflare's Content Signals Policy, answered explicitly rather than",
    "# left blank.",
    "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
    "# Machine-readable descriptions of everything on offer:",
    `#   ${origin}/llms.txt      prose summary`,
    `#   ${origin}/openapi.json  OpenAPI 3.1`,
    `#   ${origin}/             JSON catalogue with live prices`,
    `#   ${origin}/mcp          Model Context Protocol endpoint`,
    "",
  ].join("\n");
}

/** A sitemap listing only the free, crawlable documents. */
export function buildSitemap(origin: string): string {
  const urls = [
    "/",
    "/llms.txt",
    "/openapi.json",
    "/stats",
    "/status",
    "/health",
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${origin}${u}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
}
