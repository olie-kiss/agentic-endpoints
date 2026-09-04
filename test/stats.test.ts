import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Stats } from "../src/durable-objects/stats";

function statsInstance() {
  return env.STATS.get(env.STATS.idFromName("global"));
}

describe("demand telemetry", () => {
  it("separates 'nobody asked' from 'everybody refused to pay'", async () => {
    const stub = env.STATS.get(env.STATS.idFromName("funnel-test"));

    // Nothing recorded yet. Conversion must be null, not 0% — a service
    // nobody has found and a service nobody will buy need opposite fixes,
    // and reporting both as 0% is how you spend a month solving the wrong one.
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

  it("records first and last activity", async () => {
    const stub = env.STATS.get(env.STATS.idFromName("seen-test"));
    await runInDurableObject(stub, (i: Stats) => i.record("/compress", "paid"));

    const summary = await runInDurableObject(stub, (i: Stats) => i.summary());
    expect(summary.first_seen).not.toBeNull();
    expect(summary.last_seen).not.toBeNull();
  });

  it("counts a real unpaid request as a challenge", async () => {
    const before = await runInDurableObject(statsInstance(), (i: Stats) =>
      i.summary(),
    );

    const res = await SELF.fetch("https://ai.oliverkiss.com/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello world" }),
    });
    expect(res.status).toBe(402);

    const after = await runInDurableObject(statsInstance(), (i: Stats) =>
      i.summary(),
    );
    expect(after.totals.challenged).toBeGreaterThan(before.totals.challenged);
  });

  it("does not count the owner checking on the service", async () => {
    // /stats and /revenue exist to answer "is anyone using this". If looking
    // at them counted as usage, they would always say yes.
    const before = await runInDurableObject(statsInstance(), (i: Stats) =>
      i.summary(),
    );

    await SELF.fetch("https://ai.oliverkiss.com/stats");
    await SELF.fetch("https://ai.oliverkiss.com/revenue");
    await SELF.fetch("https://ai.oliverkiss.com/health");

    const after = await runInDurableObject(statsInstance(), (i: Stats) =>
      i.summary(),
    );
    expect(after.totals.requests).toBe(before.totals.requests);
  });

  it("collapses unknown paths into one bucket", async () => {
    for (const p of ["/nope-a", "/nope-b", "/nope-c"]) {
      await SELF.fetch(`https://ai.oliverkiss.com${p}`);
    }

    const summary = await runInDurableObject(statsInstance(), (i: Stats) =>
      i.summary(),
    );

    // Otherwise anyone could grow this table without bound, for free, by
    // requesting random URLs.
    expect(summary.by_path["/nope-a"]).toBeUndefined();
    expect(summary.by_path.other).toBeDefined();
  });

  it("serves the summary publicly as proof of life", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/stats");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("totals");
    expect(body).toHaveProperty("conversion");
    expect(JSON.stringify(body)).not.toContain("ae_");
  });
});
