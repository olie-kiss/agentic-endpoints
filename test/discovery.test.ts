import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://ai.oliverkiss.com";

async function catalogue() {
  const res = await SELF.fetch(ORIGIN, {
    headers: { Accept: "application/json" },
  });
  return (await res.json()) as any;
}

/**
 * Every paid route, as the payment gate itself understands them.
 *
 * Matched on a leading "$" rather than by excluding "free": /mcp is priced
 * "free to list, per-tool price to call", which is neither.
 */
async function pricedPaths(): Promise<Record<string, string>> {
  const cat = await catalogue();
  const out: Record<string, string> = {};
  for (const ep of cat.endpoints ?? []) {
    if (typeof ep.price === "string" && ep.price.startsWith("$")) {
      out[ep.path] = ep.price;
    }
  }
  return out;
}

describe("machine-readable discovery", () => {
  it("describes every paid route in OpenAPI", async () => {
    const res = await SELF.fetch(`${ORIGIN}/openapi.json`);
    expect(res.status).toBe(200);

    const spec = (await res.json()) as any;
    expect(spec.openapi).toMatch(/^3\./);

    // A route that is charged for but undocumented is a route no agent can
    // work out how to call.
    for (const path of Object.keys(await pricedPaths())) {
      expect(spec.paths[path], `missing from OpenAPI: ${path}`).toBeDefined();
    }
  });

  it("quotes the same price everywhere it is written down", async () => {
    const spec = (await (await SELF.fetch(`${ORIGIN}/openapi.json`)).json()) as any;
    const llms = await (await SELF.fetch(`${ORIGIN}/llms.txt`)).text();

    // Prices have already drifted twice in this codebase's history, once
    // giving away three endpoints for free. Generated or not, it gets asserted.
    for (const [path, price] of Object.entries(await pricedPaths())) {
      const op = Object.values(spec.paths[path])[0] as any;
      expect(op.description, `OpenAPI price for ${path}`).toContain(price);
      expect(llms, `llms.txt price for ${path}`).toContain(`${path} — ${price}`);
    }
  });

  it("documents 402 as an expected response, not an error", async () => {
    const spec = (await (await SELF.fetch(`${ORIGIN}/openapi.json`)).json()) as any;

    // A client that treats the payment challenge as a failure can never buy
    // anything, so it has to be described as part of the normal flow.
    for (const path of Object.keys(await pricedPaths())) {
      const op = Object.values(spec.paths[path])[0] as any;
      expect(op.responses["402"]).toBeDefined();
      expect(op.responses["402"].description).toMatch(/X-PAYMENT/);
    }
  });

  it("ships a callable example for every documented route", async () => {
    const spec = (await (await SELF.fetch(`${ORIGIN}/openapi.json`)).json()) as any;

    for (const path of Object.keys(await pricedPaths())) {
      if (path.startsWith("/credits/buy")) continue; // takes no body

      const op = Object.values(spec.paths[path])[0] as any;
      const media = op.requestBody?.content?.["application/json"];
      expect(media?.schema, `no schema for ${path}`).toBeDefined();

      // The example has to satisfy the schema's own required fields —
      // shipping "body": {} against a schema requiring them is exactly the
      // bug that kept these routes out of the Bazaar catalogue.
      for (const required of media.schema.required ?? []) {
        expect(
          media.example?.[required],
          `example for ${path} omits required "${required}"`,
        ).toBeDefined();
      }
    }
  });

  it("invites crawlers instead of blocking them", async () => {
    const res = await SELF.fetch(`${ORIGIN}/robots.txt`);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain("Allow: /");
    expect(body).not.toMatch(/^Disallow: \/$/m);

    // Automated readers are the customers here, so the content signals say so
    // explicitly rather than leaving Cloudflare's blank default in place.
    expect(body).toContain("ai-input=yes");
    expect(body).toContain("ai-train=yes");
    expect(body).toContain("/llms.txt");
  });

  it("tells an agent how to pay in llms.txt", async () => {
    const body = await (await SELF.fetch(`${ORIGIN}/llms.txt`)).text();

    expect(body).toContain("X-PAYMENT");
    expect(body).toContain("X-Credit-Token");
    expect(body).toContain("eip155:8453");
    expect(body).toContain("/mcp");
  });

  it("lists only free documents in the sitemap", async () => {
    const body = await (await SELF.fetch(`${ORIGIN}/sitemap.xml`)).text();
    expect(body).toContain("<urlset");

    // Pointing a crawler at a paid route just generates 402s and teaches it
    // the site is broken.
    for (const path of Object.keys(await pricedPaths())) {
      expect(body).not.toContain(`<loc>${ORIGIN}${path}</loc>`);
    }
  });
});

/**
 * The exactly-once lifecycle is only useful if an agent can find all three
 * of its steps. /once-key/complete and /once-key/release are free, so they
 * are absent from the pricing table that generates everything else — which
 * is exactly how they could silently drop out of the published documents.
 */
describe("exactly-once lifecycle discovery", () => {
  const LIFECYCLE = ["/once-key/complete", "/once-key/release"];

  it("documents the free lifecycle endpoints in OpenAPI", async () => {
    const spec = (await (
      await SELF.fetch(`${ORIGIN}/openapi.json`)
    ).json()) as any;

    for (const path of LIFECYCLE) {
      expect(spec.paths[path]).toBeDefined();
      expect(spec.paths[path].post.requestBody).toBeDefined();
    }
  });

  it("documents them in llms.txt with the status an agent must branch on", async () => {
    const body = await (await SELF.fetch(`${ORIGIN}/llms.txt`)).text();

    for (const path of LIFECYCLE) {
      expect(body).toContain(path);
    }
    // An agent that cannot distinguish these will either duplicate a side
    // effect or deadlock waiting on one that already finished.
    for (const status of ["in_progress", "duplicate", "conflict", "claimed"]) {
      expect(body).toContain(status);
    }
    expect(body).toContain("lease_ttl");
  });

  it("does not price the lifecycle endpoints", async () => {
    const priced = await pricedPaths();
    for (const path of LIFECYCLE) {
      expect(priced[path]).toBeUndefined();
    }
  });
});

/**
 * x402-list.com published all eight of these endpoints as GET. It did not get
 * that wrong — we told it. Paid routes are registered without a verb, so the
 * paywall answers any method, and the bazaar extension's enrichDeclaration
 * then overwrites the declared method with the one the caller used. Probe with
 * GET, get told "GET", publish GET. An agent that believes the listing pays,
 * sends GET, and 404s on a POST-only route: the entire funnel lost at the last
 * step, to metadata that answers differently depending on who asks.
 *
 * Unit-tested rather than driven through SELF.fetch because a paid route in
 * the test pool cannot reach the facilitator and answers 503, never 402.
 */
import { declareTrueMethod } from "../src/index";

describe("declaring the method that actually works", () => {
  function challengeHeaders(input: Record<string, unknown>) {
    const challenge = {
      x402Version: 2,
      accepts: [],
      extensions: {
        bazaar: {
          info: { input },
          schema: {
            properties: {
              input: {
                properties: { method: { type: "string", enum: ["GET"] } },
              },
            },
          },
        },
      },
    };
    return new Headers({ "PAYMENT-REQUIRED": btoa(JSON.stringify(challenge)) });
  }

  function read(headers: Headers) {
    const bazaar = JSON.parse(atob(headers.get("PAYMENT-REQUIRED") as string))
      .extensions.bazaar;
    return {
      info: bazaar.info.input.method,
      schema: bazaar.schema.properties.input.properties.method.enum,
    };
  }

  it("replaces the method a GET probe was echoed, in both info and schema", () => {
    const headers = challengeHeaders({
      type: "http",
      method: "GET",
      bodyType: "json",
      body: { text: "hello" },
    });

    declareTrueMethod(headers, "POST");

    expect(read(headers)).toEqual({ info: "POST", schema: ["POST"] });
  });

  it("leaves an MCP declaration alone, which has no HTTP method to correct", () => {
    const headers = challengeHeaders({ type: "mcp", method: "GET" });
    const before = headers.get("PAYMENT-REQUIRED");

    declareTrueMethod(headers, "POST");

    expect(headers.get("PAYMENT-REQUIRED")).toBe(before);
  });

  it("leaves a challenge it cannot parse exactly as it found it", () => {
    const headers = new Headers({ "PAYMENT-REQUIRED": "not-base64-json" });

    declareTrueMethod(headers, "POST");

    expect(headers.get("PAYMENT-REQUIRED")).toBe("not-base64-json");
  });

  it("does nothing when there is no challenge to correct", () => {
    const headers = new Headers();

    declareTrueMethod(headers, "POST");

    expect(headers.get("PAYMENT-REQUIRED")).toBeNull();
  });

  it("preserves the rest of the challenge, which facilitators parse", () => {
    const headers = challengeHeaders({
      type: "http",
      method: "GET",
      bodyType: "json",
      body: { text: "hello" },
    });

    declareTrueMethod(headers, "POST");

    const challenge = JSON.parse(
      atob(headers.get("PAYMENT-REQUIRED") as string),
    );
    expect(challenge.x402Version).toBe(2);
    expect(challenge.extensions.bazaar.info.input.body).toEqual({
      text: "hello",
    });
    expect(challenge.extensions.bazaar.info.input.bodyType).toBe("json");
  });
});
