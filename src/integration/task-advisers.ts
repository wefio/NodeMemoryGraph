/**
 * The seam between "what may be started" and "what is started first".
 *
 * The shared rules own legality (`selectableTasks`), and this module owns nothing else: an adviser
 * is handed a bounded projection and may only *rank* the legal set it is given. The four steps the
 * design fixes are visible in the shape of the types rather than in a convention:
 *
 *   1. `selectableTasks` computes the legal candidates. An adviser never computes or widens them.
 *   2. A source sees `AdviceProjection` - the admitted, bounded view - and answers with suggestions.
 *   3. `orderCandidates` orders *inside* that set: the result is always a permutation of its input.
 *   4. `revalidateSuggestion` re-checks an adopted ranking at the claim or commit point, because a
 *      score computed earlier is not a write licence.
 *
 * Nothing here enables a capability. The module holds no state, opens no store and reads no graph,
 * so it cannot leak a suggestion from one session or branch into another: the projection carries
 * both identities and a suggestion whose provenance disagrees with them is refused by name. A run
 * with no source, or with a source that is disabled or failing, orders the legal set exactly as the
 * rule policy does.
 *
 * Two design sentences are load-bearing and are enforced by what the code *cannot* express:
 *
 *  - A new task or a new dependency is not a suggestion. There is no field for one: the only action
 *    a suggestion may name is `next`, and `next` must land on a task that is already in the legal
 *    set. Changing the plan is an explicit plan revision, which is a different operation.
 *  - A soft premise is not a dependency. `assumptions` are carried as provenance and are never
 *    consulted for legality - a source that asserts "the dependency is satisfied" changes nothing,
 *    because membership of the legal set was decided before it was asked.
 *
 * `fuse` and `prepare` are named in the shared vocabulary and are not modelled (`UNMODELLED_ACTIONS`);
 * a source that proposes either is refused as unsupported rather than scored.
 */
import type { Refusal } from "./task-semantics.ts";

/** The two owners the design names as optional advisers. Not a gate: a source is passed in. */
export const ADVISER_KINDS = ["ha", "mgr"] as const;
export type AdviserKind = (typeof ADVISER_KINDS)[number];

/**
 * What an adviser may see.
 *
 * Everything here is either an identity the run already has or a fact the shared layer already
 * derived. The projection is built per decision and passed by value, which is what keeps one
 * session's or branch's suggestion out of another's: there is no place to remember it.
 */
export interface AdviceProjection {
  sessionId: string;
  branchId: string;
  /** The scoring parameters' version. A different version makes an old score a new score. */
  parametersVersion: string;
  /** The projection's version; a changed projection is not the same input. */
  projectionVersion: string;
  /**
   * The observation order the scores were taken in, and whatever initial time state they started
   * from. A source that cannot name them is re-scored rather than reported as a reproduction.
   */
  observationOrder?: readonly string[];
  initialState?: string;
  /** The legal candidates, in the rule policy's order. */
  legal: readonly string[];
  ready: readonly string[];
  accepted: readonly string[];
  blocked: Readonly<Record<string, readonly string[]>>;
}

/** Where a score came from, and what it was computed against. */
export interface SuggestionProvenance {
  sourceId: string;
  kind: AdviserKind;
  sessionId: string;
  branchId: string;
  parametersVersion: string;
  projectionVersion: string;
  observationOrder?: readonly string[];
  initialState?: string;
}

export interface Suggestion {
  /**
   * The only action a suggestion may name. `fuse` and `prepare` are unmodelled shared actions: a
   * suggestion cannot start speculative execution or merge units into one acceptance.
   */
  action: string;
  /** Must be a member of the legal set it was asked about. */
  taskId: string;
  score: number;
  provenance: SuggestionProvenance;
  /**
   * Soft premises and hypothesis markers. They explain a score; they never make a task legal, and
   * they are not read for legality here.
   */
  assumptions?: readonly string[];
}

export interface SuggestionSource {
  readonly id: string;
  readonly kind: AdviserKind;
  /**
   * A disabled source is not called at all. Its absence must not be silent, so the outcome records
   * it as a fallback and the rule policy still answers.
   */
  enabled?: boolean;
  suggest(projection: AdviceProjection): readonly Suggestion[];
}

export interface AdviceFallback {
  sourceId: string;
  reason: string;
}

/** A score that could not be attributed to the projection it claimed: it is new, not a replay. */
export interface RescoredSuggestion {
  sourceId: string;
  taskId: string;
  /** The inputs that were missing or different, so the caller can say what changed. */
  missing: readonly string[];
}

export interface AdviceOutcome {
  /** A permutation of the input set: an ordering, never a different set. */
  order: readonly string[];
  adopted: readonly { sourceId: string; taskId: string; score: number }[];
  refusals: readonly Refusal[];
  fallbacks: readonly AdviceFallback[];
  rescored: readonly RescoredSuggestion[];
}

const RULE_POLICY_FIELD = "policy";
/** How a refusal says "this proposal is not a suggestion the shared layer can adopt". */
const SUGGESTION_FIELD = "suggestion";

/**
 * Order the legal set with whatever optional sources are given.
 *
 * The policy is stated once and is deliberately dull: tasks a source corroborated come first, in
 * score order (ties keep the rule order), and everything else keeps the rule order. With no
 * adopted suggestion the result equals the input, so a run without a source is byte-identical to
 * the rule policy - which is what the design's "no stable gain, keep the rule policy" needs to be
 * measurable rather than asserted.
 */
export function orderCandidates(
  legal: readonly string[],
  projection: Omit<AdviceProjection, "legal">,
  sources: readonly SuggestionSource[] = [],
): AdviceOutcome {
  const refusals: Refusal[] = [];
  const fallbacks: AdviceFallback[] = [];
  const rescored: RescoredSuggestion[] = [];
  const adopted: { sourceId: string; taskId: string; score: number }[] = [];
  const legalSet = new Set(legal);
  const full: AdviceProjection = { ...projection, legal };

  for (const source of sources) {
    if (source.enabled === false) {
      fallbacks.push({ sourceId: source.id, reason: "source is disabled" });
      continue;
    }
    let suggestions: readonly Suggestion[];
    try {
      suggestions = source.suggest(full);
    } catch (error) {
      // A failing adviser is an absent adviser: the rule policy answers, and the run records why.
      fallbacks.push({
        sourceId: source.id,
        reason: `source failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    for (const suggestion of suggestions) {
      const refusal = refuseSuggestion(suggestion, source, projection, legalSet);
      if (refusal) {
        refusals.push(refusal);
        continue;
      }
      const missing = missingValidityInputs(suggestion.provenance, projection);
      if (missing.length > 0) {
        // The score exists but its inputs do not: this is a new score about the current state, and
        // reporting it as a reproduction would claim a history nobody recorded.
        rescored.push({ sourceId: source.id, taskId: suggestion.taskId, missing });
        continue;
      }
      adopted.push({ sourceId: source.id, taskId: suggestion.taskId, score: suggestion.score });
    }
  }

  return { order: orderByAdopted(legal, adopted), adopted, refusals, fallbacks, rescored };
}

/**
 * Re-check an adopted ranking where the write happens.
 *
 * A score is a statement about the state it was computed against. By the time a claim is written,
 * the set may have moved - the task may be accepted, cancelled, or claimed by someone else - so the
 * ranking is checked against the set as it is now, not as it was.
 */
export function revalidateSuggestion(
  adopted: { sourceId: string; taskId: string },
  legalNow: readonly string[],
): Refusal | null {
  return legalNow.includes(adopted.taskId)
    ? null
    : {
        task: adopted.taskId,
        field: RULE_POLICY_FIELD,
        reason:
          `the suggestion from ${adopted.sourceId} ranks a task that is no longer a legal ` +
          "candidate: a score computed earlier is not a write licence",
      };
}

function refuseSuggestion(
  suggestion: Suggestion,
  source: SuggestionSource,
  projection: Omit<AdviceProjection, "legal">,
  legalSet: ReadonlySet<string>,
): Refusal | null {
  if (suggestion.action !== "next") {
    return {
      task: suggestion.taskId,
      field: "action",
      reason:
        `a suggestion may only rank inside the legal set; ${suggestion.action} is not a modelled ` +
        "action, and starting speculative execution or merging units is not a ranking",
    };
  }
  if (!legalSet.has(suggestion.taskId)) {
    return {
      task: suggestion.taskId,
      field: SUGGESTION_FIELD,
      reason:
        `${source.id} suggested a task outside the legal candidate set; a score orders the set it ` +
        "was given and cannot add to it, and a dependency is satisfied by an accepted artifact " +
        "rather than by a premise",
    };
  }
  const provenance = suggestion.provenance;
  if (
    provenance.sessionId !== projection.sessionId ||
    provenance.branchId !== projection.branchId
  ) {
    return {
      task: suggestion.taskId,
      field: "provenance",
      reason:
        `a suggestion scored in session/branch ${provenance.sessionId}/${provenance.branchId} is ` +
        `not reused in ${projection.sessionId}/${projection.branchId}`,
    };
  }
  return null;
}

/**
 * Which inputs the projection would have to carry for this score to be a reproduction of it.
 *
 * A version that differs is reported the same way a missing input is: both mean the old score was
 * taken from a different state, and neither may be presented as the same reading.
 */
function missingValidityInputs(
  provenance: SuggestionProvenance,
  projection: Omit<AdviceProjection, "legal">,
): readonly string[] {
  const missing: string[] = [];
  if (provenance.parametersVersion !== projection.parametersVersion)
    missing.push(`parametersVersion=${provenance.parametersVersion}`);
  if (provenance.projectionVersion !== projection.projectionVersion)
    missing.push(`projectionVersion=${provenance.projectionVersion}`);
  if (!provenance.observationOrder?.length) missing.push("observationOrder");
  else if (!sameOrder(provenance.observationOrder, projection.observationOrder))
    missing.push(`observationOrder=${provenance.observationOrder.join(",")}`);
  if (!provenance.initialState) missing.push("initialState");
  else if (provenance.initialState !== projection.initialState)
    missing.push(`initialState=${provenance.initialState}`);
  return missing;
}

function sameOrder(left: readonly string[], right: readonly string[] | undefined): boolean {
  return !!right && left.length === right.length && left.every((id, index) => id === right[index]);
}

function orderByAdopted(
  legal: readonly string[],
  adopted: readonly { sourceId: string; taskId: string; score: number }[],
): readonly string[] {
  if (adopted.length === 0) return legal;
  const best = new Map<string, number>();
  for (const entry of adopted) {
    const current = best.get(entry.taskId);
    if (current === undefined || entry.score > current) best.set(entry.taskId, entry.score);
  }
  const ruleOrder = new Map(legal.map((id, index) => [id, index]));
  return [...legal].sort((left, right) => {
    const leftScore = best.get(left);
    const rightScore = best.get(right);
    if (leftScore === undefined && rightScore === undefined)
      return (ruleOrder.get(left) ?? 0) - (ruleOrder.get(right) ?? 0);
    if (leftScore === undefined) return 1;
    if (rightScore === undefined) return -1;
    return rightScore - leftScore || (ruleOrder.get(left) ?? 0) - (ruleOrder.get(right) ?? 0);
  });
}
