import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import {
  generateToken,
  hashToken,
  normalizeTtl,
  timingSafeEqual,
} from "../lib/utils";

/** Default claim lifetime when the caller does not supply a ttl. */
const DEFAULT_TTL_SECONDS = 86400;

/**
 * OnceKey — Atomic idempotency witness backed by Durable Object SQLite.
 *
 * Each unique {namespace} gets its own Durable Object instance.
 * Within that instance, action_keys are atomically claimed exactly once.
 *
 * Namespaces are owned. The first caller to touch a namespace is issued a
 * one-time `namespace_token` which every later request must present. Without
 * this, namespaces are just guessable strings: anyone could pre-burn another
 * tenant's action_keys for $0.001 each, causing the victim's own writes to
 * come back as "duplicate" and be silently skipped.
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
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS namespace_meta (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        token_hash   TEXT NOT NULL,
        claimed_at   TEXT NOT NULL
      )
    `);
    this.initialized = true;
  }

  private getOwnerHash(): string | null {
    const rows = this.ctx.storage.sql
      .exec(`SELECT token_hash FROM namespace_meta WHERE id = 1`)
      .toArray();
    return rows.length > 0 ? (rows[0].token_hash as string) : null;
  }

  private hasClaims(): boolean {
    return (
      this.ctx.storage.sql.exec(`SELECT 1 FROM claims LIMIT 1`).toArray()
        .length > 0
    );
  }

  private async isAuthorized(token: string | undefined): Promise<boolean> {
    const ownerHash = this.getOwnerHash();
    if (ownerHash === null) {
      // A namespace holding claims but no owner predates the ownership model.
      // Letting someone claim it now would hand them control of another
      // tenant's live idempotency keys, so these are locked instead.
      return !this.hasClaims();
    }
    if (!token) return false;
    return timingSafeEqual(await hashToken(token), ownerHash);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "POST required" }, { status: 405 });
    }

    const body = await request.json<{
      action_key: string;
      payload_sha256?: string;
      namespace_token?: string;
      ttl?: number;
    }>();

    if (!body.action_key) {
      return Response.json(
        { error: "action_key is required" },
        { status: 400 },
      );
    }

    const ttl = normalizeTtl(body.ttl);
    if (!ttl.ok) {
      return Response.json({ error: ttl.error }, { status: 400 });
    }

    this.ensureTable();

    if (!(await this.isAuthorized(body.namespace_token))) {
      return Response.json(
        { error: "Invalid or missing namespace_token for this namespace" },
        { status: 403 },
      );
    }

    // First request claims the namespace and is issued a one-time token.
    // The token is always minted here, never accepted from the caller: a
    // chosen token could be low-entropy or used to pre-claim someone else's
    // namespace with no recovery path.
    let issuedToken: string | undefined;
    if (this.getOwnerHash() === null) {
      const token = generateToken();
      const hash = await hashToken(token);

      // The await above yields, so two concurrent first-requests can both
      // see an unclaimed namespace. Insert defensively, then re-read to find
      // out which one actually won.
      this.ctx.storage.sql.exec(
        `INSERT INTO namespace_meta (id, token_hash, claimed_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        hash,
        new Date().toISOString(),
      );

      if (this.getOwnerHash() === hash) {
        issuedToken = token;
      } else {
        return Response.json(
          { error: "Invalid or missing namespace_token for this namespace" },
          { status: 403 },
        );
      }
    }

    // Purge expired claims
    this.ctx.storage.sql.exec(
      `DELETE FROM claims WHERE expires_at < ?`,
      new Date().toISOString(),
    );

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + (ttl.value ?? DEFAULT_TTL_SECONDS) * 1000,
    );

    const ownership = issuedToken
      ? {
          namespace_token: issuedToken,
          note: "Save this namespace_token — it is shown only once and is required for all future operations on this namespace.",
        }
      : {};

    // Attempt atomic claim
    const existing = this.ctx.storage.sql
      .exec(`SELECT * FROM claims WHERE action_key = ?`, body.action_key)
      .toArray();

    if (existing.length > 0) {
      const row = existing[0];
      // Check payload mismatch → conflict
      if (body.payload_sha256 && row.payload_sha !== body.payload_sha256) {
        // Deliberately HTTP 200 with status: "conflict", not 409. The x402
        // middleware cancels payment settlement on any status >= 400, so a
        // 409 here would let the caller replay the same payment header
        // forever. The outcome is machine-readable in `status` instead.
        return Response.json({
          status: "conflict",
          action_key: body.action_key,
          claimed_at: row.claimed_at,
          expires_at: row.expires_at,
          ...ownership,
        });
      }
      return Response.json({
        status: "duplicate",
        action_key: body.action_key,
        claimed_at: row.claimed_at,
        expires_at: row.expires_at,
        ...ownership,
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
      ...ownership,
    });
  }
}
