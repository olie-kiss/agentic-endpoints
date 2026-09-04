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
    // Latency is kept as a bucketed histogram rather than raw samples. Raw
    // samples would grow without bound and force a sort on every read; the
    // histogram answers "is this fast enough to depend on" just as well.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS latency (
        day     TEXT NOT NULL,
        bucket  INTEGER NOT NULL,
        count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, bucket)
      )
    `);
    // One row per cron tick. The scheduled handler fires every 5 minutes, so
    // a gap in this table is the service having been unable to run — which is
    // an outage measured by the same system that would have served requests,
    // rather than a number asserted with nothing behind it.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ticks (
        ts TEXT PRIMARY KEY
      )
    `);
    this.initialized = true;
  }

  /**
   * Records one request. Callers pass an already-bucketed path: the caller
   * knows its own route table, and letting raw URLs in here would let any
   * stranger grow this table without bound by requesting random paths.
   */
  async record(
    path: string,
    outcome: Outcome,
    durationMs?: number,
  ): Promise<void> {
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

    if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
      this.ctx.storage.sql.exec(
        `INSERT INTO latency (day, bucket, count) VALUES (?, ?, 1)
         ON CONFLICT (day, bucket) DO UPDATE SET count = count + 1`,
        day,
        bucketFor(durationMs),
      );
    }

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
    this.ctx.storage.sql.exec(`DELETE FROM latency WHERE day < ?`, cutoff);
  }

  /**
   * Records that the scheduled handler ran. Called from cron, not from a
   * request: a liveness signal produced by traffic only proves the service
   * was up at the moments someone happened to ask.
   */
  async heartbeat(): Promise<void> {
    this.ensureTable();
    const now = new Date();
    this.ctx.storage.sql.exec(
      `INSERT INTO ticks (ts) VALUES (?) ON CONFLICT (ts) DO NOTHING`,
      now.toISOString(),
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM ticks WHERE ts < ?`,
      new Date(now.getTime() - 48 * 3_600_000).toISOString(),
    );
  }

  /**
   * Reliability evidence, published openly.
   *
   * An agent deciding whether to route paid work through a stranger's API has
   * no way to tell a maintained service from one that will disappear next
   * week. Everything here is derived from what actually happened rather than
   * asserted, and returns null while there is genuinely nothing to report —
   * a fabricated "100%" from zero samples is worse than an honest gap.
   */
  async slo(): Promise<Slo> {
    this.ensureTable();
    const now = Date.now();
    const since = new Date(now - 86_400_000).toISOString();

    const ticks = this.ctx.storage.sql
      .exec(`SELECT ts FROM ticks WHERE ts >= ? ORDER BY ts`, since)
      .toArray() as unknown as { ts: string }[];

    let uptime: string | null = null;
    let window: string | null = null;
    if (ticks.length > 0) {
      // Only credit the period actually observed. Claiming 24h of uptime from
      // an hour of ticks would be an outright lie on the first day.
      const firstMs = Date.parse(ticks[0].ts);
      const observedMs = Math.max(now - firstMs, CRON_PERIOD_MS);
      const expected = Math.max(1, Math.round(observedMs / CRON_PERIOD_MS));
      uptime = `${Math.min(100, (ticks.length / expected) * 100).toFixed(2)}%`;
      window = `${(observedMs / 3_600_000).toFixed(1)}h`;
    }

    const today = new Date(now).toISOString().slice(0, 10);
    const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);

    const hits = this.ctx.storage.sql
      .exec(
        `SELECT outcome, SUM(count) AS n FROM hits
          WHERE day IN (?, ?) AND path != 'other' GROUP BY outcome`,
        today,
        yesterday,
      )
      .toArray() as unknown as { outcome: Outcome; n: number }[];

    const requests = hits.reduce((a, h) => a + h.n, 0);
    const errors = hits.find((h) => h.outcome === "error")?.n ?? 0;
    const rejected = hits.find((h) => h.outcome === "client_error")?.n ?? 0;

    // Requests for paths that do not exist are almost entirely crawlers and
    // scanners. Counting them against availability would let any stranger
    // degrade the published figure at will.
    const unknown = (
      this.ctx.storage.sql
        .exec(
          `SELECT SUM(count) AS n FROM hits WHERE day IN (?, ?) AND path = 'other'`,
          today,
          yesterday,
        )
        .toArray() as unknown as { n: number | null }[]
    )[0]?.n ?? 0;

    const buckets = this.ctx.storage.sql
      .exec(
        `SELECT bucket, SUM(count) AS n FROM latency
          WHERE day IN (?, ?) GROUP BY bucket ORDER BY bucket`,
        today,
        yesterday,
      )
      .toArray() as unknown as { bucket: number; n: number }[];

    return {
      uptime_24h: uptime,
      uptime_window: window,
      cron_ticks_24h: ticks.length,
      requests_48h: requests,
      // Server failures only, over known paths. This is the number that says
      // whether depending on the service is safe.
      error_rate_48h:
        requests > 0 ? `${((errors / requests) * 100).toFixed(2)}%` : null,
      // Reported separately and deliberately not hidden: a high rate here
      // usually means the documentation is unclear, which is our problem too,
      // just a different one from being down.
      rejected_rate_48h:
        requests > 0 ? `${((rejected / requests) * 100).toFixed(2)}%` : null,
      unknown_path_requests_48h: unknown,
      latency_ms: {
        // Named "at most" on purpose: a histogram bounds a percentile, it
        // does not measure one, and rounding that away invites a client to
        // set a timeout the service was never promised to meet.
        p50_at_most: percentileBucket(buckets, 0.5),
        p95_at_most: percentileBucket(buckets, 0.95),
        p99_at_most: percentileBucket(buckets, 0.99),
      },
      measured_by:
        "Derived from this service's own request log and 5-minute cron ticks. " +
        "A missed tick counts against uptime. error_rate counts server " +
        "failures only: a rejected token or an unclaimed key is the service " +
        "working, and is reported under rejected_rate instead. Requests for " +
        "paths that do not exist are excluded entirely. Null means not " +
        "enough data yet.",
    };
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
        client_error: totals.client_error ?? 0,
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

export type Outcome =
  | "challenged"
  | "paid"
  | "free"
  | "client_error"
  | "error";

/** Cron fires every 5 minutes; see the schedule in wrangler.toml. */
const CRON_PERIOD_MS = 5 * 60_000;

/**
 * Histogram edges, in milliseconds. Dense at the low end because the useful
 * distinctions for an edge API are all below a second; anything slower is
 * equally "too slow" to a caller deciding on a timeout.
 */
export const LATENCY_BUCKETS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000,
] as const;

/** Sentinel for samples above the largest edge. */
export const OVERFLOW_BUCKET = -1;

export function bucketFor(ms: number): number {
  for (const edge of LATENCY_BUCKETS) {
    if (ms <= edge) return edge;
  }
  return OVERFLOW_BUCKET;
}

/**
 * The smallest bucket edge at or below which `p` of the samples fall.
 *
 * Returns null when there are no samples, and null for the overflow bucket
 * rather than inventing an upper bound that was never observed.
 */
export function percentileBucket(
  buckets: { bucket: number; n: number }[],
  p: number,
): number | null {
  const total = buckets.reduce((a, b) => a + b.n, 0);
  if (total === 0) return null;

  const ordered = [...buckets].sort((a, b) =>
    a.bucket === OVERFLOW_BUCKET
      ? 1
      : b.bucket === OVERFLOW_BUCKET
        ? -1
        : a.bucket - b.bucket,
  );

  let seen = 0;
  for (const b of ordered) {
    seen += b.n;
    if (seen >= total * p) {
      return b.bucket === OVERFLOW_BUCKET ? null : b.bucket;
    }
  }
  return null;
}

export interface Slo {
  uptime_24h: string | null;
  uptime_window: string | null;
  cron_ticks_24h: number;
  requests_48h: number;
  error_rate_48h: string | null;
  rejected_rate_48h: string | null;
  unknown_path_requests_48h: number;
  latency_ms: {
    p50_at_most: number | null;
    p95_at_most: number | null;
    p99_at_most: number | null;
  };
  measured_by: string;
}

export interface StatsSummary {
  totals: {
    requests: number;
    challenged: number;
    paid: number;
    free: number;
    client_error: number;
    error: number;
  };
  conversion: string | null;
  by_path: Record<string, Record<string, number>>;
  by_day: Record<string, number>;
  first_seen: string | null;
  last_seen: string | null;
}
