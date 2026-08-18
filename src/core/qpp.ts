/**
 * QPP (Query Performance Prediction) — post-retrieval confidence that the first
 * recall prefix returned enough evidence. Drives progressive expansion through
 * cumulative Fibonacci evidence tiers. See docs/design/fibonacci-progressive-recall.md
 * and docs/experiments/qpp-evidence-signal-experiments-2026-08-02.md.
 *
 * This is an NQC-anchored variant: `C = Top1 + wNqc·NQC`. Top1 keeps the
 * absolute-strength anchor (a single strong hit is enough), NQC adds the
 * normalised dispersion (stdev/mean of the top-k scores, clamped [0,1]) that
 * measures the top1 margin relative to the rest. intentCoverage and
 * reasonHealth are computed and recorded for shadow audits but no longer
 * contribute to C — on real benchmark traces they are constant (intentCoverage
 * 0.5 for untyped ingest, reasonHealth 1.0 for normal retrieval), which pushed
 * C to ~0.92 and made the trigger never fire (see audit-qpp-trigger-stats.ts).
 *
 * Stages:
 *   - Stage 0: hard threshold + permanent guardrail floor (this module).
 *   - Stage 1: weights learned via Bayesian optimisation on trace feedback.
 *   - Stage 2: Gumbel-Sigmoid DC makes the threshold itself differentiable.
 *
 * Not to be confused with `MemoryRecord.confidence` (per-memory extraction
 * trustworthiness) — QPP is retrieval sufficiency for the whole candidate set.
 *
 * Types (QppWeights / QppCandidate / QppComponents / QppTriggerReason /
 * QppTriggerDecision) live in types.ts alongside the other retrieval types.
 */
import { hybridScore, queryIntentFamilies } from "./store/search-ranking.ts";
import type {
  ActiveGraphSelection,
  MemorySearchResult,
  QppCandidate,
  QppComponents,
  QppTriggerDecision,
  QppWeights,
} from "./types.ts";

/**
 * Untrained engineered prior. Top1 carries implicit weight 1.0 as the absolute
 * anchor; NQC carries 0.5 so dispersion can request more evidence without
 * overwhelming a genuinely strong hit. It stays frozen until independently
 * labelled real-use traces justify calibration.
 */
export const DEFAULT_QPP_WEIGHTS: QppWeights = { wNqc: 0.5 };

/**
 * Stage 0/1 initial trigger threshold on C. C = Top1 + 0.5·NQC, so a single
 * strong hit (Top1 ≥ 0.7) clears it; a flat weak distribution does not.
 * Conservative uncalibrated operating point. Benchmark traces are regression
 * evidence only; a calibrated default requires held-out, production-like
 * sufficiency and cost labels.
 */
export const DEFAULT_QPP_THRESHOLD = 0.55;

/**
 * First-pass evidence target for the Fibonacci walk (replaces starting at 1).
 * Starts near the measured efficiency sweet spot (13 on LoCoMo: 61% of
 * queries fully covered; vs top-20 the walk measures -28% records, -29%
 * noise at equal-or-better coverage). Most queries resolve in one pass; the
 * caller's LLM only appends when its own sufficiency judgement says evidence
 * is still missing (append IS the tier walk, judged by the consumer model).
 * Config knob: search options.initialEvidenceTarget / NMG_AUTO_RECALL_INITIAL_TARGET.
 */
export const DEFAULT_INITIAL_EVIDENCE_TARGET = 13;

/**
 * Strong single-evidence hit: when the relative top1→top2 margin exceeds this
 * threshold, measured median K_need collapses to ~3 (LoCoMo, BGE vectors).
 * Only real score cliffs trigger early-stop; top1 magnitude alone does not
 * (median K_need stays ~7 even at top1 ≥ 0.7).
 */
export const STRONG_HIT_TOP_GAP = 0.05;
export const STRONG_HIT_INITIAL_TARGET = 3;

export const QPP_TOP1_FLOOR = 0.2;

/**
 * Join final {@link MemorySearchResult}s with their {@link ActiveGraphSelection}
 * projections to build QPP candidates. Strength is recomputed as `hybridScore` from
 * the component scores (lexical/vector/route) — NOT `combinedScore`, whose scale is
 * path-inconsistent (bounded hybridScore on the lexical path, raw lexical ~84 on
 * some vector paths). hybridScore is always bounded [0,1] via `boundedLexical`.
 * graph_expansion selections are tagged `isDirect=false` so score-based signals
 * ignore them (their scores are not from the search pass).
 */
export function qppCandidates(
  results: readonly MemorySearchResult[],
  selections: readonly ActiveGraphSelection[],
): QppCandidate[] {
  const byMemory = new Map(results.map((result) => [result.memory.id, result]));
  return selections.map((selection) => {
    const result = byMemory.get(selection.memoryId);
    return {
      strength: hybridScore(
        selection.scores.lexical,
        selection.scores.vector,
        selection.scores.route,
      ),
      reason: selection.reason,
      // A missing join is a projection bug; fall back to a neutral type rather
      // than throwing so QPP degrades gracefully instead of breaking retrieval.
      memoryType: result?.memory.memoryType ?? "fact",
      isDirect: selection.source === "direct",
    };
  });
}

export function computeQppComponents(
  query: string,
  candidates: readonly QppCandidate[],
): QppComponents {
  const direct = candidates.filter((candidate) => candidate.isDirect);
  // strength = hybridScore is already bounded [0,1] and path-consistent; clamp
  // for safety (vector/route could marginally exceed 1 on some embedders).
  const directStrength = direct.map((candidate) => clamp(candidate.strength, 0, 1));
  const top1 = directStrength.length === 0 ? 0 : Math.max(...directStrength);
  // stdev of [0,1]-bounded values is <= 0.5, so *2 maps to [0,1].
  const variance = clamp(stdev(directStrength) * 2, 0, 1);
  // NQC: std(top-k) / mean(top-k). Measures the top1 margin relative to the
  // rest of the visible list (0 when k < 2, which keeps single-hit queries on
  // the top1 anchor alone).
  const nqc = clamp(nqcDispersion(directStrength), 0, 1);
  // Relative top1→top2 margin on the bounded strength scale. Fewer than 2
  // direct candidates means no observable margin — neutral 0.
  const topGap =
    directStrength.length < 2 || directStrength[0]! <= 0
      ? 0
      : clamp((directStrength[0]! - directStrength[1]!) / directStrength[0]!, 0, 1);
  const reasonHealth =
    direct.length === 0
      ? 0
      : direct.filter((candidate) => candidate.reason !== "hybrid_match").length / direct.length;
  return {
    top1,
    variance,
    nqc,
    topGap,
    intentCoverage: computeIntentCoverage(query, candidates),
    reasonHealth,
    directCount: direct.length,
    totalCount: candidates.length,
  };
}

/**
 * intentCoverage = matched intent families whose expected memory type appears
 * in the candidate set, divided by matched families. When the query matches no
 * intent family (vanilla factual query) there is no expected type, so the
 * signal carries no information — return neutral 0.5 so it neither rewards nor
 * penalises single-hop fact lookups.
 */
function computeIntentCoverage(query: string, candidates: readonly QppCandidate[]): number {
  const families = queryIntentFamilies(query);
  if (families.length === 0) return 0.5;
  const presentTypes = new Set(candidates.map((candidate) => candidate.memoryType));
  const covered = families.filter((family) =>
    family.expectedTypes.some((type) => presentTypes.has(type)),
  ).length;
  return covered / families.length;
}

/** Compose the QPP score C from precomputed components and weights. */
export function composeQpp(
  components: QppComponents,
  weights: QppWeights = DEFAULT_QPP_WEIGHTS,
): number {
  return components.top1 + weights.wNqc * components.nqc;
}

/** Full QPP score C for a query + candidates. */
export function computeQpp(
  query: string,
  candidates: readonly QppCandidate[],
  weights: QppWeights = DEFAULT_QPP_WEIGHTS,
): number {
  return composeQpp(computeQppComponents(query, candidates), weights);
}

/**
 * Stage 0 trigger decision: fire a second pass when C < threshold, OR when the
 * permanent guardrail floor trips (catastrophically empty result set, or every
 * direct match is a hybrid_match fallback). The guardrail survives Stage 1/2 —
 * a learned gate that says "don't trigger" while results are all-fallback must
 * still trigger, because hybrid_match means no real search signal matched.
 */
export function shouldTriggerSecondPass(
  query: string,
  candidates: readonly QppCandidate[],
  threshold: number = DEFAULT_QPP_THRESHOLD,
  weights: QppWeights = DEFAULT_QPP_WEIGHTS,
): QppTriggerDecision {
  const components = computeQppComponents(query, candidates);
  const qpp = composeQpp(components, weights);
  if (components.totalCount === 0) {
    return { trigger: true, reason: "guardrail_empty", qpp, threshold, components };
  }
  if (components.directCount > 0 && components.reasonHealth === 0) {
    return { trigger: true, reason: "guardrail_all_fallback", qpp, threshold, components };
  }
  if (components.top1 < QPP_TOP1_FLOOR) {
    return { trigger: true, reason: "guardrail_low_top1", qpp, threshold, components };
  }
  if (qpp < threshold) {
    return { trigger: true, reason: "below_threshold", qpp, threshold, components };
  }
  return { trigger: false, reason: "ok", qpp, threshold, components };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** NQC normalised dispersion: std / mean, or 0 when fewer than 2 values. */
function nqcDispersion(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 1e-9) return 0;
  return stdev(values) / mean;
}
