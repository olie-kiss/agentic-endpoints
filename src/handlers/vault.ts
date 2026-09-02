import { Hono } from "hono";
import type { Env } from "../types";
import { signReceipt, errorResponse } from "../lib/utils";

const app = new Hono<{ Bindings: Env }>();

/**
 * POST /vault/store (FREE — no x402 payment required)
 *
 * Store an encrypted item. Client-side encryption is expected —
 * the ciphertext is stored as-is, the server never sees plaintext.
 *
 * Body: { namespace, key, ciphertext, alg?, ttl? }
 */
app.post("/store", async (c) => {
  const body = await c.req.json<{
    namespace: string;
    key: string;
    ciphertext: string;
    alg?: string;
    ttl?: number;
    namespace_token?: string;
  }>();

  if (!body.namespace || !body.key || !body.ciphertext) {
    return errorResponse("namespace, key, and ciphertext are required", 400);
  }

  const id = c.env.VAULT.idFromName(body.namespace);
  const stub = c.env.VAULT.get(id);

  const doResponse = await stub.fetch(
    new Request("https://internal/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: body.key,
        ciphertext: body.ciphertext,
        alg: body.alg,
        ttl: body.ttl,
        namespace_token: body.namespace_token,
      }),
    }),
  );

  const result = await doResponse.json<Record<string, unknown>>();

  if (!doResponse.ok) {
    return c.json(result, doResponse.status as 400 | 403 | 404);
  }

  const receipt = await signReceipt(
    { ...result, namespace: body.namespace },
    c.env.RECEIPT_SECRET,
  );

  return c.json({ ...result, namespace: body.namespace, receipt });
});

/**
 * POST /vault/retrieve (PAID — $0.02 USDC via x402)
 *
 * Retrieve an encrypted item by namespace + key.
 *
 * Body: { namespace, key }
 */
app.post("/retrieve", async (c) => {
  const body = await c.req.json<{
    namespace: string;
    key: string;
    namespace_token?: string;
  }>();

  if (!body.namespace || !body.key) {
    return errorResponse("namespace and key are required", 400);
  }

  const id = c.env.VAULT.idFromName(body.namespace);
  const stub = c.env.VAULT.get(id);

  const doResponse = await stub.fetch(
    new Request("https://internal/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: body.key,
        namespace_token: body.namespace_token,
      }),
    }),
  );

  const result = await doResponse.json<Record<string, unknown>>();

  if (!doResponse.ok) {
    return c.json(result, doResponse.status as 400 | 403 | 404);
  }

  const receipt = await signReceipt(
    { ...result, namespace: body.namespace },
    c.env.RECEIPT_SECRET,
  );

  return c.json({ ...result, namespace: body.namespace, receipt });
});

/**
 * POST /vault/delete (FREE)
 *
 * Delete an encrypted item by namespace + key.
 *
 * Body: { namespace, key }
 */
app.post("/delete", async (c) => {
  const body = await c.req.json<{
    namespace: string;
    key: string;
    namespace_token?: string;
  }>();

  if (!body.namespace || !body.key) {
    return errorResponse("namespace and key are required", 400);
  }

  const id = c.env.VAULT.idFromName(body.namespace);
  const stub = c.env.VAULT.get(id);

  const doResponse = await stub.fetch(
    new Request("https://internal/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: body.key,
        namespace_token: body.namespace_token,
      }),
    }),
  );

  const result = await doResponse.json<Record<string, unknown>>();

  if (!doResponse.ok) {
    return c.json(result, doResponse.status as 400 | 403 | 404);
  }

  return c.json({ ...result, namespace: body.namespace });
});

/**
 * POST /vault/exists (FREE)
 *
 * Check if an encrypted item exists without retrieving it.
 *
 * Body: { namespace, key }
 */
app.post("/exists", async (c) => {
  const body = await c.req.json<{
    namespace: string;
    key: string;
    namespace_token?: string;
  }>();

  if (!body.namespace || !body.key) {
    return errorResponse("namespace and key are required", 400);
  }

  const id = c.env.VAULT.idFromName(body.namespace);
  const stub = c.env.VAULT.get(id);

  const doResponse = await stub.fetch(
    new Request("https://internal/exists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: body.key,
        namespace_token: body.namespace_token,
      }),
    }),
  );

  const result = await doResponse.json<Record<string, unknown>>();

  if (!doResponse.ok) {
    return c.json(result, doResponse.status as 400 | 403 | 404);
  }

  return c.json({ ...result, namespace: body.namespace });
});

export default app;
