import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import {
  generateToken,
  hashToken,
  newNamespaceError,
  normalizeTtl,
  timingSafeEqual,
} from "../lib/utils";

/** Default claim lifetime when the caller does not supply a ttl. */
const DEFAULT_TTL_SECONDS = 86400;

/**
 * A lease is opt-in via `lease_ttl`.
 *
 * The default has to be the safe one. If leases were on by default, an agent
 * that simply never calls /complete — every integration written against the
 * original claim-only API — would have its key silently become reclaimable,
 * and a second agent would run the same side effect. Duplicating a charge or
 * an email is the precise failure this service is sold to prevent, and it is
 * far worse than the alternative: a key that stays held until its ttl and
 * needs a fresh action_key to retry.
 */
const RECOMMENDED_LEASE_SECONDS = 300;

/** Cap on a stored result, to keep one namespace from filling DO storage. */
export const MAX_RESULT_BYTES = 16 * 1024;

type Action = "claim" | "complete" | "release";

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
 *
 * An action_key moves through two states:
 *
 *   claim ──▶ claimed ──▶ completed
 *                │  ▲         │
 *      release / │  │ another │ later claims replay the stored result
 *   lease expiry │  │ caller  │ instead of re-running the side effect
 *                ▼  │ takes   ▼
 *              (gone)  over
 *
 * The lease is what makes this safe for real agents. A claimant that crashes
 * mid-work would otherwise hold the key until its full ttl elapsed, blocking
 * every retry. Instead the claim carries a short lease; once that lapses the
 * work is presumed abandoned and the next caller may take it over.
 */
export class OnceKey extends DurableObject<Env> {
  private initialized = false;

  private columns(table: string): Set<string> {
    return new Set(
      this.ctx.storage.sql
        .exec(`PRAGMA table_info(${table})`)
        .toArray()
        .map((r) => r.name as string),
    );
  }

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

    // Rows written before the lease model existed were terminal on creation:
    // once claimed they could only ever read back as "duplicate". Defaulting
    // them to 'completed' preserves exactly that behaviour, where defaulting
    // to 'claimed' would silently make every historical key take-over-able.
    const cols = this.columns("claims");
    if (!cols.has("state")) {
      this.ctx.storage.sql.exec(
        `ALTER TABLE claims ADD COLUMN state TEXT NOT NULL DEFAULT 'completed'`,
      );
    }
    if (!cols.has("result")) {
      this.ctx.storage.sql.exec(`ALTER TABLE claims ADD COLUMN result TEXT`);
    }
    if (!cols.has("lease_expires_at")) {
      this.ctx.storage.sql.exec(
        `ALTER TABLE claims ADD COLUMN lease_expires_at TEXT`,
      );
    }
    if (!cols.has("completed_at")) {
      this.ctx.storage.sql.exec(
        `ALTER TABLE claims ADD COLUMN completed_at TEXT`,
      );
    }

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

  private row(actionKey: string): Record<string, unknown> | null {
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM claims WHERE action_key = ?`, actionKey)
      .toArray();
    return rows.length > 0 ? rows[0] : null;
  }

  /** Drop claims whose absolute lifetime has elapsed. */
  private purge(nowIso: string) {
    this.ctx.storage.sql.exec(
      `DELETE FROM claims WHERE expires_at < ?`,
      nowIso,
    );
  }

  /**
   * Renders a stored result into wire fields that are never ambiguous.
   *
   * `result` is always present, so a caller can never confuse "no result was
   * recorded" with "the field went missing", and `has_result` says which of
   * those it is. JSON.stringify drops undefined values, so returning a bare
   * undefined here would silently delete the field from the response — which
   * is precisely how a completed-but-empty claim used to read as a result of
   * undefined on the client.
   */
  private static resultFields(raw: unknown): Record<string, unknown> {
    if (typeof raw !== "string") return { result: null, has_result: false };
    try {
      return { result: JSON.parse(raw), has_result: true };
    } catch {
      // Stored JSON that will not parse is corruption, not an empty result.
      // `has_result` alone cannot carry this: reusing false would make it
      // identical to the legitimate "completed and recorded nothing" case, so
      // a caller would skip the side effect and proceed with null while the
      // real outcome is lost. `result_error` is the distinguishing signal and
      // clients must treat its presence as an error, not as an empty result.
      console.error("OnceKey: stored result is not decodable JSON");
      return {
        result: null,
        has_result: false,
        result_error: "stored result could not be decoded",
      };
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "POST required" }, { status: 405 });
    }

    const action = new URL(request.url).pathname.replace(
      /^\//,
      "",
    ) as Action;

    const body = await request.json<{
      action_key: string;
      namespace?: string;
      payload_sha256?: string;
      namespace_token?: string;
      ttl?: number;
      lease_ttl?: number;
      result?: unknown;
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
    const leaseTtl = normalizeTtl(body.lease_ttl);
    if (!leaseTtl.ok) {
      return Response.json(
        { error: leaseTtl.error?.replace("ttl", "lease_ttl") },
        { status: 400 },
      );
    }

    this.ensureTable();

    if (!(await this.isAuthorized(body.namespace_token))) {
      /**
       * The free lifecycle actions must not distinguish "wrong token" from
       * "never claimed": the pair is an unauthenticated, unmetered oracle for
       * which namespace names are in use, which is exactly the reconnaissance
       * step before squatting one. `claim` still answers 403, because probing
       * it costs the attacker a payment per guess.
       */
      if (action !== "claim") {
        return Response.json(
          {
            error: "No live claim for this action_key.",
            detail:
              "It was never claimed, was released, its ttl elapsed, or the namespace_token does not match this namespace.",
          },
          { status: 404 },
        );
      }
      return Response.json(
        { error: "Invalid or missing namespace_token for this namespace" },
        { status: 403 },
      );
    }

    // First request claims the namespace and is issued a one-time token.
    // The token is always minted here, never accepted from the caller: a
    // chosen token could be low-entropy or used to pre-claim someone else's
    // namespace with no recovery path.
    //
    // Only `claim` may take ownership. The free lifecycle actions used to
    // reach this block too, and since `isAuthorized` returns true for an
    // empty namespace, a bare `POST /once-key/complete` on a name nobody had
    // used yet would mint a token, persist its hash, and then return 404 —
    // the plaintext discarded, the namespace owned by a hash no one holds and
    // deliberately unrecoverable. Anyone could brick every obvious namespace
    // for free, permanently locking out the paying owner.
    let issuedToken: string | undefined;
    if (this.getOwnerHash() === null) {
      if (action !== "claim") {
        // Must be byte-identical to the unauthorized 404 above, or the detail
        // string reinstates the existence oracle it was written to remove.
        return Response.json(
          {
            error: "No live claim for this action_key.",
            detail:
              "It was never claimed, was released, its ttl elapsed, or the namespace_token does not match this namespace.",
          },
          { status: 404 },
        );
      }

      // Only enforced for names that do not exist yet, so already-claimed
      // namespaces keep working.
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

    const ownership = issuedToken
      ? {
          namespace_token: issuedToken,
          note: "Save this namespace_token — it is shown only once and is required for all future operations on this namespace.",
        }
      : {};

    const now = new Date();
    this.purge(now.toISOString());

    switch (action) {
      case "complete":
        return this.handleComplete(body, now, ttl.value, ownership);
      case "release":
        return this.handleRelease(body, ownership);
      default:
        return this.handleClaim(body, now, ttl.value, leaseTtl.value, ownership);
    }
  }

  private handleClaim(
    body: {
      action_key: string;
      payload_sha256?: string;
    },
    now: Date,
    ttlValue: number | null | undefined,
    leaseValue: number | null | undefined,
    ownership: Record<string, unknown>,
  ): Response {
    const ttlSeconds = ttlValue ?? DEFAULT_TTL_SECONDS;
    // A lease outliving the claim itself could never fire, so the claim
    // would be unrecoverable for exactly the cases the lease exists for.
    // No lease_ttl means no lease: the claim is terminal until its ttl.
    const leaseSeconds =
      leaseValue == null ? null : Math.min(leaseValue, ttlSeconds);
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const leaseExpiresAt =
      leaseSeconds === null
        ? null
        : new Date(now.getTime() + leaseSeconds * 1000);

    const existing = this.row(body.action_key);

    if (existing) {
      // A different payload under the same action_key means the caller has a
      // key-derivation bug; replaying a result computed from other inputs
      // would be worse than refusing.
      if (
        body.payload_sha256 &&
        existing.payload_sha &&
        existing.payload_sha !== body.payload_sha256
      ) {
        // Deliberately HTTP 200 with status: "conflict", not 409. The x402
        // middleware cancels payment settlement on any status >= 400, so a
        // 409 here would let the caller replay the same payment header
        // forever. The outcome is machine-readable in `status` instead.
        return Response.json({
          status: "conflict",
          action_key: body.action_key,
          claimed_at: existing.claimed_at,
          expires_at: existing.expires_at,
          ...ownership,
        });
      }

      if (existing.state === "completed") {
        return Response.json({
          status: "duplicate",
          action_key: body.action_key,
          claimed_at: existing.claimed_at,
          completed_at: existing.completed_at ?? null,
          expires_at: existing.expires_at,
          ...OnceKey.resultFields(existing.result),
          ...ownership,
        });
      }

      // An unleased claim is terminal until its ttl: there is no basis on
      // which to decide the original claimant is gone, so it stays held.
      //
      // This is deliberately NOT "duplicate". The work has not completed and
      // there is no result to hand back, so calling it a duplicate would tell
      // the caller the action already succeeded when it may still be running
      // or may have died half way through. A caller that skips its side
      // effect on that basis silently loses the work. "held" says only what
      // is actually known: someone else owns this key, nothing has completed,
      // and nothing will free it before expires_at.
      const leaseExp = existing.lease_expires_at as string | null;
      if (!leaseExp) {
        return Response.json({
          status: "held",
          action_key: body.action_key,
          claimed_at: existing.claimed_at,
          expires_at: existing.expires_at,
          retry_after: Math.max(
            1,
            Math.ceil(
              (Date.parse(existing.expires_at as string) - now.getTime()) /
                1000,
            ),
          ),
          ...ownership,
        });
      }

      // Still held by a live claimant: report it rather than allowing a
      // second agent to start the same side effect concurrently.
      if (leaseExp > now.toISOString()) {
        return Response.json({
          status: "in_progress",
          action_key: body.action_key,
          claimed_at: existing.claimed_at,
          lease_expires_at: leaseExp,
          retry_after: Math.max(
            1,
            Math.ceil((Date.parse(leaseExp) - now.getTime()) / 1000),
          ),
          ...ownership,
        });
      }

      // Lease lapsed — the previous claimant is presumed dead. Take it over,
      // preserving the original absolute expiry so a crash loop cannot
      // extend an action_key's lifetime indefinitely.
      this.ctx.storage.sql.exec(
        `UPDATE claims SET claimed_at = ?, lease_expires_at = ?, payload_sha = ?
         WHERE action_key = ?`,
        now.toISOString(),
        leaseExpiresAt ? leaseExpiresAt.toISOString() : null,
        body.payload_sha256 ?? existing.payload_sha ?? null,
        body.action_key,
      );

      return Response.json({
        status: "claimed",
        recovered: true,
        action_key: body.action_key,
        claimed_at: now.toISOString(),
        ...(leaseExpiresAt
          ? { lease_expires_at: leaseExpiresAt.toISOString() }
          : {}),
        expires_at: existing.expires_at,
        ...ownership,
      });
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO claims
         (action_key, payload_sha, claimed_at, expires_at, state, lease_expires_at)
       VALUES (?, ?, ?, ?, 'claimed', ?)`,
      body.action_key,
      body.payload_sha256 ?? null,
      now.toISOString(),
      expiresAt.toISOString(),
      leaseExpiresAt ? leaseExpiresAt.toISOString() : null,
    );

    return Response.json({
      status: "claimed",
      action_key: body.action_key,
      claimed_at: now.toISOString(),
      ...(leaseExpiresAt
        ? { lease_expires_at: leaseExpiresAt.toISOString() }
        : {}),
      expires_at: expiresAt.toISOString(),
      ...ownership,
    });
  }

  private handleComplete(
    body: { action_key: string; result?: unknown },
    now: Date,
    ttlValue: number | null | undefined,
    ownership: Record<string, unknown>,
  ): Response {
    const existing = this.row(body.action_key);
    if (!existing) {
      return Response.json(
        {
          error:
            "No live claim for this action_key. It was never claimed, was released, or its ttl elapsed.",
        },
        { status: 404 },
      );
    }

    // Completing twice is not an error — a retry that lost the response to a
    // network failure must be able to converge on the same answer.
    if (existing.state === "completed") {
      return Response.json({
        status: "already_completed",
        action_key: body.action_key,
        completed_at: existing.completed_at ?? null,
        expires_at: existing.expires_at,
        ...OnceKey.resultFields(existing.result),
        ...ownership,
      });
    }

    const serialized =
      body.result === undefined ? null : JSON.stringify(body.result);
    if (serialized !== null && serialized.length > MAX_RESULT_BYTES) {
      return Response.json(
        {
          error: `result exceeds the ${MAX_RESULT_BYTES} byte limit`,
          detail:
            "Store the payload elsewhere and record a reference to it instead.",
        },
        { status: 413 },
      );
    }

    // Completion restarts the retention clock: the value of a stored result
    // begins when it exists, not when the work started.
    const expiresAt = new Date(
      now.getTime() + (ttlValue ?? DEFAULT_TTL_SECONDS) * 1000,
    );

    this.ctx.storage.sql.exec(
      `UPDATE claims
         SET state = 'completed', result = ?, completed_at = ?,
             lease_expires_at = NULL, expires_at = ?
       WHERE action_key = ?`,
      serialized,
      now.toISOString(),
      expiresAt.toISOString(),
      body.action_key,
    );

    return Response.json({
      status: "completed",
      action_key: body.action_key,
      completed_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      ...OnceKey.resultFields(serialized),
      ...ownership,
    });
  }

  private handleRelease(
    body: { action_key: string },
    ownership: Record<string, unknown>,
  ): Response {
    const existing = this.row(body.action_key);
    if (!existing) {
      return Response.json(
        { error: "No live claim for this action_key." },
        { status: 404 },
      );
    }

    // Releasing a completed key would discard the recorded result and let the
    // side effect run a second time — the exact outcome this service sells
    // protection against.
    if (existing.state === "completed") {
      return Response.json(
        {
          error: "Cannot release a completed action_key.",
          detail:
            "Completion is final. Use a new action_key to perform the work again.",
        },
        { status: 409 },
      );
    }

    this.ctx.storage.sql.exec(
      `DELETE FROM claims WHERE action_key = ?`,
      body.action_key,
    );

    return Response.json({
      status: "released",
      action_key: body.action_key,
      ...ownership,
    });
  }
}
