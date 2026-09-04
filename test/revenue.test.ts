import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  EMPTY_STATE,
  formatUsdc,
  readState,
  recordFailure,
  scanForPayments,
  shouldAlertOnFailure,
} from "../src/lib/revenue";

describe("USDC formatting", () => {
  it("converts base units without float drift", () => {
    expect(formatUsdc(1_000_000n)).toBe(1);
    expect(formatUsdc(1n)).toBe(0.000001);
    expect(formatUsdc(0n)).toBe(0);
    expect(formatUsdc(5_000n)).toBe(0.005);
  });

  it("stays exact on amounts that break naive division", () => {
    // 0.1 + 0.2 style drift: the sum of these must land on a clean cent.
    expect(formatUsdc(100_000n) + formatUsdc(200_000n)).toBeCloseTo(0.3, 9);
    expect(formatUsdc(123_456_789n)).toBe(123.456789);
  });

  it("handles amounts beyond Number.MAX_SAFE_INTEGER base units", () => {
    expect(formatUsdc(9_007_199_254_740_993_000_000n)).toBe(9007199254740993);
  });
});

describe("revenue state", () => {
  it("reports an empty ledger before any scan", async () => {
    const state = await readState(env);
    expect(state.paymentCount).toBe(0);
    expect(state.totalUsdc).toBe(0);
    expect(state.firstPaymentAt).toBeNull();
    expect(state.recent).toEqual([]);
  });

  it("starts the watermark at the chain head instead of genesis", async () => {
    const { state, newPayments } = await scanForPayments(env);

    // A first run must not claim historical payments, and must not attempt to
    // scan millions of blocks through a public RPC node.
    expect(newPayments).toEqual([]);
    expect(state.lastBlock).toBeGreaterThan(30_000_000);
    expect(state.paymentCount).toBe(0);

    const persisted = await readState(env);
    expect(persisted.lastBlock).toBe(state.lastBlock);
  });
});

describe("GET /revenue", () => {
  it("publishes the ledger for free", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/revenue");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.asset).toBe("USDC");
    expect(body.network).toBe("base-mainnet");
    expect(body.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(body.explorer).toContain("basescan.org");
    expect(typeof body.lifetime_usdc).toBe("number");
  });
});

describe("monitor health", () => {
  it("records a failure durably instead of only logging it", async () => {
    const before = await readState(env);
    const after = await recordFailure(env, new Error("RPC exploded"));

    expect(after.consecutiveFailures).toBe(before.consecutiveFailures + 1);
    expect(after.lastError).toBe("RPC exploded");
    expect(after.lastRunAt).not.toBeNull();

    // Must survive the invocation that hit it.
    const reread = await readState(env);
    expect(reread.lastError).toBe("RPC exploded");
  });

  it("does not advance the watermark on failure, so nothing is skipped", async () => {
    const before = await readState(env);
    const after = await recordFailure(env, new Error("boom"));
    expect(after.lastBlock).toBe(before.lastBlock);
  });

  it("stays quiet on a blip but escalates a sustained outage", async () => {
    expect(shouldAlertOnFailure({ ...EMPTY_STATE, consecutiveFailures: 1 })).toBe(false);
    expect(shouldAlertOnFailure({ ...EMPTY_STATE, consecutiveFailures: 2 })).toBe(false);
    expect(shouldAlertOnFailure({ ...EMPTY_STATE, consecutiveFailures: 3 })).toBe(true);

    // Re-nags periodically rather than once, but not on every single tick.
    expect(shouldAlertOnFailure({ ...EMPTY_STATE, consecutiveFailures: 4 })).toBe(false);
    expect(shouldAlertOnFailure({ ...EMPTY_STATE, consecutiveFailures: 6 })).toBe(true);
  });

  it("clears the failure streak once a sweep succeeds", async () => {
    await recordFailure(env, new Error("transient"));
    expect((await readState(env)).consecutiveFailures).toBeGreaterThan(0);

    const { state } = await scanForPayments(env);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastError).toBeNull();
    expect(state.lastSuccessAt).not.toBeNull();
  });

  it("distinguishes a broken watcher from a quiet one on /revenue", async () => {
    await recordFailure(env, new Error("RPC down"));

    const res = await SELF.fetch("https://ai.oliverkiss.com/revenue");
    const body = await res.json();

    // Both cases report zero revenue; only this field tells them apart.
    expect(body.lifetime_usdc).toBe(0);
    expect(body.monitor.healthy).toBe(false);
    expect(body.monitor.last_error).toBe("RPC down");
  });
});
