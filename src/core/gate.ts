import type { MemoryGateDecision } from "./types.ts";
import { normalizeRecallPhrase, selectRecallTerm } from "./recall-matcher.ts";
import { RECALL_VOCABULARY, type RecallTerm } from "./recall-vocabulary.ts";

/** Stateless classification; runtime owners supply their retained entries, including an empty pool. */
export function decideMemoryLoad(
  query: string,
  options: { sessionCue?: boolean; terms?: readonly RecallTerm[] } = {},
): MemoryGateDecision {
  const normalized = normalizeRecallPhrase(query);
  const term = selectRecallTerm(normalized, options.terms ?? RECALL_VOCABULARY);
  return recallTermDecision(term?.mode, !term && options.sessionCue);
}

export function recallTermDecision(
  mode?: RecallTerm["mode"],
  sessionCue = false,
): MemoryGateDecision {
  if (mode === "retrieve") {
    return {
      mode: "retrieve",
      confidence: 0.95,
      reason: "explicit_recall",
      maxTier: 3,
      limit: 12,
      graphHops: 1,
    };
  }
  if (mode === "cue" || sessionCue) {
    return {
      mode: "cue",
      confidence: 0.75,
      reason: sessionCue ? "session_recall_hint" : "memory_may_help",
      maxTier: 3,
      limit: 5,
      graphHops: 0,
    };
  }
  return {
    mode: "none",
    confidence: 0.9,
    reason: "memory_not_needed",
    maxTier: 0,
    limit: 0,
    graphHops: 0,
  };
}
