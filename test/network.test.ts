import { describe, expect, it } from "vitest";
import { networkFor } from "../src/index";

const env = (network?: string) => ({ X402_NETWORK: network }) as any;

/**
 * The chain the payment gate demands.
 *
 * This is a var, and vars get typos. The failure modes are not symmetric: a
 * mainnet Worker that mistakenly demands Sepolia would hand out real work
 * for testnet tokens anyone can mint for free. So anything unrecognised has
 * to resolve to mainnet, and only the exact Sepolia chain id may opt out.
 */
describe("payment network selection", () => {
  it("defaults to Base mainnet when unset", () => {
    expect(networkFor(env())).toBe("eip155:8453");
    expect(networkFor({} as any)).toBe("eip155:8453");
  });

  it("switches to Base Sepolia only on an exact match", () => {
    expect(networkFor(env("eip155:84532"))).toBe("eip155:84532");
  });

  it("falls back to mainnet for anything unrecognised", () => {
    for (const bad of [
      "eip155:845321",
      " eip155:84532",
      "eip155:84532 ",
      "EIP155:84532",
      "base-sepolia",
      "sepolia",
      "",
      "true",
    ]) {
      expect(networkFor(env(bad)), `${bad} must not select testnet`).toBe(
        "eip155:8453",
      );
    }
  });
});
