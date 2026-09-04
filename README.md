# agentic-endpoints

x402-powered micro-SaaS utilities for autonomous AI agents. Pay-per-call with USDC micropayments on Base — no API keys, no accounts, no subscriptions.

Live at **https://ai.oliverkiss.com**

## Endpoints

| Route | Method | Price | Description |
|-------|--------|-------|-------------|
| `/once-key` | POST | $0.001 | Atomic idempotency witness — claim a key exactly once |
| `/scrape` | POST | $0.005 | Web scraping and text extraction |
| `/pdf-parse` | POST | $0.01 | PDF text extraction from a URL |
| `/compress` | POST | $0.005 | Token compression / context reduction for LLMs |
| `/vault/store` | POST | $0.02 | Store a client-encrypted item |
| `/vault/retrieve` | POST | $0.02 | Retrieve a client-encrypted item |
| `/vault/delete` | POST | $0.005 | Delete an item |
| `/vault/exists` | POST | $0.001 | Check whether an item exists |
| `/mcp` | POST | Free to list | Remote MCP server; each tool costs its route's price |
| `/` | GET | Free | Service discovery (JSON) or landing page (HTML) |
| `/health` | GET | Free | Health check |

`GET /` content-negotiates: send `Accept: application/json` for the machine-readable
endpoint catalogue, anything else gets the HTML landing page.

## How It Works

1. An agent requests a paid endpoint
2. The server replies `HTTP 402 Payment Required` with the price, network and receiving address
3. The agent signs a USDC transfer on Base and retries with an `X-PAYMENT` header
4. The facilitator verifies and settles the payment, then the handler runs

Try it — this returns a real 402 challenge, not an error:

```bash
curl -i -X POST https://ai.oliverkiss.com/once-key \
  -H 'Content-Type: application/json' \
  -d '{"namespace":"demo","action_key":"abc123"}'
```

## MCP Server

Every paid endpoint is also exposed as an MCP tool over Streamable HTTP at
`https://ai.oliverkiss.com/mcp`, implementing revision `2026-07-28` (stateless:
no `initialize` handshake, no session header) with a fallback for clients still
sending the `2025-06-18` handshake.

```json
{
  "mcpServers": {
    "agentic-endpoints": { "type": "http", "url": "https://ai.oliverkiss.com/mcp" }
  }
}
```

`tools/list` is free so clients can discover the catalogue. `tools/call`
re-enters the corresponding paid route in-process, so it passes the same x402
gate, body cap and validation as a direct HTTP call. Without a valid
`X-PAYMENT` header the tool returns `isError: true` and a machine-readable
payment demand (price, `payTo`, asset, network) rather than performing work.

## Stack

- **Runtime**: Cloudflare Workers + Durable Objects
- **Payments**: x402 protocol (USDC on Base mainnet, `exact` scheme)
- **State**: Durable Object SQLite (OnceKey and Vault)
- **Framework**: Hono

## Setup

### Prerequisites

- Node.js 20+
- Cloudflare account (Workers Paid plan — $5/mo, required for Durable Objects)
- A wallet address on Base to receive USDC
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (use `npx wrangler` if not installed globally)

### Install

```bash
npm install
```

### Configure Secrets

```bash
# Required — your receiving wallet address (Base USDC)
npx wrangler secret put X402_PAY_TO

# Required — HMAC key for signing JSON receipts
npx wrangler secret put RECEIPT_SECRET
```

> **Do not set `FACILITATOR_URL` unless you mean to override the default.**
> It must be a valid URL. If it is set to anything else, every paid endpoint
> returns 500 instead of a 402, and the failure is only visible in
> `npx wrangler tail` — this silently broke all payments once already.

The default facilitator is `https://facilitator.xpay.sh`: free, no signup, and it
supports Base mainnet.

### Develop and deploy

```bash
npm run dev
npm run deploy

# Tests run against the real Workers runtime via workers-pool.
# The Durable Object tests call the objects directly, since every paid
# route answers 402 without a real on-chain payment.
npm test
npm run typecheck

# Re-announce every route to the PayAI Bazaar. Signs a payment attempt with a
# throwaway, never-funded key: verification fails on balance, nothing is spent.
node scripts/trigger-indexing.mjs

# Make one real paid call. Requires a THROWAWAY wallet holding a little USDC
# on Base; the key is read from the environment and never written anywhere.
export X402_TEST_PRIVATE_KEY=0x...
node scripts/paid-test.mjs /compress
```

## API Examples

### OnceKey (idempotency witness)

```json
POST /once-key
{
  "namespace": "payment-webhooks",
  "action_key": "stripe_evt_abc123",
  "payload_sha256": "e3b0c44298fc...",
  "ttl": 86400
}
```

Returns `status: "claimed"` the first time, `"duplicate"` afterwards, and
`"conflict"` if the same key is replayed with a different payload hash.

### Web scraper

```json
POST /scrape
{ "url": "https://example.com/article", "format": "text" }
```

### PDF parser

```json
POST /pdf-parse
{ "url": "https://example.com/document.pdf", "pages": [1, 2] }
```

Inflates FlateDecode content streams, expands PDF 1.5+ object streams, and maps
character codes through each font's `/ToUnicode` CMap, so subset and composite
fonts come back as real text rather than glyph indices. Encrypted PDFs and
image-only scans return `422` rather than filler content, so callers are not
billed for a result that is known to be useless.

### Token compressor

```json
POST /compress
{ "text": "Your very long text here...", "target_tokens": 500, "strategy": "extractive" }
```

### Vault

Storage is free; retrieval is paid. The server only ever sees ciphertext —
**encrypt client-side before calling.**

Namespaces are caller-chosen strings, so they are claimed on first write. That
first `store` returns a `namespace_token` **once**; every later operation on the
namespace must present it.

```json
POST /vault/store
{ "namespace": "my-app", "key": "secret-1", "ciphertext": "base64...", "ttl": 86400 }

// First write only — save this, it is not shown again
{ "status": "stored", "namespace_token": "30ab4b26..." }
```

```json
POST /vault/retrieve
{ "namespace": "my-app", "key": "secret-1", "namespace_token": "30ab4b26..." }
```

Lose the token and the namespace is unrecoverable by design — there is no
account to reset it against.

## Limits

| Limit | Value |
|-------|-------|
| Free requests (no `X-PAYMENT`) | 60/min per IP, per Cloudflare location |
| Vault writes | 20/min per IP |
| Request body | 2 MiB |
| Vault item | 256 KiB ciphertext |
| Vault namespace | 1,000 items / 25 MiB |

Paid requests are not rate limited — each one already costs the caller USDC.

## Security Notes

- **URL-taking endpoints are SSRF-guarded** (`src/lib/url-guard.ts`): scheme
  allowlist, private/reserved IPv4 and IPv6 ranges blocked, hostnames resolved
  over DNS-over-HTTPS to defeat rebinding, every redirect hop re-validated, and
  response bodies bounded. It fails closed.
- **Vault and OnceKey namespaces are ownership-gated.** The first request to a
  namespace is issued a one-time `namespace_token`; tokens are stored only as
  SHA-256 hashes and compared in constant time.
- **Receipts are HMAC-signed** with `RECEIPT_SECRET`. Note that only `/once-key`
  and the vault endpoints return a `receipt` — the stateless utilities
  (`/pdf-parse`, `/scrape`, `/compress`) do not.
- **The wallet is the trust anchor.** Nothing in this codebase protects the seed
  phrase behind `X402_PAY_TO`. If it leaks, the money is gone.

## Money Flow

```
Agent pays USDC on Base
  → lands directly in your wallet (X402_PAY_TO)
  → transfer to an exchange that supports Base USDC
  → withdraw to your bank
```

Canadian-friendly off-ramps: Kraken, Newton, Shakepay, Coinbase. US-only
services such as Mercury and Sphere Pay are not an option.

## Known Gaps

- **Bazaar auto-indexing is not active.** Discovery metadata is declared on every
  paid route, but the public xpay facilitator reports no extensions. Indexing
  needs a Bazaar-capable facilitator (Coinbase CDP), which requires a CDP API key.
- The `extractive` compression strategy is heuristic and unvalidated against real
  agent workloads.

## License

ISC
