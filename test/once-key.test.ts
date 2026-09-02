import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * These talk to the OnceKey Durable Object directly, bypassing the x402
 * payment middleware. That is the only way to exercise the paid handlers,
 * since every HTTP route behind the gate answers 402 without a real payment.
 */
async function claim(
  namespace: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const stub = env.ONCE_KEY.get(env.ONCE_KEY.idFromName(namespace));
  const res = await stub.fetch(
    new Request("https://internal/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

function ns() {
  return `t-${crypto.randomUUID()}`;
}

describe("OnceKey namespace ownership", () => {
  it("mints a one-time token on the first claim", async () => {
    const n = ns();
    const first = await claim(n, { action_key: "a" });

    expect(first.status).toBe(200);
    expect(first.json.status).toBe("claimed");
    expect(typeof first.json.namespace_token).toBe("string");
    expect((first.json.namespace_token as string).length).toBeGreaterThan(20);
  });

  it("does not reissue the token on later requests", async () => {
    const n = ns();
    const token = (await claim(n, { action_key: "a" })).json
      .namespace_token as string;

    const second = await claim(n, { action_key: "b", namespace_token: token });
    expect(second.json.namespace_token).toBeUndefined();
  });

  it("rejects a second tenant that cannot present the token", async () => {
    const n = ns();
    await claim(n, { action_key: "a" });

    const attacker = await claim(n, { action_key: "victim-key" });
    expect(attacker.status).toBe(403);
  });

  it("rejects a wrong token", async () => {
    const n = ns();
    await claim(n, { action_key: "a" });

    const res = await claim(n, {
      action_key: "b",
      namespace_token: "not-the-right-token",
    });
    expect(res.status).toBe(403);
  });
});

describe("OnceKey claim semantics", () => {
  it("claims once, then reports duplicates", async () => {
    const n = ns();
    const first = await claim(n, { action_key: "k" });
    const token = first.json.namespace_token as string;

    const second = await claim(n, { action_key: "k", namespace_token: token });
    expect(second.json.status).toBe("duplicate");
    expect(second.json.claimed_at).toBe(first.json.claimed_at);
  });

  it("reports a conflict on payload mismatch without failing the request", async () => {
    const n = ns();
    const token = (
      await claim(n, { action_key: "k", payload_sha256: "aaa" })
    ).json.namespace_token as string;

    const res = await claim(n, {
      action_key: "k",
      payload_sha256: "bbb",
      namespace_token: token,
    });

    // Must stay 200: x402 cancels settlement on >= 400, which would let the
    // caller replay the same payment header indefinitely.
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("conflict");
  });
});

describe("OnceKey ttl validation", () => {
  it("rejects a non-numeric ttl instead of throwing a RangeError", async () => {
    const res = await claim(ns(), { action_key: "k", ttl: "soon" });
    expect(res.status).toBe(400);
  });

  it("rejects NaN, zero, negative and absurd ttls", async () => {
    for (const ttl of [0, -1, 1.5, 10 ** 12]) {
      const res = await claim(ns(), { action_key: "k", ttl });
      expect(res.status, `ttl=${ttl}`).toBe(400);
    }
  });

  it("honours a valid ttl", async () => {
    const res = await claim(ns(), { action_key: "k", ttl: 60 });
    expect(res.status).toBe(200);

    const claimed = Date.parse(res.json.claimed_at as string);
    const expires = Date.parse(res.json.expires_at as string);
    expect(expires - claimed).toBe(60_000);
  });

  it("requires an action_key", async () => {
    const res = await claim(ns(), {});
    expect(res.status).toBe(400);
  });
});
