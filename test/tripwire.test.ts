import { describe, it, expect } from "vitest";
import {
  classifyCaller,
  detectSignal,
  SIGNAL_CONFIDENCE,
} from "../src/lib/tripwire";

describe("classifyCaller", () => {
  // Taken verbatim from production logs: these are the callers that make up
  // nearly all current traffic and must not be mistaken for customers.
  const observedMonitors = [
    "SentinelOracle/0.1 (+https://glimind.com/opt-out; liveness-only, never)",
    "mcpbeat/0.1 (+https://mcpbeat.com/bot/; liveness check)",
    "GolemreachTrustBot/0.1 (+https://golemreach.com/trust/bot)",
    "AgenstryBot/0.3.0 (+https://agenstry.com/bot)",
    "x402-observer/1.0 (uptime+trust monitor; +https://x402.fuchss.app/trust)",
    "mcpi/probe",
    "aisec-registry/0.2 (+https://sec.sqrx.io)",
    "mcp-drift-monitor/0.1 (read-only tool-definition observer)",
    "mcpscan/1.0 (+https://modc2.com/mcpscan; MCP index crawler)",
  ];

  it.each(observedMonitors)("recognises %s as noise", (ua) => {
    expect(classifyCaller(ua)).toBe("monitor");
  });

  /**
   * The load-bearing case. The SDK runs on Node and sends the same
   * User-Agent an anonymous script would, so these must stay unclassified:
   * treating them as noise would suppress the one signal worth having.
   */
  it.each(["node", "undici", "axios/1.7.2", "python-httpx/0.27.0", "Go-http-client/2.0"])(
    "does not write off %s as a monitor",
    (ua) => {
      expect(classifyCaller(ua)).toBe("unclassified");
    },
  );

  it("treats a missing User-Agent as unclassified rather than noise", () => {
    expect(classifyCaller(null)).toBe("unclassified");
  });
});

describe("detectSignal", () => {
  it("reports a payment attempt even from something that looks like a bot", () => {
    // A forged User-Agent must not be able to hide a real payment.
    expect(detectSignal(true, true, false, "monitor")).toBe("payment_attempt");
  });

  it("ranks a payment authorization above prepaid credit", () => {
    expect(detectSignal(true, true, true, "unclassified")).toBe("payment_attempt");
  });

  it("reports credit use", () => {
    expect(detectSignal(true, false, true, "unclassified")).toBe("credit_use");
  });

  it("treats an unknown caller on a priced route as a prospect", () => {
    expect(detectSignal(true, false, false, "unclassified")).toBe("prospect_402");
  });

  it("stays quiet for a monitor that cannot pay", () => {
    expect(detectSignal(true, false, false, "monitor")).toBeNull();
  });

  it("stays quiet on free routes", () => {
    expect(detectSignal(false, false, false, "unclassified")).toBeNull();
  });

  /**
   * A payment or credit header on a free path still matters: it means a
   * client is configured to pay and is talking to us, which is the whole
   * point of the tripwire.
   */
  it("still reports payment on a free route", () => {
    expect(detectSignal(false, true, false, "unclassified")).toBe("payment_attempt");
  });

  it("marks only the header-backed signals as high confidence", () => {
    expect(SIGNAL_CONFIDENCE.payment_attempt).toBe("high");
    expect(SIGNAL_CONFIDENCE.credit_use).toBe("high");
    expect(SIGNAL_CONFIDENCE.prospect_402).toBe("low");
  });
});
