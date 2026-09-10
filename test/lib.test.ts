import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { assertSafeUrl, UnsafeUrlError } from "../src/lib/url-guard";
import {
  generateToken,
  normalizeTtl,
  signReceipt,
  timingSafeEqual,
} from "../src/lib/utils";
import pdfSource from "../src/lib/pdf.ts?raw";
import { extractPdfText } from "../src/lib/pdf";

describe("SSRF guard", () => {
  const unsafe = [
    "http://127.0.0.1/",
    "http://localhost/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    // Obfuscated loopback forms.
    "http://0x7f.0.0.1/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    // Non-HTTP schemes.
    "file:///etc/passwd",
    "gopher://evil/",
    "data:text/plain,hi",
  ];

  for (const url of unsafe) {
    it(`rejects ${url}`, async () => {
      await expect(assertSafeUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
    });
  }

  it("accepts an ordinary public https URL", async () => {
    const u = await assertSafeUrl("https://example.com/a?b=1");
    expect(u.hostname).toBe("example.com");
  });

  it("rejects garbage input", async () => {
    await expect(assertSafeUrl("not a url")).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });
});

describe("utils", () => {
  it("refuses to sign with a weak or missing secret", async () => {
    await expect(signReceipt({ a: 1 }, "")).rejects.toThrow();
    await expect(signReceipt({ a: 1 }, "tooshort")).rejects.toThrow();
  });

  it("produces a stable signature for identical payloads", async () => {
    const secret = "x".repeat(32);
    const a = await signReceipt({ b: 2, a: 1 }, secret);
    const b = await signReceipt({ a: 1, b: 2 }, secret);
    expect(a).toBe(b);
  });

  it("generates high-entropy, unique tokens", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateToken));
    expect(tokens.size).toBe(200);
    expect([...tokens][0].length).toBeGreaterThanOrEqual(32);
  });

  it("compares in constant time without false positives", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("normalizes ttls", () => {
    expect(normalizeTtl(undefined)).toEqual({ ok: true, value: null });
    expect(normalizeTtl(60)).toEqual({ ok: true, value: 60 });
    for (const bad of [NaN, Infinity, -1, 0, 1.5, "60", {}, 10 ** 12]) {
      expect(normalizeTtl(bad).ok, String(bad)).toBe(false);
    }
  });
});

describe("PDF extraction", () => {
  it("extracts text from an uncompressed PDF", async () => {
    const bytes = new TextEncoder().encode(buildMinimalPdf("Hello Agent"));
    const result = await extractPdfText(bytes);
    expect(result.pages.length).toBe(1);
    expect(result.pages[0].text).toContain("Hello Agent");
  });

  it("fails honestly on input that is not a PDF", async () => {
    const bytes = new TextEncoder().encode("this is plainly not a pdf");
    const result = await extractPdfText(bytes);
    expect(result.pages).toEqual([]);
    expect(result.reason).toBe("unsupported");
  });

  /**
   * Regression: the cumulative inflate budget used to be a module-level
   * `let`, i.e. shared by every request in the isolate. A stranger's large
   * PDF could exhaust it mid-parse, making a concurrent caller's good
   * document report "no text layer" — returned as HTTP 200, so x402 settles
   * and the victim is billed for a confidently wrong answer.
   *
   * Exhausting the real 64MB ceiling would need ~128MB live across two
   * concurrent parses and would OOM the test isolate, so this asserts the
   * structural invariant instead: no mutable module-level budget may exist.
   */
  it("keeps the inflate budget request-scoped, not isolate-global", () => {
    expect(pdfSource).not.toMatch(/^let\s+inflateBudget/m);
    expect(pdfSource).toMatch(/interface InflateBudget/);
  });

  it("parses concurrently without cross-contaminating results", async () => {
    const docs = Array.from({ length: 8 }, (_, i) =>
      new TextEncoder().encode(buildMinimalPdf(`Doc ${i}`)),
    );
    const results = await Promise.all(docs.map((d) => extractPdfText(d)));
    results.forEach((r, i) => {
      expect(r.pages[0]?.text, `doc ${i}`).toContain(`Doc ${i}`);
    });
  });

  it("does not hang on a pathological numeric blob (ReDoS regression)", async () => {
    // Previously took ~60s of catastrophic backtracking in parseObjects.
    const blob = `%PDF-1.4\n${"1 ".repeat(100_000)}\n%%EOF`;
    const bytes = new TextEncoder().encode(blob);

    const start = Date.now();
    await extractPdfText(bytes);
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});

describe("worker HTTP contract", () => {
  it("serves the catalogue without payment", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/");
    expect(res.status).toBe(200);
  });

  it("serves health without payment", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  // The test runner has no route to the facilitator, so the x402 stack
  // cannot load its supported payment kinds. That is exactly the outage
  // path, and the contract is the same either way: never 200 without a
  // verified payment, and always a parseable JSON body.
  it("never serves a paid endpoint without a verified payment", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect([402, 503]).toContain(res.status);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("does not accept a forged payment header", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYMENT": "forged" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).not.toBe(200);
  });

  it("degrades to a JSON 503, not a bare 500, when the facilitator is down", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    if (res.status === 503) {
      expect(res.headers.get("Retry-After")).toBe("30");
      expect((await res.json<{ error: string }>()).error).toMatch(
        /facilitator/i,
      );
    }
  });

  /**
   * Regression: /vault/store, /vault/delete and /vault/exists shipped with
   * handlers registered but no entry in the x402 routes config, so they fell
   * through the paid-path check and were served for free. Anyone could
   * consume Durable Object storage at our expense.
   */
  it.each([
    "/once-key",
    "/scrape",
    "/pdf-parse",
    "/compress",
    "/vault/store",
    "/vault/retrieve",
    "/vault/delete",
    "/vault/exists",
  ])("never serves %s without payment", async (path) => {
    const res = await SELF.fetch(`https://ai.oliverkiss.com${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // 402 normally; 503 when the test runner cannot reach the facilitator.
    // Anything else means the route was reachable without paying.
    expect([402, 503]).toContain(res.status);
  });

  it("returns JSON, not HTML, for unknown routes", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("rejects an oversized body", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/compress", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(3 * 1024 * 1024),
      },
      body: JSON.stringify({ text: "x" }),
    });
    expect(res.status).toBe(413);
  });
});

/** Smallest well-formed single-page PDF with a literal text string. */
function buildMinimalPdf(text: string): string {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}

describe("service catalogue", () => {
  it("advertises the same price it charges", async () => {
    // The catalogue used to be hand-maintained and drifted: it told agents
    // three paid vault routes were free.
    const res = await SELF.fetch("https://ai.oliverkiss.com/", {
      headers: { Accept: "application/json" },
    });
    const { endpoints } = await res.json();

    for (const ep of endpoints) {
      if (!ep.price.startsWith("$")) continue;

      const challenge = await SELF.fetch(`https://ai.oliverkiss.com${ep.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      // 503 means the facilitator is unreachable, which says nothing about price.
      if (challenge.status !== 402) continue;

      const body = await challenge.json();
      const quoted = body?.accepts?.[0]?.price ?? body?.accepts?.[0]?.maxAmountRequired;
      if (quoted) expect(String(quoted)).toContain(ep.price.replace("$", ""));
    }
  });

  it("lists every paid route as paid", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/", {
      headers: { Accept: "application/json" },
    });
    const { endpoints } = await res.json();
    const paid = endpoints.filter((e) => e.price.startsWith("$")).map((e) => e.path);

    for (const path of ["/once-key", "/compress", "/scrape", "/pdf-parse",
                        "/vault/store", "/vault/retrieve", "/vault/delete",
                        "/vault/exists", "/credits/buy", "/credits/buy-25"]) {
      expect(paid, `${path} must be advertised as paid`).toContain(path);
    }
  });
});

/** Deflate a latin1 string, as a PDF /FlateDecode stream would be stored. */
async function deflate(text: string): Promise<Uint8Array> {
  const raw = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) raw[i] = text.charCodeAt(i) & 0xff;
  const cs = new Response(raw).body!.pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(cs).arrayBuffer());
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * A PDF whose page content streams are genuinely Flate-compressed, so the
 * inflate budget is actually consulted. `contents` are decoded in order.
 */
async function buildFlatePdf(contents: string[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (u: Uint8Array) => {
    parts.push(u);
    length += u.byteLength;
  };

  push(latin1("%PDF-1.4\n"));

  const streamStart = 4;
  const refs = contents.map((_, i) => `${streamStart + i} 0 R`).join(" ");
  const fontNum = streamStart + contents.length;

  const head = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [${refs}]` +
      ` /Resources << /Font << /F1 ${fontNum} 0 R >> >> >>`,
  ];
  head.forEach((body, i) => push(latin1(`${i + 1} 0 obj\n${body}\nendobj\n`)));

  for (let i = 0; i < contents.length; i++) {
    const packed = await deflate(contents[i]);
    push(
      latin1(
        `${streamStart + i} 0 obj\n<< /Filter /FlateDecode /Length ${packed.byteLength} >>\nstream\n`,
      ),
    );
    push(packed);
    push(latin1("\nendstream\nendobj\n"));
  }

  push(
    latin1(
      `${fontNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
    ),
  );
  push(latin1(`trailer\n<< /Size ${fontNum + 1} /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`));

  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * The inflate budget used to be isolate-global. These exercise the real
 * `total > budget.remaining` branch by lowering the ceiling, rather than by
 * allocating the 128MB two concurrent parses would need at the true 64MB.
 */
describe("inflate budget", () => {
  const page = (word: string) =>
    `BT /F1 24 Tf 72 700 Td (${word}) Tj ET${" ".repeat(2000)}`;

  it("refuses to inflate past the ceiling", async () => {
    const pdf = await buildFlatePdf([page("Alpha")]);
    const result = await extractPdfText(pdf, { inflateBudgetBytes: 64 });
    expect(result.pages.map((p) => p.text).join("")).not.toContain("Alpha");
  });

  it("spends one budget across the whole document, not one per stream", async () => {
    const first = page("Alpha");
    const pdf = await buildFlatePdf([first, page("Beta")]);

    // Enough for the first stream and nothing more. If each stream were
    // given its own budget -- the regression that would silently remove the
    // cumulative ceiling -- Beta would also decode.
    const result = await extractPdfText(pdf, {
      inflateBudgetBytes: first.length + 16,
    });
    const text = result.pages.map((p) => p.text).join("");
    expect(text).toContain("Alpha");
    expect(text).not.toContain("Beta");
  });

  /**
   * Control. Without this, the two assertions above could both pass simply
   * because the fixture never decodes at all, and would keep passing after
   * the budget logic was removed entirely.
   */
  it("decodes every stream when the budget is not the constraint", async () => {
    const pdf = await buildFlatePdf([page("Alpha"), page("Beta")]);
    const text = (await extractPdfText(pdf)).pages.map((p) => p.text).join("");
    expect(text).toContain("Alpha");
    expect(text).toContain("Beta");
  });

  it("does not let one parse consume another's budget", async () => {
    const starved = await buildFlatePdf([page("Alpha")]);
    const healthy = await buildFlatePdf([page("Beta")]);

    const [a, b] = await Promise.all([
      extractPdfText(starved, { inflateBudgetBytes: 64 }),
      extractPdfText(healthy),
    ]);

    expect(a.pages.map((p) => p.text).join("")).not.toContain("Alpha");
    expect(b.pages.map((p) => p.text).join("")).toContain("Beta");
  });
});

/**
 * A body of literal `null` parses fine, so it reaches the handler as null and
 * the first property read throws a TypeError -- surfacing as a 500 on what is
 * really a malformed request. Found by fuzzing production: /once-key/complete,
 * /once-key/release and /vault/rotate-token all returned 500.
 *
 * On a paid route a 500 also cancels x402 settlement, so this is the shape of
 * bug that turns a charge into a free call.
 */
describe("null JSON bodies are client errors, not server faults", () => {
  const freeJsonPosts = [
    "/once-key/complete",
    "/once-key/release",
    "/vault/rotate-token",
  ];

  it.each(freeJsonPosts)("does not return 500 for a null body on %s", async (path) => {
    const res = await SELF.fetch(`https://ai.oliverkiss.com${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBeLessThan(500);
  });

  it.each(freeJsonPosts)("answers a null body the same as an empty one on %s", async (path) => {
    const call = (body: string) =>
      SELF.fetch(`https://ai.oliverkiss.com${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    const [nul, empty] = await Promise.all([call("null"), call("{}")]);
    expect(nul.status).toBe(empty.status);
  });

  it("still rejects genuinely unparseable JSON as a 400", async () => {
    const res = await SELF.fetch("https://ai.oliverkiss.com/once-key/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "Request body must be valid JSON",
    });
  });
});
