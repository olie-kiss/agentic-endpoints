# agentic-endpoints

x402-powered micro-SaaS utilities for autonomous AI agents. Pay-per-call with USDC micropayments on Base — no API keys, no accounts, no subscriptions.

Live at **https://ai.oliverkiss.com**

## Endpoints

| Route | Method | Price | Description |
|-------|--------|-------|-------------|
| `/once-key` | POST | $0.001 | Claim an action exactly once, and replay its recorded result |
| `/once-key/complete` | POST | Free | Record the outcome of a claimed action |
| `/once-key/release` | POST | Free | Surrender a claim whose work failed |
| `/scrape` | POST | $0.005 | Web scraping and text extraction |
| `/pdf-parse` | POST | $0.01 | PDF text extraction from a URL |
| `/compress` | POST | $0.005 | Token compression / context reduction for LLMs |
| `/vault/store` | POST | $0.02 | Store a client-encrypted item |
| `/vault/retrieve` | POST | $0.02 | Retrieve a client-encrypted item |
| `/vault/delete` | POST | $0.005 | Delete an item |
| `/vault/exists` | POST | $0.001 | Check whether an item exists |
| `/vault/list` | POST | $0.001 | List the keys in a namespace (metadata only) |
| `/vault/rotate-token` | POST | Free | Replace a namespace token that may have leaked |
| `/credits/buy` | POST | $5.00 | Buy $6.00 of prepaid credit (20% bonus) |
| `/credits/buy-25` | POST | $25.00 | Buy $32.50 of prepaid credit (30% bonus) |
| `/credits/balance` | POST | Free | Check a credit balance |
| `/revenue` | GET | Free | On-chain USDC received, read from Base |
| `/mcp` | POST | Free to list | Remote MCP server; each tool costs its route's price |
| `/` | GET | Free | Service discovery (JSON) or landing page (HTML) |
| `/health` | GET | Free | Health check |
| `/status` | GET | Free | Uptime, error rate and latency, derived from recorded behaviour |
| `/stats` | GET | Free | Demand funnel: challenged, paid, free, by route |
| `/llms.txt` | GET | Free | Prose description for a model given only a URL |
| `/openapi.json` | GET | Free | OpenAPI 3.1 description |

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

## Two Ways To Pay

Per-call x402 caps revenue at whatever a buyer will tolerate signing: $1,000 at
$0.005 a call is 200,000 signatures. Prepaid credits sell the same work once,
in an amount worth the transaction, and let callers whose wallets cannot sign
per request use the service at all.

Both paths run side by side and neither is privileged:

```bash
# Per call, unchanged
curl -X POST https://ai.oliverkiss.com/compress -H "X-PAYMENT: ..." -d '{"text":"..."}'

# Or prepay once, then no signatures
curl -X POST https://ai.oliverkiss.com/credits/buy -H "X-PAYMENT: ..."   # -> credit_token
curl -X POST https://ai.oliverkiss.com/compress \
  -H "X-Credit-Token: ae_..." -d '{"text":"..."}'
```

Omitting `X-Credit-Token` produces exactly the 402 challenge it always did, so
the Bazaar listing and every existing integration are unaffected.

Credits are integer micro-dollars, never floats: $0.001 has no exact binary
representation, and a ledger that drifts is worse than no ledger. Each account
is its own Durable Object addressed by the hash of its token, so the balance
check and its debit are atomic and one account cannot queue behind another.
Calls are debited before the work and refunded if it 5xxs, because an outage
must not bill a customer for nothing.

**The token is shown once and is not recoverable** — only its hash is stored.

## Discovery

An endpoint nobody can find earns nothing, so the service is registered wherever
agents actually look. Every catalog below was chosen because it verifies
ownership by domain or wallet rather than by a financial account — the Coinbase
CDP Bazaar is skipped for exactly that reason.

| Catalog | Status | How |
|---|---|---|
| PayAI Bazaar | Not listed on mainnet — **mechanism proven on testnet** | Listing requires a payment that *settles*, once per route; reaching `/verify` does nothing. Confirmed on Base Sepolia: all 9 routes appeared in `/discovery/resources` within seconds of paying. `X402_TEST_PRIVATE_KEY=0x... node scripts/trigger-indexing.mjs` costs **$0.068** for the whole catalogue |
| x402-list.com | Submitted, pending review | `POST /api/v1/submit`; free because the service is on a custom domain |
| Official MCP Registry | **Published — `com.oliverkiss/agentic-endpoints`, status active** | `./scripts/publish-registry.sh`. Ownership proven by an apex TXT record and an ed25519-signed timestamp, so no financial account is involved |
| npm | **Published — [`agentic-endpoints`](https://www.npmjs.com/package/agentic-endpoints)** | `cd sdk && npm publish`. Counts as discovery, not just convenience: npm is crawled by every AI coding assistant, so the client is findable by the same models that would use the service |
| Smithery | **Published — [`kiss-olie/agentic-endpoints`](https://smithery.ai/servers/kiss-olie/agentic-endpoints)** | `smithery auth login` then `smithery mcp publish https://ai.oliverkiss.com/mcp -n kiss-olie/agentic-endpoints`. The scan found all 12 tools. Note the namespace is `kiss-olie`, not the GitHub handle. Publishing leaves `description` empty and the CLI has no flag for it, which makes the listing unsearchable — set it with `PATCH https://api.smithery.ai/servers/kiss-olie%2Fagentic-endpoints` |

Aggregators such as PulseMCP ingest from the official registry, so publishing
there covers several directories at once. The repository is public, so
directories that crawl source repos can now see it too.

Machine-readable descriptions are generated from the same pricing table that
gates payment, so they cannot drift from what is actually charged: `/llms.txt`
for a model handed a bare URL, `/openapi.json` for tooling, plus `/robots.txt`
and `/sitemap.xml`. Tests assert the prices agree across all of them.

## Revenue Monitoring

The service could demand payment for months with no way to tell whether a
payment ever arrived — including the failure mode where payments verify but
never settle. A cron trigger sweeps Base every 5 minutes for USDC `Transfer`
logs into the receiving address and folds them into a running ledger in KV.

Revenue is read from the chain, not from our own logs or the facilitator's
word, so it cannot be inflated by a bug on either side. `GET /revenue` publishes
the ledger for free — it costs nothing and gives a prospective caller evidence
the service actually transacts.

Set `ALERT_WEBHOOK_URL` to a Discord webhook to be notified when money lands:

```bash
npx wrangler secret put ALERT_WEBHOOK_URL
```

The first scan starts the watermark at the current chain head rather than
genesis; scanning millions of blocks through a public RPC node would fail
repeatedly and never establish a watermark at all. The watermark advances only
on a successful scan, so a transient RPC failure is retried on the next tick
with nothing missed.

## Published SLOs

An agent choosing between two paid services has no way to tell which one works.
`GET /status` is free and answers that from recorded behaviour, not a promise:

```json
{
  "uptime_24h": "100.00%",
  "uptime_window": "0.5h",
  "cron_ticks_24h": 6,
  "requests_48h": 88,
  "error_rate_48h": "0.00%",
  "unknown_path_requests_48h": 10,
  "latency_ms": { "p50_at_most": 25, "p95_at_most": 500, "p99_at_most": 500 }
}
```

Getting the number *honest* mattered more than getting it published. It first
shipped reporting an 11.39% error rate; every one of those was a 404 on a path
that never existed — my own probes and passing crawlers — plus tokens that were
correctly rejected. An agent reading that would have taken its money elsewhere
and been right to. So client errors (4xx) are counted separately from failures
(5xx), and requests to unknown paths are excluded from the rate entirely and
surfaced as a raw count instead. Otherwise any stranger could degrade our
published reliability just by scanning for `/wp-admin`.

Latency comes from histogram buckets, so the figures are reported as
`p95_at_most` — a bound, which is what a bucket can honestly support, rather
than a precise percentile it cannot. Uptime credits only the window actually
observed, so day one does not claim 24 hours from an hour of heartbeats. The
heartbeat is written *before* the revenue scan, so an outage at a public RPC
node is not reported as ours.

`GET /stats` publishes the demand funnel — challenged, paid, free, per route —
which is the only thing that distinguishes "nobody has found us" from "agents
arrive and decline to pay".

## Client SDK

[`sdk/`](./sdk) is a dependency-free TypeScript client. It deliberately does
**not** sign payments — it takes a credit token, or your own x402-aware
`fetch`, so it never needs a private key.

```bash
npm install agentic-endpoints
```

Its reason to exist is `exactlyOnce`, which collapses the claim/complete/release
protocol into one call: it handles all four claim outcomes, records the result
so later callers can replay it, releases the claim if your work throws, and
rethrows your error untouched.

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

### Proving settlement without spending

Settlement is the one step that cannot be tested by inspection, and on
mainnet every attempt costs real USDC. `[env.testnet]` deploys the same code
to a workers.dev URL priced in Base Sepolia USDC, which
[faucet.circle.com](https://faucet.circle.com) gives away with no account.

```bash
npx wrangler deploy --env testnet
X402_TEST_PRIVATE_KEY=0x... node scripts/paid-test.mjs /once-key \
  https://agentic-endpoints-testnet.<subdomain>.workers.dev --testnet
```

Only the exact string `eip155:84532` selects Sepolia; anything unrecognised
falls back to mainnet. That asymmetry is deliberate — a Worker that wrongly
demanded testnet tokens would hand out real work for money anyone can mint.

### Announcing to the Bazaar

```bash
X402_TEST_PRIVATE_KEY=0x... node scripts/trigger-indexing.mjs
```

Pays for each route once, which is what puts it in the catalogue. $0.068 for
all 9 utility routes; credit packs are excluded unless you pass
`--include-credits`.

## API Examples

### OnceKey (exactly-once execution)

A claim on its own is only half an idempotency key. The agent that *loses*
the race needs to know what happened, or it has to either block forever or
repeat the side effect anyway — which is the failure this endpoint exists to
prevent. So the lifecycle is three calls, and only the first one costs money.

```json
POST /once-key
{
  "namespace": "payment-webhooks",
  "action_key": "stripe_evt_abc123",
  "payload_sha256": "e3b0c44298fc...",
  "ttl": 86400,
  "lease_ttl": 300
}
```

| `status` | Meaning |
|---|---|
| `claimed` | You won. Do the work, then call `/once-key/complete` |
| `duplicate` | Already done. `result` holds the original outcome — use it |
| `in_progress` | Another caller holds a live lease. Wait `retry_after`; do **not** do the work |
| `conflict` | Same key, different payload hash. Your key derivation is wrong; never retry |

```json
POST /once-key/complete          // free
{ "namespace": "...", "action_key": "...", "namespace_token": "...",
  "result": { "charge_id": "ch_abc" } }
```

Every later claim of that key returns `duplicate` **with that result**.

If the work fails, `POST /once-key/release` (free) frees the key immediately.

**`lease_ttl` is opt-in, deliberately.** Without it a claim is held for its
full `ttl` and nothing can ever run your side effect twice. With it, a
claimant that crashes is presumed dead once the lease lapses and the next
caller takes over with `recovered: true`. Leases on by default would have
made every key claimed by the original claim-only API silently reclaimable —
a duplicated charge is a far worse failure than a key that needs a retry
under a fresh name.

The [`agentic-endpoints` npm package](./sdk) wraps all of this in one call:

```ts
const { outcome, result } = await client.exactlyOnce(
  { namespace: "billing", actionKey: `charge:${order.id}`, leaseTtl: 300 },
  async () => stripe.charges.create({ amount: order.total }),
);
```

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
{ "namespace": "my-app-4f9c2b1e8d7a", "key": "secret-1", "ciphertext": "base64...", "ttl": 86400 }

// First write only — save this, it is not shown again
{ "status": "stored", "namespace_token": "30ab4b26..." }
```

```json
POST /vault/retrieve
{ "namespace": "my-app-4f9c2b1e8d7a", "key": "secret-1", "namespace_token": "30ab4b26..." }
```

Writes are last-write-wins unless you say otherwise, so two agents rotating
the same secret would clobber each other silently. Pass `if_match` with the
item's current `updated_at` for a compare-and-swap, or `if_absent` to create
only; either answers `status: "precondition_failed"` instead of overwriting.

`POST /vault/list` ($0.001) returns the keys and their versions but never any
ciphertext — that is what the $0.02 retrieve is for.

**Rotate a token you think has leaked**, with `POST /vault/rotate-token`. It
is free: putting a price on the correct response to a suspected leak is how
you get callers who never rotate. It requires the *current* token, and there
is no recovery if that is lost — any path that could restore access without
it would be a second way in, and would serve an attacker just as readily as
the owner. Lose it and the namespace is gone by design; there is no account
to reset it against.

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
- **New namespaces must be unguessable** (16+ characters, mixed character
  classes). Ownership is first-writer-wins over a global, account-less string
  and there is deliberately no recovery path, so a short name like `invoices`
  or `billing` could be claimed by anyone for $0.001 and would lock out the
  rightful owner permanently. Making real namespaces unguessable means there
  is nothing worth squatting. Use `myapp-<uuid>`. Names claimed before this
  rule keep working.
- **The free lifecycle endpoints do not reveal whether a namespace exists.**
  `/once-key/complete` and `/once-key/release` return an identical 404 whether
  the namespace was never claimed or your token is wrong, because a free
  existence oracle is the reconnaissance step before squatting. `/once-key`
  itself still answers 403, where each probe costs a payment.
- **`namespace_token` is a bearer credential with no recovery path.** Anyone
  holding it *is* the owner. Worse than a normal leak: `/vault/rotate-token`
  is free and needs only the current token, so whoever steals it can rotate
  first and lock you out irreversibly. OnceKey has no rotation at all, so a
  leaked OnceKey token is permanent. There are no accounts, no email, and no
  support channel that can restore access — treat these tokens like a private
  key, and store them before you make the call that returns one.
- **The vault cannot read your values, but it does see their names.** No key
  held here can decrypt anything, and plaintext is never received. But the
  item key, the namespace, the `alg` label and the size are all stored in the
  clear, so the service can tell *which* named secrets you hold and how large
  they are. `alg` is an advisory label: nothing here can verify that what you
  sent was in fact encrypted. Use high-entropy namespace names — ownership is
  first-writer-wins, so a guessable namespace can be squatted (now enforced;
  see above).
- **Paid routes answer completed work with 200 and a `status` field**, never a
  4xx. The x402 middleware cancels settlement above 399, so a 4xx returned
  after the work is done gives the answer away free and leaves the payment
  header replayable.
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

- **No payment has settled on mainnet.** Revenue is $0.00. Settlement itself is
  no longer unproven: on 2026-09-04 the full pipeline ran on Base Sepolia and
  0.001 USDC moved on chain, confirmed by reading the transfer log rather than
  trusting the facilitator. What is untested on mainnet is only that the same
  code paths work against a chain where the money is real.
- **Not in the PayAI Bazaar on mainnet**, though the mechanism is now proven
  rather than assumed. Listing needs a *settled* payment per route — reaching
  `/verify` does nothing, which is why the catalogue held 0 of 28,095 of our
  routes. On testnet all 9 appeared within seconds. Announcing the mainnet
  catalogue costs $0.068, not the ~$1 assumed for months.
- **No evidence of demand.** `/stats` records the funnel precisely so that
  "nobody has found us" and "agents arrive and refuse to pay" stop looking
  identical. So far the answer is the first one.
- **`/scrape`, `/pdf-parse` and `/compress` compete with free libraries.** The
  defensible endpoints are `/once-key` and `/vault`: coordination primitives a
  single agent cannot self-host, because they answer questions about what
  *other* agents have done.
- OnceKey namespace tokens cannot be rotated (vault's now can).
- The `extractive` compression strategy is heuristic and unvalidated against real
  agent workloads.

## License

ISC
