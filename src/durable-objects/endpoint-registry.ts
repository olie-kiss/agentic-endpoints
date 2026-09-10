import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { diffObservation, type Drift, type Observation } from "../lib/x402-verify";

/**
 * A shared record of what x402 endpoints have declared over time.
 *
 * One Durable Object per endpoint URL, so every caller who verifies the same
 * endpoint reads and writes the same history. That sharing is the entire
 * value: an agent checking an endpoint for the first time still benefits from
 * having been the hundredth to look at it. A per-caller cache would only ever
 * tell an agent what it already knew.
 *
 * It is also the reason this cannot be self-hosted usefully. A single agent
 * observing its own calls learns nothing about what other agents were charged
 * yesterday, which is precisely the comparison that catches a swapped payee.
 *
 * Only what an endpoint publicly declares in its own payment challenge is
 * stored -- price, chain, asset, receiving address. No caller identity is
 * recorded, because who asked is nobody else's business and would make this
 * a map of which agents are considering which services.
 */
const MAX_CHANGES = 50;

export class EndpointRegistry extends DurableObject<Env> {
  private initialized = false;

  private ensureTable() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS endpoint (
        url          TEXT PRIMARY KEY,
        first_seen   TEXT NOT NULL,
        last_seen    TEXT NOT NULL,
        times_seen   INTEGER NOT NULL DEFAULT 0,
        pay_to       TEXT,
        amount       TEXT,
        asset        TEXT,
        network      TEXT,
        scheme       TEXT
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS changes (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       TEXT NOT NULL,
        field    TEXT NOT NULL,
        old      TEXT,
        new      TEXT,
        severity TEXT NOT NULL,
        note     TEXT NOT NULL
      );
    `);
    this.initialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureTable();
    const url = new URL(request.url);
    if (url.pathname === "/observe") return this.observe(request);
    if (url.pathname === "/history") return this.history(request);
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  /**
   * Records one observation and returns how it differs from the last.
   *
   * An unreachable endpoint is deliberately NOT recorded as an observation.
   * Overwriting a known-good record with nulls because of one network blip
   * would manufacture a fake "payTo changed to nothing" alarm on the next
   * call, and a tool that cries wolf about payee changes is worse than no
   * tool.
   */
  private async observe(request: Request): Promise<Response> {
    const body = await request.json<{
      url: string;
      observation: Observation | null;
    }>();

    const now = new Date().toISOString();
    const existing = this.ctx.storage.sql
      .exec(`SELECT * FROM endpoint WHERE url = ?`, body.url)
      .toArray()[0];

    if (!body.observation) {
      return Response.json({
        first_seen: (existing?.first_seen as string) ?? null,
        last_seen: (existing?.last_seen as string) ?? null,
        times_seen: Number(existing?.times_seen ?? 0),
        drift: [],
        recorded: false,
      });
    }

    const current = body.observation;
    let drift: Drift[] = [];

    if (existing) {
      const previous: Observation = {
        pay_to: (existing.pay_to as string) ?? null,
        amount: (existing.amount as string) ?? null,
        asset: (existing.asset as string) ?? null,
        network: (existing.network as string) ?? null,
        scheme: (existing.scheme as string) ?? null,
      };
      drift = diffObservation(previous, current);

      for (const d of drift) {
        this.ctx.storage.sql.exec(
          `INSERT INTO changes (at, field, old, new, severity, note)
           VALUES (?, ?, ?, ?, ?, ?)`,
          now,
          d.field,
          d.from,
          d.to,
          d.severity,
          d.note,
        );
      }

      // Bounded by count rather than age: a payee swap from two years ago is
      // still the most important thing this object knows.
      this.ctx.storage.sql.exec(
        `DELETE FROM changes WHERE id NOT IN (
           SELECT id FROM changes ORDER BY id DESC LIMIT ?
         )`,
        MAX_CHANGES,
      );

      this.ctx.storage.sql.exec(
        `UPDATE endpoint
         SET last_seen = ?, times_seen = times_seen + 1,
             pay_to = ?, amount = ?, asset = ?, network = ?, scheme = ?
         WHERE url = ?`,
        now,
        current.pay_to,
        current.amount,
        current.asset,
        current.network,
        current.scheme,
        body.url,
      );
    } else {
      this.ctx.storage.sql.exec(
        `INSERT INTO endpoint
           (url, first_seen, last_seen, times_seen, pay_to, amount, asset, network, scheme)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        body.url,
        now,
        now,
        current.pay_to,
        current.amount,
        current.asset,
        current.network,
        current.scheme,
      );
    }

    const row = this.ctx.storage.sql
      .exec(`SELECT * FROM endpoint WHERE url = ?`, body.url)
      .toArray()[0];

    return Response.json({
      first_seen: (row?.first_seen as string) ?? now,
      last_seen: (row?.last_seen as string) ?? now,
      times_seen: Number(row?.times_seen ?? 1),
      drift,
      recorded: true,
      /**
       * True only when this is the very first look. The distinction matters:
       * "no drift" from a single observation is not evidence of stability,
       * and a caller that treats the two the same has learned nothing.
       */
      first_observation: !existing,
    });
  }

  private async history(_request: Request): Promise<Response> {
    const rows = this.ctx.storage.sql
      .exec(`SELECT at, field, old, new, severity, note FROM changes ORDER BY id DESC`)
      .toArray();
    return Response.json({ changes: rows });
  }
}
