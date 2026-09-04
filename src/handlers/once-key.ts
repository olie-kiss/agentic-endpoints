import { Hono } from "hono";
import type { Env, ClaimRequest } from "../types";
import { signReceipt, errorResponse } from "../lib/utils";

const app = new Hono<{ Bindings: Env }>();

type Action = "claim" | "complete" | "release";

/**
 * Forward one operation to the Durable Object that owns `namespace`.
 *
 * Every outcome that represents real work is returned with a signed receipt.
 * Failures are passed through with their original status so the x402 layer
 * does not settle payment for a request that did nothing.
 */
async function forward(
  c: { env: Env; json: (v: unknown, s?: 400 | 403 | 404 | 405 | 409 | 413) => Response },
  action: Action,
  body: ClaimRequest & { lease_ttl?: number; result?: unknown },
): Promise<Response> {
  if (!body.namespace || !body.action_key) {
    return errorResponse("namespace and action_key are required", 400);
  }

  const id = c.env.ONCE_KEY.idFromName(body.namespace);
  const stub = c.env.ONCE_KEY.get(id);

  const doResponse = await stub.fetch(
    new Request(`https://internal/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_key: body.action_key,
        payload_sha256: body.payload_sha256,
        namespace_token: body.namespace_token,
        ttl: body.ttl,
        lease_ttl: body.lease_ttl,
        result: body.result,
      }),
    }),
  );

  const result = await doResponse.json<Record<string, unknown>>();

  // Authorization and validation failures carry no receipt and must keep
  // their status so the payment is not settled for a rejected request.
  if (!doResponse.ok) {
    return c.json(result, doResponse.status as 400 | 403 | 404 | 405 | 409 | 413);
  }

  const receipt = await signReceipt(
    { ...result, namespace: body.namespace },
    c.env.RECEIPT_SECRET,
  );

  return c.json({ ...result, namespace: body.namespace, receipt });
}

/**
 * POST /once-key
 *
 * Atomic idempotency witness. Agents pay $0.001 to claim a
 * {namespace, action_key} pair exactly once, then do the real work.
 *
 * Body: { namespace, action_key, payload_sha256?, ttl?, lease_ttl? }
 */
app.post("/", async (c) => {
  const body = await c.req.json<ClaimRequest>();
  return forward(c, "claim", body);
});

/**
 * POST /once-key/complete — free.
 *
 * Records the outcome of a claimed action. Later claims of the same
 * action_key replay this result instead of repeating the side effect, which
 * is the only thing that makes an idempotency key useful to the caller that
 * lost the race. Charging for it again would push callers to skip it and
 * leave every key dangling, so the claim price covers the whole lifecycle.
 *
 * Body: { namespace, action_key, namespace_token, result?, ttl? }
 */
app.post("/complete", async (c) => {
  const body = await c.req.json<
    ClaimRequest & { result?: unknown }
  >();
  return forward(c, "complete", body);
});

/**
 * POST /once-key/release — free.
 *
 * Surrenders a claim whose work failed, so a retry can proceed immediately
 * rather than waiting out the lease.
 *
 * Body: { namespace, action_key, namespace_token }
 */
app.post("/release", async (c) => {
  const body = await c.req.json<ClaimRequest>();
  return forward(c, "release", body);
});

export default app;
