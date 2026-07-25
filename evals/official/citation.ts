/**
 * Answer-level citation signal.
 *
 * Benchmarks currently record whether a memory was retrieved but not whether
 * the model actually used it in its answer. A model might ignore retrieved
 * evidence entirely and answer from its own knowledge, which the official score
 * would not distinguish from a retrieval-aided answer.
 *
 * This module provides a lightweight, deterministic signal: it checks whether
 * the answer text contains substrings that match the retrieved evidence
 * content. It is NOT a judge — it measures surface-level reuse, not semantic
 * grounding. False positives (coincidental overlap on common words) and false
 * negatives (the model faithfully paraphrases but uses no verbatim substring)
 * are both expected.
 *
 * The signal is cheap enough to compute for every benchmark case and is written
 * into predictions alongside retrievedEvidenceIds so downstream analysis can
 * tell the difference between "retrieved and used" and "retrieved but ignored."
 */

export interface CitationSignal {
  /** How many retrieved source texts had at least one n-gram match in the answer. */
  citedCount: number;
  /** Total retrieved source texts checked. */
  totalRetrieved: number;
  /** The set of retrieved evidence IDs with at least one match. */
  citedEvidenceIds: Set<string>;
}

/**
 * Build a citation signal from the model's hypothesis and the retrieved
 * evidence texts indexed by their source ID.
 */
export function computeCitationSignal(
  hypothesis: string,
  retrievedEvidence: ReadonlyMap<string, string>,
): CitationSignal {
  const answer = hypothesis.toLocaleLowerCase().replace(/\s+/gu, " ").trim();
  if (!answer || retrievedEvidence.size === 0) {
    return { citedCount: 0, totalRetrieved: retrievedEvidence.size, citedEvidenceIds: new Set() };
  }
  const cited = new Set<string>();
  for (const [id, text] of retrievedEvidence) {
    if (textOverlapsAnswer(text, answer)) cited.add(id);
  }
  return { citedCount: cited.size, totalRetrieved: retrievedEvidence.size, citedEvidenceIds: cited };
}

function textOverlapsAnswer(evidence: string, answer: string): boolean {
  const tokens = evidence.toLocaleLowerCase().replace(/\s+/gu, " ").split(" ").filter(Boolean);
  // Build 5-token n-grams from the evidence and check whether any of them
  // appears verbatim in the answer. Five tokens is long enough that
  // coincidental matches on common words are rare, but short enough to catch
  // partial quotes.
  if (tokens.length < 5) return answer.includes(tokens.join(" "));
  for (let i = 0; i <= tokens.length - 5; i++) {
    const ngram = tokens.slice(i, i + 5).join(" ");
    if (answer.includes(ngram)) return true;
  }
  return false;
}
