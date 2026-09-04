import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FREE_POST_ENDPOINTS } from "../src/lib/discovery";

const ORIGIN = "https://ai.oliverkiss.com";

async function landingHtml(): Promise<string> {
  const res = await SELF.fetch(ORIGIN, { headers: { Accept: "text/html" } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  return res.text();
}

/** The paid routes as the payment gate itself understands them. */
async function pricedPaths(): Promise<Record<string, string>> {
  const res = await SELF.fetch(ORIGIN, {
    headers: { Accept: "application/json" },
  });
  const cat = (await res.json()) as any;
  const out: Record<string, string> = {};
  for (const ep of cat.endpoints ?? []) {
    if (typeof ep.price === "string" && ep.price.startsWith("$")) {
      out[ep.path] = ep.price;
    }
  }
  return out;
}

/**
 * The landing page is the one description of this service written for a
 * human, and it used to be hand-maintained — so it quietly fell a release
 * behind, advertising routes at prices we no longer charged and omitting
 * three endpoints entirely. It is now generated from the same route config
 * that gates payment; these tests are what stop it being hand-edited back.
 */
describe("landing page", () => {
  it("lists every paid route at the price actually charged", async () => {
    const html = await landingHtml();
    const priced = await pricedPaths();

    expect(Object.keys(priced).length).toBeGreaterThan(0);

    for (const [path, price] of Object.entries(priced)) {
      expect(html, `${path} missing from landing page`).toContain(path);
      // The price must appear in that route's own row, not merely somewhere
      // on the page — otherwise any two routes sharing a price would pass.
      const row = html.slice(html.indexOf(`>${path}<`));
      const rowEnd = row.indexOf("</div>\n      </div>");
      expect(
        row.slice(0, rowEnd === -1 ? 400 : rowEnd + 60),
        `${path} is not advertised at ${price}`,
      ).toContain(price);
    }
  });

  it("advertises the free lifecycle endpoints", async () => {
    const html = await landingHtml();
    for (const free of FREE_POST_ENDPOINTS) {
      expect(html, `${free.path} missing from landing page`).toContain(
        free.path,
      );
    }
  });

  it("advertises the free telemetry endpoints", async () => {
    const html = await landingHtml();
    for (const path of ["/status", "/stats", "/revenue", "/health"]) {
      expect(html, `${path} missing from landing page`).toContain(path);
    }
  });

  it("does not advertise a route that no longer exists", async () => {
    const html = await landingHtml();
    const priced = await pricedPaths();
    const known = new Set([
      ...Object.keys(priced),
      ...FREE_POST_ENDPOINTS.map((f) => f.path),
      "/status",
      "/stats",
      "/revenue",
      "/health",
      "/openapi.json",
      "/llms.txt",
      "/mcp",
    ]);

    const advertised = [...html.matchAll(/class="endpoint-path">([^<]+)</g)].map(
      (m) => m[1],
    );

    expect(advertised.length).toBeGreaterThan(0);
    for (const path of advertised) {
      expect(known, `landing page advertises unknown route ${path}`).toContain(
        path,
      );
    }
  });

  it("escapes markup in generated rows", async () => {
    const html = await landingHtml();
    // Descriptions are interpolated into HTML; an unescaped angle bracket
    // would mean the escaping helper is not on the path that renders them.
    const descs = [...html.matchAll(/class="endpoint-desc">([^<]*)</g)].map(
      (m) => m[1],
    );
    expect(descs.length).toBeGreaterThan(0);
    for (const d of descs) {
      expect(d).not.toContain("<");
    }
  });
});
