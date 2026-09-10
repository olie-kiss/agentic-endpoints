import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function meetings(
  namespace: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const stub = env.MEETINGS.get(env.MEETINGS.idFromName(namespace));
  const res = await stub.fetch(
    new Request(`https://internal${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

function ns() {
  return `s-${crypto.randomUUID()}`;
}

async function claimed(namespace: string, transcript: string, title = "Seed") {
  const res = await meetings(namespace, "/import", {
    namespace,
    title,
    visibility: "queryable",
    transcript,
  });
  return {
    token: res.json.namespace_token as string,
    meetingId: res.json.meeting_id as string,
  };
}

/**
 * A summarizer's dangerous failure is not a wrong answer, it is a confident
 * one built from nothing. Every test here is about the service declining to
 * produce that, because the caller cannot tell the difference afterwards.
 */
describe("summarize refuses to invent an answer", () => {
  it("never calls the model when nothing matched", async () => {
    const n = ns();
    const { token } = await claimed(n, "we discussed the office move");

    const res = await meetings(n, "/summarize", {
      namespace_token: token,
      question: "what did we decide about cryptocurrency custody?",
    });

    expect(res.json.status).toBe("no_matches");
    expect(res.json.answer).toBeNull();
    expect(res.json.consulted).toEqual([]);
    expect(String(res.json.notice)).toContain("no answer was generated");
  });

  it("distinguishes 'all private' from 'never discussed'", async () => {
    // The two are indistinguishable in the result but opposite in meaning.
    const n = ns();
    const first = await meetings(n, "/import", {
      namespace: n,
      visibility: "private",
      ciphertext: "opaque bytes",
    });
    const token = first.json.namespace_token as string;

    const res = await meetings(n, "/summarize", {
      namespace_token: token,
      question: "what did we decide about pricing?",
    });

    expect(res.json.status).toBe("no_matches");
    expect(res.json.searched_meetings).toBe(0);
    expect(res.json.private_meetings_skipped).toBe(1);
    expect(String(res.json.notice)).toContain("NOTHING was searched");
  });

  it("reports a question with no searchable terms", async () => {
    const n = ns();
    const { token } = await claimed(n, "the budget was approved");

    const res = await meetings(n, "/summarize", {
      namespace_token: token,
      question: "??? !!!",
    });

    expect(res.json.status).toBe("unusable_question");
    expect(String(res.json.detail)).toContain("NOT a finding");
  });

  it("accepts a natural question that would be invalid search syntax", async () => {
    // Passed to /search this throws an FTS5 error. It must not throw here.
    const n = ns();
    const { token } = await claimed(n, "we agreed to defer the pricing change");

    const res = await meetings(n, "/summarize", {
      namespace_token: token,
      question: 'what did we decide about "pricing (and the audit)?',
    });

    // Whether inference itself succeeds is not the point; the query must not
    // have been rejected by the index.
    expect(res.json.status).not.toBe("error");
    expect(res.json.status).not.toBe("unusable_question");
    expect(res.json.terms).toContain("pricing");
  });

  it("refuses a caller who does not own the namespace", async () => {
    const n = ns();
    await claimed(n, "confidential board discussion");

    const res = await meetings(n, "/summarize", {
      namespace_token: "not-the-token",
      question: "what was discussed?",
    });

    // 200 by design, not an oversight: a 4xx would cancel x402 settlement and
    // leave the payment replayable, turning this into a free oracle for which
    // namespaces exist. Charging is what makes guessing expensive.
    expect(res.json.status).toBe("forbidden");
    expect(res.json.answer).toBeUndefined();
    expect(res.json.consulted).toBeUndefined();
  });

  it("requires a question", async () => {
    const n = ns();
    const { token } = await claimed(n, "anything");

    const res = await meetings(n, "/summarize", { namespace_token: token });
    expect(res.status).toBe(400);
  });
});

describe("summarize retrieval", () => {
  it("consults only the meetings that matched", async () => {
    const n = ns();
    const { token } = await claimed(n, "the office move to the new floor");
    const wanted = await meetings(n, "/import", {
      namespace: n,
      namespace_token: token,
      title: "Pricing review",
      visibility: "queryable",
      transcript: "we agreed to defer the pricing change until Q3",
    });

    const res = await meetings(n, "/summarize", {
      namespace_token: token,
      question: "what did we decide about pricing?",
    });

    const consulted = (res.json.consulted ?? []) as Record<string, unknown>[];
    const ids = consulted.map((c) => c.meeting_id);
    expect(ids).toContain(wanted.json.meeting_id);
  });

  it("caps how many meetings one answer can consult", async () => {
    // The endpoint is a fixed price; unbounded context is an unbounded cost.
    const n = ns();
    const { token } = await claimed(n, "pricing seed");
    for (let i = 0; i < 12; i++) {
      await meetings(n, "/import", {
        namespace: n,
        namespace_token: token,
        title: `Pricing ${i}`,
        visibility: "queryable",
        transcript: `meeting ${i} about pricing`,
      });
    }

    const res = await meetings(n, "/summarize", {
      namespace_token: token,
      question: "pricing",
      limit: 50,
    });

    const consulted = (res.json.consulted ?? []) as unknown[];
    expect(consulted.length).toBeLessThanOrEqual(8);
  });

  it("flags a truncated transcript so its silence is not read as evidence", async () => {
    const n = ns();
    const big = "pricing " + "filler ".repeat(40000);
    const { token } = await claimed(n, big, "Long call");

    const res = await meetings(n, "/summarize", {
      namespace_token: token,
      question: "pricing",
    });

    const consulted = (res.json.consulted ?? []) as Record<string, unknown>[];
    if (consulted.length > 0) {
      expect(consulted[0].truncated).toBe(true);
      expect(Number(consulted[0].chars_used)).toBeLessThan(big.length);
    }
  });
});

describe("summarize when the model is unavailable", () => {
  it("hands back the meetings it found instead of nothing", async () => {
    // Retrieval already succeeded and the caller already paid. Returning a
    // bare error would make them pay again to rediscover the same meetings,
    // and would look identical to an empty namespace.
    const n = ns();
    const { token, meetingId } = await claimed(
      n,
      "we agreed to defer the pricing change until Q3",
    );

    const res = await meetings(n, "/summarize", {
      namespace_token: token,
      question: "what did we decide about pricing?",
    });

    if (res.json.status === "unavailable") {
      expect(res.status).toBe(503);
      expect(res.json.answer).toBeNull();
      const consulted = res.json.consulted as Record<string, unknown>[];
      expect(consulted.map((c) => c.meeting_id)).toContain(meetingId);
    } else {
      // The model was reachable, so this ran the real path instead.
      expect(res.json.status).toBe("ok");
      expect(String(res.json.answer).length).toBeGreaterThan(0);
    }
  });
});
