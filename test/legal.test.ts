import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { complianceJson, documents } from "../src/pages/legal";
import type { Env } from "../src/types";

/**
 * These pages make factual claims to someone deciding whether to send money or
 * data. The tests that matter are the ones checking the claims are still true
 * of the running service, not that the HTML renders.
 */

const SLUGS = ["terms", "privacy", "refunds", "acceptable-use", "compliance"];

describe("legal pages", () => {
  it("serves every policy the compliance document links to", async () => {
    // A dead link in a compliance document is the exact thing a reviewer
    // checks first.
    const doc = complianceJson({} as Env);

    for (const url of Object.values(doc.policies)) {
      const path = new URL(url).pathname;
      const res = await SELF.fetch(`https://ai.oliverkiss.com${path}`);
      expect(res.status, `${path} should be served`).toBe(200);
    }
  });

  it("renders each page as HTML with its own content", async () => {
    for (const slug of SLUGS) {
      const res = await SELF.fetch(`https://ai.oliverkiss.com/${slug}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");

      const html = await res.text();
      expect(html).toContain("<!DOCTYPE html>");
      expect(html.length).toBeGreaterThan(1000);
    }
  });

  it("publishes a machine-readable summary", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/.well-known/compliance.json");
    expect(res.status).toBe(200);

    const doc = await res.json<any>();
    expect(doc.consumer_offering).toBe(false);
    expect(doc.payment.custody_of_customer_funds).toBe(false);
    expect(doc.payment.subscriptions).toBe(false);
    expect(doc.data.client_ip_logged).toBe(false);
  });

  it("does not publish a contact nobody reads", async () => {
    // A refund policy that commits to a reply within five business days must
    // not point at an address that was invented to fill the field.
    const doc = complianceJson({} as Env);
    expect(doc.contact).toMatch(/^https?:\/\//);
    expect(doc.contact).not.toContain("example.com");
  });

  it("escapes content rather than interpolating it into the page", async () => {
    const hostile = {
      LEGAL_ENTITY: '</style><script>alert(1)</script>',
    } as unknown as Env;

    const docs = documents(hostile);
    const { renderDoc } = await import("../src/pages/legal");
    const html = renderDoc(docs[0], docs, hostile);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("links the policies from the agent card, where an operator looks", async () => {
    const card = await (
      await SELF.fetch("https://ai.oliverkiss.com/.well-known/agent-card.json")
    ).json<any>();

    expect(card.policies.terms).toContain("/terms");
    expect(card.policies.compliance_json).toContain("/.well-known/compliance.json");
  });
});

describe("claims the service must keep true", () => {
  it("still refuses to log a client IP", async () => {
    // The privacy policy states this outright. If the stats summary ever grows
    // an IP field, this test is the thing that catches the policy becoming a
    // lie.
    const stats = await (await SELF.fetch("https://ai.oliverkiss.com/stats")).json<any>();
    const serialised = JSON.stringify(stats);

    expect(serialised).not.toMatch(/"ip"\s*:/);
    expect(serialised).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it("still offers the free evaluation the refund policy points at", async () => {
    // The refund policy tells buyers to evaluate free before committing money,
    // because payments are irreversible. That advice must stay actionable.
    const doc = complianceJson({} as Env);
    const path = new URL(doc.payment.free_evaluation).pathname;

    const res = await SELF.fetch(`https://ai.oliverkiss.com${path}`, {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.99" },
    });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).trial).toBe(true);
  });
});
