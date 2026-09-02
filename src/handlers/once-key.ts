import { Hono } from "hono";
import type { Env, ClaimRequest } from "../types";
import { signReceipt, errorResponse } from "../lib/utils";

const app = new Hono<{ Bindings: Env }>();

/**
 * POST /once-key
 *
 * Atomic idempotency witness. Agents pay $0.001 to claim a
 * {namespace, action_key} pair exactly once. Returns a signed receipt.
 *
 * Body: { namespace, action_key, payload_sha256?, ttl? }
 */
app.post("/", async (c) => {
  const body = await c.req.json<ClaimRequest>();

  if (!body.namespace || !body.action_key) {
    return errorResponse("namespace and action_key are required", 400);
  }

  // Route to the Durable Object for this namespace
  const id = c.env.ONCE_KEY.idFromName(body.namespace);
  const stub = c.env.ONCE_KEY.get(id);

  const doResponse = await stub.fetch(
    new Request("https://internal/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_key: body.action_key,
        payload_sha256: body.payload_sha256,
        namespace_token: body.namespace_token,
        ttl: body.ttl,
      }),
    }),
  );

  const result = await doResponse.json<Record<string, unknown>>();

  // Authorization and validation failures carry no receipt and must keep
  // their status so the payment is not settled for a rejected request.
  if (!doResponse.ok) {
    return c.json(result, doResponse.status as 400 | 403 | 405);
  }

  // Attach a signed receipt
  const receipt = await signReceipt(
    { ...result, namespace: body.namespace },
    c.env.RECEIPT_SECRET,
  );

  return c.json({ ...result, namespace: body.namespace, receipt });
});

export default app;
