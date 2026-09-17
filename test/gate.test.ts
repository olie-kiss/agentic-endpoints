import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildRoutes, degradedChallenge } from "../src/index";
import type { Env } from "../src/types";

/**
 * Regressions for the payment gate itself.
 *
 * These cover bugs where the service performed paid work, or gave away a
 * control, without being paid. They are the highest-value tests in the suite:
 * every other test asserts the product works, these assert it cannot be taken
 * for free.
 */

/**
 * Derived from the route table, never hand-listed.
 *
 * This was a static array, and a static array silently fails to cover any
 * route added after it was written -- so the one test that proves the product
 * cannot be taken for free would quietly stop covering the newest, least
 * reviewed code. Deriving it means a new paid route is gate-tested the moment
 * it is priced, with no way to forget.
 */
const PAID_PATHS = Object.keys(buildRoutes(env as unknown as Env)).map((route) =>
  /^[A-Z]+\s/.test(route) ? route.split(/\s+/)[1] : route,
);

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
  it("derives the paid path list from the route table that prices them", () => {
    // Guards the derivation itself: if buildRoutes ever returned nothing, the
    // loops below would pass by iterating over an empty list -- a green suite
    // asserting nothing at all.
    expect(PAID_PATHS.length).toBeGreaterThanOrEqual(16);
    for (const known of [
      "/compress",
      "/once-key",
      "/vault/store",
      "/credits/buy",
      "/meetings/import",
      "/meetings/search",
    ]) {
      expect(PAID_PATHS).toContain(known);
    }
  });

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

import { newNamespaceError, MIN_NAMESPACE_LENGTH } from "../src/lib/utils";
import { redactUrls } from "../src/index";

/**
 * Namespaces are first-come, global, and unrecoverable, so a guessable name is
 * a standing denial-of-service: $0.001 claims `invoices` forever and locks out
 * the integrator who would naturally pick it. Publishing the source makes that
 * obvious rather than obscure, so new namespaces must be unguessable.
 */
describe("new namespace names must be unguessable", () => {
  const squattable = [
    "invoices",
    "billing",
    "stripe",
    "orders",
    "payments",
    "prod",
    "default",
    "test",
    "my-app",
  ];

  for (const name of squattable) {
    it(`rejects "${name}"`, () => {
      expect(newNamespaceError(name)).toBeTruthy();
    });
  }

  it("rejects a long but single-class name", () => {
    expect("averyveryverylongname".length).toBeGreaterThan(MIN_NAMESPACE_LENGTH);
    expect(newNamespaceError("averyveryverylongname")).toBeTruthy();
  });

  it("accepts a random namespace", () => {
    expect(newNamespaceError(`myapp-${crypto.randomUUID()}`)).toBeNull();
  });

  it("suggests a concrete replacement rather than just refusing", () => {
    expect(newNamespaceError("invoices")).toContain("myapp-");
  });
});

describe("redactUrls", () => {
  it("keeps the host but drops any credential in the path or query", () => {
    expect(redactUrls("failed: https://rpc.example.com/v2/SECRET_KEY timed out"))
      .toBe("failed: rpc.example.com timed out");
    expect(redactUrls("https://rpc.example.com/?apikey=abc123")).toBe(
      "rpc.example.com",
    );
  });

  it("passes through null and text without URLs", () => {
    expect(redactUrls(null)).toBeNull();
    expect(redactUrls("all endpoints failed")).toBe("all endpoints failed");
  });
});

describe("request body cap", () => {
  /**
   * The cap trusted a declared Content-Length, so a chunked request skipped it
   * entirely while every handler still buffered the whole body.
   */
  it("rejects an oversized body sent without a Content-Length", async () => {
    const oversized = new ReadableStream({
      start(controller) {
        const chunk = new Uint8Array(256 * 1024);
        for (let i = 0; i < 12; i++) controller.enqueue(chunk);
        controller.close();
      },
    });

    const res = await SELF.fetch("https://ai.oliverkiss.com/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversized,
      // @ts-expect-error duplex is required for a streaming body
      duplex: "half",
    });

    expect(res.status).toBe(413);
  });
});

/**
 * The payment challenge is the one response every would-be buyer is
 * guaranteed to see, and for months its body was the two bytes `{}`. An
 * x402-native client reads the challenge from the PAYMENT-REQUIRED header and
 * never noticed; everything else — generic agents, LLM tool wrappers, people
 * with curl — got a blank 402 and no way to discover the free trial.
 */
describe("payment challenge explains itself", () => {
  async function challenge(path = "/compress") {
    const res = await SELF.fetch(`https://ai.oliverkiss.com${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello world" }),
    });

    // Read once and keep the raw text: a body can only be consumed a single
    // time, and cloning a response whose body has already been read throws.
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { res, body, text };
  }

  it("names the free way in, not only the paid ones", async () => {
    const { res, body } = await challenge();
    expect(res.status).toBe(402);

    expect(body.error).toBe("payment_required");
    expect(body.ways_to_pay.free_trial.how).toContain("/credits/trial");
    // A caller must be told the token goes in a header, or it cannot spend it.
    expect(body.ways_to_pay.free_trial.then).toMatch(/X-Credit-Token/);
    expect(body.ways_to_pay.prepaid_credit.how).toContain("/credits/buy");
    expect(body.ways_to_pay.per_call_x402.detail).toMatch(/PAYMENT-REQUIRED/);
  });

  it("quotes the price the caller is actually being charged", async () => {
    const { res, body } = await challenge();

    // Derived from the live challenge rather than restated, so this cannot
    // drift from the amount in `accepts`.
    expect(body.price).toBe("$0.005");

    const encoded = res.headers.get("PAYMENT-REQUIRED");
    const decoded = JSON.parse(atob(encoded!));
    expect(decoded.accepts[0].amount).toBe("5000");
    expect(body.accepts[0].payTo).toBe(decoded.accepts[0].payTo);
  });

  it("leaves the machine-readable challenge in the header untouched", async () => {
    const { res } = await challenge();
    const decoded = JSON.parse(atob(res.headers.get("PAYMENT-REQUIRED")!));

    // Filling the body must not disturb what strict x402 parsers consume.
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0].scheme).toBe("exact");
    expect(decoded.accepts[0].asset).toMatch(/^0x/);
  });

  it("sends a body whose length matches what it declares", async () => {
    const { res, text } = await challenge();
    const declared = res.headers.get("Content-Length");
    const actual = new TextEncoder().encode(text).length;

    // A stale Content-Length from the empty body would truncate the response
    // to two bytes, which is worse than sending nothing.
    if (declared !== null) expect(Number(declared)).toBe(actual);
    expect(actual).toBeGreaterThan(2);
  });

  it("explains every paid route, not just the one that was checked", async () => {
    for (const path of PAID_PATHS) {
      if (path.startsWith("/credits/")) continue;
      const { res, body } = await challenge(path);
      if (res.status !== 402) continue;
      expect(body?.ways_to_pay?.free_trial?.how, path).toContain("/credits/trial");
    }
  });
});

/**
 * A facilitator outage used to answer every paid route with 503.
 *
 * That threw away the buyers who could still have paid: prepaid credit and the
 * free trial settle in our own Durable Object and never touch the facilitator.
 * It also told the uptime and trust monitors that index this service that we
 * were down, which costs the rating on the one distribution channel that
 * currently brings anyone here at all.
 */
describe("payment challenge survives a facilitator outage", () => {
  const request = new Request("https://ai.oliverkiss.com/compress", {
    method: "POST",
  });

  function degraded(path = "/compress") {
    return degradedChallenge(env as unknown as Env, request, path);
  }

  it("asks for payment rather than reporting an outage", () => {
    const res = degraded();
    expect(res).not.toBeNull();
    expect(res!.status).toBe(402);
    expect(res!.headers.get("Retry-After")).toBe("30");
  });

  it("still carries a challenge a strict x402 client can read", () => {
    const encoded = degraded()!.headers.get("PAYMENT-REQUIRED");
    expect(encoded).not.toBeNull();

    const challenge = JSON.parse(atob(encoded!));
    expect(challenge.x402Version).toBe(2);

    // Built from the route table, so it must still quote the real price,
    // payee and asset — a challenge that misquotes those is worse than none.
    const [accepts] = challenge.accepts;
    expect(accepts.scheme).toBe("exact");
    expect(accepts.amount).toBe("5000");
    expect(accepts.payTo).toBe((env as unknown as Env).X402_PAY_TO);
    expect(accepts.asset).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(accepts.network).toBe("eip155:8453");
  });

  it("names the two ways to pay that do not need the facilitator", async () => {
    const body = await degraded()!.json<any>();

    expect(body.price).toBe("$0.005");
    expect(body.ways_to_pay.free_trial.status).toBe("available");
    expect(body.ways_to_pay.prepaid_credit.status).toBe("available");

    // Honest about what is actually broken, rather than silently offering a
    // path that cannot complete.
    expect(body.ways_to_pay.per_call_x402.status).toBe("degraded");
  });

  it("encodes a description that is not Latin-1 without throwing", () => {
    // /once-key's description contains an em dash. btoa throws on it, which
    // would have turned a degraded response into a 500.
    const res = degraded("/once-key");
    expect(res).not.toBeNull();

    const challenge = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(res!.headers.get("PAYMENT-REQUIRED")!), (c) =>
          c.charCodeAt(0),
        ),
      ),
    );
    expect(challenge.resource.description).toContain("—");
    expect(challenge.accepts[0].amount).toBe("1000");
  });

  it("refuses to invent a price for a route that has none", () => {
    expect(degraded("/health")).toBeNull();
    expect(degraded("/not-a-route")).toBeNull();
  });
});
