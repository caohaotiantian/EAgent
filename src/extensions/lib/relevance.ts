/**
 * Dependency-free lexical relevance scoring shared by `handoff` (resume-injection
 * gate) and `memory` (archival query recall). Retrieval here is token-overlap over
 * salient words; `memory` layers optional semantic (embedding) recall on top via a
 * zero-dep `fetch` embedder.
 */

/**
 * A tiny, fixed stopword set dropped before relevance tokenization. Kept small
 * and explainable (no external word list, no dependency): just the highest-
 * frequency English function words that would otherwise inflate token overlap.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you",
  "are", "was", "were", "has", "had", "have", "will", "would", "should", "can",
  "but", "not", "all", "any", "out", "use", "via", "per", "its", "our",
]);

/**
 * Tokenize to lowercased salient tokens: split on non-`[a-z0-9]`, drop tokens
 * shorter than 3 chars and the fixed stopwords, dedupe. Deterministic and
 * dependency-free — the whole relevance gate is built on this.
 */
export function salientTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const tok of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length < 3) continue;
    if (STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/**
 * The lexical relevance score: the number of salient tokens `query` and `text`
 * share (the size of the set-intersection of their `salientTokens`). Zero when
 * they share none — used to rank archival recall matches and drop non-matches.
 */
export function overlapScore(query: string, text: string): number {
  const queryTokens = salientTokens(query);
  const textTokens = salientTokens(text);
  let shared = 0;
  for (const t of queryTokens) if (textTokens.has(t)) shared++;
  return shared;
}
