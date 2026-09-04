export interface Env {
  // Durable Objects
  ONCE_KEY: DurableObjectNamespace;
  VAULT: DurableObjectNamespace;
  CREDITS: DurableObjectNamespace;

  // Revenue watermark + rolling payment history
  MONITOR: KVNamespace;

  // Rate limiters (per Cloudflare location)
  FREE_RATE_LIMITER: RateLimit;
  WRITE_RATE_LIMITER: RateLimit;

  // Secrets (set via `wrangler secret put`)
  X402_PAY_TO: string;
  RECEIPT_SECRET: string;

  // Optional: override facilitator URL (defaults to https://facilitator.payai.network)
  FACILITATOR_URL?: string;
  // Optional: only needed if you switch to the CDP Facilitator for Bazaar indexing
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;

  // Optional: Discord-compatible webhook, notified when USDC arrives on-chain
  ALERT_WEBHOOK_URL?: string;
  // Optional: override the Base RPC used for revenue monitoring
  BASE_RPC_URL?: string;

  // Config
  ENVIRONMENT: string;
}

export interface ClaimRequest {
  /** One-time owner token, issued on the first request to a namespace. */
  namespace_token?: string;
  namespace: string;
  action_key: string;
  payload_sha256?: string;
  ttl?: number; // seconds, default 86400 (24h)
}

export interface ClaimResult {
  status: "claimed" | "duplicate" | "conflict";
  namespace: string;
  action_key: string;
  claimed_at: string;
  expires_at: string;
  receipt: string;
}

export interface ScrapeRequest {
  url: string;
  selector?: string; // CSS selector to extract
  format?: "text" | "markdown" | "html";
}

export interface ScrapeResult {
  url: string;
  title: string;
  content: string;
  format: string;
  extracted_at: string;
}

export interface PdfParseRequest {
  url: string;
  pages?: number[]; // specific pages, or all
}

export interface PdfParseResult {
  url: string;
  page_count: number;
  pages: { page: number; text: string }[];
  extracted_at: string;
}

export interface CompressRequest {
  text: string;
  target_tokens?: number; // target token count
  strategy?: "extractive" | "truncate";
}

export interface CompressResult {
  original_length: number;
  compressed_length: number;
  ratio: number;
  original_tokens_est: number;
  compressed_tokens_est: number;
  target_tokens: number | null;
  text: string;
  strategy: string;
}

export interface VaultStoreRequest {
  namespace: string;
  key: string;
  ciphertext: string;
  alg?: string;
  ttl?: number; // seconds
  /** Required once the namespace has been claimed by a first write. */
  namespace_token?: string;
}

export interface VaultRetrieveRequest {
  namespace: string;
  key: string;
  namespace_token: string;
}

export interface VaultStoreResult {
  status: "stored";
  namespace: string;
  key: string;
  alg: string;
  created_at: string;
  expires_at: string | null;
  receipt: string;
  /** Returned only on the first write, which claims the namespace. */
  namespace_token?: string;
  notice?: string;
}

export interface VaultRetrieveResult {
  status: "retrieved";
  namespace: string;
  key: string;
  ciphertext: string;
  alg: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  receipt: string;
}
