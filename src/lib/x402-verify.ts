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
  // Held lowercase deliberately. base58 IS case-significant, so these are a
  // canonical comparison form only -- never render one back to a caller as a
  // chain id. Left mixed-case, a v1 endpoint saying "solana" would never
  // compare equal to a v2 one saying the literal id, which is the exact
  // false alarm this table exists to prevent.
  "solana-devnet": "solana:etwtrabzayq6imfeykouru166vu2xqa1",
  solana: "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp",
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

/**
 * NOTE: URL safety is NOT checked here. `/x402/verify` uses `assertSafeUrl`
 * from `lib/url-guard`, the same guard `/scrape` and `/pdf-parse` use, so
 * there is exactly one place where outbound-fetch policy lives. An earlier
 * version of this file had its own lexical check; it was deleted rather than
 * kept, because a second, weaker guard is how the two drift apart.
 */

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
    // Base64url is accepted too: an endpoint that emits "-" and "_" would
    // otherwise throw in atob and be silently reported as not using x402.
    const cleaned = value
      .trim()
      .replace(/\s+/g, "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
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
  /**
   * Every payment option the endpoint offered, not just the one a reader
   * happens to look at first.
   *
   * A real client picks the option matching a chain and token it can actually
   * pay in, which need not be the first. An endpoint that lists an honest
   * option first and an attacker's payee second would otherwise pass this
   * check while taking the money through the option the client selects.
   */
  options?: ObservedOption[];
}

/** The parts of an option that decide where money goes. Price is not one. */
export interface ObservedOption {
  pay_to: string | null;
  asset: string | null;
  network: string | null;
  scheme: string | null;
}

/**
 * Reduces an option to a comparable identity.
 *
 * Addresses are lowercased because EIP-55 checksumming is presentation, not
 * meaning: the same address in two casings is the same address, and reporting
 * a re-casing as a changed payee would fire the most severe alarm this tool
 * has at an endpoint where nothing moved. `amount` is excluded so a price
 * change is never mistaken for a new payment option.
 */
function optionKey(o: ObservedOption): string {
  const lc = (v: string | null) => (v ?? "").toLowerCase();
  return [lc(o.pay_to), normalizeNetwork(o.network) ?? "", lc(o.asset), lc(o.scheme)].join("|");
}

/** Falls back to the primary fields for records written before options were stored. */
function optionsOf(o: Observation): ObservedOption[] {
  if (o.options && o.options.length > 0) return o.options;
  return [{ pay_to: o.pay_to, asset: o.asset, network: o.network, scheme: o.scheme }];
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
  const lc = (v: string | null) => (v ?? "").toLowerCase();

  const before = optionsOf(previous);
  const after = optionsOf(current);
  const beforeKeys = new Set(before.map(optionKey));
  const afterKeys = new Set(after.map(optionKey));

  // Compared as a set, so merely reordering `accepts` -- which changes nothing
  // about where money can go -- does not raise a critical alarm.
  const added = after.filter((o) => !beforeKeys.has(optionKey(o)));
  const removed = before.filter((o) => !afterKeys.has(optionKey(o)));

  const knownPayees = new Set(before.map((o) => lc(o.pay_to)));
  const knownAssets = new Set(before.map((o) => lc(o.asset)));
  const knownNetworks = new Set(before.map((o) => normalizeNetwork(o.network) ?? ""));

  for (const option of added) {
    if (!knownPayees.has(lc(option.pay_to))) {
      drift.push({
        field: "pay_to",
        from: before.map((o) => o.pay_to).join(", ") || null,
        to: option.pay_to,
        severity: "critical",
        note:
          "A payment option now names a receiving address this endpoint has " +
          "never offered before. Money paid through it goes somewhere other " +
          "than where earlier callers sent theirs. Confirm out of band.",
      });
    }
    // Normalised, so an endpoint moving from x402 v1's "base" to v2's
    // "eip155:8453" is correctly read as the same chain.
    if (!knownNetworks.has(normalizeNetwork(option.network) ?? "")) {
      drift.push({
        field: "network",
        from: before.map((o) => o.network).join(", ") || null,
        to: option.network,
        severity: "critical",
        note:
          "A payment option settles on a chain this endpoint has not used " +
          "before. A payment signed for the wrong chain is not recoverable.",
      });
    }
    if (!knownAssets.has(lc(option.asset))) {
      drift.push({
        field: "asset",
        from: before.map((o) => o.asset).join(", ") || null,
        to: option.asset,
        severity: "critical",
        note:
          "A payment option charges a token this endpoint has not used " +
          "before. Verify it is still one you hold.",
      });
    }
  }

  if (removed.length > 0 && added.length === 0) {
    drift.push({
      field: "options",
      from: String(before.length),
      to: String(after.length),
      severity: "info",
      note:
        "The endpoint withdrew a payment option. Nothing new was added, so " +
        "no new destination for your money appeared.",
    });
  }

  // The set is unchanged but the order is not. Harmless in itself, and worth
  // saying only because a client that blindly takes the first option would
  // now pay through a different one.
  if (
    added.length === 0 &&
    removed.length === 0 &&
    optionKey(before[0]) !== optionKey(after[0])
  ) {
    drift.push({
      field: "options",
      from: before[0].pay_to,
      to: after[0].pay_to,
      severity: "warning",
      note:
        "The payment options were reordered. The same destinations are on " +
        "offer, but a client that takes the first one will now use a " +
        "different option than before.",
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
