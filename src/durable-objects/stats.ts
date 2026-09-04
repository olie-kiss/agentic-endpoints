import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

/**
 * Aggregate demand counters.
 *
 * Every product decision made on this service so far has been a guess, because
 * nothing recorded whether a single agent had ever called it. Revenue answers
 * "did anyone pay", which is the wrong first question when the answer is zero:
 * it cannot distinguish "nobody has ever found this" from "plenty of agents
 * arrive, see the price, and leave".
 *
 * So the unit of measurement here is the funnel, not the hit count:
 *
 *   challenged → the route was asked for and a 402 went back
 *   paid       → a payment or credit actually cleared
 *
 * challenged with no paid means the product is discoverable but not worth
 * buying. Neither means it was never found. Those two failures have opposite
 * remedies, and without this they look identical from the outside.
 *
 * One Durable Object holds all of it, so every counted request serialises
 * through a single instance. That is a deliberate trade at current volume —
 * writes happen after the response via waitUntil, so they never add latency to
 * a request, and the counters have to be readable to be worth collecting.
 * If /stats ever shows sustained throughput, this belongs in Analytics Engine.
 */
export class Stats extends DurableObject<Env> {
  private initialized = false;

  private ensureTable(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hits (
        day      TEXT NOT NULL,
        path     TEXT NOT NULL,
        outcome  TEXT NOT NULL,
        count    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, path, outcome)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.initialized = true;
  }

  /**
   * Records one request. Callers pass an already-bucketed path: the caller
   * knows its own route table, and letting raw URLs in here would let any
   * stranger grow this table without bound by requesting random paths.
   */
  async record(path: string, outcome: Outcome): Promise<void> {
    this.ensureTable();
    const now = new Date().toISOString();
    const day = now.slice(0, 10);

    this.ctx.storage.sql.exec(
      `INSERT INTO hits (day, path, outcome, count) VALUES (?, ?, ?, 1)
       ON CONFLICT (day, path, outcome) DO UPDATE SET count = count + 1`,
      day,
      path,
      outcome,
    );

    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('first_seen', ?)
       ON CONFLICT (key) DO NOTHING`,
      now,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('last_seen', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      now,
    );

    // Keep the table bounded without a scheduled job. 90 days is far longer
    // than any decision here looks back.
    const cutoff = new Date(Date.now() - 90 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    this.ctx.storage.sql.exec(`DELETE FROM hits WHERE day < ?`, cutoff);
  }

  async summary(): Promise<StatsSummary> {
    this.ensureTable();

    const rows = this.ctx.storage.sql
      .exec("SELECT day, path, outcome, count FROM hits")
      .toArray() as unknown as {
        day: string;
        path: string;
        outcome: Outcome;
        count: number;
      }[];

    const totals: Record<string, number> = {};
    const byPath: Record<string, Record<string, number>> = {};
    const byDay: Record<string, number> = {};

    for (const r of rows) {
      totals[r.outcome] = (totals[r.outcome] ?? 0) + r.count;
      byPath[r.path] ??= {};
      byPath[r.path][r.outcome] = (byPath[r.path][r.outcome] ?? 0) + r.count;
      byDay[r.day] = (byDay[r.day] ?? 0) + r.count;
    }

    const meta = Object.fromEntries(
      (
        this.ctx.storage.sql
          .exec("SELECT key, value FROM meta")
          .toArray() as unknown as { key: string; value: string }[]
      ).map((m) => [m.key, m.value]),
    );

    const challenged = totals.challenged ?? 0;
    const paid = totals.paid ?? 0;

    return {
      totals: {
        requests: Object.values(totals).reduce((a, b) => a + b, 0),
        challenged,
        paid,
        free: totals.free ?? 0,
        error: totals.error ?? 0,
      },
      // The number this whole service turns on. Null rather than 0 when
      // nothing has been challenged yet: "no agent has asked" and "agents ask
      // and never buy" are different problems and must not read the same.
      conversion:
        challenged > 0
          ? `${((paid / challenged) * 100).toFixed(2)}%`
          : null,
      by_path: byPath,
      by_day: Object.fromEntries(
        Object.entries(byDay).sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 30),
      ),
      first_seen: meta.first_seen ?? null,
      last_seen: meta.last_seen ?? null,
    };
  }
}

export type Outcome = "challenged" | "paid" | "free" | "error";

export interface StatsSummary {
  totals: {
    requests: number;
    challenged: number;
    paid: number;
    free: number;
    error: number;
  };
  conversion: string | null;
  by_path: Record<string, Record<string, number>>;
  by_day: Record<string, number>;
  first_seen: string | null;
  last_seen: string | null;
}
