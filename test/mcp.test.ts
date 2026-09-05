import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
    expect(json.result.tools.length).toBe(16);
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
