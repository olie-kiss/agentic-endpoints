import { describe, expect, it } from "vitest";
import { questionToFtsQuery } from "../src/lib/question";

/**
 * The failure this guards against is silent: a question that produces a
 * broken or empty FTS5 query yields no meetings, and a summarizer handed no
 * meetings will happily report that nothing was discussed.
 */
describe("question to FTS5 query", () => {
  it("keeps the distinctive words and drops the framing", () => {
    const q = questionToFtsQuery("What did we decide about pricing?");
    expect(q.terms).toEqual(["decide", "pricing"]);
    expect(q.match).toBe('"decide" OR "pricing"');
    expect(q.fellBack).toBe(false);
  });

  it("survives the punctuation FTS5 treats as operators", () => {
    // Unbalanced quotes and bare operators are a syntax error in FTS5, so
    // passing a raw question straight through would throw rather than search.
    const q = questionToFtsQuery('who owns the "migration* (and NOT the -audit)?');
    expect(q.match).not.toContain("*");
    expect(q.match).not.toContain("(");
    expect(q.terms).toContain("migration");
    expect(q.terms).toContain("audit");
  });

  it("quotes every term so none is read as syntax", () => {
    const q = questionToFtsQuery("AND OR NOT budget");
    // "budget" survives; the operator words are quoted literals, not syntax.
    expect(q.match).toContain('"budget"');
    expect(q.match?.startsWith("AND")).toBe(false);
  });

  it("ORs terms rather than ANDing them", () => {
    // A summarizer reads the candidates and decides relevance itself, so
    // recall beats precision. AND would drop a meeting using a synonym.
    const q = questionToFtsQuery("pricing migration deadline");
    expect(q.match).toBe('"pricing" OR "migration" OR "deadline"');
  });

  it("flags a question that was all stopwords instead of returning nothing", () => {
    // Returning no query would look identical to "nothing was discussed".
    const q = questionToFtsQuery("what did we say?");
    expect(q.fellBack).toBe(true);
    expect(q.terms.length).toBeGreaterThan(0);
    expect(q.match).not.toBeNull();
  });

  it("reports an unusable question honestly", () => {
    const q = questionToFtsQuery("??? !!! ...");
    expect(q.match).toBeNull();
    expect(q.terms).toEqual([]);
  });

  it("keeps hyphenated and possessive forms intact", () => {
    const q = questionToFtsQuery("what is the go-live date for Alice's team?");
    expect(q.terms).toContain("go-live");
    expect(q.terms).toContain("alice's");
  });

  it("does not repeat a term", () => {
    const q = questionToFtsQuery("pricing pricing pricing");
    expect(q.terms).toEqual(["pricing"]);
  });

  it("bounds the number of terms", () => {
    const q = questionToFtsQuery(
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar",
    );
    expect(q.terms.length).toBeLessThanOrEqual(12);
  });

  it("handles non-Latin scripts", () => {
    const q = questionToFtsQuery("¿qué decidimos sobre précios?");
    expect(q.terms).toContain("précios");
  });

  it("escapes an embedded double quote rather than breaking the expression", () => {
    const q = questionToFtsQuery('the "budget" call');
    // Quotes are stripped as separators, so the term is clean either way --
    // but the expression must never contain an unbalanced quote.
    const quotes = (q.match ?? "").split('"').length - 1;
    expect(quotes % 2).toBe(0);
  });
});
