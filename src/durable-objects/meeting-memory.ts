import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import {
  generateToken,
  hashToken,
  newNamespaceError,
  timingSafeEqual,
} from "../lib/utils";

/**
 * MeetingMemory — searchable meeting transcripts, addressable by an agent.
 *
 * Meeting notetakers keep transcripts inside their own app, where the only
 * reader is a human scrolling a sidebar. This stores them somewhere an agent
 * can ask questions of them, which is the part nobody else exposes.
 *
 * Each {namespace} is one Durable Object owned by whoever first imports into
 * it, using the same one-time token as Vault: namespaces are caller-supplied
 * strings, so without ownership any anonymous caller could read another
 * tenant's meetings.
 *
 * PRIVACY MODEL — the important part
 * ----------------------------------
 * A transcript is the most sensitive text most people own. There are only two
 * honest positions, and this object makes the caller choose one per meeting:
 *
 *   private   — you send `ciphertext` you encrypted yourself. Stored as-is.
 *               We hold no key. Not searchable, not summarisable, because
 *               there is nothing here to search. This is the default.
 *
 *   queryable — you send plaintext `transcript`. It is indexed for full-text
 *               search so your agents can answer questions across meetings.
 *               We can read it. So could anyone who compels us.
 *
 * The choice is REQUIRED and explicit. Sending plaintext without asking for
 * `queryable` is refused rather than quietly indexed, and sending ciphertext
 * while asking for `queryable` is refused rather than quietly indexing bytes
 * that will never match anything. Both refusals exist because the failure
 * they prevent -- a transcript readable server-side by a caller who believed
 * it was not -- is silent, permanent, and discovered far too late.
 *
 * A queryable transcript is stored ONLY in the FTS index and a private one
 * ONLY in `meetings.body`, so no transcript is ever held twice.
 */

/** Quotas. Storage is charged per import, but one import is cheap and a
 *  transcript is not, so a ceiling is still needed. */
const MAX_TRANSCRIPT_BYTES = 1024 * 1024; // 1 MiB per meeting
const MAX_TITLE_LENGTH = 512;
const MAX_MEETINGS_PER_NAMESPACE = 2000;
const MAX_NAMESPACE_BYTES = 100 * 1024 * 1024; // 100 MiB per namespace
const MAX_SEARCH_RESULTS = 50;

type Visibility = "private" | "queryable";

export class MeetingMemory extends DurableObject<Env> {
  private initialized = false;

  private ensureTable() {
    if (this.initialized) return;

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL DEFAULT '',
        occurred_at  TEXT,
        source       TEXT,
        visibility   TEXT NOT NULL,
        participants TEXT NOT NULL DEFAULT '[]',
        body         TEXT,
        alg          TEXT,
        size_bytes   INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL
      )
    `);

    // Standalone FTS5 rather than an external-content table. External content
    // needs the base table and the index kept in step by hand, and a desynced
    // index fails by silently returning fewer results -- the worst possible
    // failure for a search tool, because it looks like an answer.
    //
    // The transcript of a queryable meeting lives here and nowhere else, so
    // this costs no duplicate storage.
    this.ctx.storage.sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(
        meeting_id UNINDEXED,
        title,
        transcript
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

  private async isOwner(token: string | undefined): Promise<boolean> {
    const ownerHash = this.getOwnerHash();
    if (ownerHash === null || !token) return false;
    return timingSafeEqual(await hashToken(token), ownerHash);
  }

  private hasMeetings(): boolean {
    return (
      this.ctx.storage.sql
        .exec(`SELECT 1 FROM meetings LIMIT 1`)
        .toArray().length > 0
    );
  }

  /**
   * 200, not 403. Any status >=400 cancels x402 settlement and leaves the
   * payment header replayable, which would turn this into a free oracle for
   * which namespaces exist. Charging is what makes guessing expensive.
   */
  private forbidden(): Response {
    return Response.json({
      status: "forbidden",
      error: "Invalid or missing namespace_token for this namespace",
    });
  }

  private usage(): { count: number; bytes: number } {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
         FROM meetings`,
      )
      .toArray();
    return {
      count: Number(rows[0]?.count ?? 0),
      bytes: Number(rows[0]?.bytes ?? 0),
    };
  }

  private transcriptOf(meetingId: string): string | null {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT transcript FROM meetings_fts WHERE meeting_id = ?`,
        meetingId,
      )
      .toArray();
    return rows.length > 0 ? String(rows[0].transcript) : null;
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureTable();
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/import":
        return this.handleImport(request);
      case "/search":
        return this.handleSearch(request);
      case "/get":
        return this.handleGet(request);
      case "/list":
        return this.handleList(request);
      case "/delete":
        return this.handleDelete(request);
      default:
        return Response.json({ error: "Not found" }, { status: 404 });
    }
  }

  private async handleImport(request: Request): Promise<Response> {
    const body = await request.json<{
      namespace?: string;
      namespace_token?: string;
      title?: string;
      occurred_at?: string;
      source?: string;
      participants?: string[];
      visibility?: string;
      transcript?: string;
      ciphertext?: string;
      alg?: string;
    }>();

    const visibility = body.visibility ?? "private";
    if (visibility !== "private" && visibility !== "queryable") {
      return Response.json(
        {
          error: 'visibility must be "private" or "queryable"',
          detail:
            'private stores ciphertext you encrypted and cannot be searched. ' +
            "queryable stores plaintext this service can read and index.",
        },
        { status: 400 },
      );
    }

    // Refuse the mismatches rather than resolving them. Guessing here means
    // either indexing a transcript the caller thought was encrypted, or
    // accepting one that can never match a search -- both silent.
    if (visibility === "queryable" && body.ciphertext !== undefined) {
      return Response.json(
        {
          error: "queryable meetings need `transcript`, not `ciphertext`",
          detail:
            "Ciphertext cannot be indexed, so this meeting would be stored " +
            "but never appear in a search. Send plaintext to make it " +
            'searchable, or use visibility "private".',
        },
        { status: 400 },
      );
    }
    if (visibility === "private" && body.transcript !== undefined) {
      return Response.json(
        {
          error: "private meetings need `ciphertext`, not `transcript`",
          detail:
            "Refusing to store a plaintext transcript under a mode that " +
            "promises this service cannot read it. Encrypt it client-side, " +
            'or ask for visibility "queryable" to opt in explicitly.',
        },
        { status: 400 },
      );
    }

    const content =
      visibility === "queryable" ? body.transcript : body.ciphertext;
    if (!content) {
      return Response.json(
        {
          error:
            visibility === "queryable"
              ? "transcript is required"
              : "ciphertext is required",
        },
        { status: 400 },
      );
    }

    const bytes = new TextEncoder().encode(content).length;
    if (bytes > MAX_TRANSCRIPT_BYTES) {
      return Response.json(
        {
          error: "Transcript too large",
          detail: `${bytes} bytes exceeds the ${MAX_TRANSCRIPT_BYTES} byte limit. Split long meetings.`,
        },
        { status: 413 },
      );
    }
    const title = (body.title ?? "").slice(0, MAX_TITLE_LENGTH);

    // Ownership. The token is always minted here and never taken from the
    // request: a caller-chosen token could be low-entropy, or could pre-claim
    // a namespace someone else is about to use, with no recovery path.
    let issuedToken: string | undefined;
    if (this.getOwnerHash() === null) {
      if (this.hasMeetings()) return this.forbidden();

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

      // The await above yields, so two concurrent first-imports can both see
      // an unclaimed namespace. Insert defensively, then re-read to find out
      // who actually won.
      this.ctx.storage.sql.exec(
        `INSERT INTO namespace_meta (id, token_hash, claimed_at)
         VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING`,
        hash,
        new Date().toISOString(),
      );

      if (this.getOwnerHash() === hash) {
        issuedToken = token;
      } else {
        return this.forbidden();
      }
    } else if (!(await this.isOwner(body.namespace_token))) {
      return this.forbidden();
    }

    const used = this.usage();
    if (used.count >= MAX_MEETINGS_PER_NAMESPACE) {
      return Response.json({
        status: "quota_exceeded",
        detail: `This namespace already holds ${used.count} meetings (limit ${MAX_MEETINGS_PER_NAMESPACE}). Delete some first.`,
        ...(issuedToken ? { namespace_token: issuedToken } : {}),
      });
    }
    if (used.bytes + bytes > MAX_NAMESPACE_BYTES) {
      return Response.json({
        status: "quota_exceeded",
        detail: `This meeting would put the namespace over its ${MAX_NAMESPACE_BYTES} byte limit.`,
        ...(issuedToken ? { namespace_token: issuedToken } : {}),
      });
    }

    const meetingId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    this.ctx.storage.sql.exec(
      `INSERT INTO meetings
         (id, title, occurred_at, source, visibility, participants, body, alg, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      meetingId,
      title,
      body.occurred_at ?? null,
      body.source ?? null,
      visibility,
      JSON.stringify(body.participants ?? []),
      visibility === "private" ? content : null,
      visibility === "private" ? (body.alg ?? "aes-256-gcm") : null,
      bytes,
      createdAt,
    );

    if (visibility === "queryable") {
      this.ctx.storage.sql.exec(
        `INSERT INTO meetings_fts (meeting_id, title, transcript) VALUES (?, ?, ?)`,
        meetingId,
        title,
        content,
      );
    }

    return Response.json({
      status: "imported",
      meeting_id: meetingId,
      visibility,
      title,
      occurred_at: body.occurred_at ?? null,
      source: body.source ?? null,
      size_bytes: bytes,
      created_at: createdAt,
      searchable: visibility === "queryable",
      ...(issuedToken
        ? {
            namespace_token: issuedToken,
            notice:
              "Save this namespace_token — it is shown only once and is required for all future operations on this namespace.",
          }
        : {}),
    });
  }

  private async handleSearch(request: Request): Promise<Response> {
    const body = await request.json<{
      namespace_token?: string;
      query?: string;
      limit?: number;
    }>();

    if (!(await this.isOwner(body.namespace_token))) return this.forbidden();

    const query = (body.query ?? "").trim();
    if (!query) {
      return Response.json({ error: "query is required" }, { status: 400 });
    }

    const limit = Math.min(
      Math.max(Number(body.limit) || 10, 1),
      MAX_SEARCH_RESULTS,
    );

    const totals = this.ctx.storage.sql
      .exec(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(visibility = 'queryable'), 0) AS searchable
         FROM meetings`,
      )
      .toArray()[0];
    const searchable = Number(totals?.searchable ?? 0);
    const total = Number(totals?.total ?? 0);

    let rows: Record<string, unknown>[] = [];
    let queryError: string | undefined;
    try {
      // FTS5 match syntax is caller-supplied, so a stray quote or a bare
      // operator is a user error, not a server fault. Reporting it is the
      // point: a swallowed parse error looks exactly like "no results",
      // which would have the caller conclude the meeting is not there.
      rows = this.ctx.storage.sql
        .exec(
          `SELECT meeting_id,
                  snippet(meetings_fts, 2, '[', ']', '…', 24) AS excerpt,
                  rank
           FROM meetings_fts
           WHERE meetings_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
          query,
          limit,
        )
        .toArray() as Record<string, unknown>[];
    } catch (err) {
      queryError = err instanceof Error ? err.message : String(err);
    }

    if (queryError !== undefined) {
      return Response.json({
        status: "invalid_query",
        query,
        detail:
          "That is not valid FTS5 match syntax, so nothing was searched. " +
          "This is NOT the same as finding no matches. Quote phrases like " +
          '"budget review", and escape or remove stray operators.',
        error: queryError,
      });
    }

    const matches = rows.map((row) => {
      const meta = this.ctx.storage.sql
        .exec(
          `SELECT title, occurred_at, source, participants
           FROM meetings WHERE id = ?`,
          String(row.meeting_id),
        )
        .toArray()[0];
      return {
        meeting_id: String(row.meeting_id),
        title: String(meta?.title ?? ""),
        occurred_at: (meta?.occurred_at as string) ?? null,
        source: (meta?.source as string) ?? null,
        participants: JSON.parse(String(meta?.participants ?? "[]")),
        excerpt: String(row.excerpt ?? ""),
      };
    });

    return Response.json({
      status: "ok",
      query,
      matches,
      count: matches.length,
      // Without this a caller cannot tell "no meeting mentions this" from
      // "every meeting here is encrypted, so nothing was ever searched".
      searched_meetings: searchable,
      private_meetings_skipped: total - searchable,
      ...(searchable === 0 && total > 0
        ? {
            notice:
              "No meetings in this namespace are searchable. They were all " +
              'imported as "private", which this service cannot read. ' +
              'Re-import with visibility "queryable" to search them.',
          }
        : {}),
    });
  }

  private async handleGet(request: Request): Promise<Response> {
    const body = await request.json<{
      namespace_token?: string;
      meeting_id?: string;
    }>();

    if (!(await this.isOwner(body.namespace_token))) return this.forbidden();
    if (!body.meeting_id) {
      return Response.json({ error: "meeting_id is required" }, { status: 400 });
    }

    const row = this.ctx.storage.sql
      .exec(`SELECT * FROM meetings WHERE id = ?`, body.meeting_id)
      .toArray()[0];

    // 200, not 404: the caller paid and looking is the work.
    if (!row) {
      return Response.json({ status: "not_found", meeting_id: body.meeting_id });
    }

    const visibility = String(row.visibility) as Visibility;
    const content =
      visibility === "private"
        ? (row.body as string | null)
        : this.transcriptOf(body.meeting_id);

    // A meeting recorded in `meetings` with no content anywhere is a broken
    // record, not an empty transcript. Saying so is the difference between a
    // caller retrying and a caller concluding the meeting was blank.
    if (content === null) {
      return Response.json({
        status: "content_missing",
        meeting_id: body.meeting_id,
        visibility,
        detail:
          "This meeting exists but its stored content could not be found. " +
          "It has NOT been returned empty, because an empty transcript and a " +
          "lost one are different facts. Re-import it.",
      });
    }

    return Response.json({
      status: "ok",
      meeting_id: body.meeting_id,
      title: row.title,
      occurred_at: row.occurred_at ?? null,
      source: row.source ?? null,
      visibility,
      participants: JSON.parse(String(row.participants ?? "[]")),
      size_bytes: Number(row.size_bytes ?? 0),
      created_at: row.created_at,
      ...(visibility === "private"
        ? { ciphertext: content, alg: row.alg ?? "aes-256-gcm" }
        : { transcript: content }),
    });
  }

  private async handleList(request: Request): Promise<Response> {
    const body = await request.json<{
      namespace_token?: string;
      limit?: number;
    }>();

    if (!(await this.isOwner(body.namespace_token))) return this.forbidden();

    const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500);
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, title, occurred_at, source, visibility, participants,
                size_bytes, created_at
         FROM meetings
         ORDER BY COALESCE(occurred_at, created_at) DESC
         LIMIT ?`,
        limit,
      )
      .toArray();

    const used = this.usage();
    return Response.json({
      status: "ok",
      meetings: rows.map((r) => ({
        meeting_id: r.id,
        title: r.title,
        occurred_at: r.occurred_at ?? null,
        source: r.source ?? null,
        visibility: r.visibility,
        searchable: r.visibility === "queryable",
        participants: JSON.parse(String(r.participants ?? "[]")),
        size_bytes: Number(r.size_bytes ?? 0),
        created_at: r.created_at,
      })),
      count: rows.length,
      usage: {
        meetings: used.count,
        bytes: used.bytes,
        max_meetings: MAX_MEETINGS_PER_NAMESPACE,
        max_bytes: MAX_NAMESPACE_BYTES,
      },
    });
  }

  private async handleDelete(request: Request): Promise<Response> {
    const body = await request.json<{
      namespace_token?: string;
      meeting_id?: string;
    }>();

    if (!(await this.isOwner(body.namespace_token))) return this.forbidden();
    if (!body.meeting_id) {
      return Response.json({ error: "meeting_id is required" }, { status: 400 });
    }

    const existed =
      this.ctx.storage.sql
        .exec(`SELECT 1 FROM meetings WHERE id = ?`, body.meeting_id)
        .toArray().length > 0;

    // Both tables, always. Leaving an orphaned FTS row would keep a deleted
    // transcript searchable -- a deletion that reports success while the
    // content is still readable is the worst kind of quiet failure.
    this.ctx.storage.sql.exec(
      `DELETE FROM meetings WHERE id = ?`,
      body.meeting_id,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM meetings_fts WHERE meeting_id = ?`,
      body.meeting_id,
    );

    const leftover = this.transcriptOf(body.meeting_id);
    if (leftover !== null) {
      throw new Error(
        `meeting ${body.meeting_id} was deleted but its transcript is still ` +
          "in the search index and would keep appearing in results",
      );
    }

    return Response.json({
      status: existed ? "deleted" : "not_found",
      meeting_id: body.meeting_id,
    });
  }
}
