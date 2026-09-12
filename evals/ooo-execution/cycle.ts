import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardAdmission, type PatchTaskSpec, type ProbePlan } from "./board-admission.ts";
import { verifyCandidate, type CandidateCheck } from "./candidate.ts";
import {
  preparePatchWork,
  patchSubmission,
  type ConclusionKind,
  type FrozenPatchTask,
  type FrozenPatchWork,
  type PatchSubmission,
} from "../../src/integration/ooo-patch.ts";

import { mutate, type Mutation } from "./mutation.ts";
import { RoundLog, checksDigest, type RoundEvent, type RoundEventInput } from "./round-log.ts";

export type WorkerMetrics = {
  tokens?: number;
  turns?: number;
  checks?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type WorkerResult =
  | string
  | {
      artifact: string;
      metrics?: WorkerMetrics;
      /** Reported mid-attempt: the input cannot satisfy a declared requirement, so the
       *  attempt ends without an artifact and the host decides about the dependency. */
      pushback?: { dependency: string; requirement: string; evidence: string };
    };

export type CycleWorker = (
  taskId: string,
  frozen: FrozenPatchWork,
  dependencies: Readonly<Record<string, string>>,
) => Promise<WorkerResult>;

/** A declared precondition on a dependency's accepted artifact. The host evaluates
 *  these mechanically, so a downstream pushback is a checkable fact and not a mood. */
export type Requirement =
  | { kind: "verified"; task: string }
  | { kind: "mutant-killed"; task: string; id: string }
  | { kind: "test-title"; task: string; token: string };

export interface CheckOutcomeSummary {
  verdict: "accept" | "reject" | "undecidable";
  outcomes: { label: string; status: string; log?: string }[];
}

export type CheckRunner = (options: {
  repository: string;
  files: Readonly<Record<string, string>>;
  revision: string;
  checks: readonly CandidateCheck[];
  /** Present when the round can be cancelled: a runner that spawns processes must kill
   *  their trees on abort rather than leave them running for a round nobody waits for. */
  signal?: AbortSignal;
}) => Promise<CheckOutcomeSummary>;

export type CaseRule = {
  /** Host-frozen case name. A no-change conclusion must cite it by this exact name. */
  readonly name: string;
  /** Host-frozen title token: a patch proves coverage for this case only by adding a
   *  test whose title contains it. Stated in the instruction, never inferred. */
  readonly token: string;
};

export interface CycleOptions {
  repository: string;
  revision: string;
  /** Round-frozen baseline. Uncommitted OoO files are absent from HEAD, so every
   *  file a fixed check needs must appear here, not only the editable ones. */
  baseline: Readonly<Record<string, string>>;
  checks: readonly CandidateCheck[];
  worker: CycleWorker;
  aInstruction: string;
  bInstruction: string;
  aEditable: readonly string[];
  bEditable: readonly string[];
  budget: { perFile: number; output: number };
  limits: {
    turns: number;
    reads: number;
    timeoutMs: number;
  }; /** Overridable so the deterministic test does not create worktrees. */
  runChecks?: CheckRunner;
  /** Operator cancellation. Aborting it stops dispatch, fences the round in the
   *  coordinator, and kills the process tree of every check still running, so a cancelled
   *  round leaves no orphan worker or check process behind. */
  signal?: AbortSignal;
  /** Cancellation can also arrive as durable state written by *another* process (a CLI
   *  `cancel` on a round it does not own). The round polls this while it runs, and the
   *  decision is the same one `signal` expresses, so both share a single path. */
  watchCancellation?: () => string | null;
  /** Independently reviewed, task-specific no-change claims, fixed before the round.
   *  Omission disables no-change acceptance; test names alone are not coverage proof. */
  noChangeCases?: Partial<Record<"A" | "B", readonly CaseRule[]>>;
  /** Proven-gap mode: the host declares faults the frozen suite does not detect, and
   *  a patch is accepted only when the candidate suite passes intact and kills at
   *  least one of them. It replaces the title-token rule for that task, because a
   *  surviving mutant is stronger evidence than a title match. */
  mutations?: Partial<Record<"A" | "B", readonly Mutation[]>>;
  /** Readable subset per task. The whole baseline is re-sent on every model turn, so a
   *  task sees only what its acceptance rule can point at; omission shows everything. */
  visible?: Partial<Record<"A" | "B" | "C", readonly string[]>>;
  /** Which conclusion kinds each task's acceptance rule admits. The tool schema is
   *  derived from this, so a task is never offered an answer the host must reject. */
  admitted?: Partial<Record<"A" | "B" | "C", readonly ConclusionKind[]>>;
  /** Preconditions each task declares on its dependencies. A failed requirement is a
   *  dependency rejection: the host reopens the responsible task instead of letting a
   *  dependent work on an input that cannot satisfy it. */
  requires?: Partial<Record<"A" | "B" | "C", readonly Requirement[]>>;
  /** Bounded downstream pushback. Exhausting it stops the round with evidence rather
   *  than repairing a failing version forever. */
  maxReopens?: number;
  /** Where the round records what happened. Omission keeps it in memory, which is what
   *  the deterministic tests use; a live round writes it next to its report so the round
   *  can be replayed without a model. */
  roundLog?: RoundLog;
  databaseDir?: string;
}

export interface CycleResult {
  timeline: { at: string; step: string; detail?: string }[];
  verdicts: Record<string, string>;
  submissions: Record<string, PatchSubmission>;
  accepted: Record<string, string>;
  /** Bounded artifacts of rejected attempts, so a failed round stays diagnosable. */
  rejections: { task: string; attempt: number; artifact: string }[];
  /** Declared mutants the accepted candidate suite detected / still does not detect. */
  killed: Record<string, string[]>;
  survived: Record<string, string[]>;
  /** Cost and latency evidence for the round: what the host spent, what the worker
   *  spent, and how much of an unresolved wait the out-of-order task actually hid. */
  measurements: {
    workers: Record<string, WorkerMetrics & { ms: number }>;
    hiddenWaitMs: number;
    checkMs: number;
    hostChecks: number;
    hostMs: number;
    reopens: string[];
  };
  composed: { verdict: string; files: string[] };
  /** The round's own record, in order. Replaying it needs no model call. */
  log: readonly RoundEvent[];
  /** Set when the operator cancelled the round: the reason, as the coordinator stored it. */
  cancelled?: string;
}

const plan: ProbePlan = [
  ["A", "", [], "isolated-artifact", "protocol-regression", null],
  ["B", "", [], "isolated-artifact", null, null],
  ["C", "", ["A", "B"], "isolated-artifact", null, null],
];

/** Host driver for one A/B/C round: the check is real and concurrent with B, the
 *  bypass is the coordinator's decision, and every acceptance is host-verified. */
/** The round's check verdict as the terminal evidence the board records. */
/** Round inputs with their documented defaults applied once, so the orchestrator reads
 *  resolved values instead of repeating `??` at every use. */
function cycleDefaults(options: CycleOptions) {
  return {
    runChecks: (options.runChecks ?? verifyCandidate) as CheckRunner,
    noChangeCases: structuredClone(options.noChangeCases ?? {}),
    declared: structuredClone(options.mutations ?? {}),
    maxReopens: options.maxReopens ?? 1,
  };
}

function checkOutcome(
  verdict: CheckOutcomeSummary["verdict"],
): "passed" | "failed" | "undecidable" {
  if (verdict === "accept") return "passed";
  return verdict === "reject" ? "failed" : "undecidable";
}

/** The check's own duration: issued-to-terminal, from the recorded timestamps. */
function checkWindow(timeline: CycleResult["timeline"]): number {
  const at = (step: string) => Date.parse(timeline.find((e) => e.step === step)?.at ?? "0");
  return at("check-finished") - at("check-issued") || 0;
}

/** One line per check, in order: the evidence the coordinator and the worker both see. */
function describeOutcomes(result: CheckOutcomeSummary): string {
  return result.outcomes.map((item) => `${item.label}=${item.status}`).join(", ");
}

/** Every check in the round must have reported a pass for a no-change claim to stand. */
function allChecksPassed(result: CheckOutcomeSummary, checks: readonly CandidateCheck[]): boolean {
  return checks.every(({ label }) =>
    result.outcomes.some((item) => item.label === label && item.status === "passed"),
  );
}

/** The driver and the coordinator must agree on the frozen work, or the round is not
 *  running the same task. A bare "mismatch" cost two debugging rounds, so the error
 *  names the fields that differ. */
function assertFrozenMatches(
  frozen: FrozenPatchWork,
  claimed: FrozenPatchTask & { digest: string },
) {
  if (frozen.digest === claimed.digest) return;
  const own = frozen.work as unknown as Record<string, unknown>;
  const theirs = claimed as unknown as Record<string, unknown>;
  const differing = Object.keys(own).filter(
    (key) => JSON.stringify(own[key]) !== JSON.stringify(theirs[key]),
  );
  const detail = differing
    .map((key) => `${key}=${JSON.stringify(own[key])} vs ${JSON.stringify(theirs[key])}`)
    .join(" | ");
  throw new Error(
    `frozen digest mismatch: ${frozen.digest.slice(0, 12)} vs ${claimed.digest.slice(0, 12)}; ` +
      `differing fields: ${differing.join(", ") || "none"} ${detail}`,
  );
}

/** The coordinator stays the acceptance authority; this records why the shared
 *  contract rejected an artifact, which is otherwise invisible. */
function logContractError(
  log: (step: string, detail?: string) => void,
  taskId: string,
  frozen: FrozenPatchWork,
  artifact: string,
) {
  try {
    patchSubmission(frozen, artifact);
  } catch (error) {
    log(
      `contract-error:${taskId}`,
      (error instanceof Error ? error.message : String(error)).slice(0, 300),
    );
  }
}

export async function runCycle(options: CycleOptions): Promise<CycleResult> {
  const roundLog = options.roundLog ?? new RoundLog();
  const trace = (event: RoundEventInput) =>
    roundLog.append({ ...event, at: new Date().toISOString() } as RoundEvent);
  const defaults = cycleDefaults(options);
  const runChecks = defaults.runChecks;
  const directory = options.databaseDir ?? mkdtempSync(join(tmpdir(), "ooo-cycle-db-"));
  const specs: Record<string, PatchTaskSpec> = {};
  const gate = new BoardAdmission(join(directory, "store.sqlite"), plan, specs);
  const timeline: CycleResult["timeline"] = [];
  const verdicts: Record<string, string> = {};
  const submissions: Record<string, PatchSubmission> = {};
  const rejections: CycleResult["rejections"] = [];
  const noChangeCases = defaults.noChangeCases;
  const declared = defaults.declared;
  const killed: Record<string, string[]> = {};
  const survived: Record<string, string[]> = {};
  const workers: CycleResult["measurements"]["workers"] = {};
  const reopens: string[] = [];
  let lastPushback: { dependency: string; requirement: string; evidence: string } | undefined;
  let premiseFailed = false;
  /** Set when the operator cancels: the round stops dispatching, fences itself in the
   *  coordinator, and reports the reason instead of finishing as if it had run. */
  let cancelled: string | null = null;
  /** A premise that could not be measured is not a premise that failed: the round must
   *  stop, but it must say which of the two happened. */
  let premiseUnmeasured = false;
  /** Assigned when the round starts; the verifier awaits it so a false premise can
   *  never accept anything, while the work itself already runs beside the model call. */
  let matrix: Promise<void> = Promise.resolve();
  let hostChecks = 0;
  let hostMs = 0;
  const hostCheck = async (files: Readonly<Record<string, string>>) => {
    const started = Date.now();
    try {
      return await runChecks({
        repository: options.repository,
        revision: options.revision,
        files,
        checks: options.checks,
        signal: own.signal,
      });
    } finally {
      hostChecks += 1;
      hostMs += Date.now() - started;
    }
  };
  /** Coverage is resolved to a named test title, never to the worker's own words.
   *  This proves a title exists for the case; it does not prove the test asserts it. */
  const titles = (files: Readonly<Record<string, string>>) =>
    new Set(
      Object.values(files).flatMap((source) =>
        [...source.matchAll(/test(?:\.\w+)?\(\s*["']([^"'\n]+)["']/g)].map((match) => match[1]),
      ),
    );
  const frozenTitles = titles(options.baseline);
  const caseResolved = (
    rule: CaseRule,
    available: ReadonlySet<string>,
    cited: ReadonlyMap<string, string>,
  ) => {
    const title = cited.get(rule.name);
    if (title) return frozenTitles.has(title);
    // The token is host-frozen and stated in the instruction; an unstated token is
    // not guessed, it fails closed.
    const token = rule.token.trim().toLowerCase();
    if (!token) return false;
    return [...available].some((candidate) => candidate.toLowerCase().includes(token));
  };
  const log = (step: string, detail?: string) =>
    timeline.push({ at: new Date().toISOString(), step, detail });
  /** In-flight checks are killed through this controller, which both cancellation channels
   *  abort: the operator's signal, and the store when another process asked for the stop. */
  const own = new AbortController();
  options.signal?.addEventListener("abort", () => own.abort(), { once: true });
  /** Operator cancellation, recorded once and fenced in the coordinator.
   *
   *  The coordinator is the authority, so the round does not merely stop: it cancels the
   *  round it is running, which advances every attempt and retires every live claim and
   *  ticket. That is what makes a late artifact `stale` instead of accepted into a round
   *  nobody is waiting for. Returns true when the round must stop dispatching. */
  const stopped = () => {
    if (cancelled === null) {
      const reason = options.signal?.aborted
        ? "operator cancelled the round"
        : (options.watchCancellation?.() ?? null);
      if (reason === null) return false;
      gate.cancel(reason);
      cancelled = gate.cancelled() ?? reason;
      // A cancelled round must not keep a check running: this kills its process tree.
      own.abort();
      log("cancelled", reason);
    }
    return true;
  };
  /** A round waiting on a long check still has to notice a cancellation from another
   *  process, so the store is polled rather than only consulted at dispatch points. */
  const watcher = options.watchCancellation
    ? setInterval(() => {
        if (stopped()) clearInterval(watcher);
      }, 250)
    : undefined;
  /** How much of the unresolved external wait the out-of-order task actually covered.
   *  Computed from real timestamps: claimed-to-submitted overlap with issued-to-terminal. */
  const hiddenWait = () => {
    const at = (step: string) =>
      Date.parse(timeline.find((entry) => entry.step === step)?.at ?? "");
    const claim = timeline.find((entry) => entry.step === "claim:B")?.at;
    const submit = timeline.filter((entry) => entry.step === "submit:B").pop()?.at;
    const issued = at("check-issued");
    const finished = at("check-finished");
    if (!claim || !submit || isNaN(issued) || isNaN(finished)) return 0;
    return Math.max(
      0,
      Math.min(Date.parse(submit), finished) - Math.max(Date.parse(claim), issued),
    );
  };
  const check = (files: Readonly<Record<string, string>>) => hostCheck(files);
  const record = async (result: CheckOutcomeSummary) => {
    const failed = result.outcomes.find((item) => item.status !== "passed");
    const detail =
      `${result.verdict}: ${describeOutcomes(result)}` +
      (failed?.log ? ` | ${failed.log.slice(-600)}` : "");
    log("candidate-check", detail);
    return result.verdict;
  };
  /** Case rules resolve against a title the host can actually see; an unresolved case
   *  fails closed rather than being matched by the worker's own words. */
  const resolveCases = (
    task: string,
    cases: readonly CaseRule[],
    available: ReadonlySet<string>,
    cited: ReadonlyMap<string, string>,
  ): boolean => {
    for (const rule of cases)
      if (!caseResolved(rule, available, cited)) {
        log(
          cited.size ? "citation-unresolved" : "case-unresolved",
          cited.size
            ? `${task} ${rule.name} -> ${cited.get(rule.name) ?? "none"}`
            : `${task} ${rule.name} -> no test title matching ${rule.token}`,
        );
        return false;
      }
    return true;
  };
  /** The retention rule of mutation-guided testing: a new test is worth keeping only if
   *  it passes on the intact implementation and fails on a declared mutant. */
  const runMutationProof = async (
    task: string,
    candidate: Readonly<Record<string, string>>,
    mutants: readonly Mutation[],
  ) => {
    for (const mutation of mutants) {
      const run = await check(mutate(candidate, mutation));
      const killedIt = run.verdict === "reject";
      (killedIt ? (killed[task] ??= []) : (survived[task] ??= [])).push(mutation.id);
      log(killedIt ? "mutant-killed" : "mutant-survived", `${task} ${mutation.id}`);
      trace({
        kind: "mutant",
        taskId: task,
        id: mutation.id,
        outcome: killedIt ? "killed" : "survived",
      });
    }
  };
  /** A patch candidate: the premise must hold, the declared cases must resolve, the
   *  candidate must pass intact, and it must close at least one declared gap. */
  const verifyPatch = async (
    task: "A" | "B",
    submission: Extract<PatchSubmission, { kind: "patch" }>,
  ) => {
    const mutants = declared[task] ?? [];
    // The mutant premise gates acceptance, not the start of work: awaiting the
    // concurrently proved matrix here keeps a false premise from accepting anything.
    await matrix;
    if (premiseFailed || premiseUnmeasured) {
      log(
        premiseFailed ? "premise-invalid" : "premise-unmeasured",
        `${task}: ${premiseFailed ? "a declared mutant is already detected" : "the declared faults could not be measured"}`,
      );
      return "reject";
    }
    const candidate = { ...options.baseline, ...submission.files };
    // Proven-gap mode replaces the title-token rule for patches, rather than stacking
    // with it: a surviving mutant is strictly stronger evidence than a title match, and
    // a round that declares both would reject a candidate for the weaker rule.
    const cases = mutants.length ? [] : (noChangeCases[task] ?? []);
    if (!resolveCases(task, cases, titles(candidate), new Map())) return "reject";
    const intact = await check(candidate);
    if (intact.verdict !== "accept") return record(intact);
    await runMutationProof(task, candidate, mutants);
    if (mutants.length && !killed[task]?.length) {
      log("gap-not-closed", `${task}: no declared mutant killed`);
      return "reject";
    }
    return record(intact);
  };
  /** The refusals a conclusion can hit before any check runs, as a verdict or null. */
  const conclusionRefusal = (
    task: "A" | "B",
    submission: Extract<PatchSubmission, { kind: "conclusion" }>,
    mutants: readonly Mutation[],
  ): "reject" | null => {
    // A blocked report is not completed work: it must not unlock A or C.
    if (submission.conclusion === "cannot-complete") {
      log("blocked", `${task}: ${submission.summary.slice(0, 300)}`);
      return "reject";
    }
    if (submission.conclusion !== "no-change-needed") return "reject";
    // When the host has proved a surviving mutant, "no change needed" is false by the
    // host's own evidence, so it cannot be accepted on any citation.
    if (mutants.length) {
      log("gap-proven", `${task}: ${mutants.length} declared mutant(s) survived the frozen suite`);
      return "reject";
    }
    if (!noChangeCases[task]?.length) return "reject";
    return null;
  };
  /** No-change claims are only as good as a citation the host can resolve: an invented,
   *  misquoted, or missing citation fails closed. */
  const conclusionCasesResolved = (task: "A" | "B", submission: PatchSubmission) => {
    const cases = noChangeCases[task] ?? [];
    const cited = new Map(
      submission.kind === "conclusion" ? submission.citations.map((i) => [i.case, i.test]) : [],
    );
    const unknown = [...cited.keys()].find((name) => !cases.some((rule) => rule.name === name));
    if (unknown) {
      log("citation-unresolved", `${task} unknown case ${unknown}`);
      return false;
    }
    return resolveCases(task, cases, frozenTitles, cited);
  };
  const verifyConclusion = async (
    task: "A" | "B",
    submission: Extract<PatchSubmission, { kind: "conclusion" }>,
  ) => {
    const refusal = conclusionRefusal(task, submission, declared[task] ?? []);
    if (refusal) return refusal;
    if (!conclusionCasesResolved(task, submission)) return "reject";
    const result = await check(options.baseline);
    if (!options.checks.length || !allChecksPassed(result, options.checks)) return "undecidable";
    return record(result);
  };
  const patchVerifier = (task: "A" | "B") => async (submission: PatchSubmission) =>
    submission.kind === "patch"
      ? verifyPatch(task, submission)
      : verifyConclusion(task, submission);
  const composedVerifier =
    (abFiles: Readonly<Record<string, string>>) => async (submission: PatchSubmission) => {
      // C may only promote what the host itself can re-verify as a composed candidate.
      if (submission.kind !== "conclusion" || submission.conclusion !== "promote-candidate")
        return "reject";
      return record(await check({ ...options.baseline, ...abFiles }));
    };

  /** Host evaluation of a declared precondition. Only facts the coordinator has
   *  recorded are allowed, so a rejected dependency is never a matter of opinion. */
  const describe = (requirement: Requirement) =>
    requirement.kind === "verified"
      ? `${requirement.task} verified`
      : requirement.kind === "mutant-killed"
        ? `${requirement.task} kills ${requirement.id}`
        : `${requirement.task} adds a test titled *${requirement.token}*`;
  const requirementMet = (requirement: Requirement) => {
    const submission = submissions[requirement.task];
    if (requirement.kind === "verified") return submission !== undefined;
    if (!submission) return false;
    if (requirement.kind === "mutant-killed")
      return (killed[requirement.task] ?? []).includes(requirement.id);
    if (submission.kind !== "patch") return false;
    const token = requirement.token.trim().toLowerCase();
    if (!token) return false;
    return [...titles(submission.files)].some((title) => title.toLowerCase().includes(token));
  };
  const firstUnmet = (task: "A" | "B" | "C") =>
    (options.requires?.[task] ?? []).find((requirement) => !requirementMet(requirement));

  /** A task whose instruction says "the host proved these faults survive" depends on that
   *  proof: if the premise is false the task as stated does not exist, and dispatching it
   *  anyway spends a full model call on work the host then refuses on its own evidence
   *  (measured: 204k tokens). The proof is seconds of host time, so it is awaited before the
   *  dispatch instead of being raced against the model. Returns the refusal reason, or null
   *  when the task may run. */
  const premiseRefusal = async (taskId: string): Promise<string | null> => {
    if (!(declared[taskId as "A" | "B"] ?? []).length) return null;
    await matrix;
    if (!premiseFailed && !premiseUnmeasured) return null;
    const reason = premiseFailed
      ? `${taskId} declares a fault the frozen suite already detects`
      : `${taskId}'s declared fault could not be measured`;
    // Nothing is claimed yet, but something *was* published: the round announced this task's
    // handoff, and the board serializes actionable entries, so leaving it outstanding would
    // block every later claim in the round.
    gate.withdrawHandoff(taskId, reason);
    log(premiseFailed ? "premise-invalid" : "premise-unmeasured", `${taskId}: not dispatched`);
    trace({
      kind: "worker-failed",
      taskId,
      attempt: 0,
      reason: `premise-invalid: ${reason}`,
    });
    rejections.push({ task: taskId, attempt: 0, artifact: `${taskId} not dispatched: ${reason}` });
    verdicts[taskId] = "rejected";
    return reason;
  };

  /** One worker invocation only. A rejected claim is not artificially expired. */
  const runTask = async (taskId: string) => {
    if (stopped()) {
      verdicts[taskId] ??= "cancelled";
      return undefined;
    }
    // Selection belongs to the coordinator: an unreleased dependency or a live
    // claim on another task means this task simply does not run in this round.
    const selected = gate.next();
    if (selected !== taskId) {
      log(`skip:${taskId}`, `selected=${selected ?? "none"}`);
      return undefined;
    }
    if ((await premiseRefusal(taskId)) !== null) return "rejected";
    const ticket = gate.claim(taskId, `worker-${taskId}`);
    const claimedAt = Date.now();
    if (!ticket.patch) throw new Error("round tasks must be patch tasks");
    // Rebuilt from the ticket, which carries the frozen work: the driver can then only
    // disagree with the coordinator by constructing a different digest.
    const frozen = preparePatchWork({
      taskId: ticket.patch.taskId,
      attempt: ticket.attempt,
      instruction: ticket.patch.instruction,
      files: ticket.patch.files,
      editable: ticket.patch.editable,
      visible: ticket.patch.visible,
      admittedConclusions: ticket.patch.admittedConclusions,
      budget: ticket.patch.budget,
      limits: ticket.patch.limits,
    });
    assertFrozenMatches(frozen, ticket.patch);
    log(`claim:${taskId}`, `attempt=${ticket.attempt} digest=${frozen.digest.slice(0, 12)}`);
    trace({
      kind: "claim",
      taskId,
      attempt: ticket.attempt,
      digest: frozen.digest,
      owner: ticket.owner,
    });
    // A worker that fails or returns truncated output produced no artifact: it is a
    // failed attempt with recorded reason, not a crashed round and not a retry.
    const produced = await callWorker(taskId, frozen, ticket.dependencies);
    if (produced.metrics) workers[taskId] = { ...produced.metrics, ms: Date.now() - claimedAt };
    if (produced.failure) {
      log(`worker-failed:${taskId}`, produced.failure.slice(0, 400));
      trace({
        kind: "worker-failed",
        taskId,
        attempt: ticket.attempt,
        reason: produced.failure.slice(0, 2_000),
      });
      rejections.push({
        task: taskId,
        attempt: ticket.attempt,
        artifact: produced.failure.slice(0, 2_000),
      });
      verdicts[taskId] = "rejected";
      return "rejected";
    }
    const artifact = produced.artifact!;
    trace({
      kind: "artifact",
      taskId,
      attempt: ticket.attempt,
      artifact: artifact.slice(0, 256_000),
      metrics: produced.metrics,
    });
    if (produced.pushback) {
      lastPushback = produced.pushback;
      log(
        `pushback:${taskId}`,
        `${produced.pushback.dependency} ${produced.pushback.requirement}: ${produced.pushback.evidence.slice(0, 200)}`,
      );
      trace({
        kind: "pushback",
        taskId,
        dependency: produced.pushback.dependency,
        requirement: produced.pushback.requirement,
        evidence: produced.pushback.evidence.slice(0, 2_000),
      });
      verdicts[taskId] = "blocked-by-dependency";
      return "blocked-by-dependency";
    }
    logContractError(log, taskId, frozen, artifact);
    const entry = gate.putTaskBoardEntry({
      taskId: "ooo-process-probe",
      agentId: ticket.owner,
      kind: "result",
      content: JSON.stringify({ ticket, artifact }),
      expiresAt: new Date(gate.now + 86_400_000).toISOString(),
    });
    const verdict = await gate.submit(entry.id);
    log(`submit:${taskId}`, verdict);
    trace({ kind: "verdict", taskId, attempt: ticket.attempt, verdict });
    verdicts[taskId] = verdict;
    const accepted = verdict === "accepted" ? gate.accepted()[taskId] : undefined;
    if (accepted) submissions[taskId] = JSON.parse(accepted) as PatchSubmission;
    else
      rejections.push({
        task: taskId,
        attempt: ticket.attempt,
        artifact: artifact.slice(0, 2_000),
      });
    return verdict;
  };

  /** One worker invocation, with the failure of a worker call turned into a recorded
   *  attempt rather than a crashed round. */
  const callWorker = async (
    taskId: string,
    frozen: FrozenPatchWork,
    dependencies: Record<string, string>,
  ): Promise<{
    artifact?: string;
    pushback?: { dependency: string; requirement: string; evidence: string };
    metrics?: WorkerMetrics;
    failure?: string;
  }> => {
    try {
      const produced = await options.worker(taskId, frozen, dependencies);
      return typeof produced === "string" ? { artifact: produced } : produced;
    } catch (error) {
      return { failure: error instanceof Error ? error.message : String(error) };
    }
  };

  /** Installs a task's host spec. Kept in one place because a reopened task must be
   *  reinstallable with the consumer's evidence, and its digest must cover that text. */
  const casesTail = (task: "A" | "B") =>
    "\nHost-proven faults the frozen suite does not detect (each is an exact code change): " +
    JSON.stringify(
      (declared[task] ?? []).map(({ id, path, from, to }) => ({ id, path, from, to })),
    ) +
    "\nHost-frozen cases (case name and required title token): " +
    JSON.stringify(noChangeCases[task] ?? []);
  const installB = (tail: string) => {
    specs.B = {
      instruction: options.bInstruction + tail + casesTail("B"),
      files: options.baseline,
      editable: options.bEditable,
      budget: options.budget,
      limits: options.limits,
      visible: options.visible?.B,
      admittedConclusions: options.admitted?.B,
      verify: patchVerifier("B"),
    };
  };
  const installA = (tail: string) => {
    specs.A = {
      instruction: options.aInstruction + tail + casesTail("A"),
      files: options.baseline,
      editable: options.aEditable,
      budget: options.budget,
      limits: options.limits,
      visible: options.visible?.A,
      admittedConclusions: options.admitted?.A,
      verify: patchVerifier("A"),
    };
  };

  /** A round that is already cancelled never starts: the explicit terminal state is the whole
   *  point of cancellation, and a round that threw `round cancelled` from its first coordinator
   *  call would leave the operator with an exception instead of a decision. */
  const cancelledResult = (): CycleResult => {
    const verdicts = { A: "cancelled", B: "cancelled", C: "cancelled" };
    const result: CycleResult = {
      timeline,
      verdicts,
      submissions: {},
      accepted: {},
      rejections: [],
      killed: {},
      survived: {},
      measurements: {
        workers: {},
        hiddenWaitMs: 0,
        checkMs: 0,
        hostChecks: 0,
        hostMs: 0,
        reopens: [],
      },
      composed: { verdict: "undecidable", files: [] },
      log: [],
      cancelled: cancelled ?? "cancelled before dispatch",
    };
    trace({
      kind: "plan",
      tasks: ["A", "B", "C"],
      checks: options.checks.map((check) => check.label),
      revision: options.revision,
      checkDigest: checksDigest(options.checks),
    });
    trace({
      kind: "terminal",
      accepted: {},
      verdicts,
      composed: { verdict: "undecidable", files: [] },
      cancelled: result.cancelled!,
    });
    return { ...result, log: roundLog.recorded() };
  };

  if (stopped()) {
    // The gate is this function's connection to the round's store: the early path has to close
    // it too, or a cancelled round leaves the database locked behind it.
    const early = cancelledResult();
    gate.close();
    return early;
  }

  try {
    trace({
      kind: "plan",
      tasks: ["A", "B", "C"],
      checks: options.checks.map((check) => check.label),
      revision: options.revision,
      checkDigest: checksDigest(options.checks),
    });
    // Class A/D: proving the declared mutants survive is required work that does not
    // depend on B's model call, so it runs concurrently with it instead of before the
    // round. The verifier awaits it, so a false premise still fails closed.
    //
    // Three outcomes, not two: an `undecidable` check measured nothing, and folding it into
    // "already detected" turns a repository hiccup into a false premise — which is how a
    // round once reported a surviving mutant as killed 76 ms after the previous one.
    matrix = (async () => {
      for (const [task, mutants] of Object.entries(declared))
        for (const mutation of mutants ?? []) {
          const run = await check(mutate(options.baseline, mutation));
          if (run.verdict === "accept") {
            log("mutant-survived-baseline", `${task} ${mutation.id}`);
            trace({ kind: "mutant", taskId: task, id: mutation.id, outcome: "survived" });
            continue;
          }
          if (run.verdict === "reject") {
            log("precondition-failed", `${task} ${mutation.id} is already detected`);
            trace({ kind: "mutant", taskId: task, id: mutation.id, outcome: "killed" });
            premiseFailed = true;
            continue;
          }
          log("premise-unmeasured", `${task} ${mutation.id} could not be measured`);
          trace({ kind: "mutant", taskId: task, id: mutation.id, outcome: "unmeasured" });
          premiseUnmeasured = true;
        }
    })();
    // B has no dependency on A, so it runs while A waits on the real check.
    // The declared gaps are part of the frozen instruction, so the digest binds them.
    installB("");
    const ticket = gate.issueCheck("A", "protocol-check-host");
    log("check-issued", ticket.checkId);
    trace({ kind: "check-issued", taskId: "A", ticket });
    const background = check(options.baseline).then((result) => {
      log("check-finished", result.verdict);
      return result;
    });
    let b = await runTask("B");
    const outcome = await background;
    gate.submitCheck({
      ticket,
      outcome: checkOutcome(outcome.verdict),
      log: describeOutcomes(outcome).slice(0, 4_000),
    });
    log("check-terminal", outcome.verdict);
    trace({
      kind: "check-result",
      taskId: "A",
      verdict: outcome.verdict,
      outcomes: outcome.outcomes.map((item) => ({ label: item.label, status: item.status })),
    });
    log("dispatch-after-bypass", gate.next() ?? "none");

    installA(
      `\n\nCheck ${ticket.checkId} finished with ${outcome.verdict} ` +
        `(${describeOutcomes(outcome)}). ` +
        "Fix a defect this check exposed, or return a no-change conclusion citing one listed case.",
    );
    let a = await runTask("A");

    const changedFiles = () => {
      const files: Record<string, string> = {};
      // Only files the accepted work actually changed, so the composed candidate names
      // what the round produced instead of dumping every frozen file.
      for (const submission of [submissions.A, submissions.B])
        if (submission?.kind === "patch")
          for (const [path, content] of Object.entries(submission.files))
            if (options.baseline[path] !== content) files[path] = content;
      return files;
    };
    const compose = async (): Promise<{
      files: Record<string, string>;
      result: CheckOutcomeSummary;
    }> => {
      const files = changedFiles();
      // A cancelled round does not keep verifying: the operator decided the round's work is
      // not wanted, and its composition must not be promoted on a check nobody asked for.
      if (stopped())
        return {
          files: {},
          result: {
            verdict: "undecidable" as const,
            outcomes: [{ label: "cancelled", status: "undecidable" as const }],
          },
        };
      const result = await check({ ...options.baseline, ...files });
      log("composed-check", result.verdict);
      return { files, result };
    };
    let { files: abFiles, result: composed } = await compose();
    /** The round's report, assembled once the phase above has produced its outcome. */
    const buildResult = (): CycleResult => ({
      ...(cancelled ? { cancelled } : {}),
      timeline,
      verdicts,
      submissions,
      rejections,
      killed,
      survived,
      measurements: {
        workers,
        hiddenWaitMs: hiddenWait(),
        checkMs: checkWindow(timeline),
        hostChecks,
        hostMs,
        reopens,
      },
      accepted: gate.accepted(),
      composed: { verdict: composed.verdict, files: Object.keys(abFiles) },
      log: roundLog.recorded(),
    });

    /** C's frozen envelope names the composed candidate it may promote, so it is
     *  installed immediately before every attempt; a reopen changes both. */
    const installC = () => {
      specs.C = {
        instruction:
          "Act as the composition task for this round. A and B already ran; the host has its own composed " +
          "check result. Your submission is accepted only as a promote-candidate conclusion: the host " +
          "rejects any other kind, because the composed candidate is the round's product and nothing " +
          "else can carry it. Return it only when the composed check passed and nothing in the " +
          "submissions weakens verification; if it did not pass, say so instead and explain what is " +
          "wrong, which is recorded as a blocked report rather than an accepted composition.\n" +
          `A=${a}; B=${b}; composed check=${composed.verdict} ` +
          `(${describeOutcomes(composed)}).`,
        files: { ...options.baseline, ...abFiles },
        editable: options.aEditable,
        budget: options.budget,
        limits: options.limits,
        visible: options.visible?.C,
        admittedConclusions: options.admitted?.C,
        verify: composedVerifier(abFiles),
      };
    };

    /* Bounded downstream pushback: a dependent's declared precondition that the host
     * can prove unmet reopens the responsible task with fresh input and fresh check
     * evidence, which fences everything bound to the invalidated value. Exhausting the
     * budget stops the round with evidence instead of repairing in place forever. */
    const maxReopens = defaults.maxReopens;
    let blocked: string | null = null;
    const reopenDependency = async (task: "A" | "B", requirement: string, tail: string) => {
      if (reopens.length >= maxReopens) {
        log("reopen-exhausted", `${task}: ${requirement}`);
        blocked = `${task}: ${requirement}`;
        return false;
      }
      const invalidated = gate.reopen(task, requirement);
      reopens.push(task);
      trace({ kind: "reopen", taskId: task, requirement, invalidated });
      log("reopen", `${task} invalidated=${invalidated.join(",") || "none"}`);
      if (task === "A") {
        // Fresh evidence bound to the new input: a reopened task must not consume the
        // check result that justified the artifact just invalidated.
        const fresh = gate.issueCheck("A", "protocol-check-host");
        log("check-issued", fresh.checkId);
        trace({ kind: "check-issued", taskId: "A", ticket: fresh });
        const rerun = await check(options.baseline);
        gate.submitCheck({
          ticket: fresh,
          outcome: checkOutcome(rerun.verdict),
          log: describeOutcomes(rerun).slice(0, 4_000),
        });
        log("check-terminal", rerun.verdict);
        trace({
          kind: "check-result",
          taskId: "A",
          verdict: rerun.verdict,
          outcomes: rerun.outcomes.map((item) => ({ label: item.label, status: item.status })),
        });
        installA(
          tail +
            `

Check ${fresh.checkId} finished with ${rerun.verdict} ` +
            `(${describeOutcomes(rerun)}).`,
        );
        a = await runTask("A");
      } else {
        installB(tail);
        b = await runTask("B");
      }
      ({ files: abFiles, result: composed } = await compose());
      return true;
    };
    /** Host-provable preconditions first: a requirement the host can evaluate is rejected
     *  before the dependent spends a worker call on an input it cannot use. True means the
     *  dependency was reopened and the loop must run again. */
    const handleUnmetPrecondition = async (): Promise<boolean> => {
      const unmet = firstUnmet("C");
      if (!unmet) return false;
      const note = `C requires ${describe(unmet)}`;
      log("dependency-rejected", note);
      return await reopenDependency(
        unmet.task as "A" | "B",
        note,
        `

A downstream task rejected your accepted artifact: it requires ${describe(unmet)}. ` +
          "Produce a version whose evidence satisfies that requirement, or state why it cannot.",
      );
    };
    /** The dependent discovered mid-attempt that its input is unusable. That report is
     *  evidence about its own execution, not a judgement about the dependency: the host
     *  still decides, and reopening is what makes the dependency run again. */
    const handlePushback = async (): Promise<boolean> => {
      const pushed = lastPushback!;
      return await reopenDependency(
        pushed.dependency as "A" | "B",
        `C cannot satisfy ${pushed.requirement} from ${pushed.dependency}: ${pushed.evidence.slice(0, 300)}`,
        `

The downstream task reported that your artifact cannot satisfy ${pushed.requirement}. ` +
          `Its evidence: ${pushed.evidence.slice(0, 500)}`,
      );
    };
    for (;;) {
      if (await handleUnmetPrecondition()) continue;
      installC();
      const c = await runTask("C");
      if (c !== "blocked-by-dependency") break;
      if (await handlePushback()) continue;
      break;
    }

    if (blocked) verdicts.C = "blocked";
    const result = buildResult();
    roundLog.append({
      kind: "terminal",
      at: new Date().toISOString(),
      accepted: result.accepted,
      verdicts: result.verdicts,
      composed: { verdict: result.composed.verdict, files: [...result.composed.files] },
      ...(result.cancelled ? { cancelled: result.cancelled } : {}),
    });
    return result;
  } finally {
    if (watcher) clearInterval(watcher);
    gate.close();
    if (!options.databaseDir) rmSync(directory, { recursive: true, force: true });
  }
}
