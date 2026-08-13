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

/**
 * Distinctive content tokens used by the conservative implicit-use heuristic.
 *
 * Latin text keeps whole words (numbers at any length; words at length >= 4).
 * Contiguous Han text has no whitespace word boundary, so represent it with
 * character bigrams. Bigrams retain local phrase information without the very
 * high false-positive rate of single-character matching, and require no native
 * tokenizer dependency in the Pi extension.
 */
export function contentTokens(text: string): string[] {
  const segments = text.toLowerCase().match(/\p{Script=Han}+|[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const segment of segments) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      for (let index = 0; index < segment.length - 1; index += 1) {
        tokens.push(segment.slice(index, index + 2));
      }
      continue;
    }
    if (
      (/\p{N}/u.test(segment) && segment.length >= 1) ||
      (segment.length >= 4 && !FEEDBACK_STOPWORDS.has(segment))
    ) {
      tokens.push(segment);
    }
  }
  return [...new Set(tokens)];
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
  promptText?: string,
): string[] {
  const answerTokens = new Set(contentTokens(answerText));
  const promptTokens = new Set<string>();
  // Answer-vs-prompt differential: tokens that also appear in the prompt are
  // NOT evidence the memory was used. Recall follows the prompt (memories are
  // matched against it), so an answer that restates prompt words would be a
  // systematic false positive — tau would fit "answer↔prompt word overlap"
  // instead of retrieval quality. Drop prompt tokens from the contribution
  // set before measuring memory overlap.
  if (promptText) {
    for (const token of contentTokens(promptText)) {
      promptTokens.add(token);
      answerTokens.delete(token);
    }
  }
  return results
    .filter((result) => {
      // Score only the part of the memory that the prompt did not already
      // supply. Keeping prompt-shared tokens in the denominator makes a longer
      // recall question suppress true positives even when the answer contributes
      // all of the memory's new information.
      const tokens = contentTokens(result.memory.statement).filter(
        (token) => !promptTokens.has(token),
      );
      if (tokens.length === 0) return false;
      const overlap = tokens.filter((token) => answerTokens.has(token)).length;
      return overlap / tokens.length >= 0.5;
    })
    .map((result) => result.memory.id);
}
