import { Hono } from "hono";
import type { Env, ScrapeRequest } from "../types";
import { errorResponse } from "../lib/utils";
import {
  safeFetch,
  UnsafeUrlError,
  UpstreamStatusError,
} from "../lib/url-guard";

const app = new Hono<{ Bindings: Env }>();

/**
 * POST /scrape
 *
 * Pay-per-query web scraping. Fetches a URL and extracts text content.
 * Agents pay $0.005 per call.
 *
 * Body: { url, selector?, format? }
 */
app.post("/", async (c) => {
  const body = await c.req.json<ScrapeRequest>();

  if (!body.url) {
    return errorResponse("url is required", 400);
  }

  try {
    const result = await safeFetch(body.url, {
      headers: {
        "User-Agent":
          "AgenticEndpoints/1.0 (scrape-pay; +https://github.com/agentic-endpoints)",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
    });

    const html = new TextDecoder("utf-8").decode(result.bytes);
    const format = body.format ?? "text";

    let content: string;
    if (format === "html") {
      content = html;
    } else {
      // Basic HTML → text stripping (production: use HTMLRewriter or a parser)
      content = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "";

    return c.json({
      url: body.url,
      title,
      content: content.slice(0, 50_000), // cap at 50k chars
      format,
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
    return errorResponse("Scrape failed", 502);
  }
});

export default app;
