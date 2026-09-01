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
