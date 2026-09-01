# agentic-endpoints

x402-powered micro-SaaS utilities for autonomous AI agents. Pay-per-call with USDC micropayments on Base — no API keys, no subscriptions.

## Endpoints

| Route | Method | Price | Description |
|-------|--------|-------|-------------|
| `/once-key` | POST | $0.001 | Atomic idempotency witness — claim a key exactly once |
| `/scrape` | POST | $0.005 | Pay-per-query web scraping and text extraction |
| `/pdf-parse` | POST | $0.01 | PDF text extraction from URL |
| `/compress` | POST | $0.005 | Token compression / context reduction for LLMs |
| `/` | GET | Free | Service discovery (lists all endpoints) |
| `/health` | GET | Free | Health check |

## How It Works

1. Agent makes a request to a paid endpoint
2. Server responds with `HTTP 402 Payment Required` + payment details
3. Agent signs a USDC payment on Base and retries with `X-PAYMENT` header
4. Server validates payment and returns the result

## Stack

- **Runtime**: Cloudflare Workers + Durable Objects
- **Payments**: x402 protocol (USDC on Base)
- **State**: Durable Object SQLite (for OnceKey)
- **Framework**: Hono

## Setup

### Prerequisites

- Node.js 20+
- Cloudflare account (Workers Paid plan — $5/mo)
- A wallet address on Base to receive USDC payments
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### Install

```bash
npm install
```

### Configure Secrets

```bash
# Your receiving wallet address (Base USDC)
wrangler secret put X402_PAY_TO

# x402 facilitator URL
wrangler secret put FACILITATOR_URL

# HMAC secret for receipt signing
wrangler secret put RECEIPT_SECRET
```

For local development, copy `.dev.vars` and fill in your values.

### Develop

```bash
npm run dev
```

### Deploy

```bash
npm run deploy
```

## API Examples

### OnceKey (Idempotency Witness)

```json
POST /once-key
{
  "namespace": "payment-webhooks",
  "action_key": "stripe_evt_abc123",
  "payload_sha256": "e3b0c44298fc...",
  "ttl": 86400
}

// Response
{
  "status": "claimed",
  "namespace": "payment-webhooks",
  "action_key": "stripe_evt_abc123",
  "claimed_at": "2026-08-31T18:00:00.000Z",
  "expires_at": "2026-09-01T18:00:00.000Z",
  "receipt": "a1b2c3..."
}
```

### Web Scraper

```json
POST /scrape
{
  "url": "https://example.com/article",
  "format": "text"
}
```

### PDF Parser

```json
POST /pdf-parse
{
  "url": "https://example.com/document.pdf"
}
```

### Token Compressor

```json
POST /compress
{
  "text": "Your very long text here...",
  "target_tokens": 500,
  "strategy": "extractive"
}
```

## Money Flow

```
Agent pays USDC on Base
  → Lands in your wallet (X402_PAY_TO)
  → Sphere Pay batch-sweeps USDC → converts to USD
  → ACH deposit into your bank account
```

## License

ISC
