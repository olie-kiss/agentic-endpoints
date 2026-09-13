import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Credits } from "../src/durable-objects/credits";
import { hashToken } from "../src/lib/utils";

/**
 * Proof that a paying caller receives correct work, not merely a 200.
 *
 * Every other suite tests a layer: the paywall, a Durable Object, a pure
 * function. This one buys each endpoint the way a customer would -- through
 * the real HTTP route, with a real balance debited -- and asserts on what
 * comes back. A service can pass every unit test and still sell nothing of
 * value, which is the failure this exists to catch.
 *
 * Endpoints that fetch a third-party URL (/scrape, /pdf-parse, /x402/verify)
 * are absent by necessity: outbound fetches are blocked in this pool, and a
 * test that mocked them would prove only that the mock works.
 */
async function buyer(token: string, micros = 20_000_000) {
  const tokenHash = await hashToken(token);
  const stub = env.CREDITS.get(env.CREDITS.idFromName(tokenHash));
  await runInDurableObject(stub, (i: Credits) => i.open(tokenHash, micros));
  return { token, tokenHash, stub };
}

function call(token: string, path: string, body: unknown) {
  return SELF.fetch(`https://ai.oliverkiss.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Credit-Token": token },
    body: JSON.stringify(body),
  });
}

/** Namespaces must be unguessable, so the service refuses short ones. */
function ns(label: string) {
  return `${label}-${crypto.randomUUID()}`;
}

describe("a paying customer receives real work", () => {
  it("compresses text and reports an honest ratio", async () => {
    const { token } = await buyer("delivery-compress");
    const text =
      "The quarterly review covered revenue, churn and hiring. " +
      "Revenue grew twelve percent. Churn was flat at three percent. " +
      "Hiring is paused until the next board meeting in March. " +
      "The team agreed to revisit pricing before the end of the quarter. ";

    const res = await call(token, "/compress", {
      text: text.repeat(6),
      target_tokens: 40,
      strategy: "extractive",
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(typeof body.text).toBe("string");
    expect(body.text.length).toBeGreaterThan(0);
    // The output must actually be shorter, and the reported numbers must
    // describe the string it returned rather than a convenient estimate.
    expect(body.compressed_length).toBeLessThan(body.original_length);
    expect(body.compressed_length).toBe(body.text.length);
    // Rounded to two places for readability. Asserted against the same
    // rounding rather than loosened, so a change to how the ratio is derived
    // still fails here -- and both exact lengths are returned beside it, so a
    // caller who needs full precision never depends on this field.
    expect(body.ratio).toBe(
      Math.round((body.compressed_length / body.original_length) * 100) / 100,
    );
    // Extractive compression returns sentences from the source, never invented text.
    expect(text).toContain(body.text.split(".")[0].trim().slice(0, 20));
  });

  it("claims an action exactly once and replays the result to the loser", async () => {
    const { token } = await buyer("delivery-oncekey");
    const namespace = ns("delivery-once");

    const first = await call(token, "/once-key", {
      namespace,
      action_key: "charge-order-1042",
    });
    expect(first.status).toBe(200);
    const claim = await first.json();
    expect(claim.status).toBe("claimed");
    expect(claim.receipt).toBeTruthy();

    await call(token, "/once-key/complete", {
      namespace,
      action_key: "charge-order-1042",
      namespace_token: claim.namespace_token,
      result: { charge_id: "ch_777" },
    });

    // The whole product: the second caller must not repeat the side effect.
    const second = await call(token, "/once-key", {
      namespace,
      action_key: "charge-order-1042",
      namespace_token: claim.namespace_token,
    });
    const replay = await second.json();
    expect(replay.status).not.toBe("claimed");
    expect(JSON.stringify(replay)).toContain("ch_777");
  });

  it("returns vault ciphertext byte-for-byte and never in the clear", async () => {
    const { token } = await buyer("delivery-vault");
    const namespace = ns("delivery-vault");
    const ciphertext = "Zm9vYmFyLWNpcGhlcnRleHQtMTIzNDU2Nzg5MA==";

    const stored = await call(token, "/vault/store", {
      namespace,
      key: "api-key",
      ciphertext,
    });
    expect(stored.status).toBe(200);
    const claim = await stored.json();
    expect(claim.status).toBe("stored");

    const got = await call(token, "/vault/retrieve", {
      namespace,
      key: "api-key",
      namespace_token: claim.namespace_token,
    });
    const body = await got.json();
    expect(body.ciphertext).toBe(ciphertext);

    // Listing must describe the item without ever disclosing its contents.
    const listed = await call(token, "/vault/list", {
      namespace,
      namespace_token: claim.namespace_token,
    });
    const list = await listed.json();
    expect(JSON.stringify(list)).not.toContain(ciphertext);
    expect(JSON.stringify(list)).toContain("api-key");
  });

  it("imports a transcript and finds a phrase the export split across cues", async () => {
    const { token } = await buyer("delivery-meetings");
    const namespace = ns("delivery-meet");

    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:01.000 --> 00:00:04.000",
      "We agreed to postpone the",
      "",
      "2",
      "00:00:04.000 --> 00:00:07.000",
      "pricing decision until March.",
      "",
    ].join("\n");

    const imported = await call(token, "/meetings/import", {
      namespace,
      title: "Q1 planning",
      transcript: vtt,
      visibility: "queryable",
    });
    expect(imported.status).toBe(200);
    const meeting = await imported.json();
    expect(meeting.meeting_id).toBeTruthy();

    // The reason the importer strips cue numbering: the phrase a human would
    // search for spans two cues and exists in neither.
    const found = await call(token, "/meetings/search", {
      namespace,
      query: "postpone the pricing decision",
      namespace_token: meeting.namespace_token,
    });
    const results = await found.json();
    expect(JSON.stringify(results)).toContain("Q1 planning");
  });

  it("bills exactly the advertised price for the work it did", async () => {
    const { token, tokenHash, stub } = await buyer("delivery-billing", 1_000_000);

    await call(token, "/compress", { text: "a sentence worth compressing here" });

    const ledger = await runInDurableObject(stub, (i: Credits) =>
      i.balance(tokenHash),
    );
    // /compress is $0.005. One call, one debit, no rounding drift.
    expect(ledger?.call_count).toBe(1);
    expect(ledger?.balance_micros).toBe(995_000);
  });
});
