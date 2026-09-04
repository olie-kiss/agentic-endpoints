import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { withinRateLimit } from "../src/index";
import { Credits } from "../src/durable-objects/credits";
import { hashToken } from "../src/lib/utils";
import type { Env } from "../src/types";

/**
 * The free limiter is driven directly rather than by sending 60 real requests:
 * rate limiter state is shared across a worker instance, so exhausting it for
 * real would silently break every other test in the file.
 */
function limiters(free: boolean, paid: boolean) {
  const calls = { free: 0, paid: 0 };
  return {
    calls,
    bindings: {
      FREE_RATE_LIMITER: {
        limit: async () => {
          calls.free++;
          return { success: free };
        },
      },
      PAID_RATE_LIMITER: {
        limit: async () => {
          calls.paid++;
          return { success: paid };
        },
      },
    },
  };
}

function withEnv(overrides: Record<string, unknown>): Env {
  return { ...env, ...overrides } as unknown as Env;
}

function req(token?: string) {
  return new Request("https://ai.oliverkiss.com/compress", {
    method: "POST",
    headers: token ? { "X-Credit-Token": token } : {},
  });
}

async function fund(token: string, micros: number) {
  const tokenHash = await hashToken(token);
  const stub = env.CREDITS.get(env.CREDITS.idFromName(tokenHash));
  await runInDurableObject(stub, (i: Credits) => i.open(tokenHash, micros));
}

describe("rate limiting tiers", () => {
  it("lets anyone through while under the anonymous limit", async () => {
    const { bindings, calls } = limiters(true, true);
    expect(await withinRateLimit(req(), withEnv(bindings), "1.1.1.1")).toBe(true);

    // The ledger must not be consulted on the happy path; that would put a
    // storage read in front of every single request to the service.
    expect(calls.paid).toBe(0);
  });

  it("throttles anonymous callers over the limit", async () => {
    const { bindings } = limiters(false, true);
    expect(await withinRateLimit(req(), withEnv(bindings), "1.1.1.1")).toBe(false);
  });

  it("keeps serving a customer who prepaid", async () => {
    await fund("rl-funded", 25_000_000);
    const { bindings } = limiters(false, true);

    // The whole point: $25 in credit should not be throttled like anonymous
    // traffic once the anonymous budget is spent.
    expect(
      await withinRateLimit(req("rl-funded"), withEnv(bindings), "1.1.1.1"),
    ).toBe(true);
  });

  it("does not let an invented token buy a higher limit", async () => {
    const { bindings } = limiters(false, true);

    // The header is attacker-controlled and free to make up. If merely
    // presenting one were enough, the rate limit would be optional for
    // everybody who read the docs.
    expect(
      await withinRateLimit(req("ae_totally-made-up"), withEnv(bindings), "1.1.1.1"),
    ).toBe(false);
  });

  it("does not give a drained account the paid tier", async () => {
    await fund("rl-empty", 0);
    const { bindings } = limiters(false, true);

    expect(
      await withinRateLimit(req("rl-empty"), withEnv(bindings), "1.1.1.1"),
    ).toBe(false);
  });

  it("caps how many ledger lookups one address can force", async () => {
    const { bindings, calls } = limiters(false, false);

    // Without this bound, a forged token would buy an unbounded number of
    // storage reads for the price of one HTTP header.
    expect(
      await withinRateLimit(req("ae_made-up"), withEnv(bindings), "1.1.1.1"),
    ).toBe(false);
    expect(calls.paid).toBe(1);
  });

  it("fails closed when the ledger cannot be read", async () => {
    const { bindings } = limiters(false, true);
    const broken = withEnv({
      ...bindings,
      CREDITS: {
        idFromName: () => {
          throw new Error("storage unavailable");
        },
      },
    });

    expect(await withinRateLimit(req("rl-funded"), broken, "1.1.1.1")).toBe(false);
  });
});
