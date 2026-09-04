import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function vault(
  namespace: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const stub = env.VAULT.get(env.VAULT.idFromName(namespace));
  const res = await stub.fetch(
    new Request(`https://internal${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

function ns() {
  return `v-${crypto.randomUUID()}`;
}

async function claimed(namespace: string) {
  const res = await vault(namespace, "/store", {
    key: "seed",
    ciphertext: "seed-value",
  });
  return res.json.namespace_token as string;
}

describe("Vault ownership", () => {
  it("mints a server-side token on the first write", async () => {
    const res = await vault(ns(), "/store", { key: "k", ciphertext: "c" });
    expect(res.status).toBe(200);
    expect((res.json.namespace_token as string).length).toBeGreaterThan(20);
  });

  it("ignores a caller-supplied token at claim time", async () => {
    const res = await vault(ns(), "/store", {
      key: "k",
      ciphertext: "c",
      namespace_token: "attacker-chosen-token",
    });
    expect(res.json.namespace_token).not.toBe("attacker-chosen-token");
  });

  it("locks out a second tenant", async () => {
    const n = ns();
    await claimed(n);
    const res = await vault(n, "/store", { key: "x", ciphertext: "c" });
    expect(res.status).toBe(403);
  });

  it("does not leak values to an unauthorized reader", async () => {
    const n = ns();
    await claimed(n);
    const res = await vault(n, "/retrieve", { key: "seed" });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.json)).not.toContain("seed-value");
  });

  it("round-trips for the owner", async () => {
    const n = ns();
    const token = await claimed(n);
    const res = await vault(n, "/retrieve", {
      key: "seed",
      namespace_token: token,
    });
    expect(res.status).toBe(200);
    expect(res.json.ciphertext).toBe("seed-value");
  });
});

describe("Vault quotas and metadata", () => {
  it("rejects an oversized item", async () => {
    const res = await vault(ns(), "/store", {
      key: "big",
      ciphertext: "a".repeat(256 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });

  it("measures multi-byte payloads in bytes, not characters", async () => {
    // 4-byte emoji: well under the char limit, well over the byte limit.
    const res = await vault(ns(), "/store", {
      key: "emoji",
      ciphertext: "😀".repeat(70 * 1024),
    });
    expect(res.status).toBe(413);
  });

  it("rejects an oversized key as a validation error", async () => {
    const res = await vault(ns(), "/store", {
      key: "k".repeat(513),
      ciphertext: "c",
    });
    expect(res.status).toBe(400);
  });

  it("preserves created_at when a key is overwritten", async () => {
    const n = ns();
    const token = await claimed(n);
    const first = await vault(n, "/store", {
      key: "seed",
      ciphertext: "c1",
      namespace_token: token,
    });

    await new Promise((r) => setTimeout(r, 5));

    const second = await vault(n, "/store", {
      key: "seed",
      ciphertext: "c2-longer",
      namespace_token: token,
    });

    expect(second.json.created_at).toBe(first.json.created_at);
    expect(
      Date.parse(second.json.updated_at as string),
    ).toBeGreaterThanOrEqual(Date.parse(second.json.created_at as string));
  });

  it("rejects an invalid ttl rather than throwing", async () => {
    for (const ttl of ["soon", 0, -5, 10 ** 12]) {
      const res = await vault(ns(), "/store", {
        key: "k",
        ciphertext: "c",
        ttl,
      });
      expect(res.status, `ttl=${ttl}`).toBe(400);
    }
  });
});

/**
 * These are paid routes. Under x402 any status >= 400 cancels settlement, so
 * a 4xx returned after the service has already done the work gives the answer
 * away for free and leaves the payment header replayable.
 */
describe("vault paid-route settlement contract", () => {
  it("answers a missing key with 200 and a status, not 404", async () => {
    const n = ns();
    const token = await claimed(n);

    const res = await vault(n, "/retrieve", {
      key: "no-such-key",
      namespace_token: token,
    });

    expect(res.status).toBe(200);
    expect(res.json.status).toBe("not_found");
  });

  it("treats deleting an absent key as a successful idempotent outcome", async () => {
    const n = ns();
    const token = await claimed(n);

    const res = await vault(n, "/delete", {
      key: "no-such-key",
      namespace_token: token,
    });

    expect(res.status).toBe(200);
    expect(res.json.status).toBe("not_found");
  });

  it("keeps a paid retrieve from undercutting the cheaper exists probe", async () => {
    const n = ns();
    const token = await claimed(n);

    // Both must cost the caller a settled payment to learn the same fact.
    const retrieve = await vault(n, "/retrieve", {
      key: "absent",
      namespace_token: token,
    });
    const exists = await vault(n, "/exists", {
      key: "absent",
      namespace_token: token,
    });

    expect(retrieve.status).toBe(200);
    expect(exists.status).toBe(200);
  });

  it("still refuses unauthenticated callers with a real 4xx", async () => {
    const n = ns();
    await claimed(n);

    // No work was done here, so cancelling settlement is correct.
    const res = await vault(n, "/retrieve", { key: "seed" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
