import { describe, it, expect } from "vitest";
import {
  parseChallenge,
  diffObservation,
  checkExpectation,
  checkExpectationAcrossOptions,
  normalizeNetwork,
  type Observation,
  canonicalizeUrl,
  registryKeyFor,
} from "../src/lib/x402-verify";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYEE = "0x1111111111111111111111111111111111111111";

/**
 * These tests exist because this endpoint takes a URL from a stranger and
 * fetches it. Every refusal below is a network the caller would otherwise be
 * able to reach through us.
 */
/**
 * x402 v1 and v2 put the challenge in different places. An agent that only
 * understands one of them would read a live v2 endpoint as "not paid" and
 * either call it blind or skip it.
 */
describe("parseChallenge", () => {
  const accepts = [
    {
      scheme: "exact",
      network: "base",
      maxAmountRequired: "3000",
      asset: USDC_BASE,
      payTo: PAYEE,
      resource: "https://example.com/api",
      description: "A thing",
      maxTimeoutSeconds: 60,
    },
  ];

  it("reads a v1 challenge from the response body", () => {
    const body = JSON.stringify({ x402Version: 1, accepts });
    const parsed = parseChallenge(null, body);
    expect(parsed?.source).toBe("body");
    expect(parsed?.options[0].pay_to).toBe(PAYEE);
    expect(parsed?.options[0].amount).toBe("3000");
    expect(parsed?.resource_url).toBe("https://example.com/api");
  });

  it("reads a v2 challenge from the base64 header, with an empty body", () => {
    const header = btoa(
      JSON.stringify({
        x402Version: 2,
        resource: { url: "https://example.com/api", description: "A thing" },
        accepts: [
          {
            scheme: "exact",
            network: "base",
            amount: "3000",
            asset: USDC_BASE,
            payTo: PAYEE,
          },
        ],
      }),
    );
    const parsed = parseChallenge(header, "{}");
    expect(parsed?.source).toBe("header");
    expect(parsed?.options[0].amount).toBe("3000");
    expect(parsed?.resource_url).toBe("https://example.com/api");
  });

  it("prefers the header when both are present, because v2 is authoritative", () => {
    const header = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "base", amount: "9999", asset: USDC_BASE, payTo: PAYEE }],
      }),
    );
    const parsed = parseChallenge(header, JSON.stringify({ x402Version: 1, accepts }));
    expect(parsed?.options[0].amount).toBe("9999");
  });

  it("converts a known asset to dollars", () => {
    const parsed = parseChallenge(null, JSON.stringify({ x402Version: 1, accepts }));
    expect(parsed?.options[0].price_usd).toBe("0.003");
  });

  /**
   * The important half. Guessing six decimals on an unknown token would turn
   * an 18-decimal charge into a number a thousand billion times too small,
   * and the caller would approve it.
   */
  it("refuses to price an asset whose decimals it does not know", () => {
    const parsed = parseChallenge(
      null,
      JSON.stringify({
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network: "base",
            maxAmountRequired: "3000000000000000000",
            asset: "0x9999999999999999999999999999999999999999",
            payTo: PAYEE,
          },
        ],
      }),
    );
    expect(parsed?.options[0].amount).toBe("3000000000000000000");
    expect(parsed?.options[0].price_usd).toBeNull();
  });

  it.each([
    ["not json at all", null],
    ['{"ok":true}', null],
    ["", null],
  ])("returns null for %s", (body) => {
    expect(parseChallenge(null, body)).toBeNull();
  });

  it("returns null for a corrupt header rather than throwing", () => {
    expect(parseChallenge("!!!not base64!!!", null)).toBeNull();
  });

  it("accepts a base64url header, which atob would otherwise reject", () => {
    const json = JSON.stringify({
      x402Version: 2,
      accepts: [
        { scheme: "exact", network: "base", amount: "3000", asset: USDC_BASE, payTo: PAYEE },
      ],
      note: "padding-shifting filler >>> ???",
    });
    const urlSafe = btoa(json).replace(/\+/g, "-").replace(/\//g, "_");
    const parsed = parseChallenge(urlSafe, null);
    expect(parsed?.options[0].pay_to).toBe(PAYEE);
  });

  it("keeps every option, not just the first", () => {
    const parsed = parseChallenge(
      null,
      JSON.stringify({
        x402Version: 1,
        accepts: [
          { scheme: "exact", network: "base", maxAmountRequired: "3000", asset: USDC_BASE, payTo: PAYEE },
          { scheme: "exact", network: "eip155:1", maxAmountRequired: "9000", asset: USDC_BASE, payTo: "0x2222222222222222222222222222222222222222" },
        ],
      }),
    );
    expect(parsed?.options).toHaveLength(2);
    expect(parsed?.options[1].pay_to).toBe("0x2222222222222222222222222222222222222222");
  });

  it("returns an empty option list, not a crash, for an empty accepts array", () => {
    const parsed = parseChallenge(null, JSON.stringify({ x402Version: 1, accepts: [] }));
    expect(parsed?.options).toEqual([]);
  });

  it("refuses to price a negative or non-integer amount", () => {
    for (const amount of ["-3000", "3.5", "1e6", "abc"]) {
      const parsed = parseChallenge(
        null,
        JSON.stringify({
          x402Version: 1,
          accepts: [{ scheme: "exact", network: "base", maxAmountRequired: amount, asset: USDC_BASE, payTo: PAYEE }],
        }),
      );
      expect(parsed?.options[0].price_usd).toBeNull();
    }
  });

  it("prices an amount shorter than the asset's decimals without losing digits", () => {
    const parsed = parseChallenge(
      null,
      JSON.stringify({
        x402Version: 1,
        accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "5", asset: USDC_BASE, payTo: PAYEE }],
      }),
    );
    // 5 units of a 6-decimal token is $0.000005, not $5 and not $0.5.
    expect(parsed?.options[0].price_usd).toBe("0.000005");
  });
});

describe("diffObservation", () => {
  const base: Observation = {
    pay_to: PAYEE,
    amount: "3000",
    asset: USDC_BASE,
    network: "base",
    scheme: "exact",
  };

  it("finds nothing when nothing changed", () => {
    expect(diffObservation(base, { ...base })).toEqual([]);
  });

  /**
   * The whole reason the endpoint exists: an agent paying on a schedule
   * cannot see this, because every individual response still looks correct.
   */
  it("grades a swapped payee as critical", () => {
    const drift = diffObservation(base, { ...base, pay_to: "0x2222222222222222222222222222222222222222" });
    expect(drift).toHaveLength(1);
    expect(drift[0].field).toBe("pay_to");
    expect(drift[0].severity).toBe("critical");
    expect(drift[0].from).toBe(PAYEE);
  });

  it.each(["network", "asset"] as const)("grades a changed %s as critical", (field) => {
    const drift = diffObservation(base, { ...base, [field]: "something-else" });
    expect(drift[0].severity).toBe("critical");
  });

  it("grades a price rise as a warning, not a crisis", () => {
    const drift = diffObservation(base, { ...base, amount: "9000" });
    expect(drift[0].field).toBe("amount");
    expect(drift[0].severity).toBe("warning");
  });

  it("does not warn about a price cut", () => {
    const drift = diffObservation(base, { ...base, amount: "1000" });
    expect(drift[0].severity).toBe("info");
  });

  it("does not cry wolf when an endpoint moves from x402 v1 naming to v2 CAIP-2", () => {
    const drift = diffObservation(
      { ...base, network: "base" },
      { ...base, network: "eip155:8453" },
    );
    expect(drift).toEqual([]);
  });

  it("still flags a genuine chain move", () => {
    const drift = diffObservation(
      { ...base, network: "base" },
      { ...base, network: "eip155:1" },
    );
    expect(drift[0].field).toBe("network");
    expect(drift[0].severity).toBe("critical");
  });

  /**
   * The bug this pins was live: EIP-55 checksummed and lowercase forms of one
   * address are the SAME address, and x402 servers differ in which they emit.
   * Compared literally, a library upgrade upstream would fire "the receiving
   * address changed -- payments now go somewhere other than where earlier
   * callers sent them" at an endpoint where nothing moved. A tool that cries
   * wolf about payee changes is worse than no tool.
   */
  it("does not report a re-cased payee as a changed payee", () => {
    const checksummed = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const drift = diffObservation(
      { ...base, pay_to: checksummed },
      { ...base, pay_to: checksummed.toLowerCase() },
    );
    expect(drift).toEqual([]);
  });

  it("does not report a re-cased asset as a changed asset", () => {
    const drift = diffObservation(
      { ...base, asset: USDC_BASE },
      { ...base, asset: USDC_BASE.toLowerCase() },
    );
    expect(drift).toEqual([]);
  });

  it("still catches a genuinely different payee that differs only late in the string", () => {
    const drift = diffObservation(base, {
      ...base,
      pay_to: PAYEE.slice(0, -1) + "2",
    });
    expect(drift[0].severity).toBe("critical");
    expect(drift[0].field).toBe("pay_to");
  });

  /**
   * A cheaper price must never soften a payee swap. The amount itself is
   * deliberately NOT reported here: it is the price of a different option
   * than the one previously seen, so calling it "the price changed" would
   * describe a comparison that was not made.
   */
  it("does not let a simultaneous repricing hide a payee swap", () => {
    const drift = diffObservation(base, {
      ...base,
      pay_to: "0x2222222222222222222222222222222222222222",
      amount: "1",
    });
    expect(drift.some((d) => d.field === "pay_to" && d.severity === "critical")).toBe(true);
    expect(drift.some((d) => d.field === "amount")).toBe(false);
  });

  it("does report a price change when it is the same option being repriced", () => {
    const drift = diffObservation(base, { ...base, amount: "9000" });
    expect(drift.map((d) => d.field)).toEqual(["amount"]);
    expect(drift[0].severity).toBe("warning");
  });
});

/**
 * Verified against this service's own live challenge, which declares
 * "eip155:8453" where x402 v1 said "base". Without normalisation, an endpoint
 * upgrading its protocol version would fire the most severe alarm this tool
 * has, for a chain that did not change.
 */
describe("normalizeNetwork", () => {
  it.each([
    ["base", "eip155:8453"],
    ["Base", "eip155:8453"],
    ["eip155:8453", "eip155:8453"],
    ["base-sepolia", "eip155:84532"],
    ["ARBITRUM", "eip155:42161"],
  ])("reduces %s to %s", (input, expected) => {
    expect(normalizeNetwork(input)).toBe(expected);
  });

  it("leaves an unknown chain alone rather than guessing", () => {
    expect(normalizeNetwork("eip155:999999")).toBe("eip155:999999");
    expect(normalizeNetwork("some-new-chain")).toBe("some-new-chain");
  });

  /**
   * The dangerous direction. A false alarm is annoying; an alias that quietly
   * collapses two real chains into one would SUPPRESS a critical alarm, and
   * the caller would sign for the wrong chain believing it had been checked.
   */
  it("never maps two different chain names onto the same identifier", () => {
    const seen = new Map<string, string>();
    for (const name of [
      "base", "base-mainnet", "base-sepolia", "ethereum", "mainnet",
      "sepolia", "polygon", "polygon-amoy", "avalanche", "avalanche-fuji",
      "arbitrum", "optimism", "solana", "solana-devnet",
    ]) {
      const id = normalizeNetwork(name)!;
      const clash = seen.get(id);
      // base/base-mainnet and ethereum/mainnet are genuine synonyms.
      const synonyms = [["base", "base-mainnet"], ["ethereum", "mainnet"]];
      if (clash) {
        expect(
          synonyms.some((pair) => pair.includes(clash) && pair.includes(name)),
        ).toBe(true);
      }
      seen.set(id, name);
    }
  });

  it.each(["solana", "solana-devnet"])(
    "matches %s against its own CAIP-2 form, which is not lowercase",
    (name) => {
      const canonical = normalizeNetwork(name)!;
      expect(normalizeNetwork(canonical)).toBe(canonical);
    },
  );
});

/**
 * A real client pays through the option matching a chain and token it holds,
 * which need not be the first. An endpoint listing an honest option first and
 * an attacker's payee second would pass a check that only reads index 0 --
 * while taking the money through the option the client actually selects.
 */
describe("diffObservation across multiple payment options", () => {
  const opt = (pay_to: string, network = "base") => ({
    pay_to,
    asset: USDC_BASE,
    network,
    scheme: "exact",
  });
  const base: Observation = {
    pay_to: PAYEE,
    amount: "3000",
    asset: USDC_BASE,
    network: "base",
    scheme: "exact",
    options: [opt(PAYEE)],
  };
  const ATTACKER = "0x2222222222222222222222222222222222222222";

  it("catches a second payee hidden behind an unchanged first option", () => {
    const drift = diffObservation(base, {
      ...base,
      options: [opt(PAYEE), opt(ATTACKER)],
    });
    const critical = drift.filter((d) => d.severity === "critical");
    expect(critical).toHaveLength(1);
    expect(critical[0].field).toBe("pay_to");
    expect(critical[0].to).toBe(ATTACKER);
  });

  it("catches an option added on a chain the endpoint has never used", () => {
    const drift = diffObservation(base, {
      ...base,
      options: [opt(PAYEE), opt(PAYEE, "eip155:1")],
    });
    expect(drift.some((d) => d.field === "network" && d.severity === "critical")).toBe(true);
  });

  it("does not raise a critical alarm merely because the options were reordered", () => {
    const both = { ...base, options: [opt(PAYEE), opt(PAYEE, "eip155:1")] };
    const reordered = { ...base, options: [opt(PAYEE, "eip155:1"), opt(PAYEE)] };
    const drift = diffObservation(both, reordered);
    expect(drift.some((d) => d.severity === "critical")).toBe(false);
    expect(drift.some((d) => d.severity === "warning")).toBe(true);
  });

  it("treats a withdrawn option as information, not danger", () => {
    const both = { ...base, options: [opt(PAYEE), opt(PAYEE, "eip155:1")] };
    const drift = diffObservation(both, base);
    expect(drift.every((d) => d.severity !== "critical")).toBe(true);
  });

  it("falls back to the primary fields for records stored before options were kept", () => {
    const legacy: Observation = { ...base, options: undefined };
    expect(diffObservation(legacy, { ...base, options: [opt(PAYEE)] })).toEqual([]);
    const moved = diffObservation(legacy, {
      ...base,
      pay_to: ATTACKER,
      options: [opt(ATTACKER)],
    });
    expect(moved.some((d) => d.severity === "critical")).toBe(true);
  });

  /**
   * Records written before the option set was stored describe only the first
   * option. Treating the rest as newly added would fire a critical alarm at
   * every multi-option endpoint on the first look after deploy -- an alarm
   * manufactured entirely by our own migration.
   */
  it("re-baselines a legacy record instead of calling its other options new", () => {
    const legacy: Observation = { ...base, options: undefined };
    const drift = diffObservation(legacy, {
      ...base,
      options: [opt(PAYEE), opt(ATTACKER, "eip155:1")],
    });
    expect(drift.some((d) => d.severity === "critical")).toBe(false);
    expect(drift.some((d) => d.severity === "info")).toBe(true);
  });

  it("still raises a critical if a legacy record's own option is gone", () => {
    const legacy: Observation = { ...base, options: undefined };
    const drift = diffObservation(legacy, {
      ...base,
      pay_to: ATTACKER,
      options: [opt(ATTACKER), opt(ATTACKER, "eip155:1")],
    });
    expect(drift.some((d) => d.field === "pay_to" && d.severity === "critical")).toBe(true);
  });

  it("compares everything normally on the look after a re-baseline", () => {
    const rebaselined: Observation = {
      ...base,
      options: [opt(PAYEE), opt(PAYEE, "eip155:1")],
    };
    const drift = diffObservation(rebaselined, {
      ...base,
      options: [opt(PAYEE), opt(PAYEE, "eip155:1"), opt(ATTACKER)],
    });
    expect(drift.some((d) => d.field === "pay_to" && d.severity === "critical")).toBe(true);
  });

  /**
   * An endpoint may legitimately use a different address per chain. A payee
   * that is known SOMEWHERE is not thereby known HERE, so an option quietly
   * routing one chain's token to the other chain's address must not pass
   * merely because every field has been seen before.
   */
  it("catches an option that recombines known values into a new destination", () => {
    const DAI = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
    const previous: Observation = {
      ...base,
      options: [
        { pay_to: PAYEE, asset: USDC_BASE, network: "base", scheme: "exact" },
        { pay_to: ATTACKER, asset: DAI, network: "eip155:1", scheme: "exact" },
      ],
    };
    const drift = diffObservation(previous, {
      ...previous,
      options: [
        ...previous.options!,
        // Every field familiar; this pairing of them is not.
        { pay_to: ATTACKER, asset: USDC_BASE, network: "base", scheme: "exact" },
      ],
    });
    expect(drift.some((d) => d.field === "pay_to" && d.severity === "critical")).toBe(true);
  });

  it("does not report a price change that is really just a different option", () => {
    const a = { ...base, amount: "3000", options: [opt(PAYEE), opt(PAYEE, "eip155:1")] };
    const b = { ...base, amount: "9000", options: [opt(PAYEE, "eip155:1"), opt(PAYEE)] };
    expect(diffObservation(a, b).some((d) => d.field === "amount")).toBe(false);
  });
});

describe("checkExpectation", () => {
  const option = {
    scheme: "exact",
    network: "base",
    amount: "3000",
    asset: USDC_BASE,
    asset_symbol: "USDC",
    price_usd: "0.003",
    pay_to: PAYEE,
    max_timeout_seconds: 60,
  };

  it("matches when the listing is right", () => {
    expect(checkExpectation({ pay_to: PAYEE, network: "base" }, option).matches).toBe(true);
  });

  it("accepts a caller saying 'base' against a v2 endpoint saying eip155:8453", () => {
    const result = checkExpectation(
      { network: "base" },
      { ...option, network: "eip155:8453" },
    );
    expect(result.matches).toBe(true);
  });

  it("still reports a caller expecting the wrong chain", () => {
    const result = checkExpectation(
      { network: "ethereum" },
      { ...option, network: "eip155:8453" },
    );
    expect(result.matches).toBe(false);
    expect(result.mismatches[0]).toContain("network");
  });

  it("ignores address casing, which is presentational not semantic", () => {
    expect(checkExpectation({ pay_to: PAYEE.toUpperCase() }, option).matches).toBe(true);
  });

  it("reports a stale payee in the listing", () => {
    const result = checkExpectation({ pay_to: "0x3333333333333333333333333333333333333333" }, option);
    expect(result.matches).toBe(false);
    expect(result.mismatches[0]).toContain("pay_to");
  });

  it("accepts a price under the caller's ceiling", () => {
    expect(checkExpectation({ max_price_usd: 0.01 }, option).matches).toBe(true);
  });

  it("reports a price above the caller's ceiling", () => {
    const result = checkExpectation({ max_price_usd: 0.001 }, option);
    expect(result.matches).toBe(false);
    expect(result.mismatches[0]).toContain("ceiling");
  });

  /**
   * Silently passing a ceiling check that could not actually be performed is
   * how an agent ends up approving an 18-decimal charge.
   */
  /**
   * `matches_expectation` is the boolean an agent gates on. Returning true
   * for a challenge whose second option names an attacker -- and which a
   * client paying on that chain would actually select -- is the single most
   * dangerous thing this endpoint could say.
   */
  it("fails the expectation when a later option breaks it", () => {
    const attacker = {
      ...option,
      pay_to: "0x9999999999999999999999999999999999999999",
      network: "eip155:1",
      amount: "50000000",
      price_usd: "50",
    };
    const result = checkExpectationAcrossOptions(
      { pay_to: PAYEE, max_price_usd: 0.01 },
      [option, attacker],
    );
    expect(result.matches).toBe(false);
    expect(result.mismatches.join(" ")).toContain("payment option 2");
  });

  it("passes when every option satisfies the expectation", () => {
    const sibling = { ...option, network: "eip155:1" };
    expect(
      checkExpectationAcrossOptions({ pay_to: PAYEE, max_price_usd: 0.01 }, [option, sibling])
        .matches,
    ).toBe(true);
  });

  it("does not silently pass when there is nothing to check", () => {
    const result = checkExpectationAcrossOptions({ pay_to: PAYEE }, []);
    expect(result.matches).toBe(false);
  });

  it("reports, rather than passes, a ceiling it could not check", () => {
    const result = checkExpectation(
      { max_price_usd: 0.01 },
      { ...option, price_usd: null },
    );
    expect(result.matches).toBe(false);
    expect(result.mismatches[0]).toMatch(/could NOT be checked/);
  });
});

/**
 * The shared registry is the one piece of state a stranger can influence for
 * everybody, so its key decides whether a hostile caller can defame an
 * honest endpoint to every later caller.
 */
describe("registry keying", () => {
  it("does not let a GET observation overwrite a POST baseline", () => {
    const url = "https://victim.example/api";
    expect(registryKeyFor(url, "GET")).not.toBe(registryKeyFor(url, "POST"));
  });

  it("normalises the method so casing cannot fork a history", () => {
    expect(registryKeyFor("https://a.example/x", "post")).toBe(
      registryKeyFor("https://a.example/x", "POST"),
    );
  });

  it("keeps one history for trivially different spellings of one endpoint", () => {
    const key = (u: string) => registryKeyFor(u, "POST");
    expect(key("https://X.example/a")).toBe(key("https://x.example/a"));
    expect(key("https://x.example/a#frag")).toBe(key("https://x.example/a"));
    expect(key("https://x.example:443/a")).toBe(key("https://x.example/a"));
  });

  it("still separates genuinely different endpoints on the same host", () => {
    const key = (u: string) => registryKeyFor(u, "POST");
    expect(key("https://x.example/a")).not.toBe(key("https://x.example/b"));
    expect(key("https://x.example/a?v=1")).not.toBe(key("https://x.example/a"));
  });

  it("drops only the fragment, never the path or query", () => {
    expect(canonicalizeUrl("https://x.example/a/b?q=1#z")).toBe(
      "https://x.example/a/b?q=1",
    );
  });
});

describe("decoy resistance and per-option pricing", () => {
  const opt = (
    pay_to: string,
    network: string,
    amount: string,
    asset = "0xusdc",
  ) => ({ pay_to, network, asset, scheme: "exact", amount });

  /**
   * The re-baseline branch used to check payees globally. That let an
   * endpoint move the recorded scope's payee to an attacker while keeping
   * the old address alive on some other chain: a global membership test
   * still found it, so a real swap was downgraded to an info note.
   */
  it("still raises a critical when a decoy keeps the old payee on another chain", () => {
    const legacy = {
      pay_to: "0xAAA",
      amount: "3000",
      asset: "0xusdc",
      network: "base",
      scheme: "exact",
      options: undefined,
    };
    const drift = diffObservation(legacy, {
      ...legacy,
      pay_to: "0xBBB",
      options: [
        opt("0xBBB", "base", "3000"),
        opt("0xAAA", "eip155:1", "3000"),
      ],
    });
    const payTo = drift.find((d) => d.field === "pay_to");
    expect(payTo?.severity).toBe("critical");
  });

  it("reports a price rise on an option that is not the primary one", () => {
    const before = {
      pay_to: "0xAAA",
      amount: "3000",
      asset: "0xusdc",
      network: "base",
      scheme: "exact",
      options: [opt("0xAAA", "base", "3000"), opt("0xAAA", "eip155:1", "10000")],
    };
    const after = {
      ...before,
      options: [opt("0xAAA", "base", "3000"), opt("0xAAA", "eip155:1", "50000")],
    };
    const drift = diffObservation(before, after);
    const amount = drift.find((d) => d.field === "amount");
    expect(amount?.severity).toBe("warning");
    expect(amount?.from).toBe("10000");
    expect(amount?.to).toBe("50000");
  });

  it("stays silent when no option changed price", () => {
    const o = {
      pay_to: "0xAAA",
      amount: "3000",
      asset: "0xusdc",
      network: "base",
      scheme: "exact",
      options: [opt("0xAAA", "base", "3000"), opt("0xAAA", "eip155:1", "10000")],
    };
    expect(diffObservation(o, { ...o })).toEqual([]);
  });

  /**
   * A record written before per-option prices existed has no price for the
   * non-primary options, so there is nothing to compare. Inventing a change
   * from "unknown" would be a false alarm on migration.
   */
  it("does not invent a price change for options with no recorded price", () => {
    const legacyish = {
      pay_to: "0xAAA",
      amount: "3000",
      asset: "0xusdc",
      network: "base",
      scheme: "exact",
      options: [
        { pay_to: "0xAAA", network: "base", asset: "0xusdc", scheme: "exact" },
        { pay_to: "0xAAA", network: "eip155:1", asset: "0xusdc", scheme: "exact" },
      ],
    };
    const drift = diffObservation(legacyish, {
      ...legacyish,
      options: [opt("0xAAA", "base", "3000"), opt("0xAAA", "eip155:1", "10000")],
    });
    expect(drift.filter((d) => d.field === "amount")).toEqual([]);
  });
});

describe("rebaseline payee grading", () => {
  const legacy = {
    pay_to: "0xAAA",
    amount: "3000",
    asset: "0xusdc",
    network: "base",
    scheme: "exact",
    options: undefined,
  };
  const o = (pay_to: string, network: string, asset: string) => ({
    pay_to,
    network,
    asset,
    scheme: "exact",
    amount: "3000",
  });

  /**
   * The chain and the token are each still offered, but not together, so
   * neither the network nor the asset critical fires. Without the global
   * fallback the vanished payee would go unreported entirely.
   */
  it("flags a payee that is offered nowhere, even when no single field vanished", () => {
    const drift = diffObservation(legacy, {
      ...legacy,
      pay_to: "0xBBB",
      options: [o("0xBBB", "base", "0xdai"), o("0xBBB", "eip155:1", "0xusdc")],
    });
    expect(drift.find((d) => d.field === "pay_to")?.severity).toBe("critical");
  });

  it("does not call a pure chain move a payee change", () => {
    const drift = diffObservation(legacy, {
      ...legacy,
      network: "eip155:1",
      options: [o("0xAAA", "eip155:1", "0xusdc")],
    });
    expect(drift.some((d) => d.field === "pay_to")).toBe(false);
    expect(drift.find((d) => d.field === "network")?.severity).toBe("critical");
  });
});

/**
 * The exact arrangement that satisfied every other suppression at once, each
 * by a different option: the recorded scope vanishes, an honest option keeps
 * the old payee alive so the global check passes, and the attacker's option
 * keeps the recorded chain on offer so no network critical fires.
 */
describe("chain takeover in a rebaselined record", () => {
  const legacy = {
    pay_to: "0xHONEST",
    amount: "3000",
    asset: "0xusdc",
    network: "base",
    scheme: "exact",
    options: undefined,
  };
  const o = (pay_to: string, network: string, asset: string) => ({
    pay_to,
    network,
    asset,
    scheme: "exact",
    amount: "3000",
  });

  it("flags a new address collecting on the recorded chain", () => {
    const drift = diffObservation(legacy, {
      ...legacy,
      pay_to: "0xEVIL",
      asset: "0xdai",
      options: [o("0xEVIL", "base", "0xdai"), o("0xHONEST", "eip155:1", "0xusdc")],
    });
    const payTo = drift.find((d) => d.field === "pay_to");
    expect(payTo?.severity).toBe("critical");
    expect(payTo?.to).toBe("0xEVIL");
  });

  it("stays quiet when the endpoint simply left the chain", () => {
    const drift = diffObservation(legacy, {
      ...legacy,
      network: "eip155:1",
      options: [o("0xHONEST", "eip155:1", "0xusdc")],
    });
    expect(drift.some((d) => d.field === "pay_to")).toBe(false);
  });

  it("stays quiet when the recorded chain still pays the recorded address", () => {
    const drift = diffObservation(legacy, {
      ...legacy,
      options: [o("0xHONEST", "base", "0xusdc"), o("0xHONEST", "eip155:1", "0xusdc")],
    });
    expect(drift.some((d) => d.severity === "critical")).toBe(false);
  });
});

describe("asset takeover in a rebaselined record", () => {
  const legacy = {
    pay_to: "0xHONEST",
    amount: "3000",
    asset: "0xusdc",
    network: "base",
    scheme: "exact",
    options: undefined,
  };
  const o = (pay_to: string, network: string, asset: string) => ({
    pay_to,
    network,
    asset,
    scheme: "exact",
    amount: "3000",
  });

  /**
   * The mirror image of the chain takeover: the recorded chain keeps the
   * honest payee, so the network check is satisfied, while the recorded
   * token moves to an attacker on a different chain.
   */
  it("flags a new address collecting the recorded token", () => {
    const drift = diffObservation(legacy, {
      ...legacy,
      asset: "0xdai",
      options: [o("0xHONEST", "base", "0xdai"), o("0xEVIL", "eip155:1", "0xusdc")],
    });
    const payTo = drift.find((d) => d.field === "pay_to");
    expect(payTo?.severity).toBe("critical");
    expect(payTo?.to).toBe("0xEVIL");
  });

  it("stays quiet when the endpoint simply stopped taking that token", () => {
    const drift = diffObservation(legacy, {
      ...legacy,
      asset: "0xdai",
      options: [o("0xHONEST", "base", "0xdai")],
    });
    expect(drift.some((d) => d.field === "pay_to")).toBe(false);
  });
});
