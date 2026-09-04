import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { formatUsdc, readState, scanForPayments } from "../src/lib/revenue";

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
