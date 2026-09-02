import { Hono } from "hono";
import type { Env, PdfParseRequest } from "../types";
import { errorResponse } from "../lib/utils";
import {
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
 * Text extraction lives in ../lib/pdf. When a document yields no text
 * (encrypted, or a scan with no text layer) this returns a 4xx rather than
 * a success with filler content, so the caller is not billed for a result
 * we know is useless.
 */
app.post("/", async (c) => {
  const body = await c.req.json<PdfParseRequest>();

  if (!body.url) {
    return errorResponse("url is required", 400);
  }

  try {
    const result = await safeFetch(
      body.url,
      { headers: { "User-Agent": "AgenticEndpoints/1.0 (pdf-parse)" } },
      { maxBytes: 10_000_000 },
    );

    if (!result.contentType.includes("pdf")) {
      // Don't echo the upstream content-type — it fingerprints internal services.
      return errorResponse("URL did not return a PDF", 400);
    }

    const extraction = await extractPdfText(result.bytes);

    if (extraction.reason) {
      const reasons: Record<string, string> = {
        encrypted:
          "PDF is encrypted — its content streams cannot be decrypted without the password",
        "no-text":
          "PDF contains no extractable text layer (it is likely a scan or image-only document)",
        unsupported: "File is not a valid PDF",
      };
      return errorResponse(
        reasons[extraction.reason] ?? "PDF contains no extractable text",
        extraction.reason === "unsupported" ? 400 : 422,
      );
    }

    // Optional page filter, 1-indexed to match how PDFs are numbered.
    let pages = extraction.pages;
    if (body.pages?.length) {
      const wanted = new Set(body.pages);
      pages = pages.filter((p) => wanted.has(p.page));
      if (pages.length === 0) {
        return errorResponse(
          `None of the requested pages exist (document has ${extraction.pages.length} pages)`,
          400,
        );
      }
    }

    return c.json({
      url: body.url,
      page_count: extraction.pages.length,
      pages,
      extracted_at: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return errorResponse(err.message, 400);
    }
    if (err instanceof UpstreamStatusError) {
      return errorResponse(err.message, 502);
    }
    // Avoid reflecting raw network errors — they are an internal-host probe oracle.
    return errorResponse("PDF parse failed", 502);
  }
});

export default app;
