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
  | "conflict";

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

      if (claim.status === "held") {
        throw new HeldError(actionKey, claim.expires_at);
      }

      if (claim.status === "duplicate") {
        // A duplicate is only meaningful if it carries the original outcome.
        // Returning `undefined` here would tell the caller the action already
        // succeeded while handing them nothing to act on, which is how a
        // skipped side effect turns into silent data loss. Fail loudly
        // instead: this can only happen against a server that recorded a
        // completion without a result, or an older one that used "duplicate"
        // for a claim that had not finished.
        if (!("result" in claim)) {
          throw new HeldError(actionKey, claim.expires_at);
        }
        return {
          outcome: "replayed",
          result: claim.result as T,
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

      // status === "claimed": we own it.
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

      await this.post("/once-key/complete", {
        namespace,
        action_key: actionKey,
        namespace_token: namespaceToken,
        result: value,
        ttl,
      });

      return { outcome: "performed", result: value, namespaceToken: issuedToken };
    }
  }
}
