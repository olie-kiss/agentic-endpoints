import { Hono } from "hono";
import type { Env } from "../types";
import { errorResponse } from "../lib/utils";
import {
  canonicalizeUrl,
  registryKeyFor,
  checkExpectationAcrossOptions,
  parseChallenge,
  type Expectation,
  type Observation,
} from "../lib/x402-verify";
import { assertSafeUrl, UnsafeUrlError } from "../lib/url-guard";

const app = new Hono<{ Bindings: Env }>();

/** A challenge is small. Anything larger is not one, and reading it is a cost. */
const MAX_BODY_BYTES = 64 * 1024;
/** A payment challenge is served before any work, so it should be immediate. */
const FETCH_TIMEOUT_MS = 8000;

/**
 * POST /x402/verify — $0.003
 *
 * Pre-flight a stranger's paid endpoint before authorising money to it.
 *
 * The failure this exists for is specific: an agent paying automatically
 * cannot notice that an endpoint's receiving address changed. Every request
 * still returns 200, the price still looks right, and the funds go somewhere
 * new. By the time a human looks, it has happened a thousand times.
 *
 * So this fetches the endpoint's live challenge, and compares it against
 * every previous observation made by every other caller. The comparison is
 * what a single agent cannot do for itself.
 */
app.post("/verify", async (c) => {
  const body = await c.req.json<{
    url?: string;
    expect?: Expectation;
    method?: string;
  }>().catch(() => ({}) as { url?: string; expect?: Expectation; method?: string });

  if (!body.url) return errorResponse("url is required", 400);

  // The same guard /scrape and /pdf-parse use, rather than a second weaker
  // one. It resolves the hostname over DNS-over-HTTPS and rejects private
  // answers, which a purely lexical check cannot do: a name an attacker
  // controls can point at 127.0.0.1 while looking perfectly public.
  let safeUrl: URL;
  try {
    safeUrl = await assertSafeUrl(body.url);
  } catch (err) {
    return c.json({
      status: "refused",
      url: body.url,
      detail:
        err instanceof UnsafeUrlError
          ? err.message
          : "This URL could not be validated",
      advice:
        "This URL was not fetched. Only public HTTP(S) endpoints can be " +
        "verified.",
    });
  }

  // An x402 endpoint answers on the method it advertises. POST is the common
  // case; the caller can override. The body is deliberately empty -- we want
  // the payment challenge, not to perform the work.
  const method = (body.method ?? "POST").toUpperCase();
  if (!["GET", "POST", "HEAD"].includes(method)) {
    return errorResponse("method must be GET, POST or HEAD", 400);
  }

  let response: Response | null = null;
  let fetchError: string | null = null;

  try {
    response = await fetch(safeUrl, {
      method,
      headers: {
        // Identify honestly. An endpoint owner reading their logs should be
        // able to tell this apart from a buyer and from a scanner.
        "User-Agent": "agentic-endpoints-x402-verify/1.0 (+https://ai.oliverkiss.com)",
        Accept: "application/json",
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: "{}" } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // Coarse, deliberately. The raw error distinguishes DNS failure from
    // connection refused from timeout, which is a free network-probe oracle
    // for any host a caller names. /pdf-parse refuses to echo upstream
    // details for the same reason; so does this.
    fetchError =
      err instanceof Error && err.name === "TimeoutError"
        ? "timeout"
        : "unreachable";
  }

  /**
   * The registry is keyed by method AND canonical URL, not URL alone.
   *
   * The method is caller-controlled. Many x402 services price GET and POST
   * differently (a read tier and a compute tier), so treating a GET
   * challenge as the next observation of a POST baseline would let anyone
   * pay $0.003 to make an honest endpoint appear to have swapped its payee
   * to the next caller -- the exact alarm this endpoint exists to raise.
   * Alternating the two would flap the baseline indefinitely.
   *
   * The URL is canonicalised (host already lowercased by the parser, default
   * port dropped, fragment removed) so that trivially different spellings of
   * one endpoint do not fragment its history into separate registries.
   */
  const canonicalUrl = canonicalizeUrl(safeUrl);
  const registry = c.env.ENDPOINTS.get(
    c.env.ENDPOINTS.idFromName(registryKeyFor(safeUrl, method)),
  );

  if (!response) {
    // Record nothing. See the Durable Object: overwriting a good record
    // because of one timeout would invent a payee-change alarm next time.
    const { json: seen } = await observe(registry, canonicalUrl, method, null);
    return c.json({
      status: "unreachable",
      url: body.url,
      reachable: false,
      error: fetchError,
      ...seen,
      advice:
        "The endpoint could not be reached, which is NOT evidence that it is " +
        "fraudulent, and equally not evidence that it works. Do not pay on " +
        "the strength of this result either way.",
    });
  }

  // Redirects are reported, not followed: the endpoint that answers a
  // redirect is a different endpoint from the one the caller named, and
  // silently verifying the wrong one is the failure mode to avoid.
  if (response.status >= 300 && response.status < 400) {
    return c.json({
      status: "redirected",
      url: body.url,
      /**
       * The destination is deliberately not echoed. Reporting it back would
       * turn a $0.003 call into a way to read an internal redirect target for
       * any host the caller names.
       */
      advice:
        "This URL redirects and was not followed, so nothing was verified. " +
        "Resolve the redirect yourself and verify the destination directly, " +
        "because that is where a payment would actually go.",
    });
  }

  const headerValue =
    response.headers.get("payment-required") ??
    response.headers.get("x-payment-required");

  const text = await readCapped(response);

  const challenge = parseChallenge(headerValue, text);

  if (!challenge || challenge.options.length === 0) {
    return c.json({
      status: "not_x402",
      url: body.url,
      reachable: true,
      http_status: response.status,
      advice:
        response.status === 402
          ? "The endpoint returned 402 but no readable x402 challenge, so " +
            "there is nothing to pay against. Treat it as broken, not as free."
          : "No x402 payment challenge was found. This endpoint may be free, " +
            "may require a different method, or may not use x402 at all.",
    });
  }

  const option = challenge.options[0];
  const observation: Observation = {
    pay_to: option.pay_to,
    amount: option.amount,
    asset: option.asset,
    network: option.network,
    scheme: option.scheme,
    // Every option, not just the first. A client pays through the option
    // matching a chain and token it holds, which need not be index 0, so an
    // endpoint could otherwise hide a second payee behind an honest first one.
    options: challenge.options.map((o) => ({
      pay_to: o.pay_to,
      asset: o.asset,
      network: o.network,
      scheme: o.scheme,
    })),
  };

  const { json: seen } = await observe(registry, canonicalUrl, method, observation);

  const drift = (seen.drift ?? []) as { severity: string }[];
  const critical = drift.filter((d) => d.severity === "critical");

  // Checked against every option, because a client pays through whichever one
  // matches a chain and token it holds -- not necessarily the first.
  const expectation = body.expect
    ? checkExpectationAcrossOptions(body.expect, challenge.options)
    : null;

  return c.json({
    status: "ok",
    url: body.url,
    reachable: true,
    http_status: response.status,
    /**
     * What the endpoint declares right now. `price_usd` is only populated for
     * assets whose decimals are known for certain; otherwise the raw amount
     * is given and the caller is told the units are unknown, because a
     * guessed price is worse than none.
     */
    charges: option,
    /**
     * Every option on offer. `charges` is only the first; a client that can
     * pay on a different chain would select a different one, so the whole
     * list is given rather than left for the caller to discover.
     */
    all_charges: challenge.options,
    payment_options: challenge.options.length,
    resource_url: challenge.resource_url,
    description: challenge.description,
    x402_version: challenge.x402_version,
    challenge_source: challenge.source,
    ...seen,
    ...(expectation
      ? {
          matches_expectation: expectation.matches,
          mismatches: expectation.mismatches,
        }
      : {}),
    advice: buildAdvice(
      seen.first_observation === true,
      critical.length,
      expectation,
      challenge.options.some((o) => o.price_usd === null),
      challenge.options.length,
    ),
  });
});

/**
 * Reads at most MAX_BODY_BYTES from a stranger's response, then hangs up.
 *
 * Buffering the whole body first would let a caller-supplied URL return half
 * a gigabyte and exhaust the isolate -- which every other request sharing
 * that isolate would pay for. The cap has to be applied while reading, not
 * after.
 */
async function readCapped(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } catch {
    return null;
  } finally {
    // Stop the transfer rather than politely draining a body we do not want.
    await reader.cancel().catch(() => {});
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Non-fatal by default, so a multi-byte character split by the cap becomes
  // a replacement character instead of throwing away the whole challenge.
  return new TextDecoder().decode(joined.slice(0, MAX_BODY_BYTES));
}

async function observe(
  stub: DurableObjectStub,
  url: string,
  method: string,
  observation: Observation | null,
): Promise<{ json: Record<string, unknown> }> {
  const res = await stub.fetch(
    new Request("https://internal/observe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, method, observation }),
    }),
  );
  return { json: await res.json<Record<string, unknown>>() };
}

/**
 * Says what was and was not established. Never says "safe".
 *
 * This endpoint can only report what an endpoint declares about itself. It
 * cannot tell whether the operator will deliver, and an agent that reads
 * "verified" as "trustworthy" would be worse off than one that never called.
 */
function buildAdvice(
  firstObservation: boolean,
  criticalCount: number,
  expectation: { matches: boolean; mismatches: string[] } | null,
  unknownUnits: boolean,
  optionCount: number,
): string {
  const parts: string[] = [];

  if (criticalCount > 0) {
    parts.push(
      "STOP AND CHECK: something that determines where your money goes has " +
        "changed since this endpoint was last seen. See `drift`. This is the " +
        "pattern of a compromised or replaced service, though it is also what " +
        "a legitimate migration looks like -- confirm out of band before paying.",
    );
  }

  if (expectation && !expectation.matches) {
    parts.push(
      "The endpoint does not match what you expected. Whatever told you those " +
        "values is stale or wrong; trust this challenge over a directory listing.",
    );
  }

  if (firstObservation) {
    parts.push(
      "This is the first time this endpoint has been observed here, so there " +
        "is no history to compare against. Absence of drift is NOT evidence of " +
        "stability.",
    );
  }

  if (unknownUnits) {
    parts.push(
      "The asset is not one whose decimals are known here, so the amount has " +
        "NOT been converted to dollars. Do not assume it is small.",
    );
  }

  if (optionCount > 1) {
    parts.push(
      `This endpoint offers ${optionCount} payment options and \`charges\` shows ` +
        "only the first. Check `all_charges` for the one you would actually " +
        "pay through, because it need not be the first.",
    );
  }

  parts.push(
    "This reports only what the endpoint declares about itself. It is not a " +
      "judgement that the operator will deliver anything.",
  );

  return parts.join(" ");
}

export default app;
