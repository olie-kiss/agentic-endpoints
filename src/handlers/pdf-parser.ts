import { Hono } from "hono";
import type { Env, PdfParseRequest } from "../types";
import { errorResponse } from "../lib/utils";
import {
  safeFetch,
  UnsafeUrlError,
  UpstreamStatusError,
} from "../lib/url-guard";

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
 * NOTE: This is a starter implementation using basic PDF text extraction.
 * For production, integrate a proper PDF library (pdf-parse, pdfjs-dist)
 * or offload to a Cloudflare Worker with WASM-compiled parser.
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

    const bytes = result.bytes;

    // Basic PDF text extraction — pulls text between stream markers.
    // This handles simple PDFs. Production should use a WASM PDF parser.
    const text = extractTextFromPdf(bytes);

    return c.json({
      url: body.url,
      page_count: 1, // basic extractor doesn't split pages
      pages: [{ page: 1, text }],
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

/**
 * Naive PDF text extractor. Pulls readable ASCII/UTF-8 strings
 * from the raw PDF binary. Good enough for simple text-based PDFs.
 *
 * TODO: Replace with a WASM-compiled PDF parser for production use.
 */
function extractTextFromPdf(bytes: Uint8Array): string {
  const raw = new TextDecoder("utf-8").decode(bytes);
  const textParts: string[] = [];

  // Extract text from PDF text objects: BT ... ET blocks
  const btEtRegex = /BT\s([\s\S]*?)ET/g;
  let match;
  while ((match = btEtRegex.exec(raw)) !== null) {
    const block = match[1];
    // Extract parenthesized strings: (text here)
    const parenRegex = /\(([^)]*)\)/g;
    let textMatch;
    while ((textMatch = parenRegex.exec(block)) !== null) {
      const cleaned = textMatch[1]
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "")
        .replace(/\\\(/g, "(")
        .replace(/\\\)/g, ")")
        .replace(/\\\\/g, "\\");
      if (cleaned.trim()) {
        textParts.push(cleaned);
      }
    }
  }

  return textParts.join(" ") || "[No extractable text found — PDF may use embedded fonts or images]";
}

export default app;
