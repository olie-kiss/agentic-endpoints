import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Lease and completion semantics, exercised directly against the Durable
 * Object. No sleeps: expiry is driven by asking for a lease_ttl of 1 second
 * and comparing timestamps, or by reclaiming with an already-lapsed lease.
 */
async function call(
  namespace: string,
  action: "claim" | "complete" | "release",
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const stub = env.ONCE_KEY.get(env.ONCE_KEY.idFromName(namespace));
  const res = await stub.fetch(
    new Request(`https://internal/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

function ns() {
  return `L-${crypto.randomUUID()}`;
}

/** Claim a fresh namespace and return its one-time owner token. */
async function open(namespace: string, body: Record<string, unknown> = {}) {
  const first = await call(namespace, "claim", { action_key: "seed", ...body });
  return first.json.namespace_token as string;
}

describe("OnceKey result replay", () => {
  it("replays the stored result to a later claim of the same key", async () => {
    const n = ns();
    const token = await open(n);

    await call(n, "claim", { action_key: "charge-1", namespace_token: token });
    const done = await call(n, "complete", {
      action_key: "charge-1",
      namespace_token: token,
      result: { charge_id: "ch_abc", amount: 4200 },
    });
    expect(done.json.status).toBe("completed");

    const replay = await call(n, "claim", {
      action_key: "charge-1",
      namespace_token: token,
    });
    expect(replay.json.status).toBe("duplicate");
    // The whole point: the loser of the race learns the outcome, so it can
    // carry on instead of repeating the side effect.
    expect(replay.json.result).toEqual({ charge_id: "ch_abc", amount: 4200 });
  });

  it("treats a repeated complete as success, not an error", async () => {
    const n = ns();
    const token = await open(n);
    await call(n, "claim", { action_key: "k", namespace_token: token });

    await call(n, "complete", {
      action_key: "k",
      namespace_token: token,
      result: { v: 1 },
    });
    const again = await call(n, "complete", {
      action_key: "k",
      namespace_token: token,
      result: { v: 2 },
    });

    expect(again.status).toBe(200);
    expect(again.json.status).toBe("already_completed");
    // The first result stands; a retry cannot overwrite a recorded outcome.
    expect(again.json.result).toEqual({ v: 1 });
  });

  it("refuses a result larger than the storage cap", async () => {
    const n = ns();
    const token = await open(n);
    await call(n, "claim", { action_key: "big", namespace_token: token });

    const res = await call(n, "complete", {
      action_key: "big",
      namespace_token: token,
      result: { blob: "x".repeat(17 * 1024) },
    });
    expect(res.status).toBe(413);
  });

  it("rejects completing a key that was never claimed", async () => {
    const n = ns();
    const token = await open(n);
    const res = await call(n, "complete", {
      action_key: "ghost",
      namespace_token: token,
    });
    expect(res.status).toBe(404);
  });
});

describe("OnceKey leases", () => {
  it("reports in_progress while another claimant holds a live lease", async () => {
    const n = ns();
    const token = await open(n);

    const first = await call(n, "claim", {
      action_key: "k",
      namespace_token: token,
      lease_ttl: 600,
    });
    expect(first.json.status).toBe("claimed");
    expect(typeof first.json.lease_expires_at).toBe("string");

    const second = await call(n, "claim", {
      action_key: "k",
      namespace_token: token,
      lease_ttl: 600,
    });
    expect(second.json.status).toBe("in_progress");
    expect(second.json.retry_after as number).toBeGreaterThan(0);
  });

  it("lets a new claimant take over once the lease has lapsed", async () => {
    const n = ns();
    const token = await open(n);

    await call(n, "claim", {
      action_key: "k",
      namespace_token: token,
      lease_ttl: 1,
    });
    await new Promise((r) => setTimeout(r, 1100));

    const taken = await call(n, "claim", {
      action_key: "k",
      namespace_token: token,
      lease_ttl: 600,
    });
    expect(taken.json.status).toBe("claimed");
    expect(taken.json.recovered).toBe(true);
  });

  it("does not let a crash loop extend the absolute expiry", async () => {
    const n = ns();
    const token = await open(n);

    const first = await call(n, "claim", {
      action_key: "k",
      namespace_token: token,
      ttl: 3600,
      lease_ttl: 1,
    });
    await new Promise((r) => setTimeout(r, 1100));

    const taken = await call(n, "claim", {
      action_key: "k",
      namespace_token: token,
      ttl: 3600,
      lease_ttl: 1,
    });
    expect(taken.json.expires_at).toBe(first.json.expires_at);
  });

  it("clamps a lease that would outlive the claim", async () => {
    const n = ns();
    const token = await open(n);

    const res = await call(n, "claim", {
      action_key: "k",
      namespace_token: token,
      ttl: 60,
      lease_ttl: 9999,
    });
    expect(res.json.lease_expires_at).toBe(res.json.expires_at);
  });

  it("holds an unleased claim rather than making it reclaimable", async () => {
    const n = ns();
    const token = await open(n);

    const first = await call(n, "claim", {
      action_key: "k",
      namespace_token: token,
    });
    expect(first.json.lease_expires_at).toBeUndefined();

    const second = await call(n, "claim", {
      action_key: "k",
      namespace_token: token,
    });
    expect(second.json.status).toBe("held");
  });

  it("never reports an unfinished claim as a completed duplicate", async () => {
    // The dangerous failure this guards against: a caller is told the action
    // already succeeded, skips its own side effect, and proceeds with no
    // result — so a charge that never happened looks like one that did.
    const n = ns();
    const token = await open(n);

    await call(n, "claim", { action_key: "k", namespace_token: token });

    const second = await call(n, "claim", {
      action_key: "k",
      namespace_token: token,
    });

    expect(second.json.status).not.toBe("duplicate");
    expect(second.json).not.toHaveProperty("result");
    expect(second.json.status).toBe("held");
  });

  it("only reports duplicate once a result actually exists", async () => {
    const n = ns();
    const token = await open(n);

    await call(n, "claim", { action_key: "k", namespace_token: token });
    await call(n, "complete", {
      action_key: "k",
      namespace_token: token,
      result: { charged: true },
    });

    const replay = await call(n, "claim", {
      action_key: "k",
      namespace_token: token,
    });
    expect(replay.json.status).toBe("duplicate");
    expect(replay.json.result).toEqual({ charged: true });
  });
});

describe("OnceKey release", () => {
  it("frees a failed claim for immediate retry", async () => {
    const n = ns();
    const token = await open(n);

    await call(n, "claim", {
      action_key: "k",
      namespace_token: token,
      lease_ttl: 600,
    });
    const released = await call(n, "release", {
      action_key: "k",
      namespace_token: token,
    });
    expect(released.json.status).toBe("released");

    const retry = await call(n, "claim", {
      action_key: "k",
      namespace_token: token,
      lease_ttl: 600,
    });
    expect(retry.json.status).toBe("claimed");
    expect(retry.json.recovered).toBeUndefined();
  });

  it("refuses to release a completed key", async () => {
    const n = ns();
    const token = await open(n);

    await call(n, "claim", { action_key: "k", namespace_token: token });
    await call(n, "complete", {
      action_key: "k",
      namespace_token: token,
      result: { ok: true },
    });

    const res = await call(n, "release", {
      action_key: "k",
      namespace_token: token,
    });
    // Releasing would discard the result and permit a second side effect.
    expect(res.status).toBe(409);
  });

  it("requires the namespace token", async () => {
    const n = ns();
    await open(n);
    const res = await call(n, "release", { action_key: "seed" });

    // 404, not 403: the free lifecycle actions deliberately do not reveal
    // whether a namespace exists, because that is a free oracle telling a
    // squatter which names are worth claiming. The claim action still
    // answers 403, where each probe costs a payment.
    expect(res.status).toBe(404);
  });

  it("is indistinguishable from an unclaimed namespace", async () => {
    const claimed = ns();
    await open(claimed);

    const wrongToken = await call(claimed, "release", { action_key: "seed" });
    const neverClaimed = await call(ns(), "release", { action_key: "seed" });

    expect(wrongToken.status).toBe(neverClaimed.status);
    expect(wrongToken.json).toEqual(neverClaimed.json);
  });
});
