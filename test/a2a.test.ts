import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * A2A is only worth serving if an agent that speaks it can actually buy
 * something. These tests drive the JSON-RPC transport the way a client would,
 * and assert on the work returned rather than on the envelope.
 */

const A2A = "https://ai.oliverkiss.com/a2a";

async function rpc(method: string, params?: unknown, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(A2A, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: await res.json<any>() };
}

async function trialToken(ip: string): Promise<string> {
  const res = await SELF.fetch("https://ai.oliverkiss.com/credits/trial", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip },
  });
  return (await res.json<{ credit_token: string }>()).credit_token;
}

describe("A2A agent card", () => {
  it("publishes the fields the v0.3 spec requires", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/.well-known/agent-card.json");
    expect(res.status).toBe(200);

    const card = await res.json<any>();
    for (const field of [
      "protocolVersion",
      "name",
      "description",
      "url",
      "version",
      "capabilities",
      "defaultInputModes",
      "defaultOutputModes",
      "skills",
    ]) {
      expect(card[field], `missing required field ${field}`).toBeDefined();
    }

    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.preferredTransport).toBe("JSONRPC");
    expect(card.url).toBe(A2A);
  });

  it("gives every skill the fields a client needs to select one", async () => {
    const card = await (
      await SELF.fetch("https://ai.oliverkiss.com/.well-known/agent-card.json")
    ).json<any>();

    expect(card.skills.length).toBeGreaterThan(10);
    for (const skill of card.skills) {
      expect(skill.id, "skill id is required by the spec").toBeTruthy();
      expect(skill.name).toBeTruthy();
      expect(skill.description).toBeTruthy();
      expect(Array.isArray(skill.tags), "tags are required by the spec").toBe(true);
    }

    const ids = card.skills.map((s: any) => s.id);
    expect(new Set(ids).size, "skill ids must be unique").toBe(ids.length);
  });

  it("advertises only skills the transport can actually run", async () => {
    // A card that lists something /a2a rejects is a card that sends clients
    // into an error, which is worse than not listing it.
    const card = await (
      await SELF.fetch("https://ai.oliverkiss.com/.well-known/agent-card.json")
    ).json<any>();
    const { body } = await rpc("skills/list");

    const advertised = card.skills.map((s: any) => s.id).sort();
    const callable = body.result.skills.map((s: any) => s.skill).sort();
    expect(advertised).toEqual(callable);
  });

  it("answers the pre-0.3 well-known path too", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/.well-known/agent.json");
    expect(res.status).toBe(200);
    expect((await res.json<any>()).protocolVersion).toBe("0.3.0");
  });
});

describe("A2A message/send", () => {
  it("delivers real work to a paying A2A client", async () => {
    const token = await trialToken("198.51.100.5");

    const { body } = await rpc(
      "message/send",
      {
        message: {
          kind: "message",
          role: "user",
          messageId: "m-1",
          parts: [
            {
              kind: "data",
              data: {
                skill: "compress",
                input: {
                  text: "Revenue rose sharply in the third quarter. ".repeat(80),
                  target_tokens: 20,
                },
              },
            },
          ],
        },
      },
      { "X-Credit-Token": token },
    );

    expect(body.error).toBeUndefined();
    expect(body.result.kind).toBe("message");
    expect(body.result.role).toBe("agent");

    // The point: an A2A caller receives the compressed text, not a status.
    const data = body.result.parts.find((p: any) => p.kind === "data").data;
    expect(data.text).toContain("Revenue");
    expect(data.compressed_length).toBeLessThan(data.original_length);
    expect(body.result.metadata.http_status).toBe(200);
  });

  it("accepts the skill named in message metadata", async () => {
    const token = await trialToken("198.51.100.6");

    const { body } = await rpc(
      "message/send",
      {
        message: {
          kind: "message",
          role: "user",
          messageId: "m-2",
          metadata: { skill: "compress" },
          parts: [
            {
              kind: "data",
              data: { input: { text: "a ".repeat(500), target_tokens: 10 } },
            },
          ],
        },
      },
      { "X-Credit-Token": token },
    );

    expect(body.error).toBeUndefined();
    expect(body.result.parts[0].data.compressed_length).toBeLessThan(1000);
  });

  it("returns a payment challenge, and the free way out, when unpaid", async () => {
    const { body } = await rpc("message/send", {
      message: {
        kind: "message",
        role: "user",
        messageId: "m-3",
        parts: [{ kind: "data", data: { skill: "compress", input: { text: "hello" } } }],
      },
    });

    expect(body.error).toBeUndefined();
    expect(body.result.metadata["x402.payment.status"]).toBe("payment-required");
    expect(body.result.metadata["x402.payment.required"]).toBeTruthy();
    // An agent that cannot pay must still be told how to proceed.
    expect(body.result.metadata.free_trial).toContain("/credits/trial");
  });

  it("charges the account exactly once for one A2A call", async () => {
    const token = await trialToken("198.51.100.7");

    await rpc(
      "message/send",
      {
        message: {
          kind: "message",
          role: "user",
          messageId: "m-4",
          parts: [
            { kind: "data", data: { skill: "compress", input: { text: "hello world" } } },
          ],
        },
      },
      { "X-Credit-Token": token },
    );

    const ledger = await (
      await SELF.fetch("https://ai.oliverkiss.com/credits/balance", {
        method: "POST",
        headers: { "X-Credit-Token": token },
      })
    ).json<any>();

    expect(ledger.call_count).toBe(1);
    expect(ledger.spent_usd).toBe("0.005000");
  });
});

describe("A2A protocol errors", () => {
  it("rejects a body that is not JSON-RPC 2.0", async () => {
    const { body } = await rpc("message/send", {});
    expect(body.error).toBeDefined();

    const res = await SELF.fetch(A2A, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1, method: "message/send" }),
    });
    expect((await res.json<any>()).error.code).toBe(-32600);
  });

  it("refuses batches instead of answering only the first", async () => {
    const res = await SELF.fetch(A2A, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "skills/list" }]),
    });
    const body = await res.json<any>();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain("Batch");
  });

  it("reports an unknown method and an unknown skill differently", async () => {
    expect((await rpc("does/notexist")).body.error.code).toBe(-32601);

    const unknown = await rpc("message/send", {
      message: {
        kind: "message",
        role: "user",
        messageId: "m-5",
        parts: [{ kind: "data", data: { skill: "not-a-skill", input: {} } }],
      },
    });
    expect(unknown.body.error.code).toBe(-32602);
    expect(unknown.body.error.data.available).toContain("compress");
  });

  it("does not claim streaming or tasks it cannot honour", async () => {
    expect((await rpc("message/stream", {})).body.error.code).toBe(-32004);
    expect((await rpc("tasks/get", { id: "x" })).body.error.code).toBe(-32001);
  });

  it("returns invalid JSON as a parse error, not a crash", async () => {
    const res = await SELF.fetch(A2A, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect((await res.json<any>()).error.code).toBe(-32700);
  });
});
