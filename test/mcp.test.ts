import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OUTPUT_SCHEMAS, toStructuredContent } from "../src/handlers/mcp";

const PROTOCOL = "2026-07-28";

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  opts: { id?: unknown; protocol?: string; headers?: Record<string, string> } = {},
) {
  const protocol = opts.protocol ?? PROTOCOL;
  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": protocol,
        "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  if (opts.id !== null) body.id = opts.id ?? 1;

  const res = await SELF.fetch("https://ai.oliverkiss.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": protocol,
      "Mcp-Method": method,
      ...opts.headers,
    },
    body: JSON.stringify(body),
  });

  return { status: res.status, json: await res.json().catch(() => null) };
}

describe("MCP transport", () => {
  it("rejects GET, which the current revision removed", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/mcp");
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("returns 404 with -32601 for an unknown method", async () => {
    const { status, json } = await rpc("does/not/exist");
    expect(status).toBe(404);
    expect(json.error.code).toBe(-32601);
  });

  it("rejects a header/body protocol mismatch", async () => {
    const { status, json } = await rpc("tools/list", {}, {
      headers: { "MCP-Protocol-Version": "2025-06-18" },
    });
    expect(status).toBe(400);
    expect(json.error.message).toBe("HeaderMismatch");
  });

  it("rejects an unsupported protocol version and lists what it supports", async () => {
    const { status, json } = await rpc("tools/list", {}, { protocol: "1999-01-01" });
    expect(status).toBe(400);
    expect(json.error.message).toBe("UnsupportedProtocolVersionError");
    expect(json.error.data.supported).toContain(PROTOCOL);
  });

  it("accepts a notification with 202 and no body", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": PROTOCOL,
        "Mcp-Method": "notifications/progress",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("rejects a non-https cross origin", async () => {
    const { status } = await rpc("tools/list", {}, {
      headers: { Origin: "http://evil.local" },
    });
    expect(status).toBe(403);
  });

  it("still answers the legacy initialize handshake", async () => {
    const { status, json } = await rpc("initialize", {}, { protocol: "2025-06-18" });
    expect(status).toBe(200);
    expect(json.result.serverInfo.name).toBe("agentic-endpoints");
  });

  /**
   * `server/discover` is mandatory on the current spec, and is what registry
   * scanners and spec-current clients call before anything else. Answering
   * -32601 reads as a broken server, so this is a contract, not a nicety.
   */
  it("implements the mandatory server/discover RPC, for free", async () => {
    const { status, json } = await rpc("server/discover");
    expect(status).toBe(200);
    expect(json.error).toBeUndefined();
    expect(json.result.supportedVersions).toContain("2026-07-28");
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.instructions).toBeTruthy();
    expect(json.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("agentic-endpoints");
  });

  it("describes itself identically in discover and initialize", async () => {
    const discover = await rpc("server/discover");
    const init = await rpc("initialize", {}, { protocol: "2025-06-18" });
    expect(discover.json.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual(
      init.json.result.serverInfo,
    );
    expect(discover.json.result.instructions).toBe(init.json.result.instructions);
  });

  it("rejects malformed JSON", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": PROTOCOL },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("MCP tools", () => {
  it("lists tools for free, with cache hints", async () => {
    const { status, json } = await rpc("tools/list");
    expect(status).toBe(200);
    expect(json.result.resultType).toBe("complete");
    expect(json.result.cacheScope).toBe("public");
    expect(json.result.tools.length).toBe(20);
  });

  /**
   * Annotations are advisory in the spec, but on a paid API `idempotentHint`
   * decides whether an agent retries an ambiguous failure or pays twice.
   * These assertions pin the cases where being wrong costs the caller money.
   */
  it("annotates every tool with retry-safety hints", async () => {
    const { json } = await rpc("tools/list");
    const byName = Object.fromEntries(json.result.tools.map((t: any) => [t.name, t.annotations]));

    for (const tool of json.result.tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(typeof tool.annotations.idempotentHint, tool.name).toBe("boolean");
    }

    // Repeating a claim returning the same answer is the entire point of the
    // once-key product; if this ever flips, the guarantee is broken.
    expect(byName.once_key_claim.idempotentHint).toBe(true);
    expect(byName.once_key_claim.readOnlyHint).toBe(false);

    // Each import creates another meeting, so a retry duplicates data.
    expect(byName.meetings_import.idempotentHint).toBe(false);

    // Rotation issues a new token every call and invalidates the old one.
    expect(byName.vault_rotate_token.idempotentHint).toBe(false);
    expect(byName.vault_rotate_token.destructiveHint).toBe(true);

    expect(byName.vault_delete.destructiveHint).toBe(true);
    expect(byName.meetings_search.readOnlyHint).toBe(true);

    // Only the tools that fetch third-party URLs touch the open world.
    expect(byName.scrape.openWorldHint).toBe(true);
    expect(byName.pdf_parse.openWorldHint).toBe(true);
    expect(byName.compress.openWorldHint).toBe(false);
  });

  /**
   * Declaring outputSchema obliges us to return structuredContent on success.
   * Shipping the schema without the payload would be worse than shipping
   * neither, because a validating client would have nothing to check.
   */
  it("declares an output schema for every tool, and no orphans", async () => {
    const { json } = await rpc("tools/list");
    const names = json.result.tools.map((t: any) => t.name).sort();

    for (const tool of json.result.tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.outputSchema.type, tool.name).toBe("object");
      expect(Array.isArray(tool.outputSchema.required), tool.name).toBe(true);
      expect(tool.outputSchema.required.length, tool.name).toBeGreaterThan(0);

      // Every required field must actually be described, or the schema
      // promises something it never explains.
      for (const key of tool.outputSchema.required) {
        expect(tool.outputSchema.properties[key], `${tool.name}.${key}`).toBeDefined();
      }
    }

    expect(Object.keys(OUTPUT_SCHEMAS).sort()).toEqual(names);
  });

  it("returns structuredContent on success, and never on an error", async () => {
    // The rule is unit-tested directly: there is no free tool that succeeds
    // without paid setup, so exercising it over HTTP would cost money.
    expect(toStructuredContent('{"status":"completed"}', true)).toEqual({ status: "completed" });

    // Errors are exempt from the structured-content requirement, and an error
    // body must not be presented as if it satisfied the output schema.
    expect(toStructuredContent('{"error":"nope"}', false)).toBeUndefined();

    // Bodies that are not JSON objects must not be coerced into a shape.
    expect(toStructuredContent("plain text", true)).toBeUndefined();
    expect(toStructuredContent("[1,2,3]", true)).toBeUndefined();
    expect(toStructuredContent("null", true)).toBeUndefined();
  });

  it("does not attach structuredContent to an unpaid 402", async () => {
    const { json } = await rpc("tools/call", {
      name: "scrape",
      arguments: { url: "https://example.com" },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.structuredContent).toBeUndefined();
  });

  it("states a price on every tool, including the free ones", async () => {
    const { json } = await rpc("tools/list");
    for (const tool of json.result.tools) {
      // Silence is the dangerous case: a tool whose cost is unstated is one
      // an agent must either avoid or pay for blind.
      expect(tool.description, tool.name).toMatch(
        /Costs \$\d|This tool is free; no payment is required\./,
      );
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("uses spec-legal tool names", async () => {
    const { json } = await rpc("tools/list");
    for (const tool of json.result.tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
    }
  });

  it("rejects an unknown tool", async () => {
    const { status, json } = await rpc("tools/call", { name: "nope", arguments: {} });
    expect(status).toBe(400);
    expect(json.error.code).toBe(-32602);
  });

  it("does not perform work without payment", async () => {
    const { status, json } = await rpc("tools/call", {
      name: "compress",
      arguments: { text: "hello world" },
    });

    // The JSON-RPC call itself succeeds; the payment demand is the result.
    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);

    const payload = JSON.parse(json.result.content[0].text);
    expect(payload.error).toBe("payment_required");
    expect(payload.price).toBe("$0.005");
  });
});

/**
 * The MCP endpoint carries more traffic than every other route combined, so a
 * buyer who cannot reach the free tier from here cannot reach it at all. These
 * tests exist because for two days it was unreachable: no tool issued credit,
 * no tool accepted it, and the payment refusal recommended x402 to clients
 * that have no wallet.
 */
describe("MCP free tier", () => {
  it("offers a tool that issues credit, so a client can start without a wallet", async () => {
    const { json } = await rpc("tools/list");
    const trial = json.result.tools.find((t: any) => t.name === "credits_trial");

    expect(trial).toBeDefined();
    expect(trial.description).toMatch(/free/i);
    // Requiring arguments would defeat the point: there is nothing a caller
    // could know to supply before it has anything.
    expect(trial.inputSchema.required ?? []).toEqual([]);
  });

  it("lets every paid tool be paid for by argument, not only by header", async () => {
    const { json } = await rpc("tools/list");
    const paid = json.result.tools.filter((t: any) => /Costs \$/.test(t.description));

    expect(paid.length).toBeGreaterThan(0);
    for (const tool of paid) {
      // An MCP client controls arguments, not headers. Without this the
      // token it was just issued is unusable.
      expect(tool.inputSchema.properties.credit_token, tool.name).toBeDefined();
      // It is one of three ways to pay, so demanding it would break x402.
      expect(tool.inputSchema.required ?? [], tool.name).not.toContain("credit_token");
    }
  });

  it("does not invite a free tool to spend credit it never needed", async () => {
    const { json } = await rpc("tools/list");
    const free = json.result.tools.filter((t: any) => /This tool is free/.test(t.description));

    expect(free.length).toBeGreaterThan(0);
    for (const tool of free) {
      if (tool.name === "credits_balance") continue; // takes a token to read it
      expect(tool.inputSchema.properties?.credit_token, tool.name).toBeUndefined();
    }
  });

  it("points a refused call at the free route out, not only at x402", async () => {
    const { json } = await rpc("tools/call", {
      name: "compress",
      arguments: { text: "hello world" },
    });

    const payload = JSON.parse(json.result.content[0].text);
    expect(payload.error).toBe("payment_required");
    // A client with no wallet must be told what it can actually do.
    expect(payload.free_trial.tool).toBe("credits_trial");
    expect(payload.message).toMatch(/credits_trial/);
  });

  it("issues a different trial token to a different caller", async () => {
    // Regression: the sub-request was built with fresh headers and so reached
    // the handler with no client address. Every caller derived the same token
    // from "unknown" and shared one $0.10 ledger, so the first to ask drained
    // it and the rest got an exhausted token.
    const a = await rpc("tools/call", { name: "credits_trial", arguments: {} },
      { headers: { "CF-Connecting-IP": "203.0.113.7" } });
    const b = await rpc("tools/call", { name: "credits_trial", arguments: {} },
      { headers: { "CF-Connecting-IP": "198.51.100.42" } });

    const tokenA = JSON.parse(a.json.result.content[0].text).credit_token;
    const tokenB = JSON.parse(b.json.result.content[0].text).credit_token;

    expect(tokenA).toMatch(/^ae_trial_/);
    expect(tokenB).toMatch(/^ae_trial_/);
    expect(tokenA).not.toBe(tokenB);
  });

  it("spends the trial token supplied as an argument", async () => {
    const issued = await rpc("tools/call", { name: "credits_trial", arguments: {} },
      { headers: { "CF-Connecting-IP": "203.0.113.99" } });
    const token = JSON.parse(issued.json.result.content[0].text).credit_token;

    const { json } = await rpc("tools/call", {
      name: "compress",
      arguments: {
        // Under the default 1000-token budget this text is returned unchanged.
        text: "The quick brown fox jumps over the lazy dog. ".repeat(20),
        target_tokens: 10,
        credit_token: token,
      },
    }, { headers: { "CF-Connecting-IP": "203.0.113.99" } });

    expect(json.result.isError).toBe(false);
    expect(json.result.structuredContent.text).toBeTruthy();

    // The credential must not survive into the work the handler received.
    expect(JSON.stringify(json.result.structuredContent)).not.toContain(token);
  });
});
