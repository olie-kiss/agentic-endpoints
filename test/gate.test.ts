import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Regressions for the payment gate itself.
 *
 * These cover bugs where the service performed paid work, or gave away a
 * control, without being paid. They are the highest-value tests in the suite:
 * every other test asserts the product works, these assert it cannot be taken
 * for free.
 */

const PAID_PATHS = [
  "/compress",
  "/scrape",
  "/pdf-parse",
  "/once-key",
  "/vault/store",
  "/vault/retrieve",
  "/vault/list",
  "/vault/delete",
  "/vault/exists",
  "/credits/buy",
  "/credits/buy-25",
];

/** Percent-encode the first alphabetic character of the last path segment. */
function encodeOneChar(path: string): string {
  const segments = path.split("/");
  const last = segments[segments.length - 1];
  const idx = [...last].findIndex((ch) => /[a-z]/i.test(ch));
  segments[segments.length - 1] =
    last.slice(0, idx) +
    "%" +
    last.charCodeAt(idx).toString(16).padStart(2, "0") +
    last.slice(idx + 1);
  return segments.join("/");
}

/**
 * Unpaid requests answer 402 in production. Locally the facilitator pre-flight
 * cannot make an outbound TLS connection, so the gate fails closed with 503
 * instead. Either is correct here; what matters is that it is never 200.
 */
const GATED = [402, 503];

describe("paid path gate", () => {
  it("never returns work for a paid path without payment", async () => {
    for (const path of PAID_PATHS) {
      const res = await SELF.fetch(`https://ai.oliverkiss.com${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello world", url: "https://example.com" }),
      });
      expect(GATED, `${path} must be gated, got ${res.status}`).toContain(res.status);
    }
  });

  /**
   * `new URL(url).pathname` keeps percent-escapes but Hono's router decodes
   * them, so `/compr%65ss` missed the paid-path test and was still dispatched
   * to the `/compress` handler — full paid work, no payment. `/credits/b%75y`
   * minted a $6.00 credit token for free, repeatedly.
   */
  it("never performs work for a percent-encoded paid path", async () => {
    for (const path of PAID_PATHS) {
      const encoded = encodeOneChar(path);
      expect(encoded, "test must actually encode something").not.toBe(path);

      const res = await SELF.fetch(`https://ai.oliverkiss.com${encoded}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello world", url: "https://example.com" }),
      });

      expect(res.status, `${encoded} must not return work`).not.toBe(200);

      const body = await res.text();
      expect(body, `${encoded} leaked work`).not.toContain("hello world");
      expect(body, `${encoded} leaked a credit token`).not.toContain("credit_token");
    }
  });

  it("rejects percent-encoded paths outright rather than guessing", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/compr%65ss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello world" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("internal dispatch marker", () => {
  /**
   * The marker was the constant "1", so any caller could send it and skip the
   * rate limiter and every usage counter — the only controls in front of the
   * free surface.
   */
  it("does not honour a caller-supplied X-Internal-Dispatch header", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/status", {
      headers: { "X-Internal-Dispatch": "1" },
    });
    expect(res.status).toBe(200);

    // The request must still have been counted, i.e. treated as external.
    const stats = await SELF.fetch("https://ai.oliverkiss.com/stats");
    const json = await stats.json<{ total?: number }>();
    expect(json).toBeTruthy();
  });

  it("still gates a paid path when the header is forged", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/compress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Dispatch": "1",
      },
      body: JSON.stringify({ text: "hello world" }),
    });
    expect(GATED).toContain(res.status);
  });
});
