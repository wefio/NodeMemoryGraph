// The granularity arms' driver: run one legal plan, with a chosen number of execution slots.
//
// Why this driver exists at all: the arms need the same parent task at two granularities, which is
// its own driver and not a parameter of some other one. The decision, with the couplings measured
// behind it, is `docs/decisions/implemented/2026-09-17-arms-get-their-own-driver.md`; the round this
// header used to be written beside was retired in
// `docs/decisions/implemented/2026-09-18-retire-the-round-instrument.md`, which is also where the
// interleaving this driver carries (a unit's check outstanding while another unit works) is pinned.
//
// What it does **not** duplicate: the rules and the ordering. `BoardAdmission.candidates()` is the
// ordered legal set from the shared semantics, and this driver only decides how *many* of them to
// start at once:
//
//   - `slots: 1`  - one legal unit at a time, each to acceptance: the B arm.
//   - `slots: N`  - every legal unit at once, up to N in flight: the C arm.
//
// Everything else is the shared layer's: the claim/attempt/fact writes, the candidate verification a
// unit's own `verify` performs, the accepted-artifact identity a dependent binds to. The driver adds
// only the dispatch policy, the timing, and the parent check at the end.
//
// Usage:
//   node --experimental-strip-types evals/ooo-execution/plan-driver.ts run --spec <spec.json> \
//     --slots <n> --out <file> [--live]
//   node --experimental-strip-types evals/ooo-execution/plan-driver.ts compare --spec <spec.json> \
//     --out <file> [--live]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  BoardAdmission,
  type PatchTaskSpec,
  type ProbePlan,
} from "../../src/integration/ooo-board.ts";
import { verifyDataChecks } from "../../src/integration/ooo-candidate.ts";
import type { PatchSubmission } from "../../src/integration/ooo-patch.ts";
import type { DataCheck } from "../../src/integration/ooo-candidate.ts";
import { testFileCheck } from "./data-check-runner.ts";
import type { SessionPlan } from "../../src/integration/ooo-execution.ts";
import { dispatchPlan, type DispatchedUnit } from "../../src/integration/ooo-dispatch.ts";

// The port and the session handle are the shared loop's; imported for this file's own signatures and
// re-exported so this driver's callers (its tests, the pilot, the family checks) keep importing them
// from where they read the driver. A re-export alone makes no local binding, and this file annotates
// with these names itself.
import type {
  WorkerMetrics,
  PlanWorkerResult,
  PlanWorker,
  PlanSession,
} from "../../src/integration/ooo-dispatch.ts";
export type { WorkerMetrics, PlanWorkerResult, PlanWorker, PlanSession };

/** One unit of the plan: what it is asked for, what it may edit, and what its own candidate must
 *  pass. The last one is the unit's acceptance; the parent check is separate and fixed. Both are
 *  data checks: the arms' acceptance is read from the candidate's files, and needs no workspace. */
export interface PlanUnit {
  instruction: string;
  editable: readonly string[];
  visible?: readonly string[];
  checks: readonly DataCheck[];
}

export interface PlanDriverSpec {
  plan: ProbePlan;
  units: Readonly<Record<string, PlanUnit>>;
  worker: PlanWorker;
  revision: string;
  baseline: Readonly<Record<string, string>>;
  /** The parent check: what the composed artifacts must pass, run once at the end. Omission means
   *  the arms are comparing cost only, which the report must say. */
  parentChecks?: readonly DataCheck[];
  /** The unit whose acceptance stands for the parent's composed result. Omission: every accepted
   *  unit contributes to the parent's files. */
  join?: string;
  databasePath?: string;
  slots: number;
  /** Execution fusion: how many units one session may run in a row, and the host declarations that
   *  decide which of them may share one. Declared, not derived - the runtime's policy is short ready
   *  chains, so this bound is what keeps a fused run from swallowing the plan. Omitted: no fusion. */
  fusion?: {
    unitsPerSession: number;
    /** Per-unit session declarations. Omitted: every unit shares the run's one capability and
     *  authority, and only its own visibility decides. */
    declarations?: Readonly<Record<string, { capability?: string; authority?: string }>>;
  };
  budget?: { perFile: number; output: number };
  limits?: { turns: number; reads: number; timeoutMs: number };
}

// What one dispatched unit reports, as the shared loop returns it.
export type UnitRun = DispatchedUnit;

export interface PlanRun {
  plan: readonly string[];
  /** Start order, which is the evidence for the slot count: with one slot it is the legal order. */
  order: readonly string[];
  units: readonly UnitRun[];
  accepted: Readonly<Record<string, string>>;
  /** Wall time from the first claim to the last verdict. */
  wallMs: number;
  /** Sum of the host's candidate checks. */
  hostMs: number;
  hostChecks: number;
  /** The slot count the caller asked for, and what the shared admission layer actually allowed.
   *  They differ today, and the difference is the finding: see `slotRefusal`. */
  slotsRequested: number;
  slotsUsed: number;
  /** Set when the requested slot count could not be used, with the board's own reason. A run that
   *  wanted N slots and got one must say so, or its wall time is read as the C arm's. */
  slotRefusal?: string;
  tokens: number;
  cacheRead: number;
  cacheWrite: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  failures: number;
  /** The code this run came from. A report that names its own instrument is what lets two runs be
   *  compared without a prose argument about which version produced them; `unknown` when git cannot
   *  answer, which is a fact about the run rather than a reason to fail it. */
  instrument: { commit: string };
  /** Each session's units, in the order one session ran them. One entry per session: a fused run's
   *  cost claim rests on these, and a session of one unit is a yield boundary, not fusion. */
  sessions: readonly (readonly string[])[];
  /** The parent check's verdict, when the spec declares one. */
  parent?: { verdict: string; files: readonly string[]; ms: number };
  /** Set when a worker failed or a unit was never accepted: a comparison of such runs must say so
   *  rather than compare times. */
  incomplete: readonly string[];
}

/** A unit's acceptance: its own data check, run by the store through the spec it was given. */
function unitVerifier(spec: PlanDriverSpec, unit: PlanUnit) {
  return async (submission: PatchSubmission): Promise<"accept" | "reject" | "undecidable"> => {
    if (submission.kind !== "patch") return "reject";
    const result = await verifyDataChecks({
      files: submission.files,
      frozen: spec.baseline,
      checks: [...unit.checks],
    });
    return result.verdict;
  };
}

/** Who a unit's handoff is offered to, and who therefore claims it. One name, one home: the board
 *  directs the handoff to it and the claim names it, so a run that declares more than one slot cannot
 *  offer work to one name and claim it as another. */
export const ownerOf = (taskId: string): string => `plan-driver:${taskId}`;

/** The commit this driver ran from. Read rather than remembered: a run's own report is the place its
 *  instrument belongs, because the alternative is an argument about which code produced a number. */
function instrumentCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** The parent check: the fixed acceptance over the composed artifacts, run once at the end. */
async function runParentCheck(
  spec: PlanDriverSpec,
  accepted: Readonly<Record<string, string>>,
  planIds: readonly string[],
): Promise<PlanRun["parent"]> {
  if (!spec.parentChecks?.length) return undefined;
  const startedAt = Date.now();
  const files: Record<string, string> = { ...spec.baseline };
  const acceptedIds = spec.join ? [spec.join] : planIds;
  for (const id of acceptedIds) {
    const artifact = accepted[id];
    if (!artifact) continue;
    const submission = JSON.parse(artifact) as PatchSubmission;
    // A submitted patch carries the unit's whole frozen view, so merging it wholesale would put the
    // last unit's untouched copies of its siblings' files - the stubs it was frozen with - over the
    // work they actually did. Only what the unit changed is its work; the rest stays as the baseline.
    if (submission.kind === "patch")
      for (const [path, content] of Object.entries(submission.files))
        if (spec.baseline[path] !== content) files[path] = content;
  }
  const verified = await verifyDataChecks({
    files,
    frozen: spec.baseline,
    checks: [...spec.parentChecks],
  });
  return {
    verdict: verified.verdict,
    files: acceptedIds.filter((id) => accepted[id] !== undefined),
    ms: Date.now() - startedAt,
  };
}

export async function runPlan(spec: PlanDriverSpec): Promise<PlanRun> {
  if (!Number.isInteger(spec.slots) || spec.slots < 1)
    throw new Error(`slots must be a positive integer, got ${spec.slots}`);
  const planIds = spec.plan.map((row) => String(row[0]));
  for (const id of Object.keys(spec.units))
    if (!planIds.includes(id))
      throw new Error(`unit ${id} has a spec but is not in the plan; the plan is the authority`);
  const gate = new BoardAdmission(
    spec.databasePath ?? ":memory:",
    spec.plan,
    {},
    {
      slots: spec.slots,
      // Each slot's work is offered point-to-point, because the store queues a second un-directed
      // actionable behind the first: without a target the second claim is refused, not parallel.
      handoffTarget: ownerOf,
    },
  );
  const startedAt = Date.now();

  for (const [taskId, unit] of Object.entries(spec.units)) {
    const patch: PatchTaskSpec = {
      instruction: unit.instruction,
      files: spec.baseline,
      editable: unit.editable,
      ...(unit.visible ? { visible: unit.visible } : {}),
      ...(spec.budget ? { budget: spec.budget } : {}),
      ...(spec.limits ? { limits: spec.limits } : {}),
      verify: unitVerifier(spec, unit),
    };
    gate.installPatchTask(taskId, patch);
  }
  /** What a unit's session declaration is when the spec declares no bound for it: one capability and
   *  one authority for the whole run, and only the unit's own visibility decides. */
  const declarationOf = (id: string) => ({
    capability: spec.fusion?.declarations?.[id]?.capability ?? "patch",
    authority: spec.fusion?.declarations?.[id]?.authority ?? "host",
    visible: spec.units[id]?.visible ?? [],
  });
  /** The fusion legality view. The board's own candidate answer stays the authority on staleness,
   *  cancellation, delivery and a declared external wait, because the driver cannot read those facts
   *  back out of it; the shared pair rule adds what fusion alone cares about - compatible capability,
   *  authority and visibility, a dependency that is accepted rather than merely delivered, and no
   *  reuse across a branch that is still pending. */
  const sessionPlan = (pendingBranches: readonly string[]): SessionPlan => {
    const accepted = gate.accepted();
    return {
      tasks: spec.plan.map((row) => ({
        id: String(row[0]),
        effect: String(row[3]),
        sourceVersion: spec.revision,
        observedVersion: spec.revision,
        dependencies: [...row[2]],
        accepted: accepted[String(row[0])] !== undefined,
        claimed: false,
        externalReady: true,
      })),
      declarations: Object.fromEntries(
        spec.plan.map((row) => [String(row[0]), declarationOf(String(row[0]))]),
      ),
      ...(pendingBranches.length ? { pendingBranches } : {}),
    };
  };

  // The loop is the shared one: this driver supplies what only it knows - the plan, each task's spec,
  // the declared bound, the legality view, the worker, and the session identity its measurements are
  // keyed by - and the shared layer owns the order of operations (claim, freeze, worker, result,
  // verdict, and the session decision at each boundary).
  const outcome = await dispatchPlan({
    board: gate,
    plan: planIds,
    slots: spec.slots,
    // This driver's own session identity, kept here because a fused cell's evidence is read by it: the
    // arms declare the key, the shared loop only carries it. No run to append facts to: the board is
    // the instrument's own store, which holds no run manifest for one.
    ...(spec.fusion
      ? {
          sessions: {
            bound: spec.fusion.unitsPerSession ?? 1,
            identity: (first: string) => `session:${first}`,
          },
        }
      : {}),
    legality: sessionPlan,
    worker: spec.worker,
    ownerOf,
  });
  const units = outcome.units;
  const accepted = outcome.accepted;
  const order = outcome.order;
  const failures = outcome.failures;
  const slotRefusals = outcome.slotRefusals;
  const chains = outcome.sessions;
  const widestHeld = outcome.slotsUsed;
  const wallMs = Date.now() - startedAt;
  const incomplete = [
    ...failures,
    ...planIds.filter(
      (id) => accepted[id] === undefined && units.some((unit) => unit.taskId === id),
    ),
  ];

  const parent = await runParentCheck(spec, accepted, planIds);
  gate.close();
  return {
    plan: planIds,
    order,
    units,
    accepted,
    wallMs,
    slotsRequested: spec.slots,
    slotsUsed: widestHeld,
    sessions: chains,
    ...(slotRefusals.length
      ? { slotRefusal: `wanted ${spec.slots} slots, the board allowed one: ${slotRefusals[0]}` }
      : {}),
    hostMs: units.reduce((total, unit) => total + unit.hostMs, 0),
    hostChecks: units.filter((unit) => unit.verdict !== "worker-failed").length,
    tokens: units.reduce((total, unit) => total + unit.tokens, 0),
    cacheRead: units.reduce((total, unit) => total + unit.cacheRead, 0),
    cacheWrite: units.reduce((total, unit) => total + unit.cacheWrite, 0),
    inputTokens: units.reduce((total, unit) => total + unit.inputTokens, 0),
    outputTokens: units.reduce((total, unit) => total + unit.outputTokens, 0),
    cost: units.reduce((total, unit) => total + unit.cost, 0),
    instrument: { commit: instrumentCommit() },
    failures: failures.length,
    ...(parent ? { parent } : {}),
    incomplete,
  };
}

export interface PlanComparison {
  plan: readonly string[];
  runs: number;
  arms: { slots: number; runs: PlanRun[] }[];
  /** True when every run of every arm accepted the same units and reached the same parent verdict.
   *  A comparison with different verdicts is not a comparison, and the report says so. */
  qualityParity: boolean;
  differences: string[];
  caveat: string;
  /** Every run whose requested slot count the board did not allow, with its reason. */
  slotShortfalls: string[];
  /** False when a time difference must not be read as an arm's result. */
  comparable: boolean;
}

/** Runs the same spec at two slot counts. The slot count is the only difference: same plan, same
 *  units, same checks, same parent acceptance - which is what the B/C arms require. */
export async function comparePlanSlots(
  spec: PlanDriverSpec,
  options: { runs: number; arms?: readonly number[] },
): Promise<PlanComparison> {
  if (!Number.isInteger(options.runs) || options.runs < 1)
    throw new Error(`runs must be a positive integer, got ${options.runs}`);
  const arms = options.arms ?? [1, spec.slots];
  const results: PlanComparison["arms"] = [];
  for (const slots of arms) {
    const runs: PlanRun[] = [];
    for (let index = 0; index < options.runs; index += 1)
      runs.push(await runPlan({ ...spec, plan: [...spec.plan], slots }));
    results.push({ slots, runs });
  }
  const differences: string[] = [];
  const slotShortfalls: string[] = [];
  const shape = (run: PlanRun) =>
    JSON.stringify({
      order: [...run.order].sort(),
      verdicts: run.units.map((unit) => `${unit.taskId}:${unit.verdict}`).sort(),
      ...(run.parent ? { parent: run.parent.verdict } : {}),
    });
  const first = results[0]!.runs[0]!;
  for (const arm of results)
    for (const run of arm.runs) {
      if (shape(run) !== shape(first))
        differences.push(
          `slots=${arm.slots} disagreed with the first run: ${shape(run)} vs ${shape(first)}`,
        );
      if (run.slotsUsed < run.slotsRequested)
        slotShortfalls.push(
          `slots=${arm.slots} ran with ${run.slotsUsed}: ` +
            (run.slotRefusal ?? "the plan had no more startable units"),
        );
    }
  return {
    plan: first.plan,
    runs: options.runs,
    arms: results,
    qualityParity: differences.length === 0,
    differences,
    slotShortfalls,
    /** A slot count that was never reached makes the two arms the same experiment, so the time
     *  comparison is refused rather than reported as "no gain". */
    comparable: differences.length === 0 && slotShortfalls.length === 0,
    caveat:
      "cost and scheduling only where the slot counts were actually reached and quality matches: " +
      "with different verdicts, or with a slot count the board refused, these are not a faster and " +
      "a slower run of one experiment.",
  };
}

const USAGE = `usage:
  plan-driver.ts run --spec <spec.json> --slots <n> --out <file> [--live]
  plan-driver.ts compare --spec <spec.json> --out <file> [--runs <n>] [--live]

A spec is JSON:
  baseline:  repository-relative paths read at the round's revision
  plan:      the units, each { id, revision?, dependencies?, effect, operation? }
  units:     per unit id { instruction, editable, visible?, checks?, canned? }
             checks: this unit's own candidate check; without it the global list is used
             canned: only for worker.kind "canned": editable path -> file holding the answer
  checks:    the unit's own candidate check, [{ label, command, args }]
  parentChecks: the fixed parent acceptance, run once over the composed artifacts
  worker:    { kind: "stub", latencyMs, fail? } | { kind: "canned" } | { kind: "pi", provider, model }`;

/** The spec file's shape: JSON, with `worker` naming how an artifact is produced. */
export interface SpecFile {
  baseline: readonly string[];
  revision?: string;
  /** The frozen envelope's fixed budget and limits. Optional because a run that does not name them
   *  takes the host's own defaults; a paid run fixes them so two arms differ only in the plan. */
  budget?: { perFile: number; output: number };
  limits?: { turns: number; reads: number; timeoutMs: number };
  plan: readonly {
    id: string;
    revision?: string;
    dependencies?: readonly string[];
    effect: string;
    operation?: string | null;
  }[];
  units: Readonly<Record<string, SpecUnit>>;
  /** The fallback check list: a unit that declares none of its own is checked by this. A file that
   *  declares neither is refused, because a unit nothing checks is not a unit. A check names the
   *  fixture test file that is its acceptance; the arms run it over the candidate's files as data. */
  checks?: readonly { label: string; test: string }[];
  parentChecks?: readonly { label: string; test: string }[];
  join?: string;
  /** Execution fusion, declared in the spec file the same way the driver's own spec declares it. It is
   *  copied through by `specFrom`: a spec that asked for fusion and silently got none would be read as
   *  the control arm. */
  fusion?: {
    unitsPerSession: number;
    declarations?: Readonly<Record<string, { capability?: string; authority?: string }>>;
  };
  worker:
    | { kind: "stub"; latencyMs: number; fail?: readonly string[] }
    | { kind: "canned" }
    | { kind: "pi"; provider: string; model: string };
}

/** One unit's work: what to ask for, which files it may write, what its candidate is checked by, and
 *  (for the canned worker) where the instrument's own answer is read from. */
interface SpecUnit {
  instruction: string;
  editable: string[];
  visible?: string[];
  /** This unit's own checks. Without them every unit is checked by the whole list, which a fine plan
   *  cannot use: a unit whose siblings are still unimplemented would never pass its own candidate. */
  checks?: readonly { label: string; test: string }[];
  /** The instrument's answer, as editable path -> the file holding the content to return. A canned
   *  run is how the task family is shown to accept a correct submission without paying a model. */
  canned?: Readonly<Record<string, string>>;
}

function checkList(raw: readonly { label: string; test: string }[]): DataCheck[] {
  if (!raw.length) throw new Error("a check list may not be empty");
  return raw.map((check) => testFileCheck(check.label, check.test));
}

function readSpecFile(path: string): SpecFile {
  const file = JSON.parse(readFileSync(path, "utf8")) as SpecFile;
  if (!Array.isArray(file.plan) || !file.plan.length)
    throw new Error("spec.plan must be non-empty");
  if (!Array.isArray(file.baseline) || !file.baseline.length)
    throw new Error("spec.baseline must name at least one file");
  if (!file.units || Object.keys(file.units).length === 0)
    throw new Error("spec.units must describe at least one unit");
  const planIds = new Set(file.plan.map((row) => row.id));
  for (const id of Object.keys(file.units))
    if (!planIds.has(id))
      throw new Error(`spec.units.${id} is not in the plan; the plan is the authority`);
  return file;
}

function planOf(file: SpecFile): ProbePlan {
  return file.plan.map((row) => [
    row.id,
    row.revision ?? "",
    [...(row.dependencies ?? [])],
    row.effect,
    null,
    row.operation ?? null,
  ]) as unknown as ProbePlan;
}

function baselineOf(file: SpecFile, repository: string): Record<string, string> {
  return Object.fromEntries(
    file.baseline.map((path) => [path, readFileSync(resolve(repository, path), "utf8")]),
  );
}

/** The stub worker answers by leaving its editable files as they are, so acceptance depends on the
 *  unit's own check and the run measures the driver rather than a model. `fail` names units that
 *  must fail, which is how the driver's failure path is exercised without a model. */
function stubWorker(worker: { latencyMs: number; fail?: readonly string[] }): PlanWorker {
  return async (taskId, frozen) => {
    await new Promise((done) => setTimeout(done, worker.latencyMs));
    if (worker.fail?.includes(taskId)) return { failure: `stub worker: ${taskId} fails` };
    // The protocol's patch shape is a list of whole-file replacements, and the store checks that each
    // one really differs from the frozen input: an object map (or an unchanged file) is not a proposal
    // the host can compare, so a stub that sent one would be rejected for the wrong reason.
    const files = frozen.work.editable.map((path) => ({
      path,
      content: frozen.work.files[path] ?? "",
    }));
    return {
      artifact: JSON.stringify({ digest: frozen.digest, files }),
      metrics: { tokens: 0, turns: 0, checks: 0 },
    };
  };
}

/** The canned worker: the instrument's own answer, read from the paths the spec names. It exists so
 *  that the task family's acceptance is checked offline - and so that a canned answer which is wrong
 *  is rejected - before any model is asked to write one. */
export function cannedWorker(file: SpecFile): PlanWorker {
  const answers = new Map<string, Readonly<Record<string, string>>>();
  for (const [id, unit] of Object.entries(file.units)) {
    if (!unit.canned)
      throw new Error(
        `the canned worker needs an answer for every unit: ${id} has none, ` +
          "and an instrument cannot be checked by a unit that answers nothing",
      );
    answers.set(id, unit.canned);
  }
  return async (taskId, frozen) => {
    const answer = answers.get(taskId);
    if (!answer) return { failure: `${taskId}: the canned worker has no answer for it` };
    // The protocol's patch shape: whole-file replacements that differ from the frozen input.
    const files: { path: string; content: string }[] = [];
    for (const path of frozen.work.editable) {
      const source = answer[path];
      if (!source) return { failure: `${taskId}: the canned answer has no content for ${path}` };
      files.push({ path, content: readFileSync(resolve(process.cwd(), source), "utf8") });
    }
    return {
      artifact: JSON.stringify({ digest: frozen.digest, files }),
      metrics: { tokens: 0, turns: 0, checks: 0 },
    };
  };
}

export function piWorker(worker: { provider: string; model: string }, live: boolean): PlanWorker {
  if (!live)
    throw new Error(
      "refusing a live model run without --live: the spec names the provider, the operator " +
        "authorizes the spend",
    );
  return async (taskId, frozen, _dependencies, session) => {
    // Measured, not assumed: `executePiPatch` creates a session per call (`SessionManager.inMemory()`),
    // so this worker can start a session but cannot continue one. A fused live run therefore needs the
    // extension to hold a session across calls - until it does, the continuation is refused by name
    // here rather than answered with a fresh session that would be reported as fusion.
    if (session && session.units.length > 0)
      return {
        failure:
          `${taskId}: the live worker cannot continue session ${session.id} (it has run ` +
          `${session.units.join(", ")}); a fused live arm needs the extension to hold one session ` +
          "across calls, and this harness creates a session per call",
      };
    const { executePiPatch } = await import("../../.pi/extensions/nmg/ooo-execution.ts");
    const run = await executePiPatch(frozen, worker.provider, worker.model);
    if (!run.artifact) return { failure: `${taskId}: the worker returned no artifact` };
    return {
      artifact: run.artifact,
      metrics: {
        tokens: run.tokens,
        turns: run.turns,
        checks: run.checks,
        cacheRead: run.cacheRead,
        cacheWrite: run.cacheWrite,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        cost: run.cost,
        promptDigest: run.promptDigest,
        ...(session ? { sessionId: session.id } : {}),
      },
    };
  };
}

/** The live worker that can honour a continuation: one runner per session id, created on that
 *  session's first unit and re-pointed for the rest. `piWorker` cannot do this - the extension it calls
 *  creates a session per call - so a fused live arm uses this one, and its `sessionId` is read from the
 *  session the unit actually ran in. `close()` disposes them; a run should call it once. */
export function piSessionWorker(
  worker: { provider: string; model: string },
  live: boolean,
): { worker: PlanWorker; close: () => void } {
  if (!live)
    throw new Error(
      "refusing a live model run without --live: the spec names the provider, the operator " +
        "authorizes the spend",
    );
  const runners = new Map<
    string,
    import("../../src/integration/ooo-session-mechanism.ts").PiSessionRunner
  >();
  const planWorker: PlanWorker = async (taskId, frozen, _dependencies, session) => {
    const key = session?.id ?? `unit:${taskId}`;
    // A fused session fixes its tool surface when it is created, which loosens the artifact schema's
    // conclusion to a string, so the input that feeds it must name the admitted kinds in the prompt.
    // Both flags come from this one decision, because the runner refuses them disagreeing.
    const chain = session !== undefined;
    // The mechanism is shared and the adapter is thin: the runner comes from the harness that can
    // open a pi session, while the session input it is fed is built by the shared layer.
    const { createPiSessionRunner } = await import("../../.pi/extensions/nmg/ooo-execution.ts");
    const sessionMechanism = await import("../../src/integration/ooo-session-mechanism.ts");
    let runner = runners.get(key);
    if (!runner) {
      const input = sessionMechanism.patchSessionInput(frozen, { looseConclusion: chain });
      runner = await createPiSessionRunner({
        provider: worker.provider,
        modelId: worker.model,
        patchMode: true,
        first: input,
        // A chain's surface is fixed when the session is created, so it registers the union of what
        // its units may need rather than the first unit's subset.
        chain,
      });
      runners.set(key, runner);
    }
    const run = await runner.runUnit(
      sessionMechanism.patchSessionInput(frozen, { looseConclusion: chain }),
    );
    if (!run.artifact) return { failure: `${taskId}: the worker returned no artifact` };
    return {
      artifact: run.artifact,
      metrics: {
        tokens: run.tokens,
        turns: run.turns,
        checks: run.checks,
        cacheRead: run.cacheRead,
        cacheWrite: run.cacheWrite,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        cost: run.cost,
        promptDigest: run.promptDigest,
        // The driver's name for the session it asked for, reported only because this runner is the one
        // held under that name: a worker that answered with a session of its own reports a different id
        // and the driver ends the chain, which is how a fused run is told from a wish.
        ...(session ? { sessionId: session.id } : {}),
      },
    };
  };
  return {
    worker: planWorker,
    close: () => {
      for (const runner of runners.values()) runner.dispose();
      runners.clear();
    },
  };
}

export function specFrom(file: SpecFile, worker: PlanWorker, slots: number): PlanDriverSpec {
  const repository = process.cwd();
  const fallback = file.checks ? checkList(file.checks) : undefined;
  return {
    plan: planOf(file),
    units: Object.fromEntries(
      Object.entries(file.units).map(([id, unit]) => {
        const checks = unit.checks ? checkList(unit.checks) : fallback;
        if (!checks)
          throw new Error(
            `${id}: no checks - a unit is checked by what it declares, or by the spec's own list`,
          );
        return [
          id,
          {
            instruction: unit.instruction,
            editable: unit.editable,
            ...(unit.visible ? { visible: unit.visible } : {}),
            checks,
          },
        ];
      }),
    ),
    worker,
    revision: file.revision ?? "HEAD",
    baseline: baselineOf(file, repository),
    ...(file.parentChecks ? { parentChecks: checkList(file.parentChecks) } : {}),
    ...(file.join ? { join: file.join } : {}),
    ...(file.budget ? { budget: file.budget } : {}),
    ...(file.limits ? { limits: file.limits } : {}),
    ...(file.fusion ? { fusion: file.fusion } : {}),
    slots,
  };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "run" && command !== "compare") throw new Error(USAGE);
  const { values } = parseArgs({
    args: rest,
    options: {
      spec: { type: "string" },
      slots: { type: "string" },
      runs: { type: "string" },
      out: { type: "string" },
      live: { type: "boolean" },
      // Holds one Pi session across a chain's units. Off by default: the flag is what makes a fused
      // live arm possible, and a spec naming `pi` without it keeps the per-call worker (and its
      // refusal to continue a session) as the recorded behaviour.
      "session-runner": { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (!values.spec || !values.out) throw new Error(USAGE);
  const file = readSpecFile(values.spec);
  const slots = values.slots === undefined ? 2 : Number(values.slots);
  const sessions =
    file.worker.kind === "pi" && values["session-runner"] === true
      ? piSessionWorker(file.worker, values.live === true)
      : undefined;
  const worker =
    file.worker.kind === "stub"
      ? stubWorker(file.worker)
      : file.worker.kind === "canned"
        ? cannedWorker(file)
        : (sessions?.worker ?? piWorker(file.worker, values.live === true));
  const spec = specFrom(file, worker, slots);
  let report: Awaited<ReturnType<typeof runPlan>> | PlanComparison;
  try {
    report =
      command === "run"
        ? await runPlan(spec)
        : await comparePlanSlots(spec, {
            runs: values.runs === undefined ? 3 : Number(values.runs),
          });
  } finally {
    sessions?.close();
  }
  const out = resolve(values.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ measuredAt: new Date().toISOString(), spec: values.spec, report }, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();

export { USAGE };
