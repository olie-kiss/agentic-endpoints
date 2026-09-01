export interface Env {
  // Durable Objects
  ONCE_KEY: DurableObjectNamespace;

  // Secrets (set via `wrangler secret put`)
  X402_PAY_TO: string;
  FACILITATOR_URL: string;
  RECEIPT_SECRET: string;

  // Config
  ENVIRONMENT: string;
}

export interface ClaimRequest {
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
  text: string;
  strategy: string;
}
