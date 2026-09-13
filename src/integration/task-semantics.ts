/**
 * Task-unit semantics: a computed, read-only view of the contracts that already
 * exist (PatchTaskSpec, FrozenPatchTask, BoardTicket, cycle requirements, board
 * verdicts). It adds no schema, opens no database, calls no model, and publishes
 * nothing — see docs/design/task-unit-semantics.md and the proposed decision
 * record docs/decisions/proposed/2026-09-13-task-unit-semantics.md.
 *
 * Two rules from that design are enforced here rather than left to convention:
 *
 * 1. A fact has one predicate. `isAccepted` is the only acceptance test: verdict
 *    recorded, bound to the current artifact digest, on the current revision, and
 *    not cancelled. Dependency release and the status query both call it, so one
 *    path cannot accept on "an artifact exists" while another reads the board.
 * 2. Unsupported mappings are refused with a location, never dropped. A caller
 *    that passes `maxBytes` (a byte budget aliased as tokens), `deadlineMs`
 *    (execution limits re-expressed as wall clock), or an unknown requirement
 *    kind gets a refusal naming the task and the field.
 */
import { createHash } from "node:crypto";
import { nextTask, type DispatchTask } from "./ooo-execution.ts";
import {
  CONCLUSION_KINDS,
  MAX_PATCH_BUDGET,
  MAX_PATCH_LIMITS,
  preparePatchWork,
  type ConclusionKind,
  type PatchBudget,
  type PatchLimits,
} from "./ooo-patch.ts";
import type { PatchTaskSpec, ProbePlan, ProbeOperation } from "./ooo-board.ts";
import type { Requirement } from "./ooo-cycle.ts";

/** The obligations a legal unit must satisfy (design §最小合法任务单元). */
export const OBLIGATIONS = [
  "input-closure",
  "artifact-handoff",
  "permission-closure",
  "explicit-acceptance",
  "stoppable-voidable",
  "composition-fidelity",
] as const;
export type Obligation = (typeof OBLIGATIONS)[number];

/** A refusal names where the problem is: which task, which field, which
 *  obligation it would have satisfied. A refusal without a location is not
 *  actionable, so none is produced without one. */
export interface Refusal {
  task: string;
  field: string;
  obligation?: Obligation;
  reason: string;
}

/** Analysis view of one logical unit. Field names follow the existing contracts
 *  they are derived from; this is not a second input format. */
export interface TaskUnit {
  id: string;
  revision: string;
  index: number;
  instruction: string;
  /** null for a snapshot/internal unit: it carries no host patch definition. */
  patch: {
    digest: string;
    files: readonly string[];
    visible: readonly string[];
    editable: readonly string[];
    budget: PatchBudget;
    limits: PatchLimits;
    admittedConclusions: readonly ConclusionKind[];
  } | null;
  inputs: { files: readonly string[]; dependencies: readonly string[] };
  effects: {
    effect: string;
    operation: ProbeOperation | null;
    read: readonly string[];
    proposeWrite: readonly string[];
  };
  /** Conditions on recorded artifacts. Not dependencies: satisfying one does not
   *  schedule anything, and being a dependency does not satisfy one. */
  requires: readonly Requirement[];
  /** A declared external wait: not eligible until the event is ready. */
  waitEvent: string | null;
  obligations: readonly Obligation[];
}

export interface CompiledTasks {
  units: readonly TaskUnit[];
  refusals: readonly Refusal[];
  legal: boolean;
  /** Identity of the derived view, so a ticket or manifest can bind it. */
  digest: string;
}

export interface CompileInput {
  plan: ProbePlan;
  specs?: Readonly<Record<string, PatchTaskSpec>>;
  requires?: Readonly<Record<string, readonly Requirement[]>>;
}

/** Every field a host may put in a patch spec. Anything else is refused: the
 *  rejected aliases in the design (`maxBytes`, `deadlineMs`, `maxOutputTokens`)
 *  are how a byte budget becomes a token claim. */
const SPEC_FIELDS = new Set([
  "instruction",
  "files",
  "editable",
  "visible",
  "admittedConclusions",
  "budget",
  "limits",
  "verify",
]);
const LIMIT_FIELDS = new Set(["turns", "reads", "timeoutMs"]);
const BUDGET_FIELDS = new Set(["perFile", "output"]);
const REQUIREMENT_KINDS = new Set(["verified", "mutant-killed", "test-title"]);
/** The five obligations a single unit can satisfy; composition is checked on a split. */
const UNIT_OBLIGATIONS = [
  "input-closure",
  "artifact-handoff",
  "permission-closure",
  "explicit-acceptance",
  "stoppable-voidable",
] as const;

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unknownKeys(value: unknown, allowed: ReadonlySet<string>): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.keys(value as Record<string, unknown>).filter((key) => !allowed.has(key));
}

function within(value: unknown, maximum: PatchBudget | PatchLimits): boolean {
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return false;
  const ceiling = maximum as unknown as Record<string, number>;
  return entries.every(([key, entry]) => {
    const limit = ceiling[key];
    return (
      typeof entry === "number" &&
      Number.isFinite(entry) &&
      entry > 0 &&
      limit !== undefined &&
      entry <= limit
    );
  });
}

/** Every plan id, so a dependency or a spec can be checked against the plan itself. */
function collectIds(plan: ProbePlan, refusals: Refusal[]): Set<string> {
  const ids = new Set<string>();
  for (const row of plan) {
    const id = String(row[0]);
    if (ids.has(id))
      refusals.push({ task: id, field: "id", reason: "duplicate task id in the plan" });
    else ids.add(id);
  }
  return ids;
}

function refuseForeignSpecs(
  ids: ReadonlySet<string>,
  specs: CompileInput["specs"],
  refusals: Refusal[],
): void {
  for (const id of Object.keys(specs ?? {})) {
    if (ids.has(id)) continue;
    refusals.push({
      task: id,
      field: "spec",
      obligation: "input-closure",
      reason: "a patch spec exists for a task that is not in the plan",
    });
  }
}

/** Dependency closure: the named task exists in this plan and the edges are acyclic. */
function refuseDependencies(
  id: string,
  dependencies: readonly string[],
  ids: ReadonlySet<string>,
  edges: ReadonlyMap<string, readonly string[]>,
  refusals: Refusal[],
): void {
  const located = { task: id, field: "dependencies", obligation: "input-closure" as const };
  for (const dependency of dependencies) {
    if (!ids.has(dependency)) {
      refusals.push({ ...located, reason: `dependency ${dependency} is not a task in this plan` });
    }
    if (dependency === id) {
      refusals.push({ ...located, reason: "a task cannot depend on itself" });
    }
  }
  if (reaches(id, dependencies, edges)) {
    refusals.push({ ...located, reason: "dependency cycle" });
  }
}

function reaches(
  id: string,
  dependencies: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): boolean {
  const walk = (current: string, visiting: Set<string>): boolean =>
    (edges.get(current) ?? []).some(
      (next) => next === id || (!visiting.has(next) && walk(next, new Set(visiting).add(next))),
    );
  return dependencies.some((dependency) => walk(dependency, new Set([id])));
}

/** `requires` are conditions on recorded artifacts. A schedule dependency expressed
 *  as one, or a requirement naming a task outside the plan, is refused by name. */
function refuseRequirements(
  id: string,
  requirements: readonly Requirement[],
  ids: ReadonlySet<string>,
  dependencies: readonly string[],
  refusals: Refusal[],
): void {
  const located = { task: id, field: "requires", obligation: "input-closure" as const };
  for (const requirement of requirements) {
    const kind = (requirement as { kind?: unknown }).kind;
    const task = (requirement as { task?: unknown }).task;
    if (typeof kind !== "string" || !REQUIREMENT_KINDS.has(kind)) {
      refusals.push({
        ...located,
        reason: `unknown requirement kind ${String(kind)}; a schedule dependency is a dependency, not a requirement`,
      });
    } else if (typeof task !== "string" || !ids.has(task)) {
      refusals.push({
        ...located,
        reason: `requirement names ${String(task)}, which is not a task in this plan`,
      });
    } else if (typeof task === "string" && !dependencies.includes(task)) {
      // A Requirement is by its own contract a precondition on a *dependency's* accepted
      // artifact. A condition about a task this unit does not depend on would let a soft
      // assumption stand in for a real dependency: the unit would start without its input
      // and nothing in the plan would say so.
      refusals.push({
        ...located,
        obligation: "input-closure",
        reason: `requirement is about ${task}, which is not a declared dependency of this unit`,
      });
    }
  }
}

function refuseOutOfRange(id: string, spec: PatchTaskSpec, refusals: Refusal[]): void {
  const unknownBudget = unknownKeys(spec.budget, BUDGET_FIELDS);
  const unknownLimits = unknownKeys(spec.limits, LIMIT_FIELDS);
  for (const key of unknownBudget) {
    refusals.push({
      task: id,
      field: `budget.${key}`,
      reason: "unknown budget field; budgets are byte counts",
    });
  }
  for (const key of unknownLimits) {
    refusals.push({
      task: id,
      field: `limits.${key}`,
      reason:
        "unknown limit field; execution limits keep their units and are not wall-clock deadlines",
    });
  }
  // An unknown key is refused by name; do not also report a range it has no unit for.
  if (spec.budget && !unknownBudget.length && !within(spec.budget, MAX_PATCH_BUDGET)) {
    refusals.push({ task: id, field: "budget", reason: "budget exceeds the frozen maximum" });
  }
  if (spec.limits && !unknownLimits.length && !within(spec.limits, MAX_PATCH_LIMITS)) {
    refusals.push({ task: id, field: "limits", reason: "limits exceed the frozen maximum" });
  }
}

/** A split or a spec may narrow permissions, never widen them. */
function refusePermissionExpansion(
  id: string,
  spec: PatchTaskSpec,
  usable: ReadonlySet<string>,
  refusals: Refusal[],
): void {
  for (const [field, paths] of [
    ["visible", spec.visible],
    ["editable", spec.editable],
  ] as const) {
    for (const path of paths ?? []) {
      if (!usable.has(path)) {
        refusals.push({
          task: id,
          field,
          obligation: "permission-closure",
          reason: `${field} names ${path}, which is not in the frozen files`,
        });
      }
    }
  }
}

function refuseSpecFields(id: string, spec: PatchTaskSpec, refusals: Refusal[]): void {
  for (const key of unknownKeys(spec, SPEC_FIELDS)) {
    refusals.push({
      task: id,
      field: key,
      obligation: "artifact-handoff",
      reason: "unsupported field: extend the owning contract instead of aliasing it here",
    });
  }
  for (const kind of spec.admittedConclusions ?? []) {
    if (!CONCLUSION_KINDS.includes(kind)) {
      refusals.push({
        task: id,
        field: "admittedConclusions",
        reason: `unknown conclusion kind ${String(kind)}`,
      });
    }
  }
  if (typeof spec.verify !== "function") {
    refusals.push({
      task: id,
      field: "verify",
      obligation: "explicit-acceptance",
      reason: "the host must select a verifier; a unit without one cannot be accepted",
    });
  }
}

/** Freezing stays where it already lives: preparePatchWork composes FrozenPatchTask,
 *  and this view must not re-implement it. Its refusals arrive as thrown errors,
 *  which become located refusals rather than escapes. */
function freezeEnvelope(id: string, spec: PatchTaskSpec, refusals: Refusal[]): TaskUnit["patch"] {
  try {
    const { work, digest } = preparePatchWork({
      taskId: id,
      attempt: 1,
      instruction: spec.instruction,
      files: spec.files,
      editable: spec.editable,
      visible: spec.visible,
      admittedConclusions: spec.admittedConclusions,
      budget: spec.budget,
      limits: spec.limits,
    });
    return {
      digest,
      files: Object.keys(work.files).sort(),
      visible: [...work.visible],
      editable: [...work.editable],
      budget: work.budget,
      limits: work.limits,
      admittedConclusions: [...work.admittedConclusions],
    };
  } catch (error) {
    refusals.push({
      task: id,
      field: "spec",
      obligation: "artifact-handoff",
      reason: `the frozen envelope refuses this spec: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}

function frozenPatch(id: string, spec: PatchTaskSpec, refusals: Refusal[]): TaskUnit["patch"] {
  const usable = new Set(Object.keys(spec.files ?? {}));
  refuseSpecFields(id, spec, refusals);
  refuseOutOfRange(id, spec, refusals);
  refusePermissionExpansion(id, spec, usable, refusals);
  if (refusals.some((refusal) => refusal.task === id)) return null;
  return freezeEnvelope(id, spec, refusals);
}

/** Obligations this unit still satisfies, given what was refused about it. */
function survivingObligations(id: string, refusals: readonly Refusal[]): Obligation[] {
  return UNIT_OBLIGATIONS.filter(
    (obligation) =>
      !refusals.some((refusal) => refusal.task === id && refusal.obligation === obligation),
  );
}

function unitFor(
  row: ProbePlan[number],
  index: number,
  dependencies: readonly string[],
  spec: PatchTaskSpec | undefined,
  requires: readonly Requirement[],
  refusals: Refusal[],
): TaskUnit {
  const id = String(row[0]);
  const patch = spec ? frozenPatch(id, spec, refusals) : null;
  return {
    id,
    revision: String(row[1]),
    index,
    instruction: spec?.instruction ?? "",
    patch,
    inputs: { files: patch?.files ?? [], dependencies: [...dependencies] },
    effects: {
      effect: String(row[3]),
      operation: (row[5] ?? null) as ProbeOperation | null,
      read: patch?.visible ?? [],
      proposeWrite: patch?.editable ?? [],
    },
    requires: [...requires],
    waitEvent: row[4] === null || row[4] === undefined ? null : String(row[4]),
    obligations: survivingObligations(id, refusals),
  };
}

/** Derive the view. Pure: same input, same digest, no reads outside the arguments. */
export function compileTaskUnits(input: CompileInput): CompiledTasks {
  const refusals: Refusal[] = [];
  const plan = input.plan;
  const ids = collectIds(plan, refusals);
  refuseForeignSpecs(ids, input.specs, refusals);
  const edges = new Map<string, readonly string[]>(
    plan.map((row) => [String(row[0]), row[2].map(String)]),
  );
  const units: TaskUnit[] = [];
  for (const [index, row] of plan.entries()) {
    const id = String(row[0]);
    const dependencies = row[2].map(String);
    const requires = input.requires?.[id] ?? [];
    refuseDependencies(id, dependencies, ids, edges, refusals);
    refuseRequirements(id, requires, ids, dependencies, refusals);
    units.push(unitFor(row, index, dependencies, input.specs?.[id], requires, refusals));
  }
  return {
    units,
    refusals,
    legal: refusals.length === 0,
    digest: digestOf({ plan, requires: input.requires ?? {} }),
  };
}

/** Facts a run records. The verdict is bound to the artifact it judged: a verdict
 *  for another digest, or an artifact with no verdict, is not acceptance. */
export interface RecordedFacts {
  artifacts?: Readonly<Record<string, string>>;
  verdicts?: Readonly<
    Record<string, { digest: string; verdict: "accepted" | "rejected" | "undecidable" }>
  >;
  revisions?: Readonly<Record<string, string>>;
  cancellations?: readonly string[];
  /** External waits that have actually become ready. */
  externalReady?: readonly string[];
}

/** The facts a run records about one artifact. Delivery and acceptance are different
 *  facts: bytes can exist while the verdict is pending, rejected, or about another
 *  digest, and a rejection arriving later withdraws acceptance. */
export interface AcceptedFact {
  /** The stored artifact value, or null when nothing was delivered. */
  artifact: string | null;
  /** Digest of the artifact this fact describes, compared with `judgedDigest`. */
  digest: string | null;
  verdict: string | null;
  judgedDigest: string | null;
  /** False when the input revision the artifact was built from is no longer current. */
  currentRevision: boolean;
  cancelled?: boolean;
}

/** The single acceptance rule. The compiler's view and a round's stored rows both call
 *  this, so a dependency cannot be released by one path on "bytes exist" while another
 *  path reads the verdict. */
export function acceptedFact(fact: AcceptedFact): boolean {
  if (fact.cancelled) return false;
  if (!fact.artifact || !fact.digest) return false;
  if (!fact.currentRevision) return false;
  if (fact.verdict !== "accepted") return false;
  return fact.judgedDigest === fact.digest;
}

/** The one acceptance test over a derived view. Every caller that asks "is this
 *  accepted?" — the status query and dependency release alike — uses this and nothing
 *  else. Acceptance is not the existence of bytes. */
export function isAccepted(unit: Pick<TaskUnit, "id" | "revision">, facts: RecordedFacts): boolean {
  const recordedRevision = facts.revisions?.[unit.id];
  const artifact = facts.artifacts?.[unit.id] ?? null;
  const recorded = facts.verdicts?.[unit.id];
  return acceptedFact({
    artifact,
    digest: artifact,
    verdict: recorded?.verdict ?? null,
    judgedDigest: recorded?.digest ?? null,
    currentRevision: recordedRevision === undefined || recordedRevision === unit.revision,
    cancelled: facts.cancellations?.includes(unit.id) ?? false,
  });
}

export function dispatchTasks(units: readonly TaskUnit[], facts: RecordedFacts): DispatchTask[] {
  return units.map((unit) => ({
    id: unit.id,
    effect: unit.effects.effect,
    sourceVersion: unit.revision,
    observedVersion: facts.revisions?.[unit.id] ?? unit.revision,
    dependencies: [...unit.inputs.dependencies],
    accepted: isAccepted(unit, facts),
    claimed: false,
    externalEvent: unit.waitEvent ?? undefined,
    externalReady: facts.externalReady?.includes(unit.id) ?? false,
  }));
}

/** Status and dependency release share the derived dispatch state and the existing
 *  `nextTask` eligibility rule; neither gets its own notion of "accepted". */
export function deriveStatus(
  units: readonly TaskUnit[],
  facts: RecordedFacts,
): {
  ready: readonly string[];
  blocked: readonly { id: string; waitingFor: readonly string[] }[];
  accepted: readonly string[];
} {
  const accepted = units.filter((unit) => isAccepted(unit, facts)).map((unit) => unit.id);
  const acceptedIds = new Set(accepted);
  const candidate = nextTask(dispatchTasks(units, facts));
  const blocked = units
    .filter((unit) => !isAccepted(unit, facts))
    .map((unit) => ({
      id: unit.id,
      waitingFor: unit.inputs.dependencies.filter((dependency) => !acceptedIds.has(dependency)),
    }))
    .filter((entry) => entry.waitingFor.length > 0 || entry.id !== candidate);
  return { ready: candidate ? [candidate] : [], blocked, accepted };
}

/** Actions this slice can derive. Fusion and speculative preparation are named but
 *  not modelled: they are refused as unsupported rather than reported as empty. */
export const MODELLED_ACTIONS = ["next", "publish"] as const;
export const UNMODELLED_ACTIONS = ["fuse", "prepare"] as const;

/** A refinement is a host-declared split, not something a language model asserts. */
export interface RefinementSpec {
  parent: string;
  parts: readonly string[];
  join: string;
  /** Parent obligation → the part outputs that carry it. */
  obligations: Readonly<Partial<Record<Obligation, readonly string[]>>>;
}

function refuseUnmappedObligations(parent: TaskUnit, spec: RefinementSpec): Refusal[] {
  return parent.obligations
    .filter((obligation) => !(spec.obligations[obligation] ?? []).length)
    .map((obligation) => ({
      task: spec.parent,
      field: `obligations.${obligation}`,
      obligation: "composition-fidelity" as const,
      reason: "a parent obligation must map to at least one part output",
    }));
}

function refuseWidening(part: TaskUnit, parent: TaskUnit): Refusal[] {
  if (!parent.patch) return [];
  const allowed = new Set(parent.patch.editable);
  return (part.patch?.editable ?? [])
    .filter((path) => !allowed.has(path))
    .map((path) => ({
      task: part.id,
      field: "editable",
      obligation: "permission-closure" as const,
      reason: `a split may not widen the write set: ${path} is outside the parent's`,
    }));
}

/** A split may narrow obligations, never lose or enlarge them. */
export function checkRefinement(compiled: CompiledTasks, spec: RefinementSpec): Refusal[] {
  const byId = new Map(compiled.units.map((unit) => [unit.id, unit]));
  const parent = byId.get(spec.parent);
  if (!parent) {
    return [{ task: spec.parent, field: "parent", reason: "refinement parent is not in the plan" }];
  }
  const refusals: Refusal[] = spec.parts.includes(spec.join)
    ? []
    : [
        {
          task: spec.parent,
          field: "join",
          obligation: "composition-fidelity" as const,
          reason: "the join must be one of the parts",
        },
      ];
  for (const part of spec.parts) {
    const unit = byId.get(part);
    if (!unit) {
      refusals.push({ task: part, field: "parts", reason: "refinement part is not in the plan" });
      continue;
    }
    refusals.push(...refuseWidening(unit, parent));
  }
  return [...refusals, ...refuseUnmappedObligations(parent, spec)];
}
