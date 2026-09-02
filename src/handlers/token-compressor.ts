import { Hono } from "hono";
import type { Env, CompressRequest } from "../types";
import { errorResponse } from "../lib/utils";

const app = new Hono<{ Bindings: Env }>();

/** Rough English estimate: ~4 characters per token. */
const CHARS_PER_TOKEN = 4;
const MAX_INPUT_CHARS = 400_000;
/** Beyond this, force a sentence break regardless of abbreviation context. */
const MAX_SENTENCE_CHARS = 4096;

const estimateTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

/**
 * POST /compress
 *
 * Token compression / context reduction for LLMs.
 * Agents pay $0.005 per call.
 *
 * Strategies:
 *   - "truncate"   — Hard cut to target_tokens (fast, lossy)
 *   - "extractive" — Sentence scoring to keep the most informative content (default)
 *
 * Body: { text, target_tokens?, strategy? }
 */
app.post("/", async (c) => {
  const body = await c.req.json<CompressRequest>();

  if (typeof body.text !== "string" || body.text.length === 0) {
    return errorResponse("text is required and must be a non-empty string", 400);
  }

  if (body.text.length > MAX_INPUT_CHARS) {
    return errorResponse(
      `text exceeds the ${MAX_INPUT_CHARS}-character limit`,
      413,
    );
  }

  const targetTokens = body.target_tokens ?? 1000;
  if (!Number.isFinite(targetTokens) || targetTokens < 1) {
    return errorResponse("target_tokens must be a positive number", 400);
  }

  const strategy = body.strategy ?? "extractive";
  if (strategy !== "extractive" && strategy !== "truncate") {
    return errorResponse(
      'strategy must be either "extractive" or "truncate"',
      400,
    );
  }

  const targetChars = Math.floor(targetTokens * CHARS_PER_TOKEN);
  const original = body.text;
  let compressed: string;

  if (original.length <= targetChars) {
    compressed = original;
  } else if (strategy === "truncate") {
    compressed = truncateOnWordBoundary(original, targetChars);
  } else {
    compressed = extractiveSummarize(original, targetChars);
  }

  return c.json({
    original_length: original.length,
    compressed_length: compressed.length,
    ratio: Math.round((compressed.length / original.length) * 100) / 100,
    original_tokens_est: estimateTokens(original),
    compressed_tokens_est: estimateTokens(compressed),
    target_tokens: targetTokens,
    text: compressed,
    strategy,
  });
});

/** Cut to a budget without slicing a word in half. */
function truncateOnWordBoundary(text: string, targetChars: number): string {
  const slice = text.slice(0, targetChars);
  const lastSpace = slice.lastIndexOf(" ");
  return (
    lastSpace > targetChars * 0.8 ? slice.slice(0, lastSpace) : slice
  ).trim();
}

/**
 * Split into sentences, keeping paragraph structure and avoiding breaks on
 * common abbreviations ("Inc.", "e.g.", "Dr.") that would otherwise shatter
 * a sentence into fragments and distort the scoring.
 */
function splitSentences(text: string): string[] {
  const ABBREVIATIONS =
    /\b(?:[A-Z]|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Inc|Ltd|Co|Corp|vs|etc|e\.g|i\.e|al|Fig|No|Vol|approx)$/;

  const out: string[] = [];
  let current = "";

  for (let i = 0; i < text.length; i++) {
    current += text[i];

    const isParagraph = text[i] === "\n" && text[i + 1] === "\n";
    if (isParagraph) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }

    if (!/[.!?]/.test(text[i])) continue;

    // Only break when whitespace or end-of-text follows, so decimals and
    // domain names stay intact.
    const next = text[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;

    // Test only the tail. ABBREVIATIONS is anchored at the end but not the
    // start, so testing the whole accumulator is O(len) — and because a match
    // continues without resetting `current`, the accumulator grows without
    // bound. Input like "Dr. " repeated made this quadratic: 1 MB took 18s.
    if (ABBREVIATIONS.test(current.slice(-24, -1).trimEnd())) {
      // Force a hard break if one "sentence" has grown pathologically long,
      // so a crafted input degrades gracefully instead of running away.
      if (current.length < MAX_SENTENCE_CHARS) continue;
    }

    if (current.trim()) out.push(current.trim());
    current = "";
  }

  if (current.trim()) out.push(current.trim());
  return out.length > 0 ? out : [text.trim()];
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "and", "but", "or",
  "nor", "not", "so", "yet", "both", "either", "neither", "each",
  "every", "all", "any", "few", "more", "most", "other", "some",
  "such", "no", "only", "own", "same", "than", "too", "very",
  "just", "because", "if", "when", "while", "this", "that", "these",
  "those", "it", "its", "he", "she", "they", "them", "his", "her",
  "their", "we", "you", "i", "me", "my", "your", "our", "there",
  "here", "what", "which", "who", "whom", "how", "why", "then",
]);

/**
 * Extractive summarization by sentence scoring.
 *
 * Sentences are ranked by the mean frequency of their content words, with a
 * mild positional bonus (openings and closings carry disproportionate
 * information), then packed greedily into the character budget.
 */
function extractiveSummarize(text: string, targetChars: number): string {
  const sentences = splitSentences(text);
  if (sentences.length <= 1) return truncateOnWordBoundary(text, targetChars);

  // Unicode-aware. An ASCII-only split returns zero words for Chinese,
  // Arabic, Cyrillic, Hindi and so on, which zeroed every score and made the
  // endpoint useless for non-English callers.
  const words = (s: string) =>
    s.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);

  const wordFreq = new Map<string, number>();
  for (const sentence of sentences) {
    for (const w of words(sentence)) {
      if (!STOPWORDS.has(w) && w.length > 2) {
        wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
      }
    }
  }

  const maxFreq = Math.max(1, ...wordFreq.values());

  const scored = sentences.map((sentence, idx) => {
    const tokens = words(sentence);
    const content = tokens.filter((w) => !STOPWORDS.has(w) && w.length > 2);

    // Dividing by raw token count over-rewards very short sentences, so
    // normalize by sqrt of length instead.
    const raw = content.reduce(
      (sum, w) => sum + (wordFreq.get(w) ?? 0) / maxFreq,
      0,
    );
    let score = raw / Math.sqrt(Math.max(tokens.length, 1));

    const position = idx / sentences.length;
    if (position < 0.15 || position > 0.9) score *= 1.15;

    // A sentence with almost no content words is boilerplate.
    if (content.length < 2) score *= 0.3;

    return { text: sentence, score, idx };
  });

  // Drop near-duplicates, which are common in scraped page content.
  const seen = new Set<string>();
  const unique = scored.filter((s) => {
    const fingerprint = s.text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "")
      .slice(0, 80);
    // An empty fingerprint means "no letters or digits at all" (e.g. a line of
    // punctuation). Those are not duplicates of each other.
    if (fingerprint && seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });

  unique.sort((a, b) => b.score - a.score);

  // Pack greedily. The previous implementation stopped at the first sentence
  // that didn't fit, which threw away the remaining budget whenever a long
  // sentence happened to rank highly.
  const selected: typeof unique = [];
  let charCount = 0;
  for (const s of unique) {
    const cost = s.text.length + (selected.length > 0 ? 1 : 0);
    if (charCount + cost > targetChars) continue;
    selected.push(s);
    charCount += cost;
  }

  // Nothing fit — every sentence is longer than the budget.
  if (selected.length === 0) {
    return truncateOnWordBoundary(unique[0].text, targetChars);
  }

  selected.sort((a, b) => a.idx - b.idx);
  return selected.map((s) => s.text).join(" ");
}

export default app;
