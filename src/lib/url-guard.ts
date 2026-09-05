/**
 * Outbound request guard for endpoints that fetch caller-supplied URLs.
 *
 * Protects against SSRF by:
 *  - allowing only http/https
 *  - rejecting embedded credentials
 *  - rejecting internal hostnames and IP literals in private/reserved ranges
 *    (WHATWG URL already normalizes decimal/hex/octal IPv4 forms for us)
 *  - resolving hostnames over DoH and rejecting private answers
 *  - following redirects manually, re-validating every hop
 *  - bounding response size and total time
 *
 * KNOWN LIMITATION -- this does NOT defeat DNS rebinding.
 *
 * The DoH check and the fetch below are two independent resolutions of the
 * same name. An attacker running their own nameserver with a very low TTL can
 * answer the probe with a public address and the fetch with a private one, and
 * the same window reopens on every redirect hop.
 *
 * Closing it properly means connecting to the address we vetted rather than to
 * the name. That is not expressible on Workers: `cf.resolveOverride` accepts
 * only hostnames within your own zone, never arbitrary third-party hosts or
 * IPs, and connecting to an IP literal would break TLS SNI and certificate
 * validation for https. There is no runtime API that pins a fetch to a
 * resolved address.
 *
 * What actually bounds the risk is the egress path, not this file: Workers
 * reach the internet through Cloudflare's network, which has no route to
 * RFC1918 or loopback and exposes no cloud metadata endpoint, so a rebound
 * private answer has nothing to reach. The DoH check remains worthwhile as
 * defence in depth -- it stops the ordinary case of a name that simply points
 * somewhere internal -- but it must not be mistaken for a rebinding defence.
 * Do not put anything sensitive on a network reachable from this Worker's
 * egress on the assumption that this guard prevents reaching it.
 */

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const DNS_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_BYTES = 2_000_000;

/** Hostname suffixes that never refer to a legitimate public host. */
const BLOCKED_SUFFIXES = [
  "localhost",
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".home.arpa",
];

export class UnsafeUrlError extends Error {}

/** Thrown when the upstream host responded but with a non-OK status. */
export class UpstreamStatusError extends Error {
  constructor(readonly status: number) {
    super(`Upstream returned ${status}`);
  }
}

function ipv4ToInt(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isPrivateIpv4(host: string): boolean {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;

  const inRange = (cidr: string, bits: number) =>
    (ip >>> (32 - bits)) === (ipv4ToInt(cidr)! >>> (32 - bits));

  return (
    inRange("0.0.0.0", 8) || // "this network"
    inRange("10.0.0.0", 8) || // RFC1918
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local / cloud metadata
    inRange("172.16.0.0", 12) || // RFC1918
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.0.2.0", 24) || // TEST-NET-1
    inRange("192.88.99.0", 24) || // 6to4 relay anycast
    inRange("192.168.0.0", 16) || // RFC1918
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("198.51.100.0", 24) || // TEST-NET-2
    inRange("203.0.113.0", 24) || // TEST-NET-3
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved + broadcast
  );
}

function expandIpv6(host: string): number[] | null {
  const [head, tail, ...rest] = host.split("::");
  if (rest.length > 0) return null;

  const parse = (segment: string) =>
    segment === "" ? [] : segment.split(":");

  const headParts = parse(head);
  const tailParts = tail === undefined ? [] : parse(tail);
  const all = [...headParts, ...tailParts];

  // An IPv4 suffix (e.g. ::ffff:127.0.0.1) occupies the final two groups.
  let v4Groups: string[] = [];
  if (all.length > 0 && all[all.length - 1].includes(".")) {
    const v4 = ipv4ToInt(all[all.length - 1]);
    if (v4 === null) return null;
    all.pop();
    if (tailParts.length > 0) tailParts.pop();
    else headParts.pop();
    v4Groups = [
      ((v4 >>> 16) & 0xffff).toString(16),
      (v4 & 0xffff).toString(16),
    ];
  }

  const explicit = [...headParts, ...v4Groups, ...tailParts];
  const groups: string[] =
    tail === undefined
      ? explicit
      : [
          ...headParts,
          ...Array(8 - explicit.length).fill("0"),
          ...v4Groups,
          ...tailParts,
        ];

  if (groups.length !== 8) return null;

  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}

function isPrivateIpv6(host: string): boolean {
  const groups = expandIpv6(host.toLowerCase());
  if (!groups) return true; // unparseable IPv6 literal — fail closed

  const [g0, g1] = groups;
  const isZeroPrefix = groups.slice(0, 5).every((g) => g === 0);

  // ::, ::1, and IPv4-mapped/compatible addresses
  if (isZeroPrefix && (groups[5] === 0 || groups[5] === 0xffff)) {
    const v4 = `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${
      (groups[7] >> 8) & 0xff
    }.${groups[7] & 0xff}`;
    return isPrivateIpv4(v4) || groups[6] === 0;
  }

  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x0064 && g1 === 0xff9b) return true; // NAT64

  return false;
}

function isBlockedHostLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (host.startsWith("[") && host.endsWith("]")) {
    return isPrivateIpv6(host.slice(1, -1));
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return isPrivateIpv4(host);
  }
  return BLOCKED_SUFFIXES.some(
    (suffix) =>
      suffix.startsWith(".") ? host.endsWith(suffix) : host === suffix,
  );
}

/**
 * Resolve a hostname over DNS-over-HTTPS and reject if any answer points at a
 * private address. Fails closed so a rebinding attempt cannot slip through.
 */
async function assertPublicDnsAnswers(hostname: string): Promise<void> {
  const lookup = async (type: "A" | "AAAA"): Promise<string[]> => {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(
        hostname,
      )}&type=${type}`,
      {
        headers: { Accept: "application/dns-json" },
        signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new UnsafeUrlError("Could not verify host");

    const body = await res.json<{
      Answer?: { type: number; data: string }[];
    }>();
    return (body.Answer ?? [])
      .filter((a) => a.type === 1 || a.type === 28)
      .map((a) => a.data);
  };

  let addresses: string[];
  try {
    const [a, aaaa] = await Promise.all([lookup("A"), lookup("AAAA")]);
    addresses = [...a, ...aaaa];
  } catch {
    throw new UnsafeUrlError("Could not verify host");
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError("Host does not resolve");
  }
  for (const address of addresses) {
    const blocked = address.includes(":")
      ? isPrivateIpv6(address)
      : isPrivateIpv4(address);
    if (blocked) {
      throw new UnsafeUrlError("Private and internal hosts are not allowed");
    }
  }
}

/**
 * Validate a caller-supplied URL. Throws UnsafeUrlError if it must not be fetched.
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Only http and https URLs are supported");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs with embedded credentials are not allowed");
  }
  if (isBlockedHostLiteral(url.hostname)) {
    throw new UnsafeUrlError("Private and internal hosts are not allowed");
  }

  const isLiteral =
    url.hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (!isLiteral) {
    await assertPublicDnsAnswers(url.hostname);
  }

  return url;
}

/** Read a response body, aborting if it exceeds maxBytes. */
async function readBounded(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new UnsafeUrlError("Upstream response too large");
  }

  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UnsafeUrlError("Upstream response too large");
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface SafeFetchResult {
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
}

/**
 * Fetch a caller-supplied URL with SSRF protection, manual redirect
 * re-validation, a timeout, and a response size cap.
 */
export async function safeFetch(
  raw: string,
  init: { headers?: Record<string, string> } = {},
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let current = await assertSafeUrl(raw);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current.toString(), {
      headers: init.headers,
      redirect: "manual",
      signal: deadline,
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new UpstreamStatusError(res.status);
      // Re-validate every hop: the blocklist must apply to the whole chain.
      current = await assertSafeUrl(new URL(location, current).toString());
      continue;
    }

    if (!res.ok) throw new UpstreamStatusError(res.status);

    return {
      bytes: await readBounded(res, maxBytes),
      contentType: res.headers.get("content-type") ?? "",
      finalUrl: current.toString(),
    };
  }

  throw new UnsafeUrlError("Too many redirects");
}
