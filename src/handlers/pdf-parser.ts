import { Hono } from "hono";
import type { Env, PdfParseRequest } from "../types";
import { errorResponse } from "../lib/utils";
import {
  assertSafeUrl,
  safeFetch,
  UnsafeUrlError,
  UpstreamStatusError,
} from "../lib/url-guard";
import { extractPdfText } from "../lib/pdf";

const app = new Hono<{ Bindings: Env }>();

/**
 * POST /pdf-parse
 *
 * Pay-per-query PDF text extraction. Fetches a PDF from a URL
 * and returns extracted text per page.
 * Agents pay $0.01 per call.
 *
 * Body: { url, pages? }
 *
 * Text extraction lives in ../lib/pdf.
 *
 * Status-code policy is deliberate and load-bearing. The x402 middleware
 * CANCELS settlement whenever a handler returns >= 400, so the caller's
 * payment authorization is never spent and the identical X-PAYMENT header
 * can be replayed indefinitely. Any 4xx returned *after* expensive work
 * therefore hands out unlimited free fetching and parsing.
 *
 * So: cheap pre-fetch validation may return 4xx (nothing costly has run
 * yet, and replaying it achieves nothing). Once we have fetched and parsed,
 * we always return 200 with a machine-readable `status`, including for
 * encrypted or text-free documents. "This PDF has no text layer" is a real,
 * useful answer to an agent, and it is one we did the work to produce.
 */
app.post("/", async (c) => {
  const body = await c.req.json<PdfParseRequest>();

  if (!body.url || typeof body.url !== "string") {
    return errorResponse("url is required", 400);
  }

  if (body.pages && !Array.isArray(body.pages)) {
    return errorResponse("pages must be an array of page numbers", 400);
  }

  // Reject an unsafe URL before fetching. This 4xx is cheap and replay-safe.
  try {
    await assertSafeUrl(body.url);
  } catch (err) {
    if (err instanceof UnsafeUrlError) return errorResponse(err.message, 400);
    return errorResponse("Invalid url", 400);
  }

  // Reject an unsafe URL before fetching. This 4xx is cheap and replay-safe,
  // and it is what makes any UnsafeUrlError in the catch below provably
  // post-fetch, so the two cases can be given different statuses.
  try {
    await assertSafeUrl(body.url);
  } catch (err) {
    if (err instanceof UnsafeUrlError) return errorResponse(err.message, 400);
    return errorResponse("Invalid url", 400);
  }

  try {
    const result = await safeFetch(
      body.url,
      { headers: { "User-Agent": "AgenticEndpoints/1.0 (pdf-parse)" } },
      { maxBytes: 4_000_000 },
    );

    // Post-fetch outcomes are reported as 200 + status, never 4xx. See above.
    if (!result.contentType.includes("pdf")) {
      // Don't echo the upstream content-type — it fingerprints internal services.
      return c.json({
        url: body.url,
        status: "not_a_pdf",
        detail: "URL did not return a PDF content type",
        page_count: 0,
        pages: [],
        extracted_at: new Date().toISOString(),
      });
    }

    const extraction = await extractPdfText(result.bytes);

    if (extraction.reason) {
      const details: Record<string, string> = {
        encrypted:
          "PDF is encrypted — its content streams cannot be decrypted without the password",
        "no-text":
          "PDF contains no extractable text layer (it is likely a scan or image-only document)",
        unsupported: "File is not a valid PDF",
      };
      return c.json({
        url: body.url,
        status: extraction.reason === "unsupported" ? "not_a_pdf" : extraction.reason,
        detail: details[extraction.reason],
        page_count: 0,
        pages: [],
        extracted_at: new Date().toISOString(),
      });
    }

    // Optional page filter, 1-indexed to match how PDFs are numbered.
    let pages = extraction.pages;
    if (body.pages?.length) {
      const wanted = new Set(body.pages);
      pages = pages.filter((p) => wanted.has(p.page));
    }

    return c.json({
      url: body.url,
      status: "ok",
      page_count: extraction.pages.length,
      pages,
      extracted_at: new Date().toISOString(),
    });
  } catch (err) {
    // Everything below happens after the outbound fetch, so it must be a 200
    // with a machine-readable status: a >=400 cancels settlement on work
    // already done and leaves the payment header replayable, which buys an
    // attacker unlimited fetches from our egress for a single signature.
    const base = {
      url: body.url,
      page_count: 0,
      pages: [] as unknown[],
      extracted_at: new Date().toISOString(),
    };

    // Redirect into a blocked target, or a body over the size cap.
    if (err instanceof UnsafeUrlError) {
      return c.json({ ...base, status: "blocked_redirect", detail: err.message });
    }

    // Don't echo the upstream status text — it is a probe oracle.
    if (err instanceof UpstreamStatusError) {
      return c.json({
        ...base,
        status: "fetch_failed",
        detail: "Upstream did not return a retrievable document",
      });
    }

    return c.json({ ...base, status: "fetch_failed", detail: "PDF fetch failed" });
  }
});

export default app;
