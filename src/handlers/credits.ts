import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import type { Ledger } from "../durable-objects/credits";
import { clientKey, generateToken, hashToken, hmacHex } from "../lib/utils";

const app = new Hono<{ Bindings: Env }>();

/**
 * Prepaid credit packs.
 *
 * The bonus is the entire point: prepaying is only rational for a buyer if it
 * is cheaper than paying per call. It also front-loads revenue and removes a
 * signature from every subsequent request.
 */
export const PACKS: Record<string, { paid: string; grantMicros: number; bonus: string }> = {
  "/credits/buy": { paid: "$5.00", grantMicros: 6_000_000, bonus: "20%" },
  "/credits/buy-25": { paid: "$25.00", grantMicros: 32_500_000, bonus: "30%" },
};

export function creditsStub(env: Env, tokenHash: string) {
  // Addressed by the token hash, so each account is its own Durable Object:
  // one account's traffic cannot serialise behind another's, and the balance
  // check and debit are atomic within it.
  return env.CREDITS.get(env.CREDITS.idFromName(tokenHash)) as unknown as {
    open(tokenHash: string, grantMicros: number): Promise<Ledger>;
    spend(
      tokenHash: string,
      amountMicros: number,
    ): Promise<
      | { ok: true; ledger: Ledger }
      | { ok: false; reason: "unknown" | "insufficient"; ledger?: Ledger }
    >;
    refund(tokenHash: string, amountMicros: number): Promise<void>;
    balance(tokenHash: string): Promise<Ledger | null>;
  };
}

async function mint(c: Context<{ Bindings: Env }>, path: string) {
  const pack = PACKS[path];
  const token = `ae_${generateToken()}`;
  const tokenHash = await hashToken(token);

  const ledger = await creditsStub(c.env, tokenHash).open(tokenHash, pack.grantMicros);

  return c.json({
    credit_token: token,
    balance_usd: ledger.balance_usd,
    paid: pack.paid,
    bonus: pack.bonus,
    usage:
      "Send this token as the X-Credit-Token header on any paid endpoint. Each call is debited at that endpoint's list price and needs no X-PAYMENT header.",
    // Said plainly, because the token is shown exactly once and cannot be
    // recovered from the payment: losing it means losing the balance.
    warning:
      "Store this token now. It is not recoverable — the server keeps only a hash of it.",
    balance_url: "https://ai.oliverkiss.com/credits/balance",
  });
}

app.post("/buy", (c) => mint(c, "/credits/buy"));
app.post("/buy-25", (c) => mint(c, "/credits/buy-25"));

/**
 * A free evaluation balance, issued with no account, no email and no approval.
 *
 * This exists because of an ordering problem that costs real sales: paying
 * per call requires a funded wallet, so an agent must commit money *before*
 * it can discover whether the answer is any good. A caller who cannot try
 * cheaply mostly does not try at all.
 *
 * The allowance is granted per client address rather than per request. The
 * token is derived from that address by HMAC instead of being random, so the
 * same caller always addresses the same ledger: asking twice returns the
 * balance that is left, never a fresh one. That makes the endpoint safe to
 * retry, removes any need to track who has already been issued one, and caps
 * the giveaway without storing a single identifier.
 */
export const TRIAL_GRANT_MICROS = 100_000; // $0.10 — 20 calls at the $0.005 median price.

app.post("/trial", async (c) => {
  const ip = clientKey(c.req.header("CF-Connecting-IP"));

  // Keyed by address, not by token: the point is to rate-limit issuance to a
  // caller who has not been given a token yet.
  const { success } = await c.env.WRITE_RATE_LIMITER.limit({ key: `trial:${ip}` });
  if (!success) {
    return c.json(
      { error: "rate_limited", detail: "Too many requests. Retry shortly." },
      429,
      { "Retry-After": "60" },
    );
  }

  const token = `ae_trial_${await hmacHex(`trial:v1:${ip}`, c.env.RECEIPT_SECRET)}`;
  const tokenHash = await hashToken(token);
  const ledger = await creditsStub(c.env, tokenHash).open(tokenHash, TRIAL_GRANT_MICROS);

  const exhausted = ledger.balance_micros <= 0;

  return c.json({
    credit_token: token,
    balance_usd: ledger.balance_usd,
    granted_usd: ledger.granted_usd,
    paid: "$0.00",
    trial: true,
    exhausted,
    usage:
      "Send this token as the X-Credit-Token header on any paid endpoint. Each call is debited at that endpoint's list price and needs no wallet, signature or X-PAYMENT header.",
    // Returned rather than discovered by a caller who thinks it has been
    // short-changed: the balance is deliberately not per-request.
    note: "One allowance per client address. Requesting again returns this same token and whatever balance remains — it does not top it up.",
    next: exhausted
      ? "This allowance is spent. Buy $6.00 of credit for $5.00 at POST /credits/buy, or pay per call with x402."
      : "Buy $6.00 of credit for $5.00 at POST /credits/buy when this runs out.",
    balance_url: "https://ai.oliverkiss.com/credits/balance",
  });
});

/** Free: a buyer must be able to check what they have without spending it. */
app.post("/balance", async (c) => {
  const token = c.req.header("X-Credit-Token");
  if (!token) {
    return c.json(
      { error: "missing_token", detail: "Send the X-Credit-Token header." },
      400,
    );
  }

  const tokenHash = await hashToken(token);
  const ledger = await creditsStub(c.env, tokenHash).balance(tokenHash);

  if (!ledger) {
    return c.json({ error: "unknown_token", detail: "No such credit account." }, 404);
  }

  return c.json({ ...ledger, currency: "USD" });
});

export default app;
