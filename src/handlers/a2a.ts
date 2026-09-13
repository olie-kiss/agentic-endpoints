import { Hono } from "hono";
import type { Env } from "../types";
import { buildRoutes } from "../index";
import { describeRoutes, FREE_POST_ENDPOINTS, skillId } from "../lib/discovery";

/**
 * A2A (Agent2Agent) JSON-RPC transport, speaking protocol version 0.3.
 *
 * Every skill is an existing HTTP route: a request here is translated into
 * that route and dispatched in-process, so pricing, credit balances, payment
 * verification and rate limiting are the ones already in front of the HTTP
 * API rather than a second implementation that can disagree with it.
 *
 * The notable difference from most paid agents is that the *paid* skills are
 * reachable over A2A at all. A2A has no payment step of its own, so services
 * that charge money usually expose their free operations here and document
 * the paid ones as something you must leave A2A to buy. Because this service
 * already sells prepaid credit as a header, a credit token makes every paid
 * skill callable in one round trip — and /credits/trial hands one out free.
 */

type Dispatcher = (req: Request) => Promise<Response>;

const app = new Hono<{ Bindings: Env; Variables: { dispatch: Dispatcher } }>();

/** JSON-RPC error codes: standard range, plus the A2A-specific ones. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const TASK_NOT_FOUND = -32001;
const UNSUPPORTED_OPERATION = -32004;

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message, data } };
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

/** An A2A Message from this agent. Ids are opaque to the caller. */
function agentMessage(
  parts: unknown[],
  extra: { contextId?: string; taskId?: string; metadata?: Record<string, unknown> } = {},
) {
  return {
    kind: "message" as const,
    role: "agent" as const,
    messageId: crypto.randomUUID(),
    parts,
    ...extra,
  };
}

/**
 * Every skill this agent exposes, mapped to the route that performs it.
 *
 * Built from the same config as the agent card, so a skill can never be
 * advertised without being callable, or callable without being advertised.
 */
export function skillRoutes(env: Env): Map<string, { path: string; paid: boolean }> {
  const map = new Map<string, { path: string; paid: boolean }>();

  for (const route of describeRoutes(buildRoutes(env))) {
    if (route.path.startsWith("/credits/")) continue;
    map.set(skillId(route.path), { path: route.path, paid: true });
  }
  for (const endpoint of FREE_POST_ENDPOINTS) {
    map.set(skillId(endpoint.path), { path: endpoint.path, paid: false });
  }

  return map;
}

/**
 * Pulls the requested skill and its input out of an A2A message.
 *
 * A2A carries intent as free-form parts, which is workable for a conversational
 * agent and useless for one that must be billed for the right operation. So a
 * skill is named explicitly: either in message.metadata.skill, or as a
 * `{ skill, input }` DataPart. Both are accepted because both are what a
 * client is likely to try first, and guessing wrong here charges someone for
 * the wrong endpoint.
 */
function readInvocation(message: Record<string, any>): {
  skill?: string;
  input: Record<string, unknown>;
  error?: string;
} {
  if (!message || typeof message !== "object") {
    return { input: {}, error: "params.message is required." };
  }

  const parts = Array.isArray(message.parts) ? message.parts : [];
  const dataParts = parts.filter(
    (p: any) => p && p.kind === "data" && p.data && typeof p.data === "object",
  );

  const metaSkill =
    typeof message.metadata?.skill === "string" ? message.metadata.skill : undefined;

  // A DataPart naming the skill wins over one that only carries input, so a
  // caller that sends both is never charged for whichever happened to be first.
  const naming = dataParts.find((p: any) => typeof p.data.skill === "string");

  if (naming) {
    const input = naming.data.input;
    return {
      skill: naming.data.skill,
      input: input && typeof input === "object" ? input : {},
    };
  }

  if (metaSkill) {
    const carrying = dataParts.find((p: any) => p.data.input && typeof p.data.input === "object");
    if (carrying) return { skill: metaSkill, input: carrying.data.input };
    return { skill: metaSkill, input: dataParts[0]?.data ?? {} };
  }

  return {
    input: {},
    error:
      "No skill named. Send metadata.skill, or a DataPart shaped { skill, input }. " +
      "Call skills/list or read /.well-known/agent-card.json for the available ids.",
  };
}

app.post("/", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(rpcError(null, PARSE_ERROR, "Request body is not valid JSON."));
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    // Batches are refused explicitly rather than silently ignored: a caller
    // that sends one and gets a single reply would mis-attribute the result.
    return c.json(
      rpcError(
        null,
        INVALID_REQUEST,
        Array.isArray(body)
          ? "Batch requests are not supported. Send one request object."
          : "Request must be a JSON-RPC 2.0 object.",
      ),
    );
  }

  const { id, method, params } = body;

  if (body.jsonrpc !== "2.0") {
    return c.json(rpcError(id, INVALID_REQUEST, 'Field "jsonrpc" must be "2.0".'));
  }

  switch (method) {
    case "message/send":
      return c.json(await sendMessage(c, id, params));

    case "message/stream":
      return c.json(
        rpcError(
          id,
          UNSUPPORTED_OPERATION,
          "Streaming is not supported; the agent card advertises streaming: false. Use message/send.",
        ),
      );

    case "tasks/get":
      // Honest rather than convenient: this agent completes every call within
      // the request and never returns a Task, so there is nothing to fetch.
      return c.json(
        rpcError(
          id,
          TASK_NOT_FOUND,
          "This agent returns results directly as a Message and creates no Tasks, so no task id is ever valid here.",
        ),
      );

    case "tasks/cancel":
      return c.json(
        rpcError(
          id,
          TASK_NOT_FOUND,
          "This agent creates no Tasks, so there is nothing to cancel.",
        ),
      );

    // Not in the A2A spec. Added because the spec gives a client no way to ask
    // for a machine-readable skill list over the transport it is already
    // talking on, and an agent that has to go back to HTTP for the card is one
    // HTTP call away from not bothering.
    case "skills/list": {
      const skills = [...skillRoutes(c.env).entries()].map(([skill, target]) => ({
        skill,
        path: target.path,
        paid: target.paid,
      }));
      return c.json(rpcResult(id, { skills }));
    }

    default:
      return c.json(
        rpcError(
          id,
          METHOD_NOT_FOUND,
          `Unknown method "${method}". Supported: message/send, skills/list.`,
        ),
      );
  }
});

async function sendMessage(c: any, id: unknown, params: any) {
  const message = params?.message;
  const { skill, input, error } = readInvocation(message);

  if (error) return rpcError(id, INVALID_PARAMS, error);

  const target = skillRoutes(c.env).get(skill!);
  if (!target) {
    return rpcError(id, INVALID_PARAMS, `Unknown skill "${skill}".`, {
      available: [...skillRoutes(c.env).keys()],
    });
  }

  const origin = new URL(c.req.url).origin;
  const headers = new Headers({ "Content-Type": "application/json" });

  // Payment travels as headers, exactly as it does on the HTTP route. Forwarded
  // rather than re-derived so there is one payment path, not two.
  const credit = c.req.header("X-Credit-Token");
  if (credit) headers.set("X-Credit-Token", credit);

  // The a2a-x402 extension carries a signed payload in message metadata; a
  // client that speaks plain A2A sends the header instead. Accept both.
  const payment =
    c.req.header("X-PAYMENT") ?? message?.metadata?.["x402.payment.payload"];
  if (payment) {
    headers.set(
      "X-PAYMENT",
      typeof payment === "string" ? payment : btoa(JSON.stringify(payment)),
    );
  }

  const upstream = await c.var.dispatch(
    new Request(`${origin}${target.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    }),
  );

  const contextId = message?.contextId ?? crypto.randomUUID();
  const text = await upstream.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (upstream.status === 402) {
    /**
     * Payment required. Reported as a Message rather than an input-required
     * Task on purpose: the a2a-x402 resumption flow expects to hand a taskId
     * back and have the server still hold the original input, and this agent
     * stores nothing between calls. Claiming that flow and then failing the
     * second leg would be worse than not claiming it.
     *
     * The challenge is still returned under the extension's own metadata key,
     * so a client that understands x402 can read it, sign it, and retry in one
     * step with the payload attached.
     */
    const challenge = upstream.headers.get("payment-required");

    return rpcResult(
      id,
      agentMessage(
        [
          {
            kind: "text",
            text:
              `Skill "${skill}" is paid. Either send an X-Credit-Token header — ` +
              `POST ${origin}/credits/trial issues one free, with no account — ` +
              "or sign the x402 challenge below and retry with it in " +
              "message.metadata['x402.payment.payload'].",
          },
          { kind: "data", data: payload as Record<string, unknown> },
        ],
        {
          contextId,
          metadata: {
            "x402.payment.status": "payment-required",
            "x402.payment.required": payload,
            ...(challenge ? { "x402.payment.challenge": challenge } : {}),
            free_trial: `${origin}/credits/trial`,
          },
        },
      ),
    );
  }

  if (!upstream.ok) {
    return rpcResult(
      id,
      agentMessage(
        [
          { kind: "text", text: `Skill "${skill}" failed with HTTP ${upstream.status}.` },
          { kind: "data", data: payload as Record<string, unknown> },
        ],
        { contextId, metadata: { http_status: upstream.status, skill } },
      ),
    );
  }

  return rpcResult(
    id,
    agentMessage([{ kind: "data", data: payload as Record<string, unknown> }], {
      contextId,
      metadata: {
        skill,
        http_status: upstream.status,
        ...(upstream.headers.get("X-PAYMENT-RESPONSE")
          ? { "x402.payment.status": "payment-completed" }
          : {}),
      },
    }),
  );
}

export default app;
