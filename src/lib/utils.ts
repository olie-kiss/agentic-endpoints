import type { Env } from "../types";

/**
 * Sign a receipt payload with HMAC-SHA256.
 * Returns a hex-encoded signature that callers can verify.
 */
export async function signReceipt(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = encoder.encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
