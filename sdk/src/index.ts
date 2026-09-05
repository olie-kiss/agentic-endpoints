/**
 * Client for agentic-endpoints.
 *
 * The reason this package exists is `exactlyOnce`. Everything else here is
 * a thin wrapper over fetch that you could write yourself in ten minutes.
 *
 * Payment is deliberately NOT handled in this library. Signing an x402
 * payment needs a wallet, and a package that quietly wants your private key
 * is a package nobody should install. Instead you pass either a prepaid
 * `creditToken`, or your own `fetch` — an x402-aware one such as the wrapper
 * from `x402-fetch` — and this library stays a protocol client with no
 * access to your funds.
 */

export type ClaimStatus =
  | "claimed"
  | "duplicate"
  | "held"
  | "in_progress"
  | "conflict"
  | "forbidden";

export interface ClientOptions {
  /** Defaults to the public deployment. */
  baseUrl?: string;
  /** Prepaid balance token, sent as X-Credit-Token. */
  creditToken?: string;
  /**
   * Used for every request. Supply an x402-aware fetch to pay per call;
   * the default global fetch can only reach the free endpoints and any
   * endpoint covered by a credit token.
   */
  fetch?: typeof fetch;
}

export class PaymentRequiredError extends Error {
  readonly challenge: string | null;
  constructor(path: string, challenge: string | null) {
    super(
      `${path} requires payment and no payment was made. Pass a creditToken, ` +
        "or an x402-aware fetch, when constructing the client.",
    );
    this.name = "PaymentRequiredError";
    this.challenge = challenge;
  }
}

/**
 * The same action_key was already used with a different payload.
 *
 * This is never retryable and must not be swallowed: it means the caller's
 * key derivation does not actually identify the action, so the protection
 * the key was supposed to provide is not in place.
 */
export class ConflictError extends Error {
  constructor(readonly actionKey: string) {
    super(
      `action_key "${actionKey}" was already claimed with a different ` +
        "payload hash. Your key derivation does not uniquely identify this " +
        "action; do not retry.",
    );
    this.name = "ConflictError";
  }
}

/** Another agent holds a live lease and the caller asked not to wait. */
export class InProgressError extends Error {
  constructor(
    readonly actionKey: string,
    readonly retryAfter: number,
  ) {
    super(
      `action_key "${actionKey}" is being worked on by another caller. ` +
        `Retry in ${retryAfter}s. Do not perform the work.`,
    );
    this.name = "InProgressError";
  }
}

/**
 * The key is claimed by someone who set no lease and never completed.
 *
 * This is deliberately an error and not a successful "replayed" result. The
 * side effect may still be running, or the caller that held the key may have
 * died part way through it. Nobody can tell which, and there is no result to
 * return. Reporting it as success would let you skip a charge that never
 * actually happened.
 *
 * Nothing will free the key before `expiresAt`. Recovering from this needs a
 * decision only you can make: wait, alert a human, or use a `leaseTtl` on
 * future calls so a dead claimant can be taken over automatically.
 */
export class HeldError extends Error {
  constructor(
    readonly actionKey: string,
    readonly expiresAt?: string,
  ) {
    super(
      `action_key "${actionKey}" is held by another caller that set no ` +
        "lease and has not recorded a result. The work may be in flight or " +
        "may have been abandoned; this is not a completed action and must " +
        "not be treated as one. The key stays locked until " +
        `${expiresAt ?? "its ttl expires"}. Set leaseTtl if this work is ` +
        "safe to retry after a crash.",
    );
    this.name = "HeldError";
  }
}

/**
 * Our lease lapsed, another caller took the key over, and the side effect ran
 * twice.
 *
 * Only reachable when `leaseTtl` is set and the work outlives it. The take-over
 * is deliberate — a lease exists so a crashed claimant cannot block a key
 * forever — but a claimant that was merely slow rather than dead gets taken
 * over just the same, and by the time it finds out its side effect has already
 * happened a second time.
 *
 * `yourResult` is what your own work returned; `recordedResult` is what the
 * other caller stored and what every future replayer will receive. Neither is
 * discarded here, because recovering from a double execution needs both.
 *
 * If this fires, raise `leaseTtl` above your worst-case runtime, or drop it so
 * the key is never reclaimable.
 */
/**
 * The namespace exists and your `namespaceToken` does not open it.
 *
 * Carried as a 200 with `status: "forbidden"` rather than a 403, because any
 * status >=400 cancels x402 settlement and would make namespace probing free.
 * That makes it indistinguishable from success at the HTTP layer, so it is
 * raised here — treating it as a successful claim would run the very side
 * effect the token was meant to gate.
 */
export class UnauthorizedError extends Error {
  constructor(public readonly namespace: string) {
    super(
      `namespace "${namespace}" is already claimed and the namespaceToken ` +
        "you supplied does not match it. The work was NOT run. Supply the " +
        "token issued when the namespace was first claimed, or pick a " +
        "different namespace.",
    );
    this.name = "UnauthorizedError";
  }
}

export class LeaseLostError<T = unknown> extends Error {
  constructor(
    readonly actionKey: string,
    readonly yourResult: T,
    readonly recordedResult: unknown,
    readonly hasRecordedResult: boolean,
  ) {
    super(
      `action_key "${actionKey}" was completed by another caller while your ` +
        "work was still running, so your lease had lapsed and the side " +
        "effect has now run twice. The stored result is theirs, not yours. " +
        "Increase leaseTtl beyond your worst-case runtime, or omit it so the " +
        "key can never be taken over.",
    );
    this.name = "LeaseLostError";
  }
}

/**
 * The action completed, but its stored result cannot be read back.
 *
 * Do NOT re-run the work: it definitely happened. What is lost is the record
 * of what it produced, which is a different failure from never having run and
 * needs a human rather than a retry.
 */
export class ResultUnavailableError extends Error {
  constructor(
    readonly actionKey: string,
    readonly detail: string,
  ) {
    super(
      `action_key "${actionKey}" completed, but its recorded result could ` +
        `not be read back (${detail}). The work has already happened — do ` +
        "not repeat it. The stored outcome is lost and needs manual recovery.",
    );
    this.name = "ResultUnavailableError";
  }
}

export interface ExactlyOnceOptions {
  namespace: string;
  actionKey: string;
  /** Required on every call after the first one in a namespace. */
  namespaceToken?: string;
  /** Hash of the action's inputs, so a mismatched reuse is caught. */
  payloadSha256?: string;
  /** How long the claim and its result are retained. Seconds. */
  ttl?: number;
  /**
   * Seconds before an unfinished claim may be taken over by another caller.
   *
   * Set this only if your work is safe to run again after a crash. Leaving
   * it unset means nothing can ever run the side effect twice, at the cost
   * of a key that stays held until its ttl if you die holding it.
   */
  leaseTtl?: number;
  /**
   * How many times to wait out another caller's lease before giving up.
   *
   * Defaults to 0, i.e. throw InProgressError immediately. Each retry is a
   * fresh paid claim, so waiting is not free and is not enabled for you.
   */
  waitAttempts?: number;
}

export interface ExactlyOnceResult<T> {
  /** "performed" — you did the work. "replayed" — someone already had. */
  outcome: "performed" | "replayed";
  result: T;
  /**
   * False when the action completed but no result was ever recorded, so
   * `result` is null because there is nothing to replay — not because the
   * work returned null. Check this before acting on a replayed value.
   */
  hasResult: boolean;
  /** Returned only on the very first call in a namespace. Store it. */
  namespaceToken?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AgenticEndpoints {
  private readonly baseUrl: string;
  private readonly creditToken?: string;
  private readonly doFetch: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://ai.oliverkiss.com").replace(
      /\/+$/,
      "",
    );
    this.creditToken = options.creditToken;
    this.doFetch = options.fetch ?? globalThis.fetch;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.creditToken) headers["X-Credit-Token"] = this.creditToken;

    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (res.status === 402) {
      // Under x402 v2 the 402 body is legitimately empty and the challenge
      // travels in this header. Reading only the body makes a working
      // payment flow look like a broken server.
      throw new PaymentRequiredError(path, res.headers.get("payment-required"));
    }

    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        `${path} failed with ${res.status}: ${json.error ?? "unknown error"}`,
      );
    }
    return json as T;
  }

  /** Current reliability figures, so you can decide whether to depend on this. */
  async status(): Promise<Record<string, unknown>> {
    const res = await this.doFetch(`${this.baseUrl}/status`);
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Runs `work` at most once across every agent sharing the namespace.
   *
   * This is the whole point of the service. Doing it by hand means getting
   * four branches right — won, lost, in flight, mismatched — and remembering
   * to record the result and to release on failure. Getting any of them
   * wrong reintroduces exactly the duplicate side effect you were paying to
   * prevent, so it is written once, here.
   *
   * On success the return value of `work` is stored, and every later caller
   * receives it as `{ outcome: "replayed" }` instead of running `work` again.
   * If `work` throws, the claim is released so a retry can start at once,
   * and the error is rethrown untouched.
   */
  async exactlyOnce<T>(
    options: ExactlyOnceOptions,
    work: () => Promise<T>,
  ): Promise<ExactlyOnceResult<T>> {
    const {
      namespace,
      actionKey,
      payloadSha256,
      ttl,
      leaseTtl,
      waitAttempts = 0,
    } = options;

    let namespaceToken = options.namespaceToken;
    let issuedToken: string | undefined;

    for (let attempt = 0; ; attempt++) {
      const claim = await this.post<{
        status: ClaimStatus;
        result?: T;
        has_result?: boolean;
        result_error?: string;
        retry_after?: number;
        expires_at?: string;
        namespace_token?: string;
      }>("/once-key", {
        namespace,
        action_key: actionKey,
        namespace_token: namespaceToken,
        payload_sha256: payloadSha256,
        ttl,
        lease_ttl: leaseTtl,
      });

      // The token is shown exactly once, on the first call that touches a
      // namespace. Losing it locks the namespace permanently, so capture it
      // before anything below has a chance to throw.
      if (claim.namespace_token) {
        issuedToken = claim.namespace_token;
        namespaceToken ??= claim.namespace_token;
      }

      if (claim.status === "conflict") throw new ConflictError(actionKey);

      if (claim.status === "forbidden") {
        throw new UnauthorizedError(namespace);
      }

      if (claim.status === "held") {
        throw new HeldError(actionKey, claim.expires_at);
      }

      if (claim.status === "duplicate") {
        // `has_result` distinguishes "completed, but the caller recorded no
        // result" from "the result field is missing entirely". The first is a
        // legitimate outcome for work that returns nothing; the second means
        // the server is inconsistent and nobody can say what happened.
        //
        // Returning `undefined` for either would tell the caller the action
        // already succeeded while handing them nothing to act on, which is how
        // a skipped side effect turns into silent data loss.
        if (!("result" in claim)) {
          throw new HeldError(actionKey, claim.expires_at);
        }
        // The stored result exists but could not be decoded. That is not an
        // empty result and must not be replayed as one: the work definitely
        // ran, so re-running it would double the side effect, while treating
        // null as its outcome would silently corrupt whatever comes next.
        if (claim.result_error) {
          throw new ResultUnavailableError(actionKey, claim.result_error);
        }
        return {
          outcome: "replayed",
          result: claim.result as T,
          hasResult: claim.has_result !== false,
          namespaceToken: issuedToken,
        };
      }

      if (claim.status === "in_progress") {
        const retryAfter = claim.retry_after ?? 1;
        if (attempt >= waitAttempts) {
          throw new InProgressError(actionKey, retryAfter);
        }
        await sleep(retryAfter * 1000);
        continue;
      }

      // Every other status is handled above, so this must be "claimed" — we
      // own the key. Check it rather than falling through: an unrecognised
      // status reaching here would run `work()` while believing it holds a
      // claim it does not, which is precisely the duplicate side effect this
      // method exists to prevent. Refusing an unknown status is always safe;
      // guessing never is.
      if (claim.status !== "claimed") {
        throw new Error(
          `/once-key returned unrecognised status "${claim.status}" for ` +
            `action_key "${actionKey}". Refusing to run the work, because ` +
            "this client cannot tell whether the claim was granted. Upgrade " +
            "agentic-endpoints to a version that understands this status.",
        );
      }

      // We own it.
      let value: T;
      try {
        value = await work();
      } catch (err) {
        // Best effort. If the release fails the lease still expires, so a
        // failure here delays a retry rather than losing the key — and
        // masking the original error with this one would hide the real
        // cause of the failure.
        try {
          await this.post("/once-key/release", {
            namespace,
            action_key: actionKey,
            namespace_token: namespaceToken,
          });
        } catch {
          /* deliberately ignored */
        }
        throw err;
      }

      const completion = await this.post<{
        status?: string;
        result?: T;
        has_result?: boolean;
      }>("/once-key/complete", {
        namespace,
        action_key: actionKey,
        namespace_token: namespaceToken,
        result: value,
        ttl,
      });

      // Someone else completed this key while we were working on it. That can
      // only happen when a leaseTtl was set and the work outran it: another
      // caller took the claim over, ran the same side effect, and recorded
      // their outcome. Our work has therefore already run a second time, and
      // the stored result is theirs, not ours.
      //
      // Returning outcome "performed" here would assert both that the action
      // ran exactly once and that our value is canonical, and neither is true.
      // This response is the only signal a caller ever gets that a take-over
      // collided with it, so it must not be discarded.
      if (completion.status === "already_completed") {
        throw new LeaseLostError(
          actionKey,
          value,
          completion.result,
          completion.has_result !== false,
        );
      }

      return {
        outcome: "performed",
        result: value,
        hasResult: value !== undefined,
        namespaceToken: issuedToken,
      };
    }
  }
}
