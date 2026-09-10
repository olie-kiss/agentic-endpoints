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

  /**
   * `drift: []` beside a missing `first_observation` reads as "seen before,
   * nothing changed" -- a clean bill of health invented out of a timeout.
   * Null drift says no comparison was made, which is the truth.
   */
  it("reports no history for an endpoint that was never reachable", async () => {
    const blip = await observe(endpointUrl(), null);
    expect(blip.recorded).toBe(false);
    expect(blip.first_seen).toBeNull();
    expect(blip.times_seen).toBe(0);
    expect(blip.first_observation).toBe(true);
    expect(blip.drift).toBeNull();
  });

  it("does not claim a first observation for an endpoint it already knows", async () => {
    const url = endpointUrl();
    await observe(url, observation());
    const blip = await observe(url, null);
    expect(blip.first_observation).toBe(false);
    expect(blip.drift).toBeNull();
  });

  it("stores every payment option, so a hidden second payee is caught later", async () => {
    const url = endpointUrl();
    const opt = (pay_to: string) => ({
      pay_to,
      asset: USDC,
      network: "base",
      scheme: "exact",
    });
    await observe(url, observation({ options: [opt(PAYEE)] }));
    const after = await observe(
      url,
      observation({
        options: [opt(PAYEE), opt("0x4444444444444444444444444444444444444444")],
      }),
    );
    const drift = after.drift as { field: string; severity: string }[];
    expect(drift.some((d) => d.field === "pay_to" && d.severity === "critical")).toBe(true);
  });

  it("does not alarm when a stored payee comes back differently cased", async () => {
    const url = endpointUrl();
    const checksummed = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    await observe(url, observation({ pay_to: checksummed }));
    const after = await observe(url, observation({ pay_to: checksummed.toLowerCase() }));
    expect(after.drift).toEqual([]);
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

/**
 * Drift compares against the last observation only, so a payee swap alarms
 * exactly one caller and then becomes the baseline. Without a persistent
 * record, every caller after that sees an empty drift beside a large
 * times_seen -- which reads as a long stable history at precisely the moment
 * the endpoint changed hands.
 */
describe("critical history outlives the observation that caught it", () => {
  it("keeps reporting a swap to callers who arrive after it", async () => {
    const url = endpointUrl();
    await observe(url, observation());

    const caught = await observe(
      url,
      observation({ pay_to: "0xATTACKER", options: undefined }),
    );
    expect(
      (caught.drift as { severity: string }[]).some(
        (d) => d.severity === "critical",
      ),
    ).toBe(true);
    expect(caught.prior_criticals).toBe(0);

    // A later caller sees nothing new, because the attacker's challenge is
    // now the baseline. The history must still tell them.
    const later = await observe(
      url,
      observation({ pay_to: "0xATTACKER", options: undefined }),
    );
    expect(later.drift).toEqual([]);
    expect(later.first_observation).toBe(false);
    expect(later.prior_criticals as number).toBeGreaterThan(0);
    expect((later.last_critical as { field: string }).field).toBe("pay_to");
    expect((later.last_critical as { to: string }).to).toBe("0xATTACKER");
  });

  it("reports no critical history for an endpoint that has never changed", async () => {
    const url = endpointUrl();
    await observe(url, observation());
    const second = await observe(url, observation());
    expect(second.prior_criticals).toBe(0);
    expect(second.last_critical).toBe(null);
  });
})
