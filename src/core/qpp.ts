/**
 * QPP (Query Performance Prediction) — post-retrieval confidence that the first
 * recall pass returned enough evidence. Drives the trigger for a second search
 * pass + expanded budget. See docs/retrieval-confidence-controller.md.
 *
 * This is a learned-weight NQC variant: `C = Top1 + τ_v·variance +
 * w_ic·intentCoverage + w_rh·reasonHealth`. Top1 is the anchor (implicit weight
 * 1.0); the other three terms catch distinct recall-coverage failure modes
 * (flat score distribution, type miss, all-fallback matches).
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
import { queryIntentFamilies } from "./store/search-ranking.ts";
import type {
  ActiveGraphSelection,
  MemorySearchResult,
  QppCandidate,
  QppComponents,
  QppTriggerDecision,
  QppWeights,
} from "./types.ts";

/**
 * Stage 1 initial weights (hand-set priors, ordered by signal informativeness
 * and non-redundancy). Replaced by Bayesian optimisation (Stage 1) then DC
 * gradient (Stage 2). Top1 carries implicit weight 1.0 as the NQC anchor.
 */
export const DEFAULT_QPP_WEIGHTS: QppWeights = { tauV: 0.3, wIc: 0.3, wRh: 0.2 };

/**
 * Stage 0/1 initial trigger threshold on C. Placeholder — must be calibrated on
 * the partial-evidence (16.67%) eval batch so its recall >= 0.8.
 */
export const DEFAULT_QPP_THRESHOLD = 0.45;

/**
 * Join final {@link MemorySearchResult}s with their {@link ActiveGraphSelection}
 * projections to build QPP candidates. Selections already carry `scores.usefulness`
 * and `reason`; results carry `memoryType`. graph_expansion selections are tagged
 * `isDirect=false` so score-based signals ignore them (their lexical/vector/route
 * scores are not from the search pass and would corrupt the distribution).
 */
export function qppCandidates(
  results: readonly MemorySearchResult[],
  selections: readonly ActiveGraphSelection[],
): QppCandidate[] {
  const byMemory = new Map(results.map((result) => [result.memory.id, result]));
  return selections.map((selection) => {
    const result = byMemory.get(selection.memoryId);
    return {
      usefulness: selection.scores.usefulness,
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
  const directUsefulness = direct.map((candidate) => clamp(candidate.usefulness, 0, 1));
  const top1 = directUsefulness.length === 0 ? 0 : Math.max(...directUsefulness);
  // stdev of [0,1]-bounded data is <= 0.5, so *2 maps to [0,1].
  const variance = clamp(stdev(directUsefulness) * 2, 0, 1);
  const reasonHealth =
    direct.length === 0
      ? 0
      : direct.filter((candidate) => candidate.reason !== "hybrid_match").length / direct.length;
  return {
    top1,
    variance,
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
  return (
    components.top1 +
    weights.tauV * components.variance +
    weights.wIc * components.intentCoverage +
    weights.wRh * components.reasonHealth
  );
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
