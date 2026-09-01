import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

/**
 * OnceKey — Atomic idempotency witness backed by Durable Object SQLite.
 *
 * Each unique {namespace} gets its own Durable Object instance.
 * Within that instance, action_keys are atomically claimed exactly once.
 */
export class OnceKey extends DurableObject<Env> {
  private initialized = false;

  private ensureTable() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        action_key   TEXT PRIMARY KEY,
        payload_sha  TEXT,
        claimed_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL
      )
    `);
    this.initialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "POST required" }, { status: 405 });
    }

    const body = await request.json<{
      action_key: string;
      payload_sha256?: string;
      ttl?: number;
    }>();

    if (!body.action_key) {
      return Response.json(
        { error: "action_key is required" },
        { status: 400 },
      );
    }

    this.ensureTable();

    // Purge expired claims
    this.ctx.storage.sql.exec(
      `DELETE FROM claims WHERE expires_at < ?`,
      new Date().toISOString(),
    );

    const ttl = body.ttl ?? 86400;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    // Attempt atomic claim
    const existing = this.ctx.storage.sql
      .exec(`SELECT * FROM claims WHERE action_key = ?`, body.action_key)
      .toArray();

    if (existing.length > 0) {
      const row = existing[0];
      // Check payload mismatch → conflict
      if (
        body.payload_sha256 &&
        row.payload_sha !== body.payload_sha256
      ) {
        return Response.json({
          status: "conflict",
          action_key: body.action_key,
          claimed_at: row.claimed_at,
          expires_at: row.expires_at,
        });
      }
      return Response.json({
        status: "duplicate",
        action_key: body.action_key,
        claimed_at: row.claimed_at,
        expires_at: row.expires_at,
      });
    }

    // Claim it
    this.ctx.storage.sql.exec(
      `INSERT INTO claims (action_key, payload_sha, claimed_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      body.action_key,
      body.payload_sha256 ?? null,
      now.toISOString(),
      expiresAt.toISOString(),
    );

    return Response.json({
      status: "claimed",
      action_key: body.action_key,
      claimed_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
  }
}
