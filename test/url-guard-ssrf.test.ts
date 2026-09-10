import { describe, expect, it } from "vitest";
import { assertSafeUrl, UnsafeUrlError } from "../src/lib/url-guard";

/**
 * The standard SSRF filter bypasses, against the guard that /scrape,
 * /pdf-parse and /x402/verify all share. Each of these is a valid URL that a
 * fetch resolves to loopback, to cloud metadata, or to a private host.
 */
describe("assertSafeUrl bypass resistance", () => {
  it.each([
    ["http://127.0.0.1/", "canonical loopback"],
    ["http://0177.0.0.1/", "octal first octet"],
    ["http://0x7f.0.0.1/", "hex first octet"],
    ["http://2130706433/", "loopback as a bare integer"],
    ["http://0x7f000001/", "loopback in hex"],
    ["http://127.1/", "shorthand two-part form"],
    ["http://169.254.169.254/", "cloud metadata"],
    ["http://2852039166/", "cloud metadata as an integer"],
    ["http://[::]/", "the unspecified IPv6 address"],
    ["http://[::1]/", "IPv6 loopback"],
    ["http://[::ffff:127.0.0.1]/", "IPv4-mapped IPv6"],
    ["http://[64:ff9b::7f00:1]/", "NAT64"],
    ["http://localhost/", "loopback by name"],
    ["http://localhost./", "trailing dot on a loopback name"],
    ["http://user:pass@127.0.0.1/", "credentials hiding the host"],
    ["http://10.0.0.1/", "RFC1918"],
    ["file:///etc/passwd", "non-HTTP scheme"],
  ])("refuses %s (%s)", async (url) => {
    await expect(assertSafeUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("still allows an ordinary public URL", async () => {
    await expect(assertSafeUrl("https://ai.oliverkiss.com/compress")).resolves.toBeTruthy();
  });
});
