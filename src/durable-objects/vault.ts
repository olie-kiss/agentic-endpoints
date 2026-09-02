import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { generateToken, hashToken, timingSafeEqual } from "../lib/utils";

/**
 * Vault — Encrypted key-value store backed by Durable Object SQLite.
 *
 * Each unique {namespace} gets its own Durable Object instance and is owned by
 * whoever first writes to it: that first store issues a one-time namespace
 * token, and every later operation on the namespace must present it. Without
 * this, any anonymous caller could overwrite or delete another tenant's data,
 * since namespaces are just caller-supplied strings.
 */
/**
 * Storage quotas. Writes are free, so without a ceiling a single caller
 * could fill Durable Object storage at our expense.
 */
const MAX_CIPHERTEXT_BYTES = 256 * 1024; // 256 KiB per item
const MAX_KEY_LENGTH = 512;
const MAX_ITEMS_PER_NAMESPACE = 1000;
const MAX_NAMESPACE_BYTES = 25 * 1024 * 1024; // 25 MiB total per namespace

export class Vault extends DurableObject<Env> {
  private initialized = false;

  private ensureTable() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS items (
        key          TEXT PRIMARY KEY,
        ciphertext   TEXT NOT NULL,
        alg          TEXT NOT NULL DEFAULT 'aes-256-gcm',
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        expires_at   TEXT
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

  /**
   * Strict ownership check: the namespace must already be claimed and the
   * caller must present the matching token. Used for read/delete operations,
   * so an unclaimed namespace and a wrong token are indistinguishable.
   */
  private async isOwner(token: string | undefined): Promise<boolean> {
    const ownerHash = this.getOwnerHash();
    if (ownerHash === null || !token) return false;
    return timingSafeEqual(await hashToken(token), ownerHash);
  }

  /**
   * Verify a caller-supplied token against the namespace owner hash.
   * Returns true when the namespace is unclaimed (caller is about to claim it).
   */
  private async isAuthorized(token: string | undefined): Promise<boolean> {
    if (this.getOwnerHash() === null) return true;
    return this.isOwner(token);
  }

  /** Drop expired items so they don't count against the namespace quota. */
  private purgeExpired() {
    this.ctx.storage.sql.exec(
      `DELETE FROM items WHERE expires_at IS NOT NULL AND expires_at < ?`,
      new Date().toISOString(),
    );
  }

  private usage(): { count: number; bytes: number } {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(ciphertext)), 0) AS bytes
         FROM items`,
      )
      .toArray();
    return {
      count: Number(rows[0]?.count ?? 0),
      bytes: Number(rows[0]?.bytes ?? 0),
    };
  }

  private unauthorized(): Response {
    return Response.json(
      {
        error:
          "Invalid or missing namespace_token for this namespace",
      },
      { status: 403 },
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/store" && request.method === "POST") {
      return this.handleStore(request);
    }
    if (url.pathname === "/retrieve" && request.method === "POST") {
      return this.handleRetrieve(request);
    }
    if (url.pathname === "/delete" && request.method === "POST") {
      return this.handleDelete(request);
    }
    if (url.pathname === "/exists" && request.method === "POST") {
      return this.handleExists(request);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private async handleStore(request: Request): Promise<Response> {
    const body = await request.json<{
      key: string;
      ciphertext: string;
      alg?: string;
      ttl?: number;
      namespace_token?: string;
    }>();

    if (!body.key || !body.ciphertext) {
      return Response.json(
        { error: "key and ciphertext are required" },
        { status: 400 },
      );
    }

    if (body.key.length > MAX_KEY_LENGTH) {
      return Response.json(
        { error: `key exceeds ${MAX_KEY_LENGTH} characters` },
        { status: 400 },
      );
    }

    if (body.ciphertext.length > MAX_CIPHERTEXT_BYTES) {
      return Response.json(
        {
          error: `ciphertext exceeds the ${MAX_CIPHERTEXT_BYTES}-byte per-item limit`,
        },
        { status: 413 },
      );
    }

    this.ensureTable();

    if (!(await this.isAuthorized(body.namespace_token))) {
      return this.unauthorized();
    }

    // Quotas are checked before the namespace is claimed. Claiming first
    // would mint a token we then never return, permanently bricking the
    // namespace for its rightful owner.
    this.purgeExpired();
    const existing = this.ctx.storage.sql
      .exec(`SELECT LENGTH(ciphertext) AS bytes FROM items WHERE key = ?`, body.key)
      .toArray();
    const replacedBytes = Number(existing[0]?.bytes ?? 0);
    const { count, bytes } = this.usage();

    if (existing.length === 0 && count >= MAX_ITEMS_PER_NAMESPACE) {
      return Response.json(
        {
          error: `namespace holds the maximum of ${MAX_ITEMS_PER_NAMESPACE} items`,
        },
        { status: 507 },
      );
    }

    if (bytes - replacedBytes + body.ciphertext.length > MAX_NAMESPACE_BYTES) {
      return Response.json(
        {
          error: `namespace would exceed its ${MAX_NAMESPACE_BYTES}-byte storage quota`,
        },
        { status: 507 },
      );
    }

    // First write claims the namespace and issues a one-time owner token.
    let issuedToken: string | undefined;
    if (this.getOwnerHash() === null) {
      issuedToken = body.namespace_token ?? generateToken();
      this.ctx.storage.sql.exec(
        `INSERT INTO namespace_meta (id, token_hash, claimed_at)
         VALUES (1, ?, ?)`,
        await hashToken(issuedToken),
        new Date().toISOString(),
      );
      // Only surface a token the caller didn't already choose.
      if (body.namespace_token) issuedToken = undefined;
    }

    const now = new Date();
    const expiresAt = body.ttl
      ? new Date(now.getTime() + body.ttl * 1000).toISOString()
      : null;

    // Upsert — overwrite if key already exists
    this.ctx.storage.sql.exec(
      `INSERT INTO items (key, ciphertext, alg, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         alg = excluded.alg,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
      body.key,
      body.ciphertext,
      body.alg ?? "aes-256-gcm",
      now.toISOString(),
      now.toISOString(),
      expiresAt,
    );

    return Response.json({
      status: "stored",
      key: body.key,
      alg: body.alg ?? "aes-256-gcm",
      created_at: now.toISOString(),
      expires_at: expiresAt,
      ...(issuedToken
        ? {
            namespace_token: issuedToken,
            notice:
              "Save this namespace_token — it is shown only once and is required for all future operations on this namespace.",
          }
        : {}),
    });
  }

  private async handleRetrieve(request: Request): Promise<Response> {
    const body = await request.json<{
      key: string;
      namespace_token?: string;
    }>();

    if (!body.key) {
      return Response.json(
        { error: "key is required" },
        { status: 400 },
      );
    }

    this.ensureTable();

    if (!(await this.isOwner(body.namespace_token))) {
      return this.unauthorized();
    }

    // Purge expired items
    this.ctx.storage.sql.exec(
      `DELETE FROM items WHERE expires_at IS NOT NULL AND expires_at < ?`,
      new Date().toISOString(),
    );

    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM items WHERE key = ?`, body.key)
      .toArray();

    if (rows.length === 0) {
      return Response.json(
        { status: "not_found", key: body.key },
        { status: 404 },
      );
    }

    const row = rows[0];
    return Response.json({
      status: "retrieved",
      key: body.key,
      ciphertext: row.ciphertext,
      alg: row.alg,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at,
    });
  }

  private async handleDelete(request: Request): Promise<Response> {
    const body = await request.json<{
      key: string;
      namespace_token?: string;
    }>();

    if (!body.key) {
      return Response.json(
        { error: "key is required" },
        { status: 400 },
      );
    }

    this.ensureTable();

    if (!(await this.isOwner(body.namespace_token))) {
      return this.unauthorized();
    }

    const existing = this.ctx.storage.sql
      .exec(`SELECT key FROM items WHERE key = ?`, body.key)
      .toArray();

    if (existing.length === 0) {
      return Response.json(
        { status: "not_found", key: body.key },
        { status: 404 },
      );
    }

    this.ctx.storage.sql.exec(`DELETE FROM items WHERE key = ?`, body.key);

    return Response.json({ status: "deleted", key: body.key });
  }

  private async handleExists(request: Request): Promise<Response> {
    const body = await request.json<{
      key: string;
      namespace_token?: string;
    }>();

    if (!body.key) {
      return Response.json(
        { error: "key is required" },
        { status: 400 },
      );
    }

    this.ensureTable();

    // Gated: an ungated existence check is a free enumeration oracle.
    if (!(await this.isOwner(body.namespace_token))) {
      return this.unauthorized();
    }

    // Purge expired
    this.ctx.storage.sql.exec(
      `DELETE FROM items WHERE expires_at IS NOT NULL AND expires_at < ?`,
      new Date().toISOString(),
    );

    const rows = this.ctx.storage.sql
      .exec(`SELECT key FROM items WHERE key = ?`, body.key)
      .toArray();

    return Response.json({
      status: "ok",
      key: body.key,
      exists: rows.length > 0,
    });
  }
}
