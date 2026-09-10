/**
 * Pre-flight checks for a stranger's x402 endpoint.
 *
 * An agent paying automatically cannot notice that the money started going
 * somewhere else. That is the whole problem this solves. A price rise is
 * annoying and self-limiting; a changed `payTo` is the failure that empties an
 * agent's wallet into an attacker's address while every request keeps
 * returning 200.
 *
 * Nothing here says "safe". It reports what the endpoint declares right now,
 * what it declared before, and where those disagree. The caller decides.
 */

/** USDC contracts we can convert to dollars with certainty. */
const KNOWN_ASSETS: Record<string, { symbol: string; decimals: number }> = {
  // Base mainnet
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 },
  // Base Sepolia
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": { symbol: "USDC", decimals: 6 },
};

/**
 * Chain names and their CAIP-2 identifiers.
 *
 * This exists because x402 v1 writes the network as a human name ("base")
 * while v2 writes it as CAIP-2 ("eip155:8453"). Confirmed live against this
 * service's own challenges, which declare `eip155:8453`.
 *
 * Comparing those two strings literally would report a critical "the
 * settlement chain changed" alarm at the moment an endpoint upgraded its
 * protocol version -- the single most alarming thing this tool can say, fired
 * for an endpoint that did not move a single thing that matters. Since the
 * whole value here rests on a critical flag meaning something, that false
 * positive would be worse than not checking at all.
 */
const CHAIN_ALIASES: Record<string, string> = {
  base: "eip155:8453",
  "base-mainnet": "eip155:8453",
  "base-sepolia": "eip155:84532",
  ethereum: "eip155:1",
  mainnet: "eip155:1",
  sepolia: "eip155:11155111",
  polygon: "eip155:137",
  "polygon-amoy": "eip155:80002",
  avalanche: "eip155:43114",
  "avalanche-fuji": "eip155:43113",
  arbitrum: "eip155:42161",
  optimism: "eip155:10",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};

/**
 * Reduces a network identifier to something comparable.
 *
 * Unknown values are lowercased and returned unchanged rather than guessed
 * at, so an unrecognised chain still compares equal to itself and never
 * silently compares equal to a different one.
 */
export function normalizeNetwork(value: string | null): string | null {
  if (!value) return value;
  const lower = value.trim().toLowerCase();
  return CHAIN_ALIASES[lower] ?? lower;
}

export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Refuses URLs that would turn this endpoint into a probe for networks the
 * caller cannot otherwise reach.
 *
 * This service fetches a caller-supplied URL, which is a server-side request
 * forgery primitive unless it is bounded. Blocking is by hostname shape before
 * any request is made: literal private and loopback addresses, link-local
 * (which covers cloud metadata at 169.254.169.254), and non-HTTP schemes.
 *
 * DNS rebinding is NOT defended against here -- a public name resolving to a
 * private address would still be fetched. Workers cannot route to RFC1918
 * space, which is what actually prevents that, so this check is the second
 * layer rather than the only one.
 */
export function checkUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid absolute URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `Unsupported scheme "${url.protocol}"` };
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0"
  ) {
    return { ok: false, reason: "Loopback addresses are not reachable" };
  }

  // IPv4 literals in private, loopback, link-local or carrier-grade NAT space.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const isPrivate =
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // link-local, incl. cloud metadata
      (a === 100 && b >= 64 && b <= 127) ||
      a === 0;
    if (isPrivate) {
      return { ok: false, reason: "Private and link-local addresses are refused" };
    }
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) {
    return { ok: false, reason: "Private IPv6 addresses are refused" };
  }

  if (url.hostname.endsWith(".internal") || url.hostname.endsWith(".local")) {
    return { ok: false, reason: "Internal hostnames are refused" };
  }

  return { ok: true };
}

export interface PaymentOption {
  scheme: string | null;
  network: string | null;
  /** Raw on-chain amount, as declared. Never rounded. */
  amount: string | null;
  asset: string | null;
  asset_symbol: string | null;
  /** Only set when the asset's decimals are known for certain. */
  price_usd: string | null;
  pay_to: string | null;
  max_timeout_seconds: number | null;
}

export interface ParsedChallenge {
  x402_version: number | null;
  /** Where the challenge was found: the v2 header or the response body. */
  source: "header" | "body";
  resource_url: string | null;
  description: string | null;
  options: PaymentOption[];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function toOption(raw: Record<string, unknown>): PaymentOption {
  // v2 renamed maxAmountRequired to amount. Reading only one silently reports
  // "no price" for half the ecosystem.
  const amount =
    str(raw.amount) ??
    str(raw.maxAmountRequired) ??
    (typeof raw.amount === "number" ? String(raw.amount) : null);

  const asset = str(raw.asset);
  const known = asset ? KNOWN_ASSETS[asset.toLowerCase()] : undefined;

  let priceUsd: string | null = null;
  if (amount && known && /^\d+$/.test(amount)) {
    // Integer maths only. A float here would misreport a price the caller is
    // about to authorise.
    const padded = amount.padStart(known.decimals + 1, "0");
    const whole = padded.slice(0, -known.decimals);
    const frac = padded.slice(-known.decimals);
    // Trailing zeros are noise, but the last one before the point is not:
    // "0.003" and "0." read very differently to a model deciding to pay.
    const trimmed = frac.replace(/0+$/, "");
    priceUsd = trimmed ? `${whole}.${trimmed}` : whole;
  }

  return {
    scheme: str(raw.scheme),
    network: str(raw.network),
    amount,
    asset,
    asset_symbol: known?.symbol ?? null,
    price_usd: priceUsd,
    pay_to: str(raw.payTo) ?? str(raw.pay_to),
    max_timeout_seconds:
      typeof raw.maxTimeoutSeconds === "number" ? raw.maxTimeoutSeconds : null,
  };
}

/**
 * Reads an x402 challenge from either transport.
 *
 * v2 carries it base64 in the PAYMENT-REQUIRED header and leaves the body
 * empty; v1 puts JSON in the body. An implementation that checks only the body
 * concludes a perfectly healthy v2 endpoint "is not x402", which is exactly
 * the false alarm that would make this tool untrustworthy.
 */
export function parseChallenge(
  headerValue: string | null,
  body: string | null,
): ParsedChallenge | null {
  const fromHeader = headerValue ? decodeHeader(headerValue) : null;
  if (fromHeader) return { ...fromHeader, source: "header" };

  if (body) {
    try {
      const json = JSON.parse(body) as Record<string, unknown>;
      const parsed = fromObject(json);
      if (parsed) return { ...parsed, source: "body" };
    } catch {
      // Not JSON. Not an x402 challenge.
    }
  }
  return null;
}

function decodeHeader(value: string): Omit<ParsedChallenge, "source"> | null {
  try {
    const cleaned = value.trim().replace(/\s+/g, "");
    const json = JSON.parse(atob(cleaned)) as Record<string, unknown>;
    return fromObject(json);
  } catch {
    return null;
  }
}

function fromObject(
  json: Record<string, unknown>,
): Omit<ParsedChallenge, "source"> | null {
  const accepts = json.accepts;
  if (!Array.isArray(accepts)) return null;

  const resource = json.resource as Record<string, unknown> | undefined;
  const first = accepts[0] as Record<string, unknown> | undefined;

  return {
    x402_version:
      typeof json.x402Version === "number" ? json.x402Version : null,
    // v2 nests the resource; v1 puts `resource` and `description` on each
    // accepts entry.
    resource_url:
      str(resource?.url) ?? str(first?.resource) ?? null,
    description:
      str(resource?.description) ?? str(first?.description) ?? null,
    options: accepts
      .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
      .map(toOption),
  };
}

export interface Observation {
  pay_to: string | null;
  amount: string | null;
  asset: string | null;
  network: string | null;
  scheme: string | null;
}

export interface Drift {
  field: keyof Observation;
  from: string | null;
  to: string | null;
  severity: "critical" | "warning" | "info";
  note: string;
}

/**
 * Compares what the endpoint declares now against what it declared before.
 *
 * Severity is not uniform, because the consequences are not. A changed
 * `payTo` means the money now goes to a different address than every previous
 * caller paid -- indistinguishable, from the outside, from a compromised
 * service. A price change is ordinary business.
 */
export function diffObservation(
  previous: Observation,
  current: Observation,
): Drift[] {
  const drift: Drift[] = [];

  if (previous.pay_to !== current.pay_to) {
    drift.push({
      field: "pay_to",
      from: previous.pay_to,
      to: current.pay_to,
      severity: "critical",
      note:
        "The receiving address changed. Payments now go somewhere other than " +
        "where earlier callers sent them. Confirm out of band before paying.",
    });
  }

  // Compared after normalising, so an endpoint moving from x402 v1's "base"
  // to v2's "eip155:8453" is correctly seen as the same chain.
  if (normalizeNetwork(previous.network) !== normalizeNetwork(current.network)) {
    drift.push({
      field: "network",
      from: previous.network,
      to: current.network,
      severity: "critical",
      note:
        "The settlement chain changed. A payment signed for the wrong chain " +
        "is not recoverable.",
    });
  }

  if (previous.asset !== current.asset) {
    drift.push({
      field: "asset",
      from: previous.asset,
      to: current.asset,
      severity: "critical",
      note: "The token being charged changed. Verify it is still the one you hold.",
    });
  }

  if (previous.amount !== current.amount) {
    const before = Number(previous.amount ?? 0);
    const after = Number(current.amount ?? 0);
    const rose = Number.isFinite(before) && Number.isFinite(after) && after > before;
    drift.push({
      field: "amount",
      from: previous.amount,
      to: current.amount,
      severity: rose ? "warning" : "info",
      note: rose
        ? "The price went up since it was last seen."
        : "The price changed since it was last seen.",
    });
  }

  if (previous.scheme !== current.scheme) {
    drift.push({
      field: "scheme",
      from: previous.scheme,
      to: current.scheme,
      severity: "warning",
      note: "The payment scheme changed.",
    });
  }

  return drift;
}

/**
 * Compares the live challenge against what the caller expected.
 *
 * The caller's expectation usually comes from a directory listing, which is
 * exactly the thing that goes stale. Catching the mismatch is the point.
 */
export interface Expectation {
  price_usd?: string;
  /**
   * A ceiling rather than an exact figure. Most callers do not care what an
   * endpoint costs, only that it has not become expensive while they were not
   * looking, and a ceiling survives ordinary repricing without crying wolf.
   */
  max_price_usd?: number;
  pay_to?: string;
  network?: string;
  asset?: string;
}

export function checkExpectation(
  expected: Expectation,
  option: PaymentOption,
): { matches: boolean; mismatches: string[] } {
  const mismatches: string[] = [];

  const eq = (a?: string | null, b?: string | null) =>
    (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

  if (expected.pay_to && !eq(expected.pay_to, option.pay_to)) {
    mismatches.push(
      `pay_to: expected ${expected.pay_to}, endpoint declares ${option.pay_to ?? "none"}`,
    );
  }
  // Normalised, so a caller who says "base" is not told they were wrong by an
  // endpoint that says "eip155:8453". They mean the same chain.
  if (
    expected.network &&
    normalizeNetwork(expected.network) !== normalizeNetwork(option.network)
  ) {
    mismatches.push(
      `network: expected ${expected.network}, endpoint declares ${option.network ?? "none"}`,
    );
  }
  if (expected.asset && !eq(expected.asset, option.asset)) {
    mismatches.push(
      `asset: expected ${expected.asset}, endpoint declares ${option.asset ?? "none"}`,
    );
  }
  if (expected.price_usd) {
    // Compare numerically so "0.03" and "0.030000" agree.
    const want = Number(expected.price_usd.replace(/^\$/, ""));
    const got = option.price_usd === null ? NaN : Number(option.price_usd);
    if (!Number.isFinite(got) || !Number.isFinite(want) || Math.abs(want - got) > 1e-9) {
      mismatches.push(
        `price: expected $${expected.price_usd}, endpoint declares ${
          option.price_usd === null ? "an amount in unknown units" : "$" + option.price_usd
        }`,
      );
    }
  }

  if (typeof expected.max_price_usd === "number") {
    if (option.price_usd === null) {
      mismatches.push(
        "price: a ceiling of $" +
          expected.max_price_usd +
          " was given, but the asset's units are unknown here so the charge " +
          "could NOT be checked against it",
      );
    } else if (Number(option.price_usd) > expected.max_price_usd + 1e-9) {
      mismatches.push(
        `price: endpoint declares $${option.price_usd}, above your ceiling of $${expected.max_price_usd}`,
      );
    }
  }

  return { matches: mismatches.length === 0, mismatches };
}
