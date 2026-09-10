/**
 * Turns a natural-language question into an FTS5 match expression.
 *
 * This exists because the two interfaces disagree. `meetings_search` takes
 * FTS5 syntax and reports a syntax error rather than guessing, which is right
 * for a caller composing a query deliberately. But `meetings_summarize` takes
 * a question a user actually asked -- "what did we decide about pricing?" --
 * and that string is not valid FTS5: the "?" is a syntax error, and even
 * without it, matching on "what", "did" and "we" would rank every meeting
 * that contains ordinary English equally.
 *
 * So the question is reduced to its distinctive terms and OR-ed. OR rather
 * than AND because this feeds a summarizer: recall matters more than
 * precision when a model will read the candidates and decide for itself what
 * is relevant. AND would silently drop the meeting that used a synonym.
 *
 * The terms that were actually searched are returned alongside, because a
 * summary built from the wrong retrieval should be debuggable without
 * guessing what the service did with the question.
 */

/**
 * Words carrying no retrieval value in a meeting question. Deliberately
 * conservative: only closed-class function words and the handful of framing
 * verbs that appear in almost every question asked of a transcript. Domain
 * words are never removed, because "budget" or "ship" may be the entire point
 * of the question.
 */
const STOPWORDS = new Set([
  "a", "about", "after", "again", "all", "also", "am", "an", "and", "any",
  "are", "around", "as", "at", "back", "be", "because", "been", "before",
  "being", "between", "both", "but", "by", "can", "could", "did", "do",
  "does", "doing", "done", "down", "during", "each", "for", "from", "further",
  "get", "got", "had", "has", "have", "having", "he", "her", "here", "hers",
  "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just",
  "know", "let", "like", "made", "make", "many", "me", "more", "most", "much",
  "my", "no", "nor", "not", "now", "of", "off", "on", "once", "one", "only",
  "or", "other", "our", "ours", "out", "over", "own", "said", "same", "say",
  "says", "she", "should", "so", "some", "someone", "something", "such",
  "than", "that", "the", "their", "theirs", "them", "then", "there", "these",
  "they", "this", "those", "through", "to", "too", "under", "until", "up",
  "us", "very", "was", "we", "were", "what", "when", "where", "whether",
  "which", "while", "who", "whom", "why", "will", "with", "would", "you",
  "your", "yours",
]);

/** Below this length a token is almost always noise once stopwords are gone. */
const MIN_TERM_LENGTH = 2;

/** More terms than this stops improving recall and starts costing latency. */
const MAX_TERMS = 12;

export interface QuestionQuery {
  /** FTS5 match expression, or null when the question had no usable terms. */
  match: string | null;
  /** The terms actually searched, in order. */
  terms: string[];
  /**
   * True when every word was a stopword, so the terms are the raw words
   * rather than a filtered set. The caller should treat a hit as weak.
   */
  fellBack: boolean;
}

/**
 * FTS5 treats many characters as operators. Rather than escaping selectively,
 * every term is emitted as a quoted string, which FTS5 reads as a literal.
 * Embedded double quotes are doubled, per FTS5's own escaping rule.
 */
function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

export function questionToFtsQuery(question: string): QuestionQuery {
  // Keep letters, digits and intra-word apostrophes/hyphens; everything else
  // is a separator. This drops "?", quotes, parentheses and the FTS5
  // operators in one pass instead of trying to enumerate them.
  const words = (question.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ??
    []).map((w) => w.replace(/^[-']+|[-']+$/g, "")).filter(Boolean);

  if (words.length === 0) return { match: null, terms: [], fellBack: false };

  const filtered = words.filter(
    (w) => w.length >= MIN_TERM_LENGTH && !STOPWORDS.has(w),
  );

  // A question made entirely of stopwords ("what did we say?") has no
  // retrievable content. Searching the stopwords anyway is better than
  // refusing, but the caller is told the retrieval was weak.
  const fellBack = filtered.length === 0;
  const chosen = (fellBack ? words : filtered).slice(0, MAX_TERMS);

  // De-duplicate while preserving order; repeating a term does not improve
  // an OR query.
  const terms = [...new Set(chosen)];

  return {
    match: terms.length ? terms.map(quote).join(" OR ") : null,
    terms,
    fellBack,
  };
}
