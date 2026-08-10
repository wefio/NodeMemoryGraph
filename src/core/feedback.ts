/**
 * Implicit feedback — derive which retrieved memories an answer actually used,
 * for rolling τ calibration without relying on the agent to call nmg_feedback.
 *
 * The weak reader (deepseek-v4-flash) rarely calls feedback tools, and AutoRecall
 * mode never calls nmg_get (so nmg_get's explicit feedback never fires). This
 * module matches the agent's answer text against the retrieved memory statements
 * to infer actual use. Precision-favoured: a noisy matcher yields noisy
 * calibration labels, not eval cheating (no eval outcomes are used).
 */
import type { MemorySearchResult } from "./types.ts";

const FEEDBACK_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "with",
  "was",
  "this",
  "his",
  "her",
  "you",
  "your",
  "they",
  "them",
  "are",
  "were",
  "from",
  "have",
  "has",
  "had",
  "not",
  "but",
  "all",
  "any",
  "can",
  "will",
  "would",
  "could",
  "about",
  "into",
  "than",
  "then",
  "when",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "where",
  "why",
  "how",
  "their",
  "there",
  "here",
  "just",
  "also",
  "some",
  "more",
  "most",
  "such",
  "only",
  "very",
  "been",
  "being",
  "did",
  "does",
  "doing",
  "done",
  "made",
  "make",
  "makes",
  "like",
  "said",
  "says",
  "want",
  "needs",
  "know",
  "really",
  "much",
  "many",
  "thing",
  "things",
  "stuff",
  "because",
  "since",
  "well",
  "even",
  "still",
  "both",
  "each",
]);

/** Distinctive content tokens: numbers (any length) + len>=4 non-stopword words. */
export function contentTokens(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [
    ...new Set(
      tokens.filter(
        (token) =>
          (/\d/.test(token) && token.length >= 1) ||
          (token.length >= 4 && !FEEDBACK_STOPWORDS.has(token)),
      ),
    ),
  ];
}

/**
 * A memory is "used" if >= half of its distinctive content tokens appear in the
 * answer. Catches both verbatim quotes and paraphrases; the 0.5 threshold is a
 * reasoned default (tunable by inspection, NOT by eval outcomes — that would be
 * cheating). Returns the memory IDs that pass.
 */
export function deriveUsedMemoryIds(
  answerText: string,
  results: readonly MemorySearchResult[],
): string[] {
  const answerTokens = new Set(contentTokens(answerText));
  return results
    .filter((result) => {
      const tokens = contentTokens(result.memory.statement);
      if (tokens.length === 0) return false;
      const overlap = tokens.filter((token) => answerTokens.has(token)).length;
      return overlap / tokens.length >= 0.5;
    })
    .map((result) => result.memory.id);
}
