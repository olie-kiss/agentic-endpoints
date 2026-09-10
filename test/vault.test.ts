import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Credits } from "../src/durable-objects/credits";
import { hashToken } from "../src/lib/utils";

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
    // 200, because a 4xx would cancel x402 settlement and make namespace
    // probing free. Denial is carried in the body.
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("forbidden");
  });

  it("does not leak values to an unauthorized reader", async () => {
    const n = ns();
    await claimed(n);
    const res = await vault(n, "/retrieve", { key: "seed" });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("forbidden");
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

  it("charges unauthenticated callers instead of handing them a free oracle", async () => {
    const n = ns();
    await claimed(n);

    // This deliberately reverses an earlier rule ("no work was done, so
    // cancelling settlement is correct"). Checking the token IS the work,
    // exactly as comparing is the work for precondition_failed above.
    //
    // A 4xx cancels x402 settlement and leaves the X-PAYMENT header
    // replayable, so one signature funds unlimited probing for which
    // namespaces exist -- the reconnaissance step before squatting one, and
    // squatting is unrecoverable by design. Charging is what makes guessing
    // expensive. The cost is that a legitimate caller with a stale token pays
    // to find out; that is the cheaper of the two failures.
    const res = await vault(n, "/retrieve", { key: "seed" });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("forbidden");
    // What must never change: denial still yields nothing.
    expect(JSON.stringify(res.json)).not.toContain("seed-value");
  });
});

describe("vault token rotation", () => {
  it("issues a new token and invalidates the old one", async () => {
    const n = ns();
    const old = await claimed(n);

    const res = await vault(n, "/rotate-token", { namespace_token: old });
    expect(res.status).toBe(200);

    const fresh = res.json.namespace_token as string;
    expect(typeof fresh).toBe("string");
    expect(fresh).not.toBe(old);

    // The point of rotating is that a leaked token stops working.
    const withOld = await vault(n, "/retrieve", {
      key: "seed",
      namespace_token: old,
    });
    expect(withOld.status).toBe(200);
    expect(withOld.json.status).toBe("forbidden");
    expect(JSON.stringify(withOld.json)).not.toContain("seed-value");

    const withNew = await vault(n, "/retrieve", {
      key: "seed",
      namespace_token: fresh,
    });
    expect(withNew.json.status).toBe("retrieved");
  });

  it("requires the current token to rotate", async () => {
    const n = ns();
    await claimed(n);

    // Otherwise rotation is itself the takeover primitive it defends against.
    const res = await vault(n, "/rotate-token", {
      namespace_token: "not-the-token",
    });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("forbidden");
    // The critical part: a failed rotation must not mint a token.
    expect(res.json.namespace_token).toBeUndefined();
  });

  it("leaves the stored items intact", async () => {
    const n = ns();
    const old = await claimed(n);
    const fresh = (await vault(n, "/rotate-token", { namespace_token: old }))
      .json.namespace_token as string;

    const got = await vault(n, "/retrieve", {
      key: "seed",
      namespace_token: fresh,
    });
    expect(got.json.ciphertext).toBe("seed-value");
  });
});

describe("vault compare-and-swap", () => {
  it("rejects a write based on a stale version", async () => {
    const n = ns();
    const token = await claimed(n);

    const first = await vault(n, "/store", {
      key: "rotating-secret",
      ciphertext: "v1",
      namespace_token: token,
    });
    const version = first.json.updated_at as string;

    // Someone else writes in between.
    await vault(n, "/store", {
      key: "rotating-secret",
      ciphertext: "v2",
      namespace_token: token,
    });

    const stale = await vault(n, "/store", {
      key: "rotating-secret",
      ciphertext: "v3-from-stale-read",
      namespace_token: token,
      if_match: version,
    });

    // 200, not 412: this is a paid route and comparing is the work.
    expect(stale.status).toBe(200);
    expect(stale.json.status).toBe("precondition_failed");

    const current = await vault(n, "/retrieve", {
      key: "rotating-secret",
      namespace_token: token,
    });
    expect(current.json.ciphertext).toBe("v2");
  });

  it("gives every write a distinct version, even within one millisecond", async () => {
    const n = ns();
    const token = await claimed(n);

    // updated_at doubles as the if_match version token, and Date.now() only
    // has millisecond resolution. Back-to-back writes land in the same
    // millisecond, and if they share a stamp a stale if_match compares equal
    // and is silently accepted -- losing the write CAS exists to protect.
    // This loop is what made the CAS test flaky rather than merely wrong.
    const versions: string[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await vault(n, "/store", {
        key: "hot",
        ciphertext: `v${i}`,
        namespace_token: token,
      });
      expect(res.status).toBe(200);
      versions.push(String(res.json.updated_at));
    }

    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 1; i < versions.length; i++) {
      expect(Date.parse(versions[i])).toBeGreaterThan(
        Date.parse(versions[i - 1]),
      );
    }

    // The very first version must still be rejected after all those writes.
    const stale = await vault(n, "/store", {
      key: "hot",
      ciphertext: "clobber",
      namespace_token: token,
      if_match: versions[0],
    });
    expect(stale.json.status).toBe("precondition_failed");

    const current = await vault(n, "/retrieve", {
      key: "hot",
      namespace_token: token,
    });
    expect(current.json.ciphertext).toBe("v24");
  });

  it("allows a write on the current version", async () => {
    const n = ns();
    const token = await claimed(n);

    const first = await vault(n, "/store", {
      key: "k",
      ciphertext: "v1",
      namespace_token: token,
    });

    const res = await vault(n, "/store", {
      key: "k",
      ciphertext: "v2",
      namespace_token: token,
      if_match: first.json.updated_at as string,
    });
    expect(res.json.status).toBe("stored");
  });

  it("supports create-only writes", async () => {
    const n = ns();
    const token = await claimed(n);

    const created = await vault(n, "/store", {
      key: "new-key",
      ciphertext: "v1",
      namespace_token: token,
      if_absent: true,
    });
    expect(created.json.status).toBe("stored");

    const again = await vault(n, "/store", {
      key: "new-key",
      ciphertext: "clobber",
      namespace_token: token,
      if_absent: true,
    });
    expect(again.json.status).toBe("precondition_failed");
  });

  it("leaves unconditional writes as last-write-wins", async () => {
    const n = ns();
    const token = await claimed(n);

    await vault(n, "/store", { key: "k", ciphertext: "a", namespace_token: token });
    const res = await vault(n, "/store", {
      key: "k",
      ciphertext: "b",
      namespace_token: token,
    });
    expect(res.json.status).toBe("stored");
  });
});

describe("vault listing", () => {
  it("returns keys and versions but never ciphertext", async () => {
    const n = ns();
    const token = await claimed(n);
    await vault(n, "/store", {
      key: "second",
      ciphertext: "super-secret",
      namespace_token: token,
    });

    const res = await vault(n, "/list", { namespace_token: token });
    expect(res.status).toBe(200);
    expect(res.json.count).toBe(2);

    const body = JSON.stringify(res.json);
    // Listing is $0.001; retrieving is $0.02. Leaking the value here would
    // undercut the expensive route and hand out secrets cheaply.
    expect(body).not.toContain("super-secret");

    const keys = (res.json.items as { key: string; updated_at: string }[]).map(
      (i) => i.key,
    );
    expect(keys).toEqual(["second", "seed"]);
    // updated_at doubles as the if_match version.
    expect(typeof (res.json.items as any[])[0].updated_at).toBe("string");
  });

  it("refuses to list without the namespace token", async () => {
    const n = ns();
    await claimed(n);
    const res = await vault(n, "/list", {});
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("forbidden");
    expect(res.json.keys).toBeUndefined();
  });
});

/**
 * The compare-and-swap suite above drives the Durable Object directly, so it
 * proved a guarantee no caller could actually reach: /vault/store forwarded a
 * hand-listed set of fields and if_match/if_absent were not among them, so the
 * DO always saw them undefined and every conditional write quietly degraded to
 * last-write-wins. These go through the real HTTP route instead.
 */
describe("compare-and-swap survives the HTTP route", () => {
  /** The buy route is itself paywalled, so open the account object directly. */
  async function payingToken(token: string, micros = 5_000_000) {
    const tokenHash = await hashToken(token);
    const stub = env.CREDITS.get(env.CREDITS.idFromName(tokenHash));
    await runInDurableObject(stub, (i: Credits) => i.open(tokenHash, micros));
    return token;
  }

  function store(token: string, body: Record<string, unknown>) {
    return SELF.fetch("https://ai.oliverkiss.com/vault/store", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Credit-Token": token },
      body: JSON.stringify(body),
    });
  }

  it("refuses to overwrite an existing key when if_absent is set", async () => {
    const token = await payingToken("tok-cas-absent");
    const namespace = "cas-http-absent-4f9c2ad1e6b74c08";

    const first = await store(token, {
      namespace,
      key: "k",
      ciphertext: "one",
    });
    const claimed = await first.json();
    expect(claimed.status).toBe("stored");

    const second = await store(token, {
      namespace,
      key: "k",
      ciphertext: "two",
      namespace_token: claimed.namespace_token,
      if_absent: true,
    });

    expect((await second.json()).status).toBe("precondition_failed");
  });

  it("refuses a stale if_match rather than clobbering the newer value", async () => {
    const token = await payingToken("tok-cas-match");
    const namespace = "cas-http-match-0b3e71fa9d2c48e5";

    const first = await store(token, { namespace, key: "k", ciphertext: "one" });
    const claimed = await first.json();
    const staleVersion = claimed.updated_at;
    expect(staleVersion).toBeTruthy();

    await store(token, {
      namespace,
      key: "k",
      ciphertext: "two",
      namespace_token: claimed.namespace_token,
    });

    const stale = await store(token, {
      namespace,
      key: "k",
      ciphertext: "three",
      namespace_token: claimed.namespace_token,
      if_match: staleVersion,
    });

    expect((await stale.json()).status).toBe("precondition_failed");
  });

  it("accepts an if_match that is still current", async () => {
    const token = await payingToken("tok-cas-current");
    const namespace = "cas-http-current-7a1d4e60c8b2495f";

    const first = await store(token, { namespace, key: "k", ciphertext: "one" });
    const claimed = await first.json();

    const next = await store(token, {
      namespace,
      key: "k",
      ciphertext: "two",
      namespace_token: claimed.namespace_token,
      if_match: claimed.updated_at,
    });

    expect((await next.json()).status).toBe("stored");
  });
});

/**
 * Rotation used to re-check ownership by calling isOwner() a second time, which
 * does not close the race it was written for: isOwner samples the owner hash on
 * entry and only then awaits hashToken, so two concurrent rotations both compare
 * against the same pre-await snapshot and both are told they succeeded. Only the
 * last write survives, and there is deliberately no recovery path — so the loser
 * is locked out holding a token this service confirmed as valid.
 *
 * Honest caveat: this test cannot force that interleaving. The Durable Object
 * input gate serialises these requests, so it passes against the old code too.
 * It stands as an invariant guard, not as proof of the fix. The fix itself --
 * making the write conditional on the hash it authorised against -- is what
 * closes the hole, and it costs nothing if the gate never opens.
 */
describe("concurrent token rotation", () => {
  it("confirms at most one rotation, and the confirmed token is the one that works", async () => {
    const namespace = ns();
    const token = await claimed(namespace);

    const rotations = await Promise.all(
      Array.from({ length: 5 }, () =>
        vault(namespace, "/rotate-token", { namespace_token: token }),
      ),
    );

    const rotated = rotations.filter((r) => r.json.status === "rotated");
    expect(rotated.length).toBe(1);

    // Every token this service handed back must actually open the namespace.
    for (const winner of rotated) {
      const check = await vault(namespace, "/exists", {
        key: "seed",
        namespace_token: winner.json.namespace_token,
      });
      expect(check.json.status).not.toBe("forbidden");
    }

    // The old token is gone. A rejection is reported as 200 with a
    // "forbidden" status on purpose: any 4xx would cancel x402 settlement
    // and leave the payment header replayable.
    const stale = await vault(namespace, "/exists", {
      key: "seed",
      namespace_token: token,
    });
    expect(stale.json.status).toBe("forbidden");
  });
});
