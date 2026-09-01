import { Hono } from "hono";
import type { Env, ScrapeRequest } from "../types";
import { errorResponse } from "../lib/utils";

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

  let targetUrl: URL;
  try {
    targetUrl = new URL(body.url);
  } catch {
    return errorResponse("Invalid URL", 400);
  }

  // Block internal/private ranges
  if (
    targetUrl.hostname === "localhost" ||
    targetUrl.hostname.startsWith("127.") ||
    targetUrl.hostname.startsWith("10.") ||
    targetUrl.hostname.startsWith("192.168.")
  ) {
    return errorResponse("Private URLs are not allowed", 403);
  }

  try {
    const res = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent":
          "AgenticEndpoints/1.0 (scrape-pay; +https://github.com/agentic-endpoints)",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      return errorResponse(
        `Upstream returned ${res.status}`,
        502,
      );
    }

    const html = await res.text();
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
    return errorResponse(
      `Scrape failed: ${err instanceof Error ? err.message : "unknown error"}`,
      502,
    );
  }
});

export default app;
