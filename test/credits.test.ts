import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Credits } from "../src/durable-objects/credits";
import { statsStub } from "../src/index";
import type { Env } from "../src/types";
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

  it(
    "debits exactly the price with no rounding drift",
    async () => {
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
    },
    // 1000 separate round-trips through the test harness land around 4.8s,
    // close enough to vitest's 5s default that this failed intermittently and
    // made the whole suite untrustworthy as a gate.
    //
    // The loop is deliberately not collapsed into a single runInDurableObject
    // call. That would be far faster, but real calls arrive as separate
    // invocations, and drift that only appears across invocation boundaries is
    // exactly the kind this test exists to catch. The runtime is the price of
    // testing the real shape, so the timeout is raised instead.
    30_000,
  );

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

    // Rejected loudly, not quietly. A forged refund is either an attack or a
    // bug, and either way it leaves a real charge unreversed, so it must not
    // be possible for one to pass without anyone noticing.
    await expect(
      runInDurableObject(stub, (i: Credits) =>
        i.refund("f".repeat(64), 500_000),
      ),
    ).rejects.toThrow(/does not match/i);

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

    const overdrawn = await runInDurableObject(stub, (i: Credits) =>
      i.balance(tokenHash),
    );
    expect(overdrawn?.balance_micros).toBe(0);
  });

  it("lets every concurrent spend through when the balance covers them all", async () => {
    const tokenHash = await fund("tok-race-funded", 1_000_000);
    const { stub } = await account("tok-race-funded");

    // The sibling test above proves concurrency cannot overdraw. This proves
    // the opposite half, which is what the docs promise: credits are the
    // answer to the facilitator refusing overlapping x402 authorizations from
    // one payer, so concurrent credit debits must not fail spuriously. If
    // they did, the documented workaround would be advice to fail differently.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        runInDurableObject(stub, (i: Credits) => i.spend(tokenHash, 5_000)),
      ),
    );

    expect(results.filter((r) => r.ok).length).toBe(20);

    const ledger = await runInDurableObject(stub, (i: Credits) => i.balance(tokenHash));
    expect(ledger?.balance_micros).toBe(900_000);
    expect(ledger?.call_count).toBe(20);
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

  it("does not bill a credit customer for a request it refused", async () => {
    await fund("ae_refund", 1_000_000);

    // Malformed body: /compress needs `text`. Nothing is served here.
    const res = await SELF.fetch("https://ai.oliverkiss.com/compress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Credit-Token": "ae_refund",
      },
      body: JSON.stringify({ not_text: 1 }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);

    // An x402 caller gets this same 4xx for nothing, because settlement is
    // cancelled above 399. Billing it here would charge the customer who
    // committed money up front for an error the per-call customer gets free.
    const { tokenHash, stub } = await account("ae_refund");
    const ledger = await runInDurableObject(stub, (i: Credits) =>
      i.balance(tokenHash),
    );
    expect(ledger?.balance_usd).toBe("1.000000");
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

  it("answers the balance_url it advertises with the verb that URL implies", async () => {
    // /credits/trial, /credits/buy and the legal page all hand out
    // `balance_url`. A URL named that way gets fetched, and GET used to 404 —
    // which reads as "the endpoint you were just told about does not exist".
    await fund("ae_get_check", 1_000_000);

    const got = await SELF.fetch("https://ai.oliverkiss.com/credits/balance", {
      headers: { "X-Credit-Token": "ae_get_check" },
    });
    expect(got.status).toBe(200);
    expect((await got.json()).balance_usd).toBe("1.000000");
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

/**
 * For thirty hours this service published "GET" as the way to call these
 * endpoints, because the bazaar extension echoes back whichever method the
 * asking crawler used. A buyer that believed us paid, landed on a route that
 * only accepts POST, and got a 404.
 *
 * The refund machinery did its job -- nobody was billed for nothing -- which
 * is exactly why this was invisible: no angry customer, no failed settlement,
 * no error in the logs. Just a sale that quietly did not happen.
 */
describe("paying with the wrong method", () => {
  it("delivers and bills on POST, and neither on GET", async () => {
    const token = "tok-method-regression";
    const tokenHash = await fund(token, 5_000_000);

    const call = (method: string) =>
      SELF.fetch("https://ai.oliverkiss.com/compress", {
        method,
        headers: { "Content-Type": "application/json", "X-Credit-Token": token },
        ...(method === "GET"
          ? {}
          : { body: JSON.stringify({ text: "a sentence long enough to compress" }) }),
      });

    const posted = await call("POST");
    expect(posted.status).toBe(200);

    const got = await call("GET");
    expect(got.status).toBe(404);

    // Charged exactly once: for the call that actually did the work.
    const { stub } = await account(token);
    const ledger = await runInDurableObject(stub, (i: Credits) =>
      i.balance(tokenHash),
    );
    expect(ledger?.call_count).toBe(1);
    expect(ledger?.balance_micros).toBe(4_995_000);
  });
});

/**
 * The regression above proves the wrong method loses the sale. This proves we
 * would now SEE it: the failure that hid for thirty hours was invisible
 * because the attempt was recorded without its outcome.
 */
describe("a lost sale is visible afterwards", () => {
  it("records the 404 a wrong-method buyer received", async () => {
    const token = "tok-observed-failure";
    await fund(token, 5_000_000);

    await SELF.fetch("https://ai.oliverkiss.com/compress", {
      method: "GET",
      headers: { "Content-Type": "application/json", "X-Credit-Token": token },
    });

    const summary = await statsStub(env as unknown as Env).summary();
    const failure = summary.buyer_signals.recent.find(
      (e) => e.path === "/compress" && e.status === 404,
    );

    expect(failure).toBeDefined();
    expect(failure?.signal).toBe("credit_use");
  });
});

describe("free evaluation credit", () => {
  /**
   * The trial is unauthenticated and gives away real balance, so the tests
   * that matter are the ones about what it refuses to do twice.
   */
  const ip = (v: string) => ({ "CF-Connecting-IP": v });

  it("issues a working balance with no account, and the token actually buys", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/credits/trial", {
      method: "POST",
      headers: ip("203.0.113.10"),
    });
    expect(res.status).toBe(200);

    const body = await res.json<{
      credit_token: string;
      balance_usd: string;
      trial: boolean;
      exhausted: boolean;
    }>();
    expect(body.trial).toBe(true);
    expect(body.exhausted).toBe(false);
    expect(body.balance_usd).toBe("0.100000");
    expect(body.credit_token).toMatch(/^ae_trial_[0-9a-f]{64}$/);

    // The point of the endpoint is not that it returns a token; it is that an
    // agent holding one receives real work without ever funding a wallet.
    const work = await SELF.fetch("https://ai.oliverkiss.com/compress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Credit-Token": body.credit_token,
      },
      body: JSON.stringify({
        text: "Revenue rose sharply in the third quarter. ".repeat(80),
        target_tokens: 20,
      }),
    });
    expect(work.status).toBe(200);

    // Asserting the actual contract: the answer is cut to the requested
    // budget and is still real text, not merely that a 200 came back.
    const out = await work.json<{
      text: string;
      original_length: number;
      compressed_length: number;
    }>();
    expect(out.text).toBeTruthy();
    expect(out.compressed_length).toBeLessThan(out.original_length);
    expect(out.compressed_length).toBeLessThanOrEqual(20 * 4);
    expect(out.text).toContain("Revenue");
  });

  it("does not hand the same caller a second allowance", async () => {
    const claim = async () =>
      (
        await SELF.fetch("https://ai.oliverkiss.com/credits/trial", {
          method: "POST",
          headers: ip("203.0.113.20"),
        })
      ).json<{ credit_token: string; balance_usd: string }>();

    const first = await claim();

    // Spend it down, then ask again. A refill here would be an unlimited
    // free tier wearing a cap.
    const { tokenHash, stub } = await account(first.credit_token);
    await runInDurableObject(stub, (i: Credits) => i.spend(tokenHash, 60_000));

    const second = await claim();
    expect(second.credit_token).toBe(first.credit_token);
    expect(second.balance_usd).toBe("0.040000");
  });

  it("gives different callers their own allowance", async () => {
    const one = await (
      await SELF.fetch("https://ai.oliverkiss.com/credits/trial", {
        method: "POST",
        headers: ip("203.0.113.30"),
      })
    ).json<{ credit_token: string }>();
    const two = await (
      await SELF.fetch("https://ai.oliverkiss.com/credits/trial", {
        method: "POST",
        headers: ip("203.0.113.31"),
      })
    ).json<{ credit_token: string }>();

    expect(one.credit_token).not.toBe(two.credit_token);
  });

  it("treats an IPv6 /64 as one caller", async () => {
    // A single machine is routinely handed every address in a /64, so issuing
    // per full address would be an unbounded supply of free allowances.
    const a = await (
      await SELF.fetch("https://ai.oliverkiss.com/credits/trial", {
        method: "POST",
        headers: ip("2001:db8:abcd:1234:1::1"),
      })
    ).json<{ credit_token: string }>();
    const b = await (
      await SELF.fetch("https://ai.oliverkiss.com/credits/trial", {
        method: "POST",
        headers: ip("2001:db8:abcd:1234:ffff:ffff:ffff:ffff"),
      })
    ).json<{ credit_token: string }>();

    expect(b.credit_token).toBe(a.credit_token);
  });
});
