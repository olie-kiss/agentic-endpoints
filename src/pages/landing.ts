import { describeRoutes, FREE_POST_ENDPOINTS } from "../lib/discovery";
import type { RoutesConfig } from "@x402/core/server";

/** Free endpoints that carry no request body, so they are not in either
 * generated list but are the first thing a human or crawler tries. */
const FREE_GET_ENDPOINTS = [
  ["/status", "Uptime, error rate and latency, measured from real traffic"],
  ["/stats", "Demand funnel: requests challenged, paid and served free"],
  ["/revenue", "USDC received, read directly from Base — not from our logs"],
  ["/health", "Health check"],
  ["/openapi.json", "OpenAPI 3.1 description of every route"],
  ["/llms.txt", "Plain-language description for a model given only this URL"],
];

const escapeHtml = (raw: string): string =>
  raw.replace(/[&<>"]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;",
  );

/**
 * One row of the endpoint table.
 *
 * Descriptions come from the same route config that sets the price, so the
 * page cannot advertise a route that no longer exists or a price we do not
 * actually charge. Everything interpolated here is authored in this repo,
 * but it is escaped anyway: the day a description carries a user-supplied
 * string is not the day anyone will remember this template.
 */
function endpointRow(
  method: string,
  path: string,
  desc: string,
  price: string,
): string {
  const free = price === "Free";
  return `      <div class="endpoint">
        <div class="endpoint-left">
          <div><span class="endpoint-method">${escapeHtml(method)}</span><span class="endpoint-path">${escapeHtml(path)}</span></div>
          <div class="endpoint-desc">${escapeHtml(desc)}</div>
        </div>
        <span class="endpoint-price ${free ? "free" : "paid"}">${escapeHtml(price)}</span>
      </div>`;
}

export function landingPage(routes: RoutesConfig): string {
  const paidRows = describeRoutes(routes)
    .map((r) => endpointRow(r.method, r.path, r.description, r.price))
    .join("\n\n");

  const freeRows = [
    ...FREE_POST_ENDPOINTS.map((f) =>
      endpointRow("POST", f.path, f.summary, "Free"),
    ),
    ...FREE_GET_ENDPOINTS.map(([path, desc]) =>
      endpointRow("GET", path, desc, "Free"),
    ),
  ].join("\n\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agentic Endpoints — ai.oliverkiss.com</title>
  <meta name="description" content="Pay-per-call micro-utilities for autonomous AI agents. x402 protocol, USDC on Base." />
  <style>
    :root {
      --bg: #0a0a0b;
      --surface: #141416;
      --border: #23232a;
      --text: #e4e4e7;
      --muted: #71717a;
      --accent: #6d5cff;
      --accent-dim: rgba(109, 92, 255, 0.12);
      --green: #22c55e;
      --green-dim: rgba(34, 197, 94, 0.12);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
    }
    .container { max-width: 720px; margin: 0 auto; padding: 3rem 1.5rem; }

    /* Header */
    .header { margin-bottom: 3rem; }
    .header h1 {
      font-size: 1.5rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-bottom: 0.5rem;
    }
    .header h1 span { color: var(--accent); }
    .header p { color: var(--muted); font-size: 0.875rem; }

    /* Protocol badge */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      background: var(--accent-dim);
      color: var(--accent);
      border: 1px solid rgba(109, 92, 255, 0.2);
      border-radius: 999px;
      padding: 0.25rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 500;
      margin-bottom: 1.5rem;
    }
    .badge .dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--accent);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* How it works */
    .how-it-works {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.25rem 1.5rem;
      margin-bottom: 2rem;
      font-size: 0.8125rem;
    }
    .how-it-works h2 {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 0.75rem;
    }
    .how-it-works .steps {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .how-it-works .step {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.375rem 0.625rem;
      white-space: nowrap;
    }
    .how-it-works .arrow { color: var(--muted); }

    /* Endpoints */
    .endpoints { margin-bottom: 2rem; }
    .endpoints h2 {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 0.75rem;
    }
    .section-note {
      font-size: 0.8rem;
      line-height: 1.6;
      color: var(--muted);
      margin: -0.25rem 0 0.85rem;
      max-width: 60ch;
    }
    .endpoint {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem 1.25rem;
      margin-bottom: 0.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      transition: border-color 0.15s;
    }
    .endpoint:hover { border-color: var(--accent); }
    .endpoint-left { flex: 1; min-width: 0; }
    .endpoint-method {
      font-size: 0.6875rem;
      font-weight: 600;
      color: var(--green);
      background: var(--green-dim);
      padding: 0.125rem 0.375rem;
      border-radius: 3px;
      margin-right: 0.5rem;
    }
    .endpoint-path { font-weight: 500; font-size: 0.875rem; }
    .endpoint-desc {
      color: var(--muted);
      font-size: 0.75rem;
      margin-top: 0.25rem;
    }
    .endpoint-price {
      font-size: 0.8125rem;
      font-weight: 600;
      white-space: nowrap;
      padding: 0.25rem 0.625rem;
      border-radius: 6px;
    }
    .endpoint-price.paid {
      color: var(--accent);
      background: var(--accent-dim);
    }
    .endpoint-price.free {
      color: var(--green);
      background: var(--green-dim);
    }

    /* Code block */
    .code-section { margin-bottom: 2rem; }
    .code-section h2 {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 0.75rem;
    }
    .code-block {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem 1.25rem;
      font-size: 0.8125rem;
      overflow-x: auto;
      white-space: pre;
      line-height: 1.7;
    }
    .code-block .kw { color: #c084fc; }
    .code-block .str { color: #86efac; }
    .code-block .cmt { color: #52525b; }
    .code-block .fn { color: #60a5fa; }

    /* Footer */
    .footer {
      border-top: 1px solid var(--border);
      padding-top: 1.5rem;
      color: var(--muted);
      font-size: 0.75rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .footer a { color: var(--accent); text-decoration: none; }
    .footer a:hover { text-decoration: underline; }

    @media (max-width: 600px) {
      .container { padding: 2rem 1rem; }
      .endpoint { flex-direction: column; align-items: flex-start; }
      .how-it-works .steps { flex-direction: column; align-items: flex-start; }
      .how-it-works .arrow { display: none; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="badge"><span class="dot"></span> x402 Protocol — Base Mainnet</div>
      <h1>agentic<span>.</span>endpoints</h1>
      <p>Pay-per-call micro-utilities for autonomous AI agents.<br/>No API keys. No subscriptions. Just USDC micropayments.</p>
    </div>

    <div class="how-it-works">
      <h2>How It Works</h2>
      <div class="steps">
        <span class="step">Agent calls endpoint</span>
        <span class="arrow">→</span>
        <span class="step">402 Payment Required</span>
        <span class="arrow">→</span>
        <span class="step">Agent pays USDC on Base</span>
        <span class="arrow">→</span>
        <span class="step">Response + signed receipt</span>
      </div>
    </div>

    <div class="endpoints">
      <h2>Paid Endpoints</h2>
${paidRows}
    </div>

    <div class="endpoints">
      <h2>Free Endpoints</h2>
      <p class="section-note">Lifecycle calls are free because the paid claim already covers them, and telemetry is free because a service asking to be trusted should not charge you to check whether it works.</p>
${freeRows}

${endpointRow("POST", "/mcp", "Remote MCP server (Streamable HTTP). Listing tools is free; calling one costs that tool's price", "Free")}
    </div>

    <div class="code-section">
      <h2>Use as an MCP server</h2>
      <div class="code-block"><span class="cmt">// Add to any MCP client (Claude Desktop, Copilot CLI, Cursor)</span>
{
  <span class="str">"mcpServers"</span>: {
    <span class="str">"agentic-endpoints"</span>: {
      <span class="str">"type"</span>: <span class="str">"http"</span>,
      <span class="str">"url"</span>: <span class="str">"https://ai.oliverkiss.com/mcp"</span>
    }
  }
}</div>
    </div>

    <div class="code-section">
      <h2>Quick Start</h2>
      <div class="code-block"><span class="cmt">// npm install agentic-endpoints</span>
<span class="kw">import</span> { AgenticEndpoints } <span class="kw">from</span> <span class="str">"agentic-endpoints"</span>;

<span class="cmt">// Run a side effect exactly once, even if your agent is running twice.</span>
<span class="cmt">// Claims the key, records the result, releases it if the work throws.</span>
<span class="kw">const</span> { outcome, result } = <span class="kw">await</span> client.<span class="fn">exactlyOnce</span>(
  { namespace: <span class="str">"billing"</span>, actionKey: <span class="str">\`charge:\${order.id}\`</span>, leaseTtl: <span class="str">300</span> },
  <span class="kw">async</span> () =&gt; stripe.charges.<span class="fn">create</span>({ amount: order.total }),
);

<span class="cmt">// outcome: "performed" — you did the work</span>
<span class="cmt">// outcome: "replayed"  — someone else already did it; result is theirs</span>
<span class="cmt">// throws HeldError    — claimed but never completed; no result exists</span></div>
    </div>

    <div class="code-section">
      <h2>Or over plain HTTP</h2>
      <div class="code-block"><span class="cmt">// 1. Claim it. Costs $0.001. Any x402-enabled wallet can pay.</span>
<span class="kw">const</span> claim = <span class="kw">await</span> <span class="fn">fetch</span>(<span class="str">"https://ai.oliverkiss.com/once-key"</span>, {
  method: <span class="str">"POST"</span>,
  headers: { <span class="str">"Content-Type"</span>: <span class="str">"application/json"</span> },
  body: <span class="fn">JSON.stringify</span>({
    namespace: <span class="str">"billing"</span>,
    action_key: <span class="str">"charge:order-12345"</span>,
    lease_ttl: <span class="str">300</span>
  })
}).<span class="fn">then</span>(r =&gt; r.<span class="fn">json</span>());

<span class="cmt">// "claimed"     → you won the race, do the work</span>
<span class="cmt">// "duplicate"   → already done; claim.result holds the outcome</span>
<span class="cmt">// "held"        → claimed but never finished. No result. Do not do the work</span>
<span class="cmt">// "in_progress" → someone else holds a live lease, wait and retry</span>
<span class="cmt">// "conflict"    → same key, different payload. Never retry this.</span>

<span class="cmt">// 2. Record what happened. Free — the claim paid for this.</span>
<span class="kw">await</span> <span class="fn">fetch</span>(<span class="str">"https://ai.oliverkiss.com/once-key/complete"</span>, {
  method: <span class="str">"POST"</span>,
  headers: { <span class="str">"Content-Type"</span>: <span class="str">"application/json"</span> },
  body: <span class="fn">JSON.stringify</span>({
    namespace: <span class="str">"billing"</span>,
    action_key: <span class="str">"charge:order-12345"</span>,
    namespace_token: claim.namespace_token,
    result: { charge_id: <span class="str">"ch_abc123"</span> }
  })
});</div>
    </div>

    <div class="footer">
      <span>&copy; 2026 Oliver Kiss</span>
      <span>
        <a href="https://github.com/olie-kiss/agentic-endpoints">GitHub</a>
        &nbsp;·&nbsp;
        Settlement: USDC on Base
      </span>
    </div>
  </div>
</body>
</html>`;
}
