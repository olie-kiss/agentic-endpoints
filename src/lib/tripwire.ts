/**
 * Buyer detection.
 *
 * The service receives thousands of requests a day and, so far, no revenue.
 * Almost all of that traffic is directory crawlers, liveness probes and trust
 * scanners, which are indistinguishable from a customer in an access log. The
 * risk this module addresses is not abuse: it is that the first genuine buyer
 * arrives, is refused for a reason we could have fixed, and leaves without
 * ever appearing as a distinguishable line in the logs.
 *
 * Detection keys on behaviour rather than identity. A monitor never carries a
 * payment authorization; anything that does is trying to buy. User-Agent is
 * used only to suppress known-noise callers, never to grant anything, because
 * it is attacker-controlled and trivially forged.
 */

/**
 * Callers we have observed and expect: uptime monitors, trust scorers and
 * index crawlers. Matching is a noise filter, not a security boundary -- a
 * forged User-Agent here buys nothing but a quieter log line.
 */
const MONITOR_PATTERNS: readonly RegExp[] = [
  /bot\b/i,
  /crawler/i,
  /spider/i,
  /monitor/i,
  /\bprobe\b/i,
  /scan/i,
  /uptime/i,
  /liveness/i,
  /checker/i,
  /registry/i,
  /observer/i,
  /oracle/i,
  /mcpbeat/i,
  /\+https?:\/\//i,
];

export type CallerClass = "monitor" | "unclassified";

/**
 * Deliberately coarse. The SDK runs on Node and inherits an undici or `node`
 * User-Agent, which is exactly what an anonymous script sends too, so there is
 * no string that positively identifies a customer. Everything that is not
 * recognisable noise is therefore "unclassified" rather than "buyer".
 */
export function classifyCaller(userAgent: string | null): CallerClass {
  if (!userAgent) return "unclassified";
  return MONITOR_PATTERNS.some((re) => re.test(userAgent)) ? "monitor" : "unclassified";
}

export type BuyerSignal =
  /** Carried a payment authorization. Someone tried to spend real money. */
  | "payment_attempt"
  /** Spent prepaid credit. An existing customer, mid-transaction. */
  | "credit_use"
  /** Hit a priced route with no means of paying, and is not known noise. */
  | "prospect_402";

export interface SignalContext {
  path: string;
  method: string;
  userAgent: string | null;
  country: string | null;
}

/**
 * Ranked so a log search can start at the top and stop as soon as it finds
 * something. `payment_attempt` and `credit_use` are near-certain; the ranking
 * exists because `prospect_402` is a guess and should never be read as a sale.
 */
export const SIGNAL_CONFIDENCE: Record<BuyerSignal, "high" | "low"> = {
  payment_attempt: "high",
  credit_use: "high",
  prospect_402: "low",
};

/**
 * Returns the signal a request warrants, or null if it is unremarkable.
 *
 * `hasPayment` and `hasCredit` report only the presence of a header. Their
 * contents are a signed authorization and a bearer credential respectively,
 * and neither is validated here -- an unverified header is enough to say
 * "someone attempted to pay", which is the only claim this module makes.
 */
export function detectSignal(
  isPaidPath: boolean,
  hasPayment: boolean,
  hasCredit: boolean,
  caller: CallerClass,
): BuyerSignal | null {
  if (hasPayment) return "payment_attempt";
  if (hasCredit) return "credit_use";
  if (!isPaidPath) return null;
  return caller === "monitor" ? null : "prospect_402";
}

/**
 * Emits a single structured line for log search.
 *
 * Nothing sensitive is recorded. The payment and credit headers are reported
 * as booleans upstream and their values never reach this function; the caller
 * IP is deliberately excluded in favour of the country Cloudflare already
 * derived, which is enough to tell a real user from a datacentre crawler
 * without retaining an identifier.
 */
export function recordBuyerSignal(signal: BuyerSignal, ctx: SignalContext): void {
  console.log(
    JSON.stringify({
      tag: "BUYER_SIGNAL",
      signal,
      confidence: SIGNAL_CONFIDENCE[signal],
      path: ctx.path,
      method: ctx.method,
      // Truncated: a User-Agent is caller-controlled and unbounded.
      ua: ctx.userAgent?.slice(0, 120) ?? null,
      country: ctx.country,
      at: new Date().toISOString(),
    }),
  );
}
