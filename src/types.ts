export interface Env {
  // Durable Objects
  ONCE_KEY: DurableObjectNamespace;
  VAULT: DurableObjectNamespace;
  CREDITS: DurableObjectNamespace;
  STATS: DurableObjectNamespace;

  // Revenue watermark + rolling payment history
  MONITOR: KVNamespace;

  // Rate limiters (per Cloudflare location)
  FREE_RATE_LIMITER: RateLimit;
  WRITE_RATE_LIMITER: RateLimit;
  PAID_RATE_LIMITER: RateLimit;

  // Secrets (set via `wrangler secret put`)
  X402_PAY_TO: string;
  RECEIPT_SECRET: string;

  // Optional: override facilitator URL (defaults to https://facilitator.payai.network)
  FACILITATOR_URL?: string;

  /**
   * Chain to price and settle on. Only "eip155:84532" (Base Sepolia) is
   * honoured; anything else, including unset, means Base mainnet. Exists so
   * settlement can be proven end to end without spending real USDC.
   */
  X402_NETWORK?: string;
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
  /** How long the claimant has to complete before the key is reclaimable. */
  lease_ttl?: number; // seconds, default 300 (5m)
}

export interface ClaimResult {
  status:
    | "claimed"
    | "duplicate"
    | "conflict"
    | "in_progress"
    | "completed"
    | "already_completed"
    | "released";
  namespace: string;
  action_key: string;
  claimed_at: string;
  expires_at: string;
  /** Present once the action has been completed; replayed to later claims. */
  result?: unknown;
  /** Present while a claim is live. */
  lease_expires_at?: string;
  /** True when a lapsed lease was taken over from a previous claimant. */
  recovered?: boolean;
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
