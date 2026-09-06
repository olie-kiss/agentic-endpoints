import { Hono } from "hono";
import type { Env } from "../types";

/**
 * Remote MCP server (Streamable HTTP) exposing the paid endpoints as tools.
 *
 * Distribution, not a second product: the same handlers, the same wallet, the
 * same Durable Objects. This just makes them reachable from MCP clients and
 * publishable to the MCP Registry, which verifies ownership through the
 * domain rather than through any financial account.
 *
 * Protocol revision 2026-07-28 removed the `initialize` handshake, protocol
 * sessions and the GET stream endpoint, so every request is self-contained.
 * That maps exactly onto a Worker, which has no connection state to keep.
 * The older initialize-based revisions are still answered, because real
 * clients in the wild lag the spec.
 *
 * Discovery (`tools/list`) is free. Every tool that performs work is paid,
 * and a call without payment returns the x402 challenge as a structured
 * result so an agent knows the exact price, asset and address. Handing out
 * free `scrape` or `pdf_parse` calls would reopen the bandwidth-amplification
 * hole that pricing the vault routes just closed.
 */

const LATEST_PROTOCOL = "2026-07-28";
const SUPPORTED_PROTOCOLS = [LATEST_PROTOCOL, "2025-11-25", "2025-06-18", "2025-03-26"];

/** Clients that omit the version header predate it; the spec allows this. */
const ASSUMED_LEGACY_PROTOCOL = "2025-03-26";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/**
 * Claimed by both `initialize` and `server/discover`. Kept in one place so the
 * two cannot drift into describing the server differently.
 */
const SERVER_INFO = {
  name: "agentic-endpoints",
  title: "Agentic Endpoints",
  version: "1.0.0",
  // `description` and `websiteUrl` are not in the MCP Implementation schema,
  // but registries scrape them and an empty description makes a discovery
  // listing close to useless — Smithery published us with a blank one because
  // it does not map `instructions`. Additive and ignored by spec-strict clients.
  description:
    "Pay-per-call HTTP and MCP utilities for autonomous AI agents, settled in USDC on Base via the x402 protocol. No signup, no API keys, no subscription — an agent pays per request. Includes exactly-once idempotency claims, an encrypted vault, web scraping, PDF text extraction, and token compression.",
  websiteUrl: "https://ai.oliverkiss.com",
} as const;

const SERVER_CAPABILITIES = { tools: { listChanged: false } } as const;

const SERVER_INSTRUCTIONS =
  "Pay-per-call utilities for autonomous agents, settled in USDC on Base via x402. tools/list is free. Every tool that does work is paid; calling one without payment returns the price and payment address.";

/**
 * Annotation profiles. Named rather than inlined so that two routes with the
 * same semantics cannot accidentally describe themselves differently.
 *
 * `idempotentHint` is the load-bearing one here: it tells an agent whether a
 * retry after an ambiguous failure is free or charges again.
 */

/** Pure reads. Safe to repeat, touch nothing outside this service. */
const READS = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

/** Pure reads that fetch arbitrary third-party URLs. */
const READS_WEB = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

/** Writes that converge on the same state when repeated. Retry is safe. */
const WRITES_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Writes where each call creates another record. A retry duplicates data. */
const WRITES_APPENDS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/** Overwrites or removes existing data, but repeating lands in the same state. */
const WRITES_DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Destroys prior state and yields a different result every call. */
const WRITES_ROTATES = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** Backing HTTP route. Every one of these is payment-gated. */
  path: string;
  price: string;
  inputSchema: Record<string, unknown>;
  /**
   * Behavioural hints. These are advisory per spec, but for a paid API they
   * are the difference between an agent safely retrying a failed call and
   * paying twice for it, so they are derived from each route's real
   * semantics rather than defaulted.
   */
  annotations: Record<string, boolean>;
}

const str = (description: string) => ({ type: "string", description });

const NAMESPACE_TOKEN = str(
  "One-time token issued by the first call that claimed this namespace. Required for every later call.",
);

const TOOLS: ToolDef[] = [
  {
    name: "meetings_search",
    title: "Search your meeting transcripts",
    description:
      "Ask a question across every meeting you have imported as queryable, and get back ranked excerpts with the meeting they came from. This is the tool to use when the user refers to something that was said, agreed, or decided in a call -- 'what did we decide about pricing', 'who owned the migration', 'when did we say we would ship'. Returns 'searched_meetings' and 'private_meetings_skipped': meetings imported as private are encrypted and CANNOT be searched, so if searched_meetings is 0 an empty result means nothing was searched, NOT that the topic was never discussed. Use meetings_get to read a full transcript once you have found the right meeting.",
    path: "/meetings/search",
    price: "$0.006",
    annotations: READS,
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope holding your meetings"),
        namespace_token: NAMESPACE_TOKEN,
        query: str(
          'FTS5 match expression. Use quotes for phrases, e.g. "budget review". Prefer a few distinctive words over a whole sentence.',
        ),
        limit: { type: "integer", description: "Max results, 1-50 (default 10)" },
      },
      required: ["namespace", "namespace_token", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "meetings_import",
    title: "Import a meeting transcript",
    description:
      "Store a transcript so it can be searched later. `visibility` is a required decision and cannot be guessed for you: 'queryable' stores plaintext, indexes it, and means this service can read it; 'private' stores ciphertext you encrypted yourself, which is unreadable here and therefore NEVER searchable. Send `transcript` for queryable and `ciphertext` for private -- the mismatched combinations are refused rather than silently doing the wrong thing. The first import into a namespace returns a namespace_token shown exactly once; save it or the namespace is unrecoverable.",
    path: "/meetings/import",
    price: "$0.004",
    annotations: WRITES_APPENDS,
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope, e.g. my-meetings-<uuid>"),
        namespace_token: NAMESPACE_TOKEN,
        title: str("Human-readable meeting title"),
        occurred_at: str("ISO-8601 time the meeting happened"),
        source: str("Free-form label for where the transcript came from, e.g. webvtt, srt, plain-text"),
        visibility: str(
          "'queryable' (plaintext, searchable, readable by this service) or 'private' (ciphertext, never searchable). Defaults to private.",
        ),
        transcript: str("Plaintext transcript. Only valid with visibility 'queryable'."),
        ciphertext: str("Client-side encrypted transcript. Only valid with visibility 'private'."),
        participants: { type: "array", items: { type: "string" }, description: "Optional attendees" },
      },
      required: ["namespace"],
      additionalProperties: false,
    },
  },
  {
    name: "meetings_get",
    title: "Read one meeting in full",
    description:
      "Fetch a single meeting by meeting_id, including its full transcript when it was imported as queryable. Use this after meetings_search has identified the meeting you want. A 'content_missing' status means the record exists but its stored text could not be found -- that is a broken record, not an empty meeting, so do not report it as one.",
    path: "/meetings/get",
    price: "$0.002",
    annotations: READS,
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope holding your meetings"),
        namespace_token: NAMESPACE_TOKEN,
        meeting_id: str("Returned by meetings_import or meetings_search"),
      },
      required: ["namespace", "namespace_token", "meeting_id"],
      additionalProperties: false,
    },
  },
  {
    name: "meetings_list",
    title: "List your meetings",
    description:
      "List the meetings in a namespace newest first, with titles, dates, participants and whether each one is searchable. Never returns transcripts. Useful for orienting before a search, and for finding meetings that are private and therefore invisible to meetings_search.",
    path: "/meetings/list",
    price: "$0.001",
    annotations: READS,
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope holding your meetings"),
        namespace_token: NAMESPACE_TOKEN,
        limit: { type: "integer", description: "Max results, 1-500 (default 100)" },
      },
      required: ["namespace", "namespace_token"],
      additionalProperties: false,
    },
  },
  {
    name: "once_key_claim",
    title: "Claim an action exactly once",
    description:
      "Atomic idempotency witness. Claims a {namespace, action_key} pair exactly once, so a fleet of agents cannot perform the same side effect twice. Call this BEFORE any non-idempotent action such as sending an email, charging a card, or posting an order. Returns one of: 'claimed' — you won, do the work, then call once_key_complete; 'in_progress' — another agent holds a live lease, wait retry_after seconds and do NOT do the work; 'duplicate' — already done, and the 'result' field carries the original outcome, so use it instead of repeating the work; 'held' — another agent claimed this key, set no lease, and has NOT completed it: there is no result and there may never be one, so do NOT do the work and do NOT treat it as done, because the key stays locked until expires_at; 'conflict' — the same key was claimed with a different payload hash, so your key derivation is wrong. Backed by a strongly consistent Durable Object; this is not something an agent can safely reimplement locally.",
    path: "/once-key",
    price: "$0.001",
    annotations: WRITES_IDEMPOTENT,
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope, e.g. your application name"),
        action_key: str("Stable identifier for the action being claimed"),
        payload_sha256: str(
          "Optional hash of the action payload. If it differs from the stored hash, the result is a conflict.",
        ),
        namespace_token: NAMESPACE_TOKEN,
        ttl: { type: "integer", description: "Claim lifetime in seconds (default 86400)" },
        lease_ttl: {
          type: "integer",
          description:
            "Seconds you have to call once_key_complete before the claim is treated as abandoned and another agent may take it over. Set this if your work could crash partway. Omit it to hold the claim for the full ttl, which guarantees nothing else can ever run the side effect.",
        },
      },
      required: ["namespace", "action_key"],
      additionalProperties: false,
    },
  },
  {
    name: "once_key_complete",
    title: "Record the outcome of a claimed action",
    description:
      "Free. Records the result of work you performed under a claim from once_key_claim. Every later claim of that action_key returns 'duplicate' along with this result, which is what lets another agent continue without repeating the side effect. Always call this after the work succeeds — a claim with no recorded result leaves every other agent unable to learn what happened. Completion is final and cannot be overwritten.",
    path: "/once-key/complete",
    price: "free",
    annotations: WRITES_IDEMPOTENT,
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope used when the key was claimed"),
        action_key: str("The action_key you claimed"),
        namespace_token: NAMESPACE_TOKEN,
        result: {
          description:
            "Any JSON value describing the outcome, up to 16 KB serialized. Store large payloads elsewhere and record a reference.",
        },
        ttl: {
          type: "integer",
          description: "How long to retain the result, in seconds (default 86400)",
        },
      },
      required: ["namespace", "action_key"],
      additionalProperties: false,
    },
  },
  {
    name: "once_key_release",
    title: "Release a claim whose work failed",
    description:
      "Free. Surrenders a claimed action_key so a retry can start immediately instead of waiting out the lease. Call this when the work you claimed fails. Refuses if the key was already completed, because releasing it would discard the recorded result and allow the side effect to run twice.",
    path: "/once-key/release",
    price: "free",
    annotations: WRITES_IDEMPOTENT,
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope used when the key was claimed"),
        action_key: str("The action_key to release"),
        namespace_token: NAMESPACE_TOKEN,
      },
      required: ["namespace", "action_key"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_store",
    title: "Store an encrypted secret",
    description:
      "Store client-side encrypted data. This service holds no key that could decrypt it and never sees plaintext; note that the item key, namespace, alg label and size ARE stored in the clear. The first store claims the namespace and returns a namespace_token shown only once — store it immediately, because it is required by every later call and cannot be recovered. Pass if_match with an item's updated_at for a compare-and-swap write, or if_absent to create only; either returns status 'precondition_failed' rather than silently clobbering a concurrent write.",
    path: "/vault/store",
    price: "$0.02",
    annotations: WRITES_DESTRUCTIVE,
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope"),
        key: str("Item key"),
        ciphertext: str("Encrypt before sending. Plaintext here would be a mistake."),
        alg: str("Algorithm label recorded alongside the item (default aes-256-gcm)"),
        ttl: { type: "integer", description: "Item lifetime in seconds" },
        namespace_token: NAMESPACE_TOKEN,
        if_match: str(
          "Only write if the item's current updated_at equals this. Use it whenever you are updating a value you read earlier, or a concurrent writer's change is lost silently.",
        ),
        if_absent: {
          type: "boolean",
          description:
            "Only write if the key does not already exist. Fails with status 'precondition_failed' if it does.",
        },
      },
      required: ["namespace", "key", "ciphertext"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_retrieve",
    title: "Retrieve an encrypted secret",
    description: "Retrieve a previously stored ciphertext. Requires the namespace_token.",
    path: "/vault/retrieve",
    price: "$0.02",
    annotations: READS,
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope"),
        key: str("Item key"),
        namespace_token: NAMESPACE_TOKEN,
      },
      required: ["namespace", "key", "namespace_token"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_exists",
    title: "Test whether a key exists",
    description:
      "Check for a key without returning its ciphertext. Requires the namespace_token.",
    path: "/vault/exists",
    price: "$0.001",
    annotations: READS,
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope"),
        key: str("Item key"),
        namespace_token: NAMESPACE_TOKEN,
      },
      required: ["namespace", "key", "namespace_token"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_delete",
    title: "Delete a stored secret",
    description: "Permanently delete an item. Requires the namespace_token.",
    path: "/vault/delete",
    price: "$0.005",
    annotations: WRITES_DESTRUCTIVE,
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope"),
        key: str("Item key"),
        namespace_token: NAMESPACE_TOKEN,
      },
      required: ["namespace", "key", "namespace_token"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_list",
    title: "List the keys in a vault namespace",
    description:
      "List the keys held in a namespace with their metadata: alg, size, timestamps. Never returns ciphertext — use vault_retrieve for that. Each item's updated_at is the version to pass back as if_match on a conditional store. Use this when you have stored secrets and need to know what is there.",
    path: "/vault/list",
    price: "$0.001",
    annotations: READS,
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope"),
        namespace_token: NAMESPACE_TOKEN,
      },
      required: ["namespace", "namespace_token"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_rotate_token",
    title: "Rotate a vault namespace token",
    description:
      "Free. Mints a new namespace_token and immediately invalidates the current one, which you must present to authorize the rotation. Do this whenever the token may have been exposed — a leaked token is otherwise permanent, unrevocable read and delete access to every secret in the namespace. There is no recovery if you lose the token.",
    path: "/vault/rotate-token",
    price: "free",
    annotations: WRITES_ROTATES,
    inputSchema: {
      type: "object",
      properties: {
        namespace: str("Isolation scope"),
        namespace_token: NAMESPACE_TOKEN,
      },
      required: ["namespace", "namespace_token"],
      additionalProperties: false,
    },
  },
  {
    name: "pdf_parse",
    title: "Extract text from a PDF",
    description:
      "Extract text from a PDF by URL. Handles compressed streams, PDF 1.5+ object streams and ToUnicode CMaps, and reports encrypted or image-only documents honestly instead of returning garbage.",
    path: "/pdf-parse",
    price: "$0.01",
    annotations: READS_WEB,
    inputSchema: {
      type: "object",
      properties: {
        url: str("HTTPS URL of the PDF"),
        max_pages: { type: "integer", description: "Optional page cap" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "scrape",
    title: "Fetch a page as text or markdown",
    description:
      "Fetch a URL and return readable text or markdown, optionally narrowed by CSS selector. Requests to private, loopback and link-local addresses are refused, and every redirect hop is re-validated.",
    path: "/scrape",
    price: "$0.005",
    annotations: READS_WEB,
    inputSchema: {
      type: "object",
      properties: {
        url: str("HTTPS URL to fetch"),
        format: {
          type: "string",
          enum: ["text", "markdown", "html"],
          description: "Output format (default text)",
        },
        selector: str("Optional CSS selector to extract just part of the page"),
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "compress",
    title: "Compress text to a token budget",
    description:
      "Reduce text to fit a token budget, preserving whole sentences and reporting before/after token estimates.",
    path: "/compress",
    price: "$0.005",
    annotations: READS,
    inputSchema: {
      type: "object",
      properties: {
        text: str("Text to compress"),
        target_tokens: { type: "integer", description: "Approximate token budget" },
        strategy: {
          type: "string",
          enum: ["extractive", "truncate"],
          description: "Compression strategy (default extractive)",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

/**
 * Dispatches a request back through the full request pipeline in-process, so
 * tool calls pass the same payment gate, body cap and validation as a direct
 * HTTP caller. Injected by the router to avoid an import cycle.
 */
export type Dispatcher = (request: Request) => Promise<Response>;

const app = new Hono<{ Bindings: Env; Variables: { dispatch: Dispatcher } }>();

/** JSON-RPC error, returned with an HTTP status the spec pins to the case. */
function rpcError(
  id: unknown,
  code: number,
  message: string,
  status: number,
  data?: unknown,
) {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } },
    { status },
  );
}

function rpcResult(id: unknown, result: Record<string, unknown>) {
  return Response.json({ jsonrpc: "2.0", id, result });
}

/**
 * The GET stream endpoint was removed in 2026-07-28, but clients still probe
 * it. Answering 405 rather than 404 tells them the endpoint exists and only
 * the method is wrong.
 */
app.get("/", (c) =>
  c.json(
    {
      error: "Method not allowed",
      detail: `This MCP endpoint accepts POST only. Protocol ${LATEST_PROTOCOL} removed the GET stream endpoint.`,
    },
    405,
    { Allow: "POST" },
  ),
);

app.post("/", async (c) => {
  /**
   * Origin sanity check. Note what this does NOT do: it accepts any `https:`
   * origin, so it is not a DNS-rebinding or CSRF defence, and the comment
   * that once claimed otherwise was wrong. `app.use("*", cors())` also serves
   * a wildcard `Access-Control-Allow-Origin`, so any page can reach this
   * endpoint by design — MCP clients are not all same-origin.
   *
   * That is currently safe for exactly one reason: there is no ambient
   * credential. Every secret here (X-PAYMENT, namespace tokens, credit
   * tokens) is an explicit header the attacking page would already have to
   * possess, and none is a cookie the browser attaches automatically.
   *
   * If a cookie, a session, or any IP-derived trust is ever introduced, this
   * becomes a real CSRF surface and must be tightened to a same-origin or
   * explicit allowlist check first.
   */
  const origin = c.req.header("Origin");
  if (origin) {
    let ok = false;
    try {
      const o = new URL(origin);
      ok = o.origin === new URL(c.req.url).origin || o.protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) {
      return rpcError(null, -32600, "Invalid Origin", 403);
    }
  }

  let body: {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
  try {
    body = await c.req.json();
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }

  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body.id, -32600, "Invalid Request", 400);
  }

  const { id, method, params = {} } = body;
  const isNotification = id === undefined;

  // The header is the routable mirror of the body field; the body is
  // authoritative. A mismatch means an intermediary rewrote one of them.
  const headerVersion = c.req.header("MCP-Protocol-Version");
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const bodyVersion = typeof meta[META_VERSION] === "string" ? (meta[META_VERSION] as string) : undefined;

  if (headerVersion && bodyVersion && headerVersion !== bodyVersion) {
    return rpcError(id, -32600, "HeaderMismatch", 400, {
      header: headerVersion,
      body: bodyVersion,
    });
  }

  const version = headerVersion ?? bodyVersion ?? ASSUMED_LEGACY_PROTOCOL;
  if (!SUPPORTED_PROTOCOLS.includes(version)) {
    return rpcError(id, -32600, "UnsupportedProtocolVersionError", 400, {
      supported: SUPPORTED_PROTOCOLS,
      requested: version,
    });
  }

  // Notifications get no response body at all.
  if (isNotification) {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    /**
     * Mandatory on the current spec ("Servers MUST implement it"). Lets a
     * client fetch supported versions, capabilities and identity in one call
     * instead of probing, and is the documented stdio fallback probe. We
     * previously answered -32601, which a spec-current client reads as a
     * broken server.
     */
    case "server/discover":
      return rpcResult(id, {
        resultType: "complete",
        supportedVersions: SUPPORTED_PROTOCOLS,
        capabilities: SERVER_CAPABILITIES,
        instructions: SERVER_INSTRUCTIONS,
        _meta: { [META_SERVER_INFO]: SERVER_INFO },
      });

    /**
     * Retained for clients on initialize-based revisions. Servers on the
     * current spec have no handshake, but answering keeps older clients
     * working instead of failing at connect time.
     */
    case "initialize":
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(version) ? version : LATEST_PROTOCOL,
        capabilities: SERVER_CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });

    case "ping":
      return rpcResult(id, {});

    /**
     * We advertise no `resources` or `prompts` capability, so a spec-strict
     * client never calls these and -32601 was a correct answer. Registry
     * scanners probe them regardless and log the error as a warning against
     * the listing, so answer with an empty list instead. Costs nothing and
     * keeps the scan clean.
     */
    case "resources/list":
      return rpcResult(id, { resources: [] });

    case "prompts/list":
      return rpcResult(id, { prompts: [] });

    case "tools/list":
      return rpcResult(id, {
        resultType: "complete",
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          // "Costs free in USDC on Base" would read as a price to a model,
          // and a tool an agent believes it must pay for is a tool it skips.
          description:
            t.price === "free"
              ? `${t.description} This tool is free; no payment is required.`
              : `${t.description} Costs ${t.price} in USDC on Base, paid via the x402 protocol.`,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
        // The catalogue is identical for every caller and changes only on
        // deploy, so it is safe for clients to cache and share.
        ttlMs: 300_000,
        cacheScope: "public",
      });

    case "tools/call": {
      const name = params.name as string | undefined;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return rpcError(id, -32602, `Unknown tool: ${name}`, 400);
      }

      const args = (params.arguments ?? {}) as Record<string, unknown>;

      /**
       * Re-enter the pipeline so the call passes the payment middleware and
       * the body cap exactly as a direct HTTP caller would. Reimplementing
       * the gate here would be a second code path to keep in sync, and the
       * first one to drift.
       */
      const target = new URL(c.req.url);
      target.pathname = tool.path;
      target.search = "";

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const payment = c.req.header("X-PAYMENT");
      if (payment) headers["X-PAYMENT"] = payment;

      const upstream = await c.var.dispatch(
        new Request(target.toString(), {
          method: "POST",
          headers,
          body: JSON.stringify(args),
        }),
      );

      const text = await upstream.text();

      if (upstream.status === 402) {
        const challenge = decodeChallenge(upstream.headers.get("payment-required"));
        const accept = challenge?.accepts?.[0];

        return rpcResult(id, {
          resultType: "complete",
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "payment_required",
                  message: `${tool.name} costs ${tool.price}. Pay with the x402 protocol and retry, or call ${target} directly with an X-PAYMENT header.`,
                  price: tool.price,
                  resource: target.toString(),
                  x402: accept
                    ? {
                        scheme: accept.scheme,
                        network: accept.network,
                        asset: accept.asset,
                        payTo: accept.payTo,
                        amount: accept.amount,
                      }
                    : undefined,
                  docs: new URL("/", c.req.url).toString(),
                },
                null,
                2,
              ),
            },
          ],
        });
      }

      return rpcResult(id, {
        resultType: "complete",
        isError: !upstream.ok,
        content: [{ type: "text", text }],
      });
    }

    default:
      // The spec pins unknown methods to 404 so they are distinguishable
      // from a host that does not serve MCP at all.
      return rpcError(id, -32601, `Method not found: ${method}`, 404);
  }
});

interface Challenge {
  accepts?: Array<{
    scheme?: string;
    network?: string;
    asset?: string;
    payTo?: string;
    amount?: string;
  }>;
}

function decodeChallenge(header: string | null): Challenge | null {
  if (!header) return null;
  try {
    return JSON.parse(atob(header)) as Challenge;
  } catch {
    return null;
  }
}

export default app;
export { TOOLS };
