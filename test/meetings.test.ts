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
  return `m-${crypto.randomUUID()}`;
}

/** Claim a namespace and return its one-time token. */
async function claimed(namespace: string, transcript = "seed transcript") {
  const res = await meetings(namespace, "/import", {
    namespace,
    title: "Seed",
    visibility: "queryable",
    transcript,
  });
  return {
    token: res.json.namespace_token as string,
    meetingId: res.json.meeting_id as string,
  };
}

describe("meeting import and privacy model", () => {
  it("indexes a queryable transcript and makes it searchable", async () => {
    const n = ns();
    const { token } = await claimed(
      n,
      "Alice: we agreed to hold pricing at nine dollars a month.",
    );

    const res = await meetings(n, "/search", {
      namespace_token: token,
      query: "pricing",
    });

    expect(res.json.status).toBe("ok");
    expect(res.json.count).toBe(1);
    const matches = res.json.matches as Record<string, unknown>[];
    expect(String(matches[0].excerpt)).toContain("pricing");
  });

  it("stores a private meeting as opaque ciphertext and never indexes it", async () => {
    const n = ns();
    const { token } = await claimed(n);

    const imported = await meetings(n, "/import", {
      namespace: n,
      namespace_token: token,
      title: "Board call",
      visibility: "private",
      ciphertext: "AAAAsecret-board-ciphertextAAAA",
    });
    expect(imported.json.status).toBe("imported");
    expect(imported.json.searchable).toBe(false);

    // The whole promise of "private": its content cannot surface in a search.
    const res = await meetings(n, "/search", {
      namespace_token: token,
      query: "board",
    });
    expect(JSON.stringify(res.json)).not.toContain("secret-board-ciphertext");
    expect(res.json.private_meetings_skipped).toBe(1);
  });

  it("refuses plaintext under the mode that promises it cannot be read", async () => {
    const n = ns();
    const { token } = await claimed(n);

    // Silently accepting this would store a readable transcript for a caller
    // who believed they had encrypted it.
    const res = await meetings(n, "/import", {
      namespace_token: token,
      visibility: "private",
      transcript: "this was never encrypted",
    });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toContain("ciphertext");
  });

  it("refuses ciphertext that asks to be searchable", async () => {
    const n = ns();
    const { token } = await claimed(n);

    // Accepting this would store a meeting that can never match a search,
    // which the caller would read as "we never discussed that".
    const res = await meetings(n, "/import", {
      namespace_token: token,
      visibility: "queryable",
      ciphertext: "opaque",
    });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toContain("transcript");
  });

  it("defaults to private, never to readable", async () => {
    const n = ns();
    const { token } = await claimed(n);

    const res = await meetings(n, "/import", {
      namespace_token: token,
      ciphertext: "opaque-bytes",
    });
    expect(res.json.visibility).toBe("private");
    expect(res.json.searchable).toBe(false);
  });
});

describe("meeting search honesty", () => {
  it("says nothing was searched when every meeting is private", async () => {
    const n = ns();
    const first = await meetings(n, "/import", {
      namespace: n,
      visibility: "private",
      ciphertext: "opaque",
    });
    const token = first.json.namespace_token as string;

    const res = await meetings(n, "/search", {
      namespace_token: token,
      query: "anything",
    });

    // An empty result here means "nothing was searchable", not "not
    // discussed". Conflating those is how an agent confidently tells a user
    // something never happened.
    expect(res.json.count).toBe(0);
    expect(res.json.searched_meetings).toBe(0);
    expect(res.json.private_meetings_skipped).toBe(1);
    expect(String(res.json.notice)).toContain("No meetings");
  });

  it("reports a malformed query instead of returning zero matches", async () => {
    const n = ns();
    const { token } = await claimed(n, "quarterly budget review notes");

    // Bad FTS5 syntax. Swallowing the parse error would look identical to a
    // genuine miss.
    const res = await meetings(n, "/search", {
      namespace_token: token,
      query: '"unterminated',
    });

    expect(res.json.status).toBe("invalid_query");
    expect(String(res.json.detail)).toContain("NOT the same");
  });

  it("finds a phrase across several meetings and ranks them", async () => {
    const n = ns();
    const { token } = await claimed(n, "kickoff, nothing relevant here");

    for (const [title, transcript] of [
      ["Migration", "Bob owns the database migration and will finish in May"],
      ["Retro", "the migration slipped, Bob flagged the risk early"],
    ]) {
      await meetings(n, "/import", {
        namespace_token: token,
        title,
        visibility: "queryable",
        transcript,
      });
    }

    const res = await meetings(n, "/search", {
      namespace_token: token,
      query: "migration",
    });
    expect(res.json.count).toBe(2);
    expect(res.json.searched_meetings).toBe(3);
  });
});

describe("meeting retrieval and deletion", () => {
  it("returns a full transcript by id", async () => {
    const n = ns();
    const { token, meetingId } = await claimed(n, "the full text of the call");

    const res = await meetings(n, "/get", {
      namespace_token: token,
      meeting_id: meetingId,
    });
    expect(res.json.status).toBe("ok");
    expect(res.json.transcript).toBe("the full text of the call");
  });

  it("answers a missing meeting with 200 and a status, not 404", async () => {
    const n = ns();
    const { token } = await claimed(n);

    // A 4xx would cancel x402 settlement and give the lookup away free.
    const res = await meetings(n, "/get", {
      namespace_token: token,
      meeting_id: "does-not-exist",
    });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("not_found");
  });

  it("removes a deleted transcript from the search index", async () => {
    const n = ns();
    const { token, meetingId } = await claimed(
      n,
      "confidential salary discussion",
    );

    const del = await meetings(n, "/delete", {
      namespace_token: token,
      meeting_id: meetingId,
    });
    expect(del.json.status).toBe("deleted");

    // A delete that leaves the text searchable is a deletion that lied.
    const res = await meetings(n, "/search", {
      namespace_token: token,
      query: "salary",
    });
    expect(res.json.count).toBe(0);
    expect(JSON.stringify(res.json)).not.toContain("confidential salary");
  });

  it("lists meetings without ever returning their content", async () => {
    const n = ns();
    const { token } = await claimed(n, "sensitive spoken words");

    const res = await meetings(n, "/list", { namespace_token: token });
    expect(res.json.count).toBe(1);
    expect(JSON.stringify(res.json)).not.toContain("sensitive spoken words");
  });
});

describe("meeting namespace ownership", () => {
  it("locks out a caller without the token", async () => {
    const n = ns();
    await claimed(n, "private business");

    for (const [path, body] of [
      ["/search", { query: "private" }],
      ["/list", {}],
      ["/get", { meeting_id: "x" }],
      ["/delete", { meeting_id: "x" }],
    ] as [string, Record<string, unknown>][]) {
      const res = await meetings(n, path, body);
      // 200 + forbidden, so probing settles a payment rather than being free.
      expect(res.status).toBe(200);
      expect(res.json.status).toBe("forbidden");
      expect(JSON.stringify(res.json)).not.toContain("private business");
    }
  });

  it("issues the namespace token exactly once", async () => {
    const n = ns();
    const { token } = await claimed(n);

    const second = await meetings(n, "/import", {
      namespace_token: token,
      visibility: "queryable",
      transcript: "another one",
    });
    expect(second.json.status).toBe("imported");
    expect(second.json.namespace_token).toBeUndefined();
  });

  it("rejects a guessable namespace name", async () => {
    const n = "meetings";
    const res = await meetings(n, "/import", {
      namespace: n,
      visibility: "queryable",
      transcript: "squattable",
    });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toContain("guessable");
  });
});
