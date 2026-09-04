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
