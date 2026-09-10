import { describe, it, expect } from "vitest";
import {
  parseChallenge,
  diffObservation,
  checkExpectation,
  normalizeNetwork,
  type Observation,
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

  it("reports every change at once, so a payee swap is not hidden behind a repricing", () => {
    const drift = diffObservation(base, {
      ...base,
      pay_to: "0x2222222222222222222222222222222222222222",
      amount: "1",
    });
    expect(drift.map((d) => d.field).sort()).toEqual(["amount", "pay_to"]);
    expect(drift.some((d) => d.severity === "critical")).toBe(true);
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
  it("reports, rather than passes, a ceiling it could not check", () => {
    const result = checkExpectation(
      { max_price_usd: 0.01 },
      { ...option, price_usd: null },
    );
    expect(result.matches).toBe(false);
    expect(result.mismatches[0]).toMatch(/could NOT be checked/);
  });
});
