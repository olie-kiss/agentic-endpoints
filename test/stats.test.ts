import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Stats } from "../src/durable-objects/stats";
import { classify } from "../src/index";

function ledger(name: string) {
  return env.STATS.get(env.STATS.idFromName(name));
}

describe("how a request is counted", () => {
  it("treats an unpaid 402 as a challenge, not an error", () => {
    // The distinction the whole funnel rests on: a 402 is the normal, expected
    // first response to every paying customer, not a failure.
    expect(classify("/scrape", 402, true)?.outcome).toBe("challenged");
  });

  it("treats a served paid route as a sale", () => {
    expect(classify("/scrape", 200, true)?.outcome).toBe("paid");
  });

  it("separates free traffic from paid", () => {
    expect(classify("/", 200, false)?.outcome).toBe("free");
    expect(classify("/mcp", 200, false)?.outcome).toBe("free");
  });

  it("counts non-payment failures as errors", () => {
    expect(classify("/scrape", 400, true)?.outcome).toBe("error");
    expect(classify("/scrape", 500, true)?.outcome).toBe("error");
  });

  it("ignores the owner checking on the service", () => {
    // Otherwise the endpoints that answer "is anyone using this" would
    // guarantee the answer was always yes.
    expect(classify("/stats", 200, false)).toBeNull();
    expect(classify("/revenue", 200, false)).toBeNull();
    expect(classify("/health", 200, false)).toBeNull();
  });

  it("collapses unknown paths into a single bucket", () => {
    // Bucketing is what stops a stranger growing the table without bound, for
    // free, by requesting random URLs.
    expect(classify("/wp-admin.php", 404, false)?.bucket).toBe("other");
    expect(classify("/nope", 404, false)?.bucket).toBe("other");
    expect(classify("/scrape", 402, true)?.bucket).toBe("/scrape");
  });
});

describe("the demand ledger", () => {
  it("separates 'nobody asked' from 'nobody bought'", async () => {
    const stub = ledger("funnel");

    // Nothing recorded yet: conversion must be null, not 0%. A service nobody
    // has found and a service nobody will buy need opposite fixes, and
    // reporting both as 0% is how you spend a month solving the wrong one.
    let summary = await runInDurableObject(stub, (i: Stats) => i.summary());
    expect(summary.conversion).toBeNull();
    expect(summary.totals.requests).toBe(0);

    await runInDurableObject(stub, async (i: Stats) => {
      for (let n = 0; n < 4; n++) await i.record("/scrape", "challenged");
      await i.record("/scrape", "paid");
    });

    summary = await runInDurableObject(stub, (i: Stats) => i.summary());
    expect(summary.totals.challenged).toBe(4);
    expect(summary.totals.paid).toBe(1);
    expect(summary.conversion).toBe("25.00%");
  });

  it("accumulates rather than overwriting", async () => {
    const stub = ledger("accumulate");
    await runInDurableObject(stub, async (i: Stats) => {
      await i.record("/compress", "paid");
      await i.record("/compress", "paid");
      await i.record("/once-key", "paid");
    });

    const summary = await runInDurableObject(stub, (i: Stats) => i.summary());
    expect(summary.totals.paid).toBe(3);
    expect(summary.by_path["/compress"].paid).toBe(2);
    expect(summary.by_path["/once-key"].paid).toBe(1);
  });

  it("records when activity started and last happened", async () => {
    const stub = ledger("seen");
    await runInDurableObject(stub, (i: Stats) => i.record("/compress", "paid"));

    const summary = await runInDurableObject(stub, (i: Stats) => i.summary());
    expect(summary.first_seen).not.toBeNull();
    expect(summary.last_seen).not.toBeNull();
  });
});

describe("the public summary", () => {
  it("is served as proof the service is alive", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/stats");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("totals");
    expect(body).toHaveProperty("conversion");
  });

  it("leaks nothing about who the callers are", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/stats");
    const text = await res.text();

    // Aggregates only. No credit tokens, no wallet addresses, no bodies.
    expect(text).not.toContain("ae_");
    expect(text).not.toContain("0x");
  });
});
