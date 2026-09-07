import type { ContextAction } from "./context-router.ts";

/** Semantic outcome a cheap, in-place judge returns for ONE recall/injection
 * decision. The judge evaluates the RECALL RESULT itself (好不好/充分不充分)
 * against the turn, not the correctness of the downstream answer.
 */
export type ContextRecallOutcome =
  /** 够且好用上: recall relevant + sufficient + actually used. */
  | "verified"
  /** 注入了但没用上 / 本不需注入: injected but this turn did not need it. */
  | "rejected"
  /** 没注入(abstain)且正确: choosing none/cue was the right call. */
  | "correctAbstain"
  /** 不足: the turn needed memory that was missing / the recall fell short. */
  | "insufficient"
  /** 有害/误导: injected memory was wrong/stale/contradictory (false positive). */
  | "falsePositive";

/** Actions that put memory content into the answer context. none/cue inject no
 * memory content, so they cannot be verified/rejected/false-positive. */
export const INJECTION_ACTIONS: ReadonlySet<ContextAction> = new Set([
  "resurface",
  "retrieve",
]);

/** RSCB-MC asymmetric outcome reward (Equation 12 minus the latency/token cost
 * terms, which are already subtracted at selection as lambda*K so they are NOT
 * folded in here). Coefficients preserve the design invariant
 *   |gamma| > |alpha| > |kappa| > 0  and  |gamma| > |iota| > |delta|,
 * i.e. a false-positive (harmful) injection is always the worst outcome and a
 * beneficial reuse beats a correct abstention. All values already sit in the
 * [-1, 1] reward envelope the router update and intervention admission need.
 */
const RSCB_REWARD: Record<ContextRecallOutcome, number> = {
  verified: 0.6,
  correctAbstain: 0.3,
  insufficient: -0.5,
  rejected: -0.2,
  falsePositive: -1.0,
};

const NEEDS_INJECTION: ReadonlySet<ContextRecallOutcome> = new Set([
  "verified",
  "rejected",
  "falsePositive",
]);
const NEEDS_ABSTAIN: ReadonlySet<ContextRecallOutcome> = new Set(["correctAbstain"]);

function assertConsistent(outcome: ContextRecallOutcome, action: ContextAction): void {
  const injected = INJECTION_ACTIONS.has(action);
  if (NEEDS_INJECTION.has(outcome) && !injected) {
    throw new Error(`outcome ${outcome} requires an injection action, got ${action}`);
  }
  if (NEEDS_ABSTAIN.has(outcome) && injected) {
    throw new Error(`outcome ${outcome} requires an abstain action (none/cue), got ${action}`);
  }
}

/** Asymmetric scalar reward for one executed recall/injection decision. The
 * judge returns a semantic outcome; this maps it to the scalar the neural net
 * consumes. Throws on judge/action inconsistency so a mislabeled row can never
 * silently feed training.
 */
export function contextUseReward(outcome: ContextRecallOutcome, action: ContextAction): number {
  assertConsistent(outcome, action);
  return RSCB_REWARD[outcome];
}

/** The recall-quality labels already produced by the existing natural feedback
 * path (nmg_remember action=feedback / ShadowFeedbackEvent), including the
 * optional memoryMisleading flag added for RSCB false positives. NULL/omitted
 * means "not reviewed", so it never votes.
 */
export interface ContextFeedbackLabels {
  taskSuccess?: boolean | null;
  userCorrection?: boolean | null;
  evidenceSufficient?: boolean | null;
  expansionUseful?: boolean | null;
  excessiveNoise?: boolean | null;
  noMemoryNeeded?: boolean | null;
  memoryMisleading?: boolean | null;
}

/** Explicit label -> RSCB outcome mapping (priority-ordered, never reinterprets
 * an existing label's meaning). Harmful memory dominates (gamma), then
 * not-needed (rejected), then shortfall (insufficient), then good-and-used
 * (verified); noise without verified signal falls to rejected. Returns null when
 * the labels carry no usable signal, so a sparse natural row is skipped rather
 * than mislabelled.
 */
export function contextOutcomeFromFeedback(
  labels: ContextFeedbackLabels,
): ContextRecallOutcome | null {
  if (labels.memoryMisleading === true) return "falsePositive";
  if (labels.noMemoryNeeded === true) return "rejected";
  if (labels.evidenceSufficient === false) return "insufficient";
  // Verified = the recalled evidence was sufficient and the task did not fail.
  // The model often sets only evidenceSufficient, so expansionUseful/taskSuccess
  // are NOT required; taskSuccess=false vetoes (contradictory -> no vote).
  if (labels.evidenceSufficient === true && labels.taskSuccess !== false) return "verified";
  if (labels.excessiveNoise === true) return "rejected";
  return null;
}
