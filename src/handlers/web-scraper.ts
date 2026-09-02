import { Hono } from "hono";
import type { Env, ScrapeRequest } from "../types";
import { errorResponse } from "../lib/utils";
import {
  assertSafeUrl,
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
 *
 * Status codes follow the same rule as /pdf-parse: the x402 middleware
 * cancels settlement on any status >= 400, so a 4xx returned after the
 * upstream fetch would let the same payment be replayed for unlimited free
 * fetches. Cheap pre-fetch validation may 4xx; anything after the fetch is
 * reported as 200 with a machine-readable `status`.
 */
app.post("/", async (c) => {
  const body = await c.req.json<ScrapeRequest>();

  if (!body.url || typeof body.url !== "string") {
    return errorResponse("url is required", 400);
  }

  const format = body.format ?? "text";
  if (format !== "text" && format !== "markdown" && format !== "html") {
    return errorResponse(
      'format must be one of "text", "markdown", or "html"',
      400,
    );
  }

  if (body.selector !== undefined && typeof body.selector !== "string") {
    return errorResponse("selector must be a string", 400);
  }

  // Reject an unsafe URL before fetching. This 4xx is cheap and replay-safe.
  try {
    await assertSafeUrl(body.url);
  } catch (err) {
    if (err instanceof UnsafeUrlError) return errorResponse(err.message, 400);
    return errorResponse("Invalid url", 400);
  }

  try {
    const result = await safeFetch(body.url, {
      headers: {
        "User-Agent":
          "AgenticEndpoints/1.0 (scrape-pay; +https://github.com/agentic-endpoints)",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
    });

    // Only textual documents are meaningful here. Previously any upstream
    // bytes — an image or a zip — were UTF-8 decoded and returned as
    // successful "scraped text".
    if (
      result.contentType &&
      !/^(text\/|application\/(xhtml\+xml|xml|json))/i.test(result.contentType)
    ) {
      return c.json({
        url: body.url,
        status: "unsupported_content_type",
        detail: "URL did not return a textual document",
        title: "",
        content: "",
        format,
        truncated: false,
        extracted_at: new Date().toISOString(),
      });
    }

    let html = new TextDecoder("utf-8").decode(result.bytes);

    // Narrow to the requested subtree before converting.
    if (body.selector) {
      html = await selectHtml(html, body.selector);
    }

    const content =
      format === "html"
        ? html
        : format === "markdown"
          ? htmlToMarkdown(html)
          : htmlToText(html);

    const titleMatch = new TextDecoder("utf-8")
      .decode(result.bytes)
      .match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : "";

    const MAX_CONTENT = 50_000;
    const truncated = content.length > MAX_CONTENT;

    return c.json({
      url: body.url,
      status: "ok",
      title,
      content: content.slice(0, MAX_CONTENT),
      format,
      // Silent truncation is dangerous for an agent acting on the result.
      truncated,
      extracted_at: new Date().toISOString(),
    });
  } catch (err) {
    // The URL was already validated as safe above, so reaching here means the
    // fetch itself failed — work we have already paid for. Report it as a
    // 200 result rather than a 4xx/5xx, which would cancel settlement.
    if (err instanceof UnsafeUrlError) {
      // Only reachable via a redirect into a blocked target.
      return errorResponse(err.message, 400);
    }

    const detail =
      err instanceof UpstreamStatusError
        ? err.message
        : "Upstream fetch failed";

    return c.json({
      url: body.url,
      status: "fetch_failed",
      detail,
      title: "",
      content: "",
      format,
      truncated: false,
      extracted_at: new Date().toISOString(),
    });
  }
});

/**
 * Keep only the parts of the document matching a CSS selector, using the
 * runtime's streaming HTML parser rather than regex.
 */
async function selectHtml(html: string, selector: string): Promise<string> {
  const parts: string[] = [];

  const rewriter = new HTMLRewriter().on(selector, {
    element(el) {
      parts.push(`<${el.tagName}>`);
      el.onEndTag(() => {
        parts.push(`</${el.tagName}>`);
      });
    },
    text(chunk) {
      parts.push(chunk.text);
    },
  });

  await rewriter.transform(new Response(html)).text();
  return parts.join("");
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”",
};

/** Decode the HTML entities that survive tag stripping. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[entity] ?? match;
  });
}

/** Strip non-content elements that would otherwise pollute the output. */
function stripNonContent(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

function htmlToText(html: string): string {
  return decodeEntities(
    stripNonContent(html)
      // Keep block structure as line breaks instead of collapsing everything.
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert HTML to Markdown. Deliberately a pragmatic subset — headings,
 * emphasis, links, images, code, lists, blockquotes — which is what an LLM
 * consumer actually benefits from.
 */
function htmlToMarkdown(html: string): string {
  let out = stripNonContent(html);

  out = out
    .replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag: string, inner: string) => {
      const level = Number(tag[1]);
      return `\n\n${"#".repeat(level)} ${inner.replace(/<[^>]+>/g, "").trim()}\n\n`;
    })
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `**${inner.replace(/<[^>]+>/g, "").trim()}**`)
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `*${inner.replace(/<[^>]+>/g, "").trim()}*`)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => `\n\n\`\`\`\n${inner.replace(/<[^>]+>/g, "").trim()}\n\`\`\`\n\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${inner.replace(/<[^>]+>/g, "").trim()}\``)
    .replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      return label ? `[${label}](${href})` : "";
    })
    .replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*>/gi, "![$1]($2)")
    .replace(/<img[^>]*src=["']([^"']*)["'][^>]*>/gi, "![]($1)")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${inner.replace(/<[^>]+>/g, "").trim()}`)
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => `\n\n> ${inner.replace(/<[^>]+>/g, "").trim()}\n\n`)
    .replace(/<\/(p|div|section|article|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeEntities(out)
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default app;
