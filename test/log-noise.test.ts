import { describe, expect, it } from "vitest";
import { isBenignBazaarWarning } from "../src/lib/log-noise";

/**
 * The filter exists to stop benign AJV dumps burying a buyer signal. It is
 * only safe if it cannot also swallow a warning that means discovery broke.
 */
describe("bazaar warning filter", () => {
  it("matches the real warning, dump and all", () => {
    expect(
      isBenignBazaarWarning([
        'x402: Route "/meetings/import" has an invalid bazaar extension: ' +
          "Schema validation failed: Code generation from strings disallowed " +
          "for this context",
        "function validate(data){...}",
      ]),
    ).toBe(true);
  });

  it("lets a genuinely malformed extension through", () => {
    // This one means discovery is actually broken. Suppressing it would hide
    // the failure the filter is supposed to leave visible.
    expect(
      isBenignBazaarWarning([
        'x402: Route "/vault/put" has an invalid bazaar extension: ' +
          "must have required property 'input'",
      ]),
    ).toBe(false);
  });

  it("does not match the AJV cause on its own", () => {
    // Same root cause, different subsystem — not ours to silence.
    expect(
      isBenignBazaarWarning([
        "Code generation from strings disallowed for this context",
      ]),
    ).toBe(false);
  });

  it("leaves unrelated warnings alone", () => {
    expect(isBenignBazaarWarning(["Facilitator unreachable"])).toBe(false);
  });

  it("survives non-string arguments", () => {
    expect(() =>
      isBenignBazaarWarning([{ a: 1 }, null, undefined, 42]),
    ).not.toThrow();
  });
});
