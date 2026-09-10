import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYEE = "0x1111111111111111111111111111111111111111";

function observation(overrides: Record<string, unknown> = {}) {
  return {
    pay_to: PAYEE,
    amount: "3000",
    asset: USDC,
    network: "base",
    scheme: "exact",
    ...overrides,
  };
}

async function observe(url: string, obs: Record<string, unknown> | null) {
  const stub = env.ENDPOINTS.get(env.ENDPOINTS.idFromName(url));
  const res = await stub.fetch(
    new Request("https://internal/observe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, observation: obs }),
    }),
  );
  return res.json<Record<string, unknown>>();
}

function endpointUrl() {
  return `https://example.com/${crypto.randomUUID()}`;
}

describe("endpoint registry", () => {
  /**
   * The distinction this test protects is the difference between "nothing has
   * changed" and "there is nothing to compare against". A caller that reads
   * the second as the first believes a brand new endpoint has a clean record.
   */
  it("marks the very first look as a first observation, with no history", async () => {
    const url = endpointUrl();
    const first = await observe(url, observation());
    expect(first.first_observation).toBe(true);
    expect(first.times_seen).toBe(1);
    expect(first.drift).toEqual([]);
    expect(first.first_seen).toBe(first.last_seen);
  });

  it("stops calling it a first observation once there is a record", async () => {
    const url = endpointUrl();
    await observe(url, observation());
    const second = await observe(url, observation());
    expect(second.first_observation).toBe(false);
    expect(second.times_seen).toBe(2);
    expect(second.drift).toEqual([]);
  });

  it("reports a swapped payee as critical drift on the next look", async () => {
    const url = endpointUrl();
    await observe(url, observation());
    const after = await observe(
      url,
      observation({ pay_to: "0x2222222222222222222222222222222222222222" }),
    );
    const drift = after.drift as { field: string; severity: string; from: string }[];
    expect(drift).toHaveLength(1);
    expect(drift[0].field).toBe("pay_to");
    expect(drift[0].severity).toBe("critical");
    expect(drift[0].from).toBe(PAYEE);
  });

  it("does not re-report drift it has already reported", async () => {
    const url = endpointUrl();
    await observe(url, observation());
    await observe(url, observation({ pay_to: "0x2222222222222222222222222222222222222222" }));
    const third = await observe(
      url,
      observation({ pay_to: "0x2222222222222222222222222222222222222222" }),
    );
    expect(third.drift).toEqual([]);
  });

  /**
   * The failure this prevents: one timeout overwrites a good record with
   * nulls, and the next successful call reports "the payee changed from
   * nothing to 0x1111" -- a critical alarm invented entirely by a network
   * blip. A tool that cries wolf about payee changes is worse than no tool.
   */
  it("does not record an unreachable endpoint over a known-good one", async () => {
    const url = endpointUrl();
    await observe(url, observation());
    const blip = await observe(url, null);
    expect(blip.recorded).toBe(false);
    expect(blip.times_seen).toBe(1);

    const recovered = await observe(url, observation());
    expect(recovered.drift).toEqual([]);
    expect(recovered.times_seen).toBe(2);
  });

  it("reports no history for an endpoint that was never reachable", async () => {
    const blip = await observe(endpointUrl(), null);
    expect(blip.recorded).toBe(false);
    expect(blip.first_seen).toBeNull();
    expect(blip.times_seen).toBe(0);
  });

  /**
   * The sharing is the product: an agent could check an endpoint against its
   * own memory, but it could not check it against everyone else's.
   */
  it("keeps a separate record per endpoint URL", async () => {
    const a = endpointUrl();
    const b = endpointUrl();
    await observe(a, observation());
    const other = await observe(b, observation({ pay_to: "0x3333333333333333333333333333333333333333" }));
    expect(other.first_observation).toBe(true);
    expect(other.drift).toEqual([]);
  });

  it("keeps a change log that survives later observations", async () => {
    const url = endpointUrl();
    await observe(url, observation());
    await observe(url, observation({ pay_to: "0x2222222222222222222222222222222222222222" }));
    await observe(url, observation({ pay_to: "0x2222222222222222222222222222222222222222" }));

    const stub = env.ENDPOINTS.get(env.ENDPOINTS.idFromName(url));
    const res = await stub.fetch(
      new Request("https://internal/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      }),
    );
    const json = await res.json<Record<string, unknown>>();
    const changes = json.changes as { field: string; severity: string }[];
    expect(changes.some((c) => c.field === "pay_to" && c.severity === "critical")).toBe(true);
  });
});
