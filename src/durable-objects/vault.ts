import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

/**
 * Vault — Encrypted key-value store backed by Durable Object SQLite.
 *
 * Each unique {namespace} gets its own Durable Object instance.
 * Storing encrypted items is free; retrieval is paid via x402.
 */
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
    this.initialized = true;
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
    }>();

    if (!body.key || !body.ciphertext) {
      return Response.json(
        { error: "key and ciphertext are required" },
        { status: 400 },
      );
    }

    this.ensureTable();

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
    });
  }

  private async handleRetrieve(request: Request): Promise<Response> {
    const body = await request.json<{ key: string }>();

    if (!body.key) {
      return Response.json(
        { error: "key is required" },
        { status: 400 },
      );
    }

    this.ensureTable();

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
    const body = await request.json<{ key: string }>();

    if (!body.key) {
      return Response.json(
        { error: "key is required" },
        { status: 400 },
      );
    }

    this.ensureTable();

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
    const body = await request.json<{ key: string }>();

    if (!body.key) {
      return Response.json(
        { error: "key is required" },
        { status: 400 },
      );
    }

    this.ensureTable();

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
