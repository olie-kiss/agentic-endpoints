import type { Env } from "../types";

/**
 * Sign a receipt payload with HMAC-SHA256.
 * Returns a hex-encoded signature that callers can verify.
 */
export async function signReceipt(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  // Fail closed. TextEncoder stringifies undefined to the literal bytes
  // "undefined", so a missing secret would silently sign every receipt with
  // a publicly known key — and the receipts would still look well-formed.
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error(
      "RECEIPT_SECRET is missing or too short (need >= 32 characters)",
    );
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // Canonical JSON: JSON.stringify preserves insertion order, so two
  // logically identical payloads can hash differently. A verifier that
  // rebuilds the payload from named fields would then see a bogus mismatch.
  const data = encoder.encode(canonicalJson(payload));
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Deterministic JSON with object keys sorted at every depth. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Create a JSON error response.
 */
export function errorResponse(
  message: string,
  status: number,
): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Generate a high-entropy namespace ownership token (256 bits, hex).
 */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SHA-256 hash of a token, hex-encoded. Tokens are 256-bit random values,
 * so a plain hash is sufficient — there is nothing to brute force.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time comparison of two hex strings, to avoid leaking
 * how much of a token prefix an attacker guessed correctly.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Upper bound on any caller-supplied TTL: one year, in seconds. */
export const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;

/**
 * Validate a caller-supplied TTL.
 *
 * Unvalidated TTLs were both a correctness and an availability problem:
 * `new Date(now + NaN).toISOString()` throws a RangeError (a 500), and an
 * unbounded value let a caller pin a claim for millennia.
 */
export function normalizeTtl(
  ttl: unknown,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (ttl === undefined || ttl === null) return { ok: true, value: null };

  if (typeof ttl !== "number" || !Number.isFinite(ttl)) {
    return { ok: false, error: "ttl must be a finite number of seconds" };
  }
  if (!Number.isInteger(ttl) || ttl < 1) {
    return { ok: false, error: "ttl must be a positive integer" };
  }
  if (ttl > MAX_TTL_SECONDS) {
    return { ok: false, error: `ttl must not exceed ${MAX_TTL_SECONDS} seconds` };
  }
  return { ok: true, value: ttl };
}
