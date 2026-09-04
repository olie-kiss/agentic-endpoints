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
      const next = queue.shift();
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
