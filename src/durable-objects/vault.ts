import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import {
  generateToken,
  hashToken,
  newNamespaceError,
  normalizeTtl,
  timingSafeEqual,
} from "../lib/utils";

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
        size_bytes   INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        expires_at   TEXT
      )
    `);
    // Namespaces created before size_bytes existed still have the old shape.
    //
    // Only "column already exists" is expected here. Catching everything hid
    // two different bugs: a genuinely failed migration, and a backfill that
    // silently never ran, leaving every legacy item recorded as 0 bytes and
    // therefore free of any quota.
    let migrated = true;
    try {
      this.ctx.storage.sql.exec(
        `ALTER TABLE items ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/duplicate column/i.test(message)) throw err;
      migrated = false;
    }

    if (migrated) {
      // Separate statement, deliberately outside the catch: a failed backfill
      // must surface rather than be mistaken for an already-applied migration.
      this.ctx.storage.sql.exec(
        `UPDATE items SET size_bytes = LENGTH(ciphertext) WHERE size_bytes = 0`,
      );
    }

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
    if (this.getOwnerHash() === null) {
      // A namespace holding items but no owner predates the ownership model.
      // Allowing a claim here would hand an attacker every item written
      // during that window, so these are locked rather than claimable.
      return !this.hasItems();
    }
    return this.isOwner(token);
  }

  private hasItems(): boolean {
    return (
      this.ctx.storage.sql
        .exec(`SELECT 1 FROM items LIMIT 1`)
        .toArray().length > 0
    );
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
        `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
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
    if (url.pathname === "/list" && request.method === "POST") {
      return this.handleList(request);
    }
    if (url.pathname === "/rotate-token" && request.method === "POST") {
      return this.handleRotateToken(request);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private async handleStore(request: Request): Promise<Response> {
    const body = await request.json<{
      key: string;
      namespace?: string;
      ciphertext: string;
      alg?: string;
      ttl?: number;
      namespace_token?: string;
      if_match?: string;
      if_absent?: boolean;
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

    // Byte length, not character count: a multi-byte string is larger on
    // disk than `.length` suggests, so the quota was under-counting.
    const ciphertextBytes = new TextEncoder().encode(body.ciphertext).byteLength;

    if (ciphertextBytes > MAX_CIPHERTEXT_BYTES) {
      return Response.json(
        {
          error: `ciphertext exceeds the ${MAX_CIPHERTEXT_BYTES}-byte per-item limit`,
        },
        { status: 413 },
      );
    }

    const ttl = normalizeTtl(body.ttl);
    if (!ttl.ok) {
      return Response.json({ error: ttl.error }, { status: 400 });
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
      .exec(`SELECT size_bytes AS bytes FROM items WHERE key = ?`, body.key)
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

    if (bytes - replacedBytes + ciphertextBytes > MAX_NAMESPACE_BYTES) {
      return Response.json(
        {
          error: `namespace would exceed its ${MAX_NAMESPACE_BYTES}-byte storage quota`,
        },
        { status: 507 },
      );
    }

    // First write claims the namespace and issues a one-time owner token.
    //
    // The token is ALWAYS minted here and never taken from the request. If a
    // caller could choose it they could register a low-entropy value (making
    // the namespace brute-forceable) or silently pre-claim a namespace they
    // do not own, locking out its rightful owner with no recovery path.
    let issuedToken: string | undefined;
    if (this.getOwnerHash() === null) {
      // Only enforced for names that do not exist yet, so already-claimed
      // namespaces keep working. A guessable name is squattable, and a
      // squatted vault namespace is unrecoverable by design.
      if (body.namespace) {
        const invalid = newNamespaceError(body.namespace);
        if (invalid) {
          return Response.json(
            { error: "Namespace too guessable", detail: invalid },
            { status: 400 },
          );
        }
      }

      const token = generateToken();
      const hash = await hashToken(token);

      // The await above yields, so two concurrent first-writes can both
      // observe an unclaimed namespace. Insert defensively and re-read to
      // find out who actually won.
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
        // Lost the race: another caller owns this namespace now.
        return this.unauthorized();
      }
    }

    const now = new Date();
    const expiresAt = ttl.value
      ? new Date(now.getTime() + ttl.value * 1000).toISOString()
      : null;

    // Compare-and-swap, checked here so the read and the write are in the
    // same synchronous run of the Durable Object. Any await between them
    // would let a concurrent writer land in the gap and defeat the point.
    //
    // Without this, /store is last-write-wins: two agents rotating the same
    // secret silently clobber each other and neither can tell. That is the
    // one operation a secrets store must never lose quietly.
    if (body.if_match !== undefined || body.if_absent) {
      const current = this.ctx.storage.sql
        .exec(`SELECT updated_at FROM items WHERE key = ?`, body.key)
        .toArray()[0] as { updated_at?: string } | undefined;

      const failed = body.if_absent
        ? current !== undefined
        : current?.updated_at !== body.if_match;

      if (failed) {
        // 200, not 412: the caller paid, and comparing is the work. A 4xx
        // would cancel x402 settlement and make the answer free.
        return Response.json({
          status: "precondition_failed",
          key: body.key,
          updated_at: current?.updated_at ?? null,
          detail: body.if_absent
            ? "Key already exists and if_absent was set."
            : "Key was modified since the version you supplied in if_match. Re-read it and retry.",
          ...(issuedToken
            ? {
                namespace_token: issuedToken,
                notice:
                  "Save this namespace_token — it is shown only once and is required for all future operations on this namespace.",
              }
            : {}),
        });
      }
    }

    // Upsert — overwrite if key already exists
    this.ctx.storage.sql.exec(
      `INSERT INTO items (key, ciphertext, alg, size_bytes, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         alg = excluded.alg,
         size_bytes = excluded.size_bytes,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
      body.key,
      body.ciphertext,
      body.alg ?? "aes-256-gcm",
      ciphertextBytes,
      now.toISOString(),
      now.toISOString(),
      expiresAt,
    );

    // Report the persisted row, not the request. Overwriting an existing key
    // preserves its original created_at, so echoing `now` was a lie.
    const stored = this.ctx.storage.sql
      .exec(
        `SELECT created_at, updated_at, size_bytes FROM items WHERE key = ?`,
        body.key,
      )
      .toArray()[0];

    return Response.json({
      status: "stored",
      key: body.key,
      alg: body.alg ?? "aes-256-gcm",
      size_bytes: Number(stored?.size_bytes ?? ciphertextBytes),
      created_at: String(stored?.created_at ?? now.toISOString()),
      updated_at: String(stored?.updated_at ?? now.toISOString()),
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
      // Deliberately 200, not 404. This is a $0.02 route and the caller was
      // authenticated: "no such key" is the authoritative answer they paid
      // for, and answering it is the work. Under x402 any status >= 400
      // cancels settlement, so a 404 here hands out that answer for free and
      // leaves the payment header replayable — and it would let an owner
      // probe key existence by replaying a retrieve instead of paying for
      // /vault/exists, which already returns 200 for exactly this reason.
      return Response.json({ status: "not_found", key: body.key });
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
      // Deleting something already absent is a successful idempotent
      // outcome, not a failure — and as above, a 4xx would make the paid
      // request settle-free and replayable.
      return Response.json({ status: "not_found", key: body.key });
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

  /**
   * Lists the keys in a namespace, never their contents.
   *
   * An agent that stored secrets and lost track of what it named them had no
   * way to find out short of guessing, and no way to clean them up. Returns
   * metadata only: the ciphertext is what the caller pays $0.02 to retrieve.
   */
  private async handleList(request: Request): Promise<Response> {
    const body = await request.json<{ namespace_token?: string }>();

    this.ensureTable();

    if (!(await this.isOwner(body.namespace_token))) {
      return this.unauthorized();
    }

    this.purgeExpired();

    const rows = this.ctx.storage.sql
      .exec(
        `SELECT key, alg, size_bytes, created_at, updated_at, expires_at
           FROM items ORDER BY key`,
      )
      .toArray();

    const usage = this.usage();

    return Response.json({
      status: "listed",
      count: rows.length,
      // updated_at doubles as the version to pass back as if_match.
      items: rows.map((r) => ({
        key: r.key,
        alg: r.alg,
        size_bytes: Number(r.size_bytes ?? 0),
        created_at: r.created_at,
        updated_at: r.updated_at,
        expires_at: r.expires_at,
      })),
      usage: {
        items: usage.count,
        bytes: usage.bytes,
        max_items: MAX_ITEMS_PER_NAMESPACE,
        max_bytes: MAX_NAMESPACE_BYTES,
      },
    });
  }

  /**
   * Replaces the namespace token with a freshly minted one.
   *
   * A secrets store whose owner token can never be rotated is one where a
   * single leak grants permanent, unrevocable read and delete over every
   * secret in the namespace, with no remedy but abandoning it. Rotation is
   * the whole reason a credential is survivable.
   *
   * Free, on purpose. Putting a price on the safe response to a suspected
   * leak is how you get callers who do not rotate.
   */
  private async handleRotateToken(request: Request): Promise<Response> {
    const body = await request.json<{ namespace_token?: string }>();

    this.ensureTable();

    // Requires the *current* token. There is deliberately no recovery path:
    // any mechanism that could restore access without it would be a second
    // way in, and would belong to an attacker just as readily as the owner.
    if (!(await this.isOwner(body.namespace_token))) {
      return this.unauthorized();
    }

    const token = generateToken();
    const hash = await hashToken(token);

    // The await above yields. Re-checking under the same synchronous run
    // stops two concurrent rotations from both reporting success while only
    // one token actually works — which would lock the owner out of their own
    // namespace using a token this service told them was valid.
    if (!(await this.isOwner(body.namespace_token))) {
      return this.unauthorized();
    }

    this.ctx.storage.sql.exec(
      `UPDATE namespace_meta SET token_hash = ? WHERE id = 1`,
      hash,
    );

    return Response.json({
      status: "rotated",
      namespace_token: token,
      notice:
        "This replaces your previous namespace_token, which no longer works. It is shown only once.",
    });
  }
}
