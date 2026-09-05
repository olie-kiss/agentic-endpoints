import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../types";
import { signReceipt, errorResponse } from "../lib/utils";

const app = new Hono<{ Bindings: Env }>();

/**
 * POST /vault/store — $0.02
 *
 * Store an encrypted item. Client-side encryption is expected — the
 * ciphertext is stored as-is and the server holds no key that could decrypt
 * it. Note the limits of that claim: the item key, the namespace, the `alg`
 * label and the size are all stored in the clear, so the service can see
 * which named secrets exist and how big they are. `alg` is advisory, and
 * nothing here can verify that what was sent was in fact encrypted.
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
        namespace: body.namespace,
        ciphertext: body.ciphertext,
        alg: body.alg,
        ttl: body.ttl,
        namespace_token: body.namespace_token,
      }),
    }),
  );

  const result = await doResponse.json<Record<string, unknown>>();

  if (!doResponse.ok) {
    return c.json(result, doResponse.status as ContentfulStatusCode);
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
    return c.json(result, doResponse.status as ContentfulStatusCode);
  }

  const receipt = await signReceipt(
    { ...result, namespace: body.namespace },
    c.env.RECEIPT_SECRET,
  );

  return c.json({ ...result, namespace: body.namespace, receipt });
});

/**
 * POST /vault/delete — $0.005
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
    return c.json(result, doResponse.status as ContentfulStatusCode);
  }

  return c.json({ ...result, namespace: body.namespace });
});

/**
 * POST /vault/exists — $0.001
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
    return c.json(result, doResponse.status as ContentfulStatusCode);
  }

  return c.json({ ...result, namespace: body.namespace });
});

/**
 * POST /vault/list — $0.001
 *
 * List the keys in a namespace with their metadata. Never returns
 * ciphertext; that is what /vault/retrieve is for.
 *
 * Each item's `updated_at` is the version to pass back as `if_match` on a
 * conditional store.
 *
 * Body: { namespace, namespace_token }
 */
app.post("/list", async (c) => {
  const body = await c.req.json<{
    namespace: string;
    namespace_token?: string;
  }>();

  if (!body.namespace) {
    return errorResponse("namespace is required", 400);
  }

  const stub = c.env.VAULT.get(c.env.VAULT.idFromName(body.namespace));
  const doResponse = await stub.fetch(
    new Request("https://internal/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace_token: body.namespace_token }),
    }),
  );

  const result = await doResponse.json<Record<string, unknown>>();
  if (!doResponse.ok) {
    return c.json(result, doResponse.status as ContentfulStatusCode);
  }
  return c.json({ ...result, namespace: body.namespace });
});

/**
 * POST /vault/rotate-token — free.
 *
 * Replaces the namespace token. Requires the current one; there is no
 * recovery path if it is lost, because any such path would be a second way
 * into the namespace and would serve an attacker just as well as the owner.
 *
 * Free deliberately: charging for the correct response to a suspected leak
 * is how you end up with callers who do not rotate.
 *
 * Body: { namespace, namespace_token }
 */
app.post("/rotate-token", async (c) => {
  const body = await c.req.json<{
    namespace: string;
    namespace_token?: string;
  }>();

  if (!body.namespace) {
    return errorResponse("namespace is required", 400);
  }

  const stub = c.env.VAULT.get(c.env.VAULT.idFromName(body.namespace));
  const doResponse = await stub.fetch(
    new Request("https://internal/rotate-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace_token: body.namespace_token }),
    }),
  );

  const result = await doResponse.json<Record<string, unknown>>();
  if (!doResponse.ok) {
    return c.json(result, doResponse.status as ContentfulStatusCode);
  }
  return c.json({ ...result, namespace: body.namespace });
});

export default app;
