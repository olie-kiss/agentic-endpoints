import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../types";
import { errorResponse } from "../lib/utils";

const app = new Hono<{ Bindings: Env }>();

/**
 * Meeting memory — import transcripts once, then let your agents ask
 * questions across all of them.
 *
 * Every route forwards to the namespace's Durable Object and adds nothing of
 * its own, so the ownership check and the privacy rules live in exactly one
 * place.
 */
async function callDo(
  env: Env,
  namespace: string,
  path: string,
  payload: Record<string, unknown>,
) {
  const stub = env.MEETINGS.get(env.MEETINGS.idFromName(namespace));
  const res = await stub.fetch(
    new Request(`https://internal${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  return { res, json: await res.json<Record<string, unknown>>() };
}

/**
 * POST /meetings/import — $0.004
 *
 * `visibility` decides whether this service can read the transcript, and it
 * has to be stated. See the Durable Object for why the mismatched
 * combinations are refused instead of resolved.
 */
app.post("/import", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();

  if (!body.namespace || typeof body.namespace !== "string") {
    return errorResponse("namespace is required", 400);
  }

  const { res, json } = await callDo(c.env, body.namespace, "/import", body);
  if (!res.ok) return c.json(json, res.status as ContentfulStatusCode);
  return c.json({ ...json, namespace: body.namespace });
});

/**
 * POST /meetings/search — $0.006
 *
 * Full-text search across the meetings imported as `queryable`. Private
 * meetings are invisible here by construction, and the response says how many
 * were skipped so an empty result is never mistaken for an absent meeting.
 */
app.post("/search", async (c) => {
  const body = await c.req.json<{
    namespace?: string;
    namespace_token?: string;
    query?: string;
    limit?: number;
  }>();

  if (!body.namespace) return errorResponse("namespace is required", 400);
  if (!body.query) return errorResponse("query is required", 400);

  const { res, json } = await callDo(c.env, body.namespace, "/search", {
    namespace_token: body.namespace_token,
    query: body.query,
    limit: body.limit,
  });
  if (!res.ok) return c.json(json, res.status as ContentfulStatusCode);
  return c.json({ ...json, namespace: body.namespace });
});

/** POST /meetings/get — $0.002. Returns one meeting in full. */
app.post("/get", async (c) => {
  const body = await c.req.json<{
    namespace?: string;
    namespace_token?: string;
    meeting_id?: string;
  }>();

  if (!body.namespace) return errorResponse("namespace is required", 400);
  if (!body.meeting_id) return errorResponse("meeting_id is required", 400);

  const { res, json } = await callDo(c.env, body.namespace, "/get", {
    namespace_token: body.namespace_token,
    meeting_id: body.meeting_id,
  });
  if (!res.ok) return c.json(json, res.status as ContentfulStatusCode);
  return c.json({ ...json, namespace: body.namespace });
});

/** POST /meetings/list — $0.001. Metadata only; never returns content. */
app.post("/list", async (c) => {
  const body = await c.req.json<{
    namespace?: string;
    namespace_token?: string;
    limit?: number;
  }>();

  if (!body.namespace) return errorResponse("namespace is required", 400);

  const { res, json } = await callDo(c.env, body.namespace, "/list", {
    namespace_token: body.namespace_token,
    limit: body.limit,
  });
  if (!res.ok) return c.json(json, res.status as ContentfulStatusCode);
  return c.json({ ...json, namespace: body.namespace });
});

/** POST /meetings/delete — $0.001. Removes the record and its index entry. */
app.post("/delete", async (c) => {
  const body = await c.req.json<{
    namespace?: string;
    namespace_token?: string;
    meeting_id?: string;
  }>();

  if (!body.namespace) return errorResponse("namespace is required", 400);
  if (!body.meeting_id) return errorResponse("meeting_id is required", 400);

  const { res, json } = await callDo(c.env, body.namespace, "/delete", {
    namespace_token: body.namespace_token,
    meeting_id: body.meeting_id,
  });
  if (!res.ok) return c.json(json, res.status as ContentfulStatusCode);
  return c.json({ ...json, namespace: body.namespace });
});

export default app;
