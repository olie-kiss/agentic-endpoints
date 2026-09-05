import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { timingSafeEqual } from "../lib/utils";

/**
 * A prepaid credit account, one Durable Object per account.
 *
 * Per-call x402 requires the caller to sign a payment for every single
 * request, which is a hard ceiling on revenue: $1,000 at $0.005 a call means
 * 200,000 signatures. Credits collapse that to one payment, so the same
 * product can be sold in amounts worth the buyer's trouble.
 *
 * Balances are integer micro-dollars (1e-6 USD). Money must never be tracked
 * in floating point: $0.001 is not representable in binary, and a service
 * whose ledger drifts is worse than one that cannot bill at all.
 */
export class Credits extends DurableObject<Env> {
  private initialized = false;

  private ensureTable(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS account (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        token_hash      TEXT NOT NULL,
        balance_micros  INTEGER NOT NULL,
        granted_micros  INTEGER NOT NULL,
        spent_micros    INTEGER NOT NULL DEFAULT 0,
        call_count      INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      )
    `);
    this.initialized = true;
  }

  private row():
    | {
        token_hash: string;
        balance_micros: number;
        granted_micros: number;
        spent_micros: number;
        call_count: number;
        created_at: string;
        updated_at: string;
      }
    | undefined {
    return this.ctx.storage.sql
      .exec("SELECT * FROM account WHERE id = 1")
      .toArray()[0] as never;
  }

  /**
   * Creates the account. The DO is addressed by the hash of the token, so an
   * attacker cannot reach an account without already holding its token; the
   * hash is stored only so a collision or a routing bug cannot silently spend
   * someone else's balance.
   */
  async open(tokenHash: string, grantMicros: number): Promise<Ledger> {
    this.ensureTable();
    const existing = this.row();

    // Idempotent: a retried mint must not double-grant, and must not reset a
    // balance the buyer has already spent against.
    if (existing) return this.toLedger(existing);

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO account
         (id, token_hash, balance_micros, granted_micros, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      tokenHash,
      grantMicros,
      grantMicros,
      now,
      now,
    );

    return this.toLedger(this.row()!);
  }

  /**
   * Spends from the balance.
   *
   * Runs inside the Durable Object's single-threaded execution, so the
   * read-check-write is atomic by construction: two concurrent calls cannot
   * both pass the balance check and overdraw the account.
   */
  async spend(
    tokenHash: string,
    amountMicros: number,
  ): Promise<
    | { ok: true; ledger: Ledger }
    | { ok: false; reason: "unknown" | "insufficient"; ledger?: Ledger }
  > {
    this.ensureTable();
    const row = this.row();
    if (!row || !timingSafeEqual(row.token_hash, tokenHash)) {
      return { ok: false, reason: "unknown" };
    }

    if (row.balance_micros < amountMicros) {
      return { ok: false, reason: "insufficient", ledger: this.toLedger(row) };
    }

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE account
          SET balance_micros = balance_micros - ?,
              spent_micros   = spent_micros + ?,
              call_count     = call_count + 1,
              updated_at     = ?
        WHERE id = 1`,
      amountMicros,
      amountMicros,
      now,
    );

    return { ok: true, ledger: this.toLedger(this.row()!) };
  }

  /**
   * Returns credit taken for work that then failed.
   *
   * Without this, an upstream outage silently bills the customer for nothing —
   * the fastest way to lose the few buyers this service manages to attract.
   */
  async refund(tokenHash: string, amountMicros: number): Promise<void> {
    this.ensureTable();
    const row = this.row();

    // Never credit an account on an unverified hash — that would make refunds
    // a way to mint balance. But do not return quietly either: refund is only
    // ever called after a charge succeeded against this same hash, so getting
    // here means either a bug or an attempt to forge one, and the customer is
    // still holding a charge nobody will reverse. Throwing hands it to the
    // caller's logging, which records the amount and account for reconciling.
    if (!row) {
      throw new Error("Refund rejected: no credit account exists");
    }
    if (!timingSafeEqual(row.token_hash, tokenHash)) {
      throw new Error("Refund rejected: token hash does not match the account");
    }

    this.ctx.storage.sql.exec(
      `UPDATE account
          SET balance_micros = balance_micros + ?,
              spent_micros   = MAX(spent_micros - ?, 0),
              call_count     = MAX(call_count - 1, 0),
              updated_at     = ?
        WHERE id = 1`,
      amountMicros,
      amountMicros,
      new Date().toISOString(),
    );
  }

  async balance(tokenHash: string): Promise<Ledger | null> {
    this.ensureTable();
    const row = this.row();
    if (!row || !timingSafeEqual(row.token_hash, tokenHash)) return null;
    return this.toLedger(row);
  }

  private toLedger(row: NonNullable<ReturnType<Credits["row"]>>): Ledger {
    return {
      balance_micros: row.balance_micros,
      balance_usd: micros(row.balance_micros),
      granted_usd: micros(row.granted_micros),
      spent_usd: micros(row.spent_micros),
      call_count: row.call_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

export interface Ledger {
  balance_micros: number;
  balance_usd: string;
  granted_usd: string;
  spent_usd: string;
  call_count: number;
  created_at: string;
  updated_at: string;
}

/** Renders micro-dollars for display without ever doing float arithmetic. */
function micros(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 1_000_000)}.${String(abs % 1_000_000).padStart(6, "0")}`;
}

