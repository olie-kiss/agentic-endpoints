import { Hono } from "hono";
import type { Env, CompressRequest } from "../types";
import { errorResponse } from "../lib/utils";

const app = new Hono<{ Bindings: Env }>();

/**
 * POST /compress
 *
 * Token compression / context reduction for LLMs.
 * Agents pay $0.005 per call.
 *
 * Strategies:
 *   - "truncate"   — Hard cut to target_tokens (fast, lossy)
 *   - "extractive"  — Sentence scoring to keep most informative content (default)
 *
 * Body: { text, target_tokens?, strategy? }
 */
app.post("/", async (c) => {
  const body = await c.req.json<CompressRequest>();

  if (!body.text) {
    return errorResponse("text is required", 400);
  }

  const targetTokens = body.target_tokens ?? 1000;
  const strategy = body.strategy ?? "extractive";

  // Rough token estimate: ~4 chars per token for English
  const CHARS_PER_TOKEN = 4;
  const targetChars = targetTokens * CHARS_PER_TOKEN;

  const originalLength = body.text.length;
  let compressed: string;

  if (originalLength <= targetChars) {
    // Already under target
    compressed = body.text;
  } else if (strategy === "truncate") {
    compressed = body.text.slice(0, targetChars);
  } else {
    compressed = extractiveSummarize(body.text, targetChars);
  }

  return c.json({
    original_length: originalLength,
    compressed_length: compressed.length,
    ratio: Math.round((compressed.length / originalLength) * 100) / 100,
    text: compressed,
    strategy,
  });
});

/**
 * Basic extractive summarization by sentence scoring.
 * Ranks sentences by word frequency, keeps top-N until budget is filled.
 */
function extractiveSummarize(text: string, targetChars: number): string {
  const sentences = text.match(/[^.!?\n]+[.!?\n]+/g) ?? [text];

  // Build word frequency map (stopword-filtered)
  const stopwords = new Set([
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
    "their", "we", "you", "i", "me", "my", "your", "our",
  ]);

  const wordFreq = new Map<string, number>();
  for (const sentence of sentences) {
    const words = sentence.toLowerCase().split(/\W+/).filter(Boolean);
    for (const w of words) {
      if (!stopwords.has(w) && w.length > 2) {
        wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
      }
    }
  }

  // Score each sentence
  const scored = sentences.map((s, idx) => {
    const words = s.toLowerCase().split(/\W+/).filter(Boolean);
    const score = words.reduce(
      (sum, w) => sum + (wordFreq.get(w) ?? 0),
      0,
    ) / Math.max(words.length, 1);
    return { text: s.trim(), score, idx };
  });

  // Sort by score descending, pick until budget met
  scored.sort((a, b) => b.score - a.score);

  const selected: typeof scored = [];
  let charCount = 0;
  for (const s of scored) {
    if (charCount + s.text.length > targetChars) break;
    selected.push(s);
    charCount += s.text.length;
  }

  // Restore original order
  selected.sort((a, b) => a.idx - b.idx);

  return selected.map((s) => s.text).join(" ");
}

export default app;
