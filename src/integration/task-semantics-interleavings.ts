/**
 * The design's last offline acceptance: enumerate the legal event interleavings of at most four
 * units and check, for every publication they allow, the publication's obligations, its inputs and
 * its source.
 *
 * This is a checker, not a second model. It owns no notion of acceptance: it reads the derived view
 * (`deriveStatus`, which itself calls the one acceptance predicate) and asks whether what that view
 * publishes is supported by the facts the interleaving recorded.
 *
 * The two publications are checked for what each one actually claims:
 *
 *   - a **dispatch** (`ready`) claims the run may hand this task out, so every declared input must be
 *     closed: present, current, un-cancelled and itself accepted by the same predicate. That is the
 *     design's "后继未过验收时不能偷跑";
 *   - a **completion** (the accepted set closed over the same predicate) claims this unit's bytes are
 *     accepted and that what it read from is closed: the verdict must judge those bytes, the bytes
 *     must exist, the unit must not be cancelled, and every input must be present, current,
 *     un-cancelled, accepted and attributable - an input whose verdict judged other bytes is not
 *     evidence about the input now. That is "历史 event 中曾 accepted 不表示当前仍 accepted" and
 *     "候选存在不等于接受".
 *
 * A completion is the dependency-closed set rather than the raw per-unit answer, because a completion
 * is the run saying "this unit is done", which is the same closure `nextTask`'s eligibility computes.
 * The per-unit acceptance query stays per-unit and is what the closure is built from: one predicate,
 * asked twice, which is what the design requires instead of two notions of "accepted".
 *
 * Passing says this finite model satisfies the listed properties. It does not say any Agent program
 * is correct - the design's own caveat.
 */
import {
  compileTaskUnits,
  deriveStatus,
  isAccepted,
  type CompileInput,
  type Obligation,
  type RecordedFacts,
  type TaskUnit,
} from "./task-semantics.ts";
import { checkedSlots } from "./ooo-execution.ts";
import { acceptedClosure } from "./task-semantics-model.ts";

/** The design's cap for the enumeration. Above it this refuses rather than grows. */
export const MAX_INTERLEAVING_UNITS = 4;

/** The budgets every enumeration checks by default: one slot, the rule the repository had, and two,
 *  the smallest declared budget that lets two claims coexist - which is what the C arm varies. A
 *  caller may declare others; each must be a positive integer. */
export const DEFAULT_BUDGETS: readonly number[] = [1, 2];
/** Events per enumerated interleaving. This cap is what keeps the enumeration finite: four units of
 *  three events each already merge 369,600 ways, so six is where "枚举合法交错" stays a check a test
 *  runs rather than a tool nobody runs. */
export const MAX_INTERLEAVING_EVENTS = 6;

export type InterleavingEventKind =
  | "deliver"
  | "redeliver"
  | "judge-accept"
  | "judge-reject"
  | "judge-undecidable"
  /** An accepted verdict bound to bytes other than the ones the unit delivered. */
  | "judge-stale-digest"
  | "cancel"
  | "claim"
  /** The input the unit read is no longer the current one. */
  | "revision-drift"
  | "external-ready";

export interface InterleavingEvent {
  unit: string;
  kind: InterleavingEventKind;
}

/** One unit's script: the events about that unit, in the order they can happen. An interleaving is
 *  an order-preserving merge of the scripts, and a script set is one script per unit. */
export interface UnitScript {
  unit: string;
  events: readonly InterleavingEventKind[];
}

export interface PublicationViolation {
  obligation: Obligation;
  /** Which publication this is about: a dispatch or a completion. */
  publication: "dispatch" | "completion";
  unit: string;
  /** Index of the event whose prefix this was checked at. */
  atStep: number;
  reason: string;
}

export interface InterleavingFinding extends PublicationViolation {
  interleaving: readonly InterleavingEvent[];
}

/** A property a declared claim budget must have, checked on a view the budget produced. These are
 *  not the unit obligations: a budget is a property of the run, not of a task. */
export interface BudgetViolation {
  property: BudgetProperty;
  /** The budget whose view broke it. */
  budget: number;
  unit: string;
  atStep: number;
  reason: string;
}

export type BudgetProperty =
  /** A task someone is working is not offered to a second worker, whatever the budget. */
  | "claimed-task-is-not-startable"
  /** A smaller budget's candidates stay candidates: a bigger budget adds, it does not replace. */
  | "a-bigger-budget-keeps-the-smaller-candidates";

export interface BudgetFinding extends BudgetViolation {
  interleaving: readonly InterleavingEvent[];
}

export interface InterleavingReport {
  units: readonly string[];
  interleavings: number;
  steps: number;
  /** Publications checked, summed over the declared budgets: each budget publishes its own set. */
  dispatches: number;
  completions: number;
  /** The declared budgets this report walked. */
  budgets: readonly number[];
  /** How often a bigger budget published a task a smaller one did not: the count that makes the
   *  budget's own effect on the model visible rather than assumed. */
  widened: number;
  /** Refusal, when the input cannot be enumerated at all. */
  refused?: string;
  findings: readonly InterleavingFinding[];
  /** What a declared budget did to the view that the declared budgets may not do. */
  budgetFindings: readonly BudgetFinding[];
}

const bytes = (unit: string, generation = 0): string => `${unit}-artifact-v${generation}`;
const JUDGE_VERDICTS: Readonly<Record<string, "accepted" | "rejected" | "undecidable">> = {
  "judge-accept": "accepted",
  "judge-reject": "rejected",
  "judge-undecidable": "undecidable",
};

interface MutableFacts {
  artifacts: Record<string, string>;
  verdicts: Record<string, { digest: string; verdict: "accepted" | "rejected" | "undecidable" }>;
  revisions: Record<string, string>;
  sourceRevisions: Record<string, string>;
  cancellations: string[];
  claimed: string[];
  externalReady: string[];
}

/** What one event records. Delivery records the bytes and the revision they were built from, so a
 *  later drift event is a fact about the run rather than a rewritten artifact. */
export function recordEvent(facts: MutableFacts, event: InterleavingEvent): void {
  const { unit, kind } = event;
  if (kind === "deliver") {
    facts.artifacts[unit] = bytes(unit);
    facts.revisions[unit] = "rev-1";
    return;
  }
  if (kind === "redeliver") {
    // New bytes for the same input revision: the verdict that judged the old bytes no longer
    // describes these, which is how acceptance withdraws without anyone cancelling anything.
    facts.artifacts[unit] = bytes(unit, 1);
    facts.revisions[unit] ??= "rev-1";
    return;
  }
  if (kind === "judge-stale-digest") {
    facts.verdicts[unit] = { digest: bytes(unit, 9), verdict: "accepted" };
    return;
  }
  const verdict = JUDGE_VERDICTS[kind];
  if (verdict) {
    // A verdict before any delivery is recorded with a digest for bytes that do not exist: the
    // interleaving may do that, and the publication check is what has to notice.
    facts.verdicts[unit] = { digest: facts.artifacts[unit] ?? bytes(unit), verdict };
    return;
  }
  if (kind === "cancel") facts.cancellations.push(unit);
  else if (kind === "claim") facts.claimed.push(unit);
  else if (kind === "external-ready") facts.externalReady.push(unit);
  else if (kind === "revision-drift") facts.sourceRevisions[unit] = "rev-2";
}

function emptyFacts(): MutableFacts {
  return {
    artifacts: {},
    verdicts: {},
    revisions: {},
    sourceRevisions: {},
    cancellations: [],
    claimed: [],
    externalReady: [],
  };
}

/** The facts one publication check reads, and where its findings go. */
interface CheckContext {
  byId: ReadonlyMap<string, TaskUnit>;
  facts: RecordedFacts;
  atStep: number;
  violations: PublicationViolation[];
}

function fail(
  context: CheckContext,
  publication: PublicationViolation["publication"],
  unit: string,
  obligation: Obligation,
  reason: string,
): void {
  context.violations.push({ obligation, publication, unit, atStep: context.atStep, reason });
}

const artifactOf = (facts: RecordedFacts, id: string): string | undefined => facts.artifacts?.[id];
const verdictOf = (
  facts: RecordedFacts,
  id: string,
): { digest: string; verdict: string } | undefined => facts.verdicts?.[id];
const cancelled = (facts: RecordedFacts, id: string): boolean =>
  facts.cancellations?.includes(id) ?? false;

// What a published input has to satisfy, whichever publication names it. Whether an input is
// current, and whether its bytes are the bytes its verdict judged, is the one acceptance predicate's
// answer rather than a second comparison here: a drifted input is an unaccepted input.
function checkInputs(
  context: CheckContext,
  unit: TaskUnit,
  publication: PublicationViolation["publication"],
): void {
  for (const dependency of unit.inputs.dependencies) {
    if (!artifactOf(context.facts, dependency)) {
      fail(
        context,
        publication,
        unit.id,
        "input-closure",
        `published while its declared input ${dependency} has no artifact`,
      );
      continue;
    }
    if (cancelled(context.facts, dependency))
      fail(
        context,
        publication,
        unit.id,
        "stoppable-voidable",
        `published although its input ${dependency} was cancelled`,
      );
    const dependencyUnit = context.byId.get(dependency);
    if (dependencyUnit && !isAccepted(dependencyUnit, context.facts))
      fail(
        context,
        publication,
        unit.id,
        "input-closure",
        `published although its input ${dependency} is not accepted`,
      );
  }
}

// A dispatch hands the unit out, so everything it will read has to be closed first, and a cancelled
// task is not handed out at all.
function checkDispatch(context: CheckContext, unit: TaskUnit): void {
  checkInputs(context, unit, "dispatch");
  if (cancelled(context.facts, unit.id))
    fail(
      context,
      "dispatch",
      unit.id,
      "stoppable-voidable",
      "dispatched although it was cancelled",
    );
}

// A completion claims this unit's bytes are accepted: the verdict must judge those bytes, the bytes
// must exist, the unit must not be cancelled, and its inputs must be closed.
function checkCompletion(context: CheckContext, unit: TaskUnit): void {
  const artifact = artifactOf(context.facts, unit.id);
  const verdict = verdictOf(context.facts, unit.id);
  // explicit-acceptance: a verdict is acceptance of the bytes it judged, not of the task.
  if (!verdict || verdict.verdict !== "accepted")
    fail(
      context,
      "completion",
      unit.id,
      "explicit-acceptance",
      `published as complete without an accepted verdict (${verdict?.verdict ?? "none"})`,
    );
  else if (verdict.digest !== artifact)
    fail(
      context,
      "completion",
      unit.id,
      "explicit-acceptance",
      `the accepted verdict judged ${verdict.digest} while the published bytes are ${artifact}`,
    );
  // artifact-handoff: what is published is an artifact, and there is no artifact without bytes.
  if (!artifact)
    fail(
      context,
      "completion",
      unit.id,
      "artifact-handoff",
      "published as complete with no delivered artifact",
    );
  if (cancelled(context.facts, unit.id))
    fail(
      context,
      "completion",
      unit.id,
      "stoppable-voidable",
      "published as complete although it was cancelled",
    );
  checkInputs(context, unit, "completion");
}

/**
 * Whether what the view publishes is supported by the recorded facts. The publications are given
 * rather than derived, so a hand-built violation can be handed in: that is what lets a deleted
 * condition here be caught by its own case instead of only by luck.
 */
export function checkPublications(
  units: readonly TaskUnit[],
  facts: RecordedFacts,
  publications: { dispatches?: readonly string[]; completions?: readonly string[] },
  atStep = 0,
): PublicationViolation[] {
  const context: CheckContext = {
    byId: new Map(units.map((unit) => [unit.id, unit])),
    facts,
    atStep,
    violations: [],
  };
  for (const id of publications.dispatches ?? []) {
    const unit = context.byId.get(id);
    if (unit) checkDispatch(context, unit);
  }
  for (const id of publications.completions ?? []) {
    const unit = context.byId.get(id);
    if (unit) checkCompletion(context, unit);
  }
  return context.violations;
}

/** Every interleaving of the scripts: an order-preserving merge, one event per step. */
function interleavings(scripts: readonly UnitScript[]): InterleavingEvent[][] {
  const out: InterleavingEvent[][] = [];
  const walk = (positions: number[], prefix: InterleavingEvent[]): void => {
    if (positions.every((position, index) => position === scripts[index]!.events.length)) {
      out.push([...prefix]);
      return;
    }
    for (const [index, script] of scripts.entries()) {
      const position = positions[index]!;
      const kind = script.events[position];
      if (kind === undefined) continue;
      const next = [...positions];
      next[index] = position + 1;
      walk(next, [...prefix, { unit: script.unit, kind }]);
    }
  };
  walk(
    scripts.map(() => 0),
    [],
  );
  return out;
}

function refusal(units: readonly string[], refused: string): InterleavingReport {
  return {
    units: [...units],
    interleavings: 0,
    steps: 0,
    dispatches: 0,
    completions: 0,
    budgets: [],
    widened: 0,
    refused,
    findings: [],
    budgetFindings: [],
  };
}

/**
 * What a declared budget must not do to the view it produced, given the publications themselves.
 *
 * The publications are given rather than derived, so a hand-built violation can be handed in: that is
 * what lets a deleted condition here be caught by its own case instead of only by luck.
 */
export function checkBudget(input: {
  budget: number;
  ready: readonly string[];
  claimed: readonly string[];
  /** What the next smaller declared budget published, when there is one. */
  smallerReady?: readonly string[];
  atStep?: number;
}): BudgetViolation[] {
  const atStep = input.atStep ?? 0;
  const out: BudgetViolation[] = [];
  for (const unit of input.ready)
    if (input.claimed.includes(unit))
      out.push({
        property: "claimed-task-is-not-startable",
        budget: input.budget,
        unit,
        atStep,
        reason: `the ${input.budget}-slot view offers ${unit} although it is already claimed`,
      });
  for (const unit of input.smallerReady ?? [])
    if (!input.ready.includes(unit))
      out.push({
        property: "a-bigger-budget-keeps-the-smaller-candidates",
        budget: input.budget,
        unit,
        atStep,
        reason: `the ${input.budget}-slot view dropped ${unit}, which a smaller budget published`,
      });
  return out;
}

/**
 * One prefix as every declared budget sees it: what each budget publishes, and the violations of the
 * budget's own obligations. Returned rather than pushed, so the walk over budgets and the walk over
 * interleavings each stay one loop deep - and the dependency-closed accepted set, which no budget
 * changes, is computed once per prefix rather than once per budget.
 */
function budgetViews(
  compiled: ReturnType<typeof compileTaskUnits>,
  facts: RecordedFacts,
  budgets: readonly number[],
  step: number,
): {
  published: string[][];
  accepted: readonly string[];
  findings: PublicationViolation[];
  budgetFindings: BudgetViolation[];
  widened: number;
} {
  const published: string[][] = [];
  const findings: PublicationViolation[] = [];
  const budgetFindings: BudgetViolation[] = [];
  // A run's completions are the dependency-closed accepted set: the same closure the dispatch rule
  // computes, over the one acceptance predicate.
  const accepted = [...acceptedClosure(compiled.units, (unit) => isAccepted(unit, facts))];
  let widened = 0;
  let smaller: readonly string[] | undefined;
  for (const budget of budgets) {
    const ready = [...deriveStatus(compiled.units, facts, budget).ready];
    if (smaller) widened += ready.filter((id) => !smaller!.includes(id)).length;
    for (const violation of checkPublications(
      compiled.units,
      facts,
      { dispatches: ready, completions: accepted },
      step,
    ))
      findings.push(violation);
    for (const violation of checkBudget({
      budget,
      ready,
      claimed: facts.claimed ?? [],
      ...(smaller ? { smallerReady: smaller } : {}),
      atStep: step,
    }))
      budgetFindings.push(violation);
    published.push(ready);
    smaller = ready;
  }
  return { published, accepted, findings, budgetFindings, widened };
}

/**
 * Enumerate every legal interleaving of one script set and check every publication at every prefix.
 * A prefix is checked rather than only the final state, because "published earlier and voided later"
 * is exactly the interleaving this exists for.
 *
 * Every prefix is walked once per declared budget: a run that admits N claims publishes a set the
 * one-slot run does not, and that set has to satisfy the same obligations plus the budget's own.
 */
export function enumerateInterleavings(input: {
  plan: CompileInput["plan"];
  specs?: CompileInput["specs"];
  requires?: CompileInput["requires"];
  scripts: readonly UnitScript[];
  budgets?: readonly number[];
}): InterleavingReport {
  const compiled = compileTaskUnits({
    plan: input.plan,
    specs: input.specs,
    requires: input.requires,
  });
  const ids = compiled.units.map((unit) => unit.id);
  if (!compiled.legal)
    return refusal(
      ids,
      `refused: the plan has ${compiled.refusals.length} refusal(s), so no interleaving is legal`,
    );
  if (compiled.units.length > MAX_INTERLEAVING_UNITS)
    return refusal(
      ids,
      `refused: ${compiled.units.length} units exceeds the enumeration's cap of ${MAX_INTERLEAVING_UNITS}`,
    );
  const known = new Set(ids);
  const scripted = new Set<string>();
  for (const script of input.scripts) {
    if (!known.has(script.unit))
      return refusal(
        ids,
        `refused: the script for ${script.unit} names a unit the plan does not have`,
      );
    if (scripted.has(script.unit))
      return refusal(
        ids,
        `refused: ${script.unit} has two scripts, so the merge would not be a legal order of that unit's events`,
      );
    scripted.add(script.unit);
  }
  const total = input.scripts.reduce((sum, script) => sum + script.events.length, 0);
  if (total > MAX_INTERLEAVING_EVENTS)
    return refusal(
      ids,
      `refused: ${total} events exceeds the enumeration's cap of ${MAX_INTERLEAVING_EVENTS}`,
    );

  const findings: InterleavingFinding[] = [];
  const budgetFindings: BudgetFinding[] = [];
  const budgets = [...(input.budgets ?? DEFAULT_BUDGETS)];
  for (const budget of budgets) {
    try {
      checkedSlots(budget);
    } catch {
      return refusal(ids, `refused: budget ${String(budget)} is not a positive integer`);
    }
  }
  let steps = 0;
  let dispatches = 0;
  let completions = 0;
  let widened = 0;
  const enumerated = interleavings(input.scripts);
  for (const interleaving of enumerated) {
    const facts = emptyFacts();
    for (const [step, event] of interleaving.entries()) {
      recordEvent(facts, event);
      steps += 1;
      const views = budgetViews(compiled, facts, budgets, step);
      for (const ready of views.published) dispatches += ready.length;
      completions += views.accepted.length;
      widened += views.widened;
      for (const violation of views.findings) findings.push({ ...violation, interleaving });
      for (const violation of views.budgetFindings)
        budgetFindings.push({ ...violation, interleaving });
    }
  }
  return {
    units: ids,
    interleavings: enumerated.length,
    steps,
    dispatches,
    completions,
    budgets,
    widened,
    findings,
    budgetFindings,
  };
}

export interface TableReport extends InterleavingReport {
  sets: number;
  perSet: readonly InterleavingReport[];
}

/** Run a table of script sets: the design's shapes are several orders of the same small plan, and a
 *  script set is one per-unit order, so the table is what covers them. */
export function enumerateTable(input: {
  plan: CompileInput["plan"];
  specs?: CompileInput["specs"];
  requires?: CompileInput["requires"];
  sets: readonly (readonly UnitScript[])[];
  budgets?: readonly number[];
}): TableReport {
  const perSet = input.sets.map((scripts) =>
    enumerateInterleavings({
      plan: input.plan,
      specs: input.specs,
      requires: input.requires,
      scripts,
      ...(input.budgets ? { budgets: input.budgets } : {}),
    }),
  );
  const refused = perSet.find((report) => report.refused);
  return {
    units: perSet[0]?.units ?? [],
    sets: perSet.length,
    perSet,
    interleavings: perSet.reduce((sum, report) => sum + report.interleavings, 0),
    steps: perSet.reduce((sum, report) => sum + report.steps, 0),
    dispatches: perSet.reduce((sum, report) => sum + report.dispatches, 0),
    completions: perSet.reduce((sum, report) => sum + report.completions, 0),
    budgets: perSet[0]?.budgets ?? [],
    widened: perSet.reduce((sum, report) => sum + report.widened, 0),
    findings: perSet.flatMap((report) => report.findings),
    budgetFindings: perSet.flatMap((report) => report.budgetFindings),
    ...(refused?.refused ? { refused: refused.refused } : {}),
  };
}

/** The plan the scripts are written against: one unit and one that depends on it. */
export const DESIGN_PLAN: CompileInput["plan"] = [
  ["P", "rev-1", [], "isolated-artifact", null, null],
  ["D", "rev-1", ["P"], "read-only", null, null],
];

/**
 * The script sets the design's traps are made of: bytes before and after the verdict, a verdict
 * bound to other bytes, a cancellation around a verdict, a redelivery after acceptance, an input
 * that drifted after the artifact was built, and the dependent whose input was rejected. Each set is
 * a legal order of one unit's events, so an interleaving of it is a legal order of the run's.
 */
export const DESIGN_SCRIPT_SETS: readonly (readonly UnitScript[])[] = [
  [{ unit: "P", events: ["cancel"] }],
  [{ unit: "P", events: ["deliver", "judge-accept"] }],
  [{ unit: "P", events: ["judge-accept", "deliver"] }],
  [{ unit: "P", events: ["deliver", "judge-stale-digest"] }],
  [{ unit: "P", events: ["deliver", "judge-accept", "redeliver"] }],
  [{ unit: "P", events: ["deliver", "revision-drift", "judge-accept"] }],
  [{ unit: "P", events: ["deliver", "cancel", "judge-accept"] }],
  [{ unit: "P", events: ["deliver", "judge-reject"] }],
  [{ unit: "P", events: ["deliver", "judge-undecidable"] }],
  [{ unit: "P", events: ["claim", "deliver", "judge-accept"] }],
  [{ unit: "P", events: ["deliver", "external-ready"] }],
  [
    { unit: "P", events: ["deliver", "judge-reject"] },
    { unit: "D", events: ["deliver", "judge-accept"] },
  ],
  [
    { unit: "P", events: ["deliver", "judge-accept"] },
    { unit: "D", events: ["deliver", "judge-accept"] },
  ],
  [
    { unit: "P", events: ["deliver", "judge-accept", "redeliver"] },
    { unit: "D", events: ["deliver", "judge-accept"] },
  ],
  [
    { unit: "P", events: ["deliver", "judge-accept"] },
    { unit: "D", events: ["deliver", "judge-stale-digest"] },
  ],
  [
    { unit: "P", events: ["deliver", "cancel"] },
    { unit: "D", events: ["deliver", "judge-accept"] },
  ],
  [
    { unit: "P", events: ["deliver"] },
    { unit: "D", events: ["deliver", "judge-accept"] },
  ],
];
