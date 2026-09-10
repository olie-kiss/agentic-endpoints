import { describe, it, expect } from "vitest";
import {
  checkUrl,
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
describe("checkUrl", () => {
  it.each([
    ["http://localhost/x", "loopback by name"],
    ["http://127.0.0.1/x", "loopback literal"],
    ["http://127.1.2.3/x", "the whole 127/8 block, not just .0.1"],
    ["http://10.0.0.5/x", "RFC1918 class A"],
    ["http://172.16.4.4/x", "RFC1918 class B, low end"],
    ["http://172.31.255.1/x", "RFC1918 class B, high end"],
    ["http://192.168.1.1/x", "RFC1918 class C"],
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://100.64.0.1/x", "carrier-grade NAT"],
    ["http://0.0.0.0/x", "unspecified address"],
    ["http://[fd00::1]/x", "IPv6 unique-local"],
    ["http://[fe80::1]/x", "IPv6 link-local"],
    ["http://[::1]/x", "IPv6 loopback"],
    ["http://db.internal/x", "internal TLD"],
    ["http://printer.local/x", "mDNS name"],
    ["file:///etc/passwd", "non-HTTP scheme"],
    ["not a url", "unparseable"],
  ])("refuses %s (%s)", (url) => {
    expect(checkUrl(url).ok).toBe(false);
  });

  it.each([
    "https://ai.oliverkiss.com/compress",
    "http://example.com/api",
    "https://172.32.0.1/x", // just outside RFC1918
    "https://11.0.0.1/x", // just outside 10/8
  ])("allows %s", (url) => {
    expect(checkUrl(url).ok).toBe(true);
  });

  it("gives a reason, so a refusal is not mistaken for a network failure", () => {
    const result = checkUrl("http://169.254.169.254/");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/link-local|Private/i);
  });
});

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
  ])("reduces %s to %s", (input, expected) => {
    expect(normalizeNetwork(input)).toBe(expected);
  });

  it("leaves an unknown chain alone rather than guessing", () => {
    expect(normalizeNetwork("eip155:999999")).toBe("eip155:999999");
    expect(normalizeNetwork("some-new-chain")).toBe("some-new-chain");
  });

  it("does not make two different unknown chains compare equal", () => {
    expect(normalizeNetwork("chain-a")).not.toBe(normalizeNetwork("chain-b"));
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
