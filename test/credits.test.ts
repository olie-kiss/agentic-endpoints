import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Credits } from "../src/durable-objects/credits";
import { hashToken } from "../src/lib/utils";

/** Reaches the account object directly; the buy route itself is paywalled. */
async function account(token: string) {
  const tokenHash = await hashToken(token);
  const id = env.CREDITS.idFromName(tokenHash);
  const stub = env.CREDITS.get(id);
  return { tokenHash, stub };
}

async function fund(token: string, micros: number) {
  const { tokenHash, stub } = await account(token);
  await runInDurableObject(stub, (instance: Credits) =>
    instance.open(tokenHash, micros),
  );
  return tokenHash;
}

describe("credit accounts", () => {
  it("grants the purchased balance", async () => {
    const tokenHash = await fund("tok-grant", 6_000_000);
    const { stub } = await account("tok-grant");

    const ledger = await runInDurableObject(stub, (i: Credits) =>
      i.balance(tokenHash),
    );
    expect(ledger?.balance_usd).toBe("6.000000");
    expect(ledger?.granted_usd).toBe("6.000000");
  });

  it("does not double-grant when a mint is retried", async () => {
    const tokenHash = await fund("tok-retry", 6_000_000);
    const { stub } = await account("tok-retry");

    // A retried purchase must not top the account up again, and must not
    // reset a balance the buyer has already spent against.
    await runInDurableObject(stub, (i: Credits) => i.spend(tokenHash, 1_000_000));
    await runInDurableObject(stub, (i: Credits) => i.open(tokenHash, 6_000_000));

    const ledger = await runInDurableObject(stub, (i: Credits) => i.balance(tokenHash));
    expect(ledger?.balance_usd).toBe("5.000000");
  });

  it("debits exactly the price with no rounding drift", async () => {
    const tokenHash = await fund("tok-drift", 1_000_000);
    const { stub } = await account("tok-drift");

    // 1000 calls at $0.001 must consume exactly $1.00, not $0.999999.
    for (let i = 0; i < 1000; i++) {
      await runInDurableObject(stub, (d: Credits) => d.spend(tokenHash, 1_000));
    }

    const ledger = await runInDurableObject(stub, (d: Credits) => d.balance(tokenHash));
    expect(ledger?.balance_micros).toBe(0);
    expect(ledger?.spent_usd).toBe("1.000000");
    expect(ledger?.call_count).toBe(1000);
  });

  it("refuses to overdraw", async () => {
    const tokenHash = await fund("tok-over", 5_000);
    const { stub } = await account("tok-over");

    const result = await runInDurableObject(stub, (i: Credits) =>
      i.spend(tokenHash, 10_000),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("insufficient");

    const ledger = await runInDurableObject(stub, (i: Credits) => i.balance(tokenHash));
    expect(ledger?.balance_micros).toBe(5_000);
  });

  it("cannot be spent with the wrong token", async () => {
    await fund("tok-owner", 5_000_000);
    const { stub } = await account("tok-owner");

    const result = await runInDurableObject(stub, (i: Credits) =>
      i.spend("0".repeat(64), 1_000),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("unknown");
  });

  it("restores credit on refund", async () => {
    const tokenHash = await fund("tok-refund", 1_000_000);
    const { stub } = await account("tok-refund");

    await runInDurableObject(stub, (i: Credits) => i.spend(tokenHash, 5_000));
    await runInDurableObject(stub, (i: Credits) => i.refund(tokenHash, 5_000));

    const ledger = await runInDurableObject(stub, (i: Credits) => i.balance(tokenHash));
    expect(ledger?.balance_micros).toBe(1_000_000);
    expect(ledger?.spent_usd).toBe("0.000000");
    expect(ledger?.call_count).toBe(0);
  });

  it("does not let a refund be forged with the wrong token", async () => {
    const tokenHash = await fund("tok-forge", 1_000_000);
    const { stub } = await account("tok-forge");

    await runInDurableObject(stub, (i: Credits) => i.spend(tokenHash, 500_000));
    await runInDurableObject(stub, (i: Credits) => i.refund("f".repeat(64), 500_000));

    const ledger = await runInDurableObject(stub, (i: Credits) => i.balance(tokenHash));
    expect(ledger?.balance_micros).toBe(500_000);
  });

  it("survives concurrent spends without overdrawing", async () => {
    const tokenHash = await fund("tok-race", 10_000);
    const { stub } = await account("tok-race");

    // Ten concurrent $0.005 calls against a $0.01 balance: at most two may win.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        runInDurableObject(stub, (i: Credits) => i.spend(tokenHash, 5_000)),
      ),
    );

    expect(results.filter((r) => r.ok).length).toBe(2);

    const ledger = await runInDurableObject(stub, (i: Credits) => i.balance(tokenHash));
    expect(ledger?.balance_micros).toBe(0);
  });
});

describe("paying with credits over HTTP", () => {
  it("rejects an unknown token rather than serving free work", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Credit-Token": "ae_nope" },
      body: JSON.stringify({ text: "hello world" }),
    });

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_credit_token");
  });

  it("reports insufficient balance with what it needed", async () => {
    await fund("ae_broke", 1);

    const res = await SELF.fetch("https://ai.oliverkiss.com/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Credit-Token": "ae_broke" },
      body: JSON.stringify({ text: "hello world" }),
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("insufficient_credit");
    expect(body.required_usd).toBe("0.005000");
  });

  it("serves the work and reports the new balance", async () => {
    await fund("ae_rich", 1_000_000);

    const res = await SELF.fetch("https://ai.oliverkiss.com/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Credit-Token": "ae_rich" },
      body: JSON.stringify({ text: "the quick brown fox jumps over the lazy dog. ".repeat(20) }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Credit-Charged")).toBe("0.005000");
    expect(res.headers.get("X-Credit-Balance")).toBe("0.995000");
  });

  it("leaves per-call x402 completely untouched", async () => {
    // No credit header: the existing payment gate must behave exactly as before.
    const res = await SELF.fetch("https://ai.oliverkiss.com/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    expect([402, 503]).toContain(res.status);
    expect(res.headers.get("X-Credit-Charged")).toBeNull();
  });

  it("advertises prepayment on the payment challenge", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/once-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "n", action_key: "k" }),
    });

    if (res.status === 402) {
      expect(res.headers.get("X-Credits-Available")).toContain("/credits/buy");
    }
  });

  it("exposes a balance to its holder and nobody else", async () => {
    await fund("ae_check", 2_500_000);

    const ok = await SELF.fetch("https://ai.oliverkiss.com/credits/balance", {
      method: "POST",
      headers: { "X-Credit-Token": "ae_check" },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).balance_usd).toBe("2.500000");

    const bad = await SELF.fetch("https://ai.oliverkiss.com/credits/balance", {
      method: "POST",
      headers: { "X-Credit-Token": "ae_not_a_real_token" },
    });
    expect(bad.status).toBe(404);
  });

  it("keeps the credit packs themselves behind real payment", async () => {
    // Selling credit for credit would let a token mint its own successor.
    const res = await SELF.fetch("https://ai.oliverkiss.com/credits/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Credit-Token": "ae_rich" },
      body: "{}",
    });

    expect([402, 503]).toContain(res.status);
  });
});
