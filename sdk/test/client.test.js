import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgenticEndpoints,
  ConflictError,
  InProgressError,
  PaymentRequiredError,
} from "../dist/index.js";

/**
 * A stand-in for the service. Each test scripts the /once-key responses it
 * wants and then asserts on what the client did — which is the only way to
 * check the branches that must NOT run the work.
 */
function fakeServer(claimResponses) {
  const calls = [];
  const queue = [...claimResponses];

  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(init.body) });

    if (path === "/once-key") {
      // A queue that runs dry used to throw an unrelated TypeError, which
      // masked what a test was actually asserting. Repeating the final
      // scripted response keeps a test that scripts one 402 meaningful now
      // that a refused payment is retried.
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next.status === 402) {
        return new Response("{}", {
          status: 402,
          headers: { "payment-required": "challenge-blob" },
        });
      }
      return Response.json(next);
    }
    return Response.json({ status: "ok" });
  };

  return { fetchImpl, calls };
}

const base = { namespace: "test", actionKey: "k", namespaceToken: "tok" };

test("performs the work and records the result when it wins the claim", async () => {
  const { fetchImpl, calls } = fakeServer([{ status: "claimed" }]);
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  let ran = 0;
  const out = await client.exactlyOnce(base, async () => {
    ran++;
    return { charge: "ch_1" };
  });

  assert.equal(ran, 1);
  assert.equal(out.outcome, "performed");
  assert.deepEqual(out.result, { charge: "ch_1" });

  const complete = calls.find((c) => c.path === "/once-key/complete");
  assert.ok(complete, "must record the result, or no other agent can learn it");
  assert.deepEqual(complete.body.result, { charge: "ch_1" });
});

test("replays the stored result without running the work again", async () => {
  const { fetchImpl, calls } = fakeServer([
    { status: "duplicate", result: { charge: "ch_original" } },
  ]);
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  let ran = 0;
  const out = await client.exactlyOnce(base, async () => {
    ran++;
    return { charge: "ch_duplicate" };
  });

  // The entire purpose of the product: the side effect does not happen twice.
  assert.equal(ran, 0);
  assert.equal(out.outcome, "replayed");
  assert.deepEqual(out.result, { charge: "ch_original" });
  assert.ok(!calls.some((c) => c.path === "/once-key/complete"));
});

test("releases the claim when the work throws, then rethrows", async () => {
  const { fetchImpl, calls } = fakeServer([{ status: "claimed" }]);
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  await assert.rejects(
    client.exactlyOnce(base, async () => {
      throw new Error("card declined");
    }),
    // The caller's error must survive intact; swallowing it for a protocol
    // error would hide why the work actually failed.
    /card declined/,
  );

  assert.ok(calls.some((c) => c.path === "/once-key/release"));
  assert.ok(!calls.some((c) => c.path === "/once-key/complete"));
});

test("does not complete a claim whose release also failed", async () => {
  let releaseAttempted = false;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/once-key") return Response.json({ status: "claimed" });
    if (path === "/once-key/release") {
      releaseAttempted = true;
      throw new Error("network down");
    }
    return Response.json({ status: "ok" });
  };

  const client = new AgenticEndpoints({ fetch: fetchImpl });
  await assert.rejects(
    client.exactlyOnce(base, async () => {
      throw new Error("original failure");
    }),
    /original failure/,
  );
  assert.equal(releaseAttempted, true);
});

test("refuses to work when another caller holds the lease", async () => {
  const { fetchImpl } = fakeServer([
    { status: "in_progress", retry_after: 30 },
  ]);
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  let ran = 0;
  await assert.rejects(
    client.exactlyOnce(base, async () => {
      ran++;
      return 1;
    }),
    InProgressError,
  );
  assert.equal(ran, 0, "must not run work that another agent is already doing");
});

test("waits out a lease only when explicitly told to", async () => {
  const { fetchImpl, calls } = fakeServer([
    { status: "in_progress", retry_after: 0 },
    { status: "duplicate", result: "done-by-someone-else" },
  ]);
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  const out = await client.exactlyOnce(
    { ...base, waitAttempts: 1 },
    async () => "mine",
  );

  assert.equal(out.result, "done-by-someone-else");
  // Each retry is a fresh paid claim, so the count matters.
  assert.equal(calls.filter((c) => c.path === "/once-key").length, 2);
});

test("treats a payload conflict as fatal", async () => {
  const { fetchImpl } = fakeServer([{ status: "conflict" }]);
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  let ran = 0;
  await assert.rejects(
    client.exactlyOnce(base, async () => {
      ran++;
      return 1;
    }),
    ConflictError,
  );
  assert.equal(ran, 0);
});

test("captures the one-time namespace token before anything can throw", async () => {
  const { fetchImpl } = fakeServer([
    { status: "claimed", namespace_token: "secret-token" },
  ]);
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  // Losing this token locks the namespace forever, so it has to come back
  // even though the caller never asked for it.
  const out = await client.exactlyOnce(
    { namespace: "fresh", actionKey: "k" },
    async () => "v",
  );
  assert.equal(out.namespaceToken, "secret-token");
});

test("surfaces the x402 challenge from the header, not the empty body", async () => {
  const { fetchImpl } = fakeServer([{ status: 402 }]);
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  await assert.rejects(
    client.exactlyOnce(base, async () => "v"),
    (err) => {
      assert.ok(err instanceof PaymentRequiredError);
      assert.equal(err.challenge, "challenge-blob");
      return true;
    },
  );
});

/**
 * A server that scripts both /once-key and /once-key/complete, so the
 * completion branch can be exercised too.
 */
function scriptedServer({ claim, complete }) {
  const ran = { work: 0 };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/once-key") return Response.json(claim);
    if (path === "/once-key/complete") return Response.json(complete ?? { status: "completed" });
    return Response.json({ status: "ok" });
  };
  return { fetchImpl, ran };
}

test("a duplicate carrying no result is never reported as success", async () => {
  const { fetchImpl } = scriptedServer({ claim: { status: "duplicate" } });
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  await assert.rejects(
    () => client.exactlyOnce(base, async () => "work"),
    (err) => err.name === "HeldError",
  );
});

test("an empty recorded result replays as null, not as an error", async () => {
  const { fetchImpl } = scriptedServer({
    claim: { status: "duplicate", result: null, has_result: false },
  });
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  const res = await client.exactlyOnce(base, async () => "work");
  assert.equal(res.outcome, "replayed");
  assert.equal(res.result, null);
  assert.equal(res.hasResult, false);
});

test("a corrupted stored result is not replayed as an empty one", async () => {
  const { fetchImpl } = scriptedServer({
    claim: {
      status: "duplicate",
      result: null,
      has_result: false,
      result_error: "stored result could not be decoded",
    },
  });
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  await assert.rejects(
    () => client.exactlyOnce(base, async () => "work"),
    (err) => err.name === "ResultUnavailableError",
  );
});

test("a held key is an error, and the work is never run", async () => {
  let ran = false;
  const { fetchImpl } = scriptedServer({
    claim: { status: "held", expires_at: "2099-01-01T00:00:00.000Z" },
  });
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  await assert.rejects(
    () =>
      client.exactlyOnce(base, async () => {
        ran = true;
        return "work";
      }),
    (err) => err.name === "HeldError",
  );
  assert.equal(ran, false, "the side effect must not run for a held key");
});

test("losing the lease mid-flight is surfaced, not reported as performed", async () => {
  const { fetchImpl } = scriptedServer({
    claim: { status: "claimed" },
    complete: {
      status: "already_completed",
      result: { chargedBy: "B" },
      has_result: true,
    },
  });
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  await assert.rejects(
    () => client.exactlyOnce(base, async () => ({ chargedBy: "A" })),
    (err) => {
      assert.equal(err.name, "LeaseLostError");
      assert.deepEqual(err.yourResult, { chargedBy: "A" });
      assert.deepEqual(err.recordedResult, { chargedBy: "B" });
      return true;
    },
  );
});

test("a forbidden namespace is an error, and the work is never run", async () => {
  // The service answers 200 (a 4xx would cancel x402 settlement and make
  // namespace probing free), so denial is indistinguishable from success at
  // the HTTP layer. If the client does not read the status it will run the
  // very side effect the namespace token exists to gate.
  let ran = false;
  const { fetchImpl } = scriptedServer({
    claim: {
      status: "forbidden",
      error: "Invalid or missing namespace_token for this namespace",
    },
  });
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  await assert.rejects(
    () =>
      client.exactlyOnce(base, async () => {
        ran = true;
        return "work";
      }),
    (err) => err.name === "UnauthorizedError",
  );
  assert.equal(ran, false, "denied callers must not run the side effect");
});

test("an unrecognised claim status refuses to run the work", async () => {
  // Forward compatibility: a newer service returning a status this client
  // does not know must never fall through into "we own the claim".
  let ran = false;
  const { fetchImpl } = scriptedServer({
    claim: { status: "some_future_status" },
  });
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  await assert.rejects(
    () =>
      client.exactlyOnce(base, async () => {
        ran = true;
        return "work";
      }),
    (err) => /unrecognised status/.test(err.message),
  );
  assert.equal(ran, false, "an unknown status must not run the side effect");
});

/**
 * Retry-on-402 tests.
 *
 * The facilitator refuses overlapping authorizations from one payer, and a
 * refused call settles nothing, so retrying is safe. These pin the boundary:
 * retry when payment is actually possible, never otherwise.
 */
test("retries a refused payment and succeeds on a later attempt", async () => {
  const { fetchImpl, calls } = fakeServer([
    { status: 402 },
    { status: 402 },
    { status: "claimed" },
  ]);
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  let ran = 0;
  const out = await client.exactlyOnce(base, async () => {
    ran++;
    return { ok: true };
  });

  assert.equal(out.outcome, "performed");
  assert.equal(ran, 1, "the work must run exactly once despite the retries");
  assert.equal(
    calls.filter((c) => c.path === "/once-key").length,
    3,
    "should have attempted the claim three times",
  );
});

test("gives up after maxPaymentRetries and reports payment required", async () => {
  const { fetchImpl, calls } = fakeServer([
    { status: 402 },
    { status: 402 },
    { status: 402 },
    { status: 402 },
  ]);
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  await assert.rejects(
    () => client.exactlyOnce(base, async () => ({ ok: true })),
    PaymentRequiredError,
  );
  // Default is 2 retries, so 3 attempts total — not the 4 that were queued.
  assert.equal(calls.filter((c) => c.path === "/once-key").length, 3);
});

test("does not retry when no payment mechanism was supplied", async () => {
  // Without an x402-aware fetch a 402 recurs forever, so retrying would only
  // burn time to arrive at the same error.
  const { fetchImpl, calls } = fakeServer([{ status: 402 }, { status: 402 }]);
  const globalBefore = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const client = new AgenticEndpoints({});
    await assert.rejects(
      () => client.exactlyOnce(base, async () => ({ ok: true })),
      PaymentRequiredError,
    );
    assert.equal(calls.filter((c) => c.path === "/once-key").length, 1);
  } finally {
    globalThis.fetch = globalBefore;
  }
});

test("honours maxPaymentRetries: 0", async () => {
  const { fetchImpl, calls } = fakeServer([{ status: 402 }, { status: "claimed" }]);
  const client = new AgenticEndpoints({ fetch: fetchImpl, maxPaymentRetries: 0 });

  await assert.rejects(
    () => client.exactlyOnce(base, async () => ({ ok: true })),
    PaymentRequiredError,
  );
  assert.equal(calls.filter((c) => c.path === "/once-key").length, 1);
});

test("preserves the payment challenge across retries", async () => {
  const { fetchImpl } = fakeServer([{ status: 402 }, { status: 402 }, { status: 402 }]);
  const client = new AgenticEndpoints({ fetch: fetchImpl });

  await client
    .exactlyOnce(base, async () => ({ ok: true }))
    .then(
      () => assert.fail("should have thrown"),
      (err) => {
        assert.ok(err instanceof PaymentRequiredError);
        assert.equal(err.challenge, "challenge-blob");
      },
    );
});
