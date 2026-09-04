import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import type { Ledger } from "../durable-objects/credits";
import { generateToken, hashToken } from "../lib/utils";

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
