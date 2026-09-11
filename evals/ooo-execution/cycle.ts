import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardAdmission, type PatchTaskSpec, type ProbePlan } from "./board-admission.ts";
import { verifyCandidate, type CandidateCheck } from "./candidate.ts";
import {
  preparePatchWork,
  patchSubmission,
  type ConclusionKind,
  type FrozenPatchWork,
  type PatchSubmission,
} from "../../src/integration/ooo-patch.ts";

import { mutate, type Mutation } from "./mutation.ts";

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
}

const plan: ProbePlan = [
  ["A", "", [], "isolated-artifact", "protocol-regression", null],
  ["B", "", [], "isolated-artifact", null, null],
  ["C", "", ["A", "B"], "isolated-artifact", null, null],
];

/** Host driver for one A/B/C round: the check is real and concurrent with B, the
 *  bypass is the coordinator's decision, and every acceptance is host-verified. */
export async function runCycle(options: CycleOptions): Promise<CycleResult> {
  const runChecks = (options.runChecks ?? verifyCandidate) as CheckRunner;
  const directory = options.databaseDir ?? mkdtempSync(join(tmpdir(), "ooo-cycle-db-"));
  const specs: Record<string, PatchTaskSpec> = {};
  const gate = new BoardAdmission(join(directory, "store.sqlite"), plan, specs);
  const timeline: CycleResult["timeline"] = [];
  const verdicts: Record<string, string> = {};
  const submissions: Record<string, PatchSubmission> = {};
  const rejections: CycleResult["rejections"] = [];
  const noChangeCases = structuredClone(options.noChangeCases ?? {});
  const declared = structuredClone(options.mutations ?? {});
  const killed: Record<string, string[]> = {};
  const survived: Record<string, string[]> = {};
  const workers: CycleResult["measurements"]["workers"] = {};
  const reopens: string[] = [];
  let lastPushback: { dependency: string; requirement: string; evidence: string } | undefined;
  let premiseFailed = false;
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
      `${result.verdict}: ${result.outcomes.map((item) => `${item.label}=${item.status}`).join(", ")}` +
      (failed?.log ? ` | ${failed.log.slice(-600)}` : "");
    log("candidate-check", detail);
    return result.verdict;
  };
  const patchVerifier = (task: "A" | "B") => async (submission: PatchSubmission) => {
    const mutants = declared[task] ?? [];
    // Proven-gap mode replaces the title-token rule for patches, rather than stacking
    // with it: a surviving mutant is strictly stronger evidence than a title match, and
    // a round that declares both would reject a candidate for the weaker rule.
    const cases = mutants.length ? [] : (noChangeCases[task] ?? []);
    if (submission.kind === "patch") {
      // The mutant premise gates acceptance, not the start of work: awaiting the
      // concurrently proved matrix here keeps a false premise from accepting anything.
      await matrix;
      if (premiseFailed) {
        log("premise-invalid", `${task}: a declared mutant is already detected`);
        return "reject";
      }
      const candidate = { ...options.baseline, ...submission.files };
      const available = titles(candidate);
      for (const rule of cases)
        if (!caseResolved(rule, available, new Map())) {
          log("case-unresolved", `${task} ${rule.name} -> no test title matching ${rule.token}`);
          return "reject";
        }
      // The retention rule of mutation-guided testing: a new test is worth keeping
      // only if it passes on the intact implementation and fails on a mutant.
      const intact = await check(candidate);
      if (intact.verdict !== "accept") return record(intact);
      for (const mutation of mutants) {
        const run = await check(mutate(candidate, mutation));
        if (run.verdict === "reject") {
          (killed[task] ??= []).push(mutation.id);
          log("mutant-killed", `${task} ${mutation.id}`);
        } else {
          (survived[task] ??= []).push(mutation.id);
          log("mutant-survived", `${task} ${mutation.id}`);
        }
      }
      if (mutants.length && !killed[task]?.length) {
        log("gap-not-closed", `${task}: no declared mutant killed`);
        return "reject";
      }
      return record(intact);
    }
    // A blocked report is not completed work: it must not unlock A or C.
    if (submission.conclusion === "cannot-complete") {
      log("blocked", `${task}: ${submission.summary.slice(0, 300)}`);
      return "reject";
    }
    if (submission.conclusion !== "no-change-needed") return "reject";
    // When the host has proved a surviving mutant, "no change needed" is false by
    // the host's own evidence, so it cannot be accepted on any citation.
    if (mutants.length) {
      log("gap-proven", `${task}: ${mutants.length} declared mutant(s) survived the frozen suite`);
      return "reject";
    }
    if (!noChangeCases[task]?.length) return "reject";
    // A no-change claim is only as good as a citation the host can resolve: an
    // invented, misquoted, or missing citation fails closed.
    const cited = new Map(submission.citations.map((item) => [item.case, item.test]));
    const unknown = [...cited.keys()].find((name) => !cases.some((rule) => rule.name === name));
    if (unknown) {
      log("citation-unresolved", `${task} unknown case ${unknown}`);
      return "reject";
    }
    for (const rule of cases)
      if (!caseResolved(rule, frozenTitles, cited)) {
        log("citation-unresolved", `${task} ${rule.name} -> ${cited.get(rule.name) ?? "none"}`);
        return "reject";
      }
    const result = await check(options.baseline);
    if (
      !options.checks.length ||
      options.checks.some(
        ({ label }) =>
          !result.outcomes.some((item) => item.label === label && item.status === "passed"),
      )
    )
      return "undecidable";
    return record(result);
  };
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

  /** One worker invocation only. A rejected claim is not artificially expired. */
  const runTask = async (taskId: string) => {
    // Selection belongs to the coordinator: an unreleased dependency or a live
    // claim on another task means this task simply does not run in this round.
    const selected = gate.next();
    if (selected !== taskId) {
      log(`skip:${taskId}`, `selected=${selected ?? "none"}`);
      return undefined;
    }
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
    if (frozen.digest !== ticket.patch.digest) {
      // A bare "mismatch" cost two debugging rounds; the error states what differs.
      const differing = Object.keys(frozen.work).filter(
        (key) =>
          JSON.stringify((frozen.work as unknown as Record<string, unknown>)[key]) !==
          JSON.stringify((ticket.patch as unknown as Record<string, unknown>)[key]),
      );
      throw new Error(
        `frozen digest mismatch: ${frozen.digest.slice(0, 12)} vs ${ticket.patch.digest.slice(0, 12)}; ` +
          `differing fields: ${differing.join(", ") || "none"} ` +
          differing
            .map(
              (key) =>
                `${key}=${JSON.stringify((frozen.work as unknown as Record<string, unknown>)[key])} vs ${JSON.stringify((ticket.patch as unknown as Record<string, unknown>)[key])}`,
            )
            .join(" | "),
      );
    }
    log(`claim:${taskId}`, `attempt=${ticket.attempt} digest=${frozen.digest.slice(0, 12)}`);
    // A worker that fails or returns truncated output produced no artifact: it is a
    // failed attempt with recorded reason, not a crashed round and not a retry.
    let artifact: string;
    let pushback: { dependency: string; requirement: string; evidence: string } | undefined;
    try {
      const produced = await options.worker(taskId, frozen, ticket.dependencies);
      if (typeof produced === "string") artifact = produced;
      else {
        artifact = produced.artifact;
        pushback = produced.pushback;
        if (produced.metrics) workers[taskId] = { ...produced.metrics, ms: Date.now() - claimedAt };
      }
      if (pushback) {
        lastPushback = pushback;
        log(
          `pushback:${taskId}`,
          `${pushback.dependency} ${pushback.requirement}: ${pushback.evidence.slice(0, 200)}`,
        );
        verdicts[taskId] = "blocked-by-dependency";
        return "blocked-by-dependency";
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`worker-failed:${taskId}`, reason.slice(0, 400));
      rejections.push({ task: taskId, attempt: ticket.attempt, artifact: reason.slice(0, 2_000) });
      verdicts[taskId] = "rejected";
      return "rejected";
    }
    // The coordinator stays the acceptance authority; this local parse only records
    // why the shared contract rejected an artifact, which is otherwise invisible.
    try {
      patchSubmission(frozen, artifact);
    } catch (error) {
      log(
        `contract-error:${taskId}`,
        (error instanceof Error ? error.message : String(error)).slice(0, 300),
      );
    }
    const entry = gate.putTaskBoardEntry({
      taskId: "ooo-process-probe",
      agentId: ticket.owner,
      kind: "result",
      content: JSON.stringify({ ticket, artifact }),
      expiresAt: new Date(gate.now + 86_400_000).toISOString(),
    });
    const verdict = await gate.submit(entry.id);
    log(`submit:${taskId}`, verdict);
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

  try {
    // Class A/D: proving the declared mutants survive is required work that does not
    // depend on B's model call, so it runs concurrently with it instead of before the
    // round. The verifier awaits it, so a false premise still fails closed.
    matrix = (async () => {
      for (const [task, mutants] of Object.entries(declared))
        for (const mutation of mutants ?? []) {
          const run = await check(mutate(options.baseline, mutation));
          if (run.verdict === "accept") {
            log("mutant-survived-baseline", `${task} ${mutation.id}`);
          } else {
            log("precondition-failed", `${task} ${mutation.id} is already detected`);
            premiseFailed = true;
          }
        }
    })();
    // B has no dependency on A, so it runs while A waits on the real check.
    // The declared gaps are part of the frozen instruction, so the digest binds them.
    installB("");
    const ticket = gate.issueCheck("A", "protocol-check-host");
    log("check-issued", ticket.checkId);
    const background = check(options.baseline).then((result) => {
      log("check-finished", result.verdict);
      return result;
    });
    let b = await runTask("B");
    const outcome = await background;
    gate.submitCheck({
      ticket,
      outcome:
        outcome.verdict === "accept"
          ? "passed"
          : outcome.verdict === "reject"
            ? "failed"
            : "undecidable",
      log: outcome.outcomes
        .map((item) => `${item.label}=${item.status}`)
        .join(", ")
        .slice(0, 4_000),
    });
    log("check-terminal", outcome.verdict);
    log("dispatch-after-bypass", gate.next() ?? "none");

    installA(
      `\n\nCheck ${ticket.checkId} finished with ${outcome.verdict} ` +
        `(${outcome.outcomes.map((item) => `${item.label}=${item.status}`).join(", ")}). ` +
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
    const compose = async () => {
      const files = changedFiles();
      const result = await check({ ...options.baseline, ...files });
      log("composed-check", result.verdict);
      return { files, result };
    };
    let { files: abFiles, result: composed } = await compose();

    /* Bounded downstream pushback: a dependent's declared precondition that the host
     * can prove unmet reopens the responsible task with fresh input and fresh check
     * evidence, which fences everything bound to the invalidated value. Exhausting the
     * budget stops the round with evidence instead of repairing in place forever. */
    const maxReopens = options.maxReopens ?? 1;
    let blocked: string | null = null;
    const reopenDependency = async (task: "A" | "B", requirement: string, tail: string) => {
      if (reopens.length >= maxReopens) {
        log("reopen-exhausted", `${task}: ${requirement}`);
        blocked = `${task}: ${requirement}`;
        return false;
      }
      const invalidated = gate.reopen(task, requirement);
      reopens.push(task);
      log("reopen", `${task} invalidated=${invalidated.join(",") || "none"}`);
      if (task === "A") {
        // Fresh evidence bound to the new input: a reopened task must not consume the
        // check result that justified the artifact just invalidated.
        const fresh = gate.issueCheck("A", "protocol-check-host");
        log("check-issued", fresh.checkId);
        const rerun = await check(options.baseline);
        gate.submitCheck({
          ticket: fresh,
          outcome:
            rerun.verdict === "accept"
              ? "passed"
              : rerun.verdict === "reject"
                ? "failed"
                : "undecidable",
          log: rerun.outcomes
            .map((item) => `${item.label}=${item.status}`)
            .join(", ")
            .slice(0, 4_000),
        });
        log("check-terminal", rerun.verdict);
        installA(
          tail +
            `

Check ${fresh.checkId} finished with ${rerun.verdict} ` +
            `(${rerun.outcomes.map((item) => `${item.label}=${item.status}`).join(", ")}).`,
        );
        a = await runTask("A");
      } else {
        installB(tail);
        b = await runTask("B");
      }
      ({ files: abFiles, result: composed } = await compose());
      return true;
    };
    for (;;) {
      // Host-provable preconditions first: a requirement the host can evaluate is
      // rejected before the dependent spends a worker call on an input it cannot use.
      const unmet = firstUnmet("C");
      if (unmet) {
        const note = `C requires ${describe(unmet)}`;
        log("dependency-rejected", note);
        const reopened = await reopenDependency(
          unmet.task as "A" | "B",
          note,
          `

A downstream task rejected your accepted artifact: it requires ${describe(unmet)}. ` +
            "Produce a version whose evidence satisfies that requirement, or state why it cannot.",
        );
        if (reopened) continue;
        break;
      }
      // C's frozen envelope names the composed candidate it may promote, so it is
      // installed immediately before every attempt; a reopen changes both.
      specs.C = {
        instruction:
          "Act as the composition task for this round. A and B already ran; the host has its own composed " +
          "check result. Your submission is accepted only as a promote-candidate conclusion: the host " +
          "rejects any other kind, because the composed candidate is the round's product and nothing " +
          "else can carry it. Return it only when the composed check passed and nothing in the " +
          "submissions weakens verification; if it did not pass, say so instead and explain what is " +
          "wrong, which is recorded as a blocked report rather than an accepted composition.\n" +
          `A=${a}; B=${b}; composed check=${composed.verdict} ` +
          `(${composed.outcomes.map((item) => `${item.label}=${item.status}`).join(", ")}).`,
        files: { ...options.baseline, ...abFiles },
        editable: options.aEditable,
        budget: options.budget,
        limits: options.limits,
        visible: options.visible?.C,
        admittedConclusions: options.admitted?.C,
        verify: composedVerifier(abFiles),
      };
      const c = await runTask("C");
      if (c !== "blocked-by-dependency") break;
      // The dependent discovered mid-attempt that its input is unusable. That report is
      // evidence about its own execution, not a judgement about the dependency: the host
      // still decides, and reopening is what makes the dependency run again.
      const pushed = lastPushback!;
      const reopened = await reopenDependency(
        pushed.dependency as "A" | "B",
        `C cannot satisfy ${pushed.requirement} from ${pushed.dependency}: ${pushed.evidence.slice(0, 300)}`,
        `

The downstream task reported that your artifact cannot satisfy ${pushed.requirement}. ` +
          `Its evidence: ${pushed.evidence.slice(0, 500)}`,
      );
      if (reopened) continue;
      break;
    }

    if (blocked) verdicts.C = "blocked";
    return {
      timeline,
      verdicts,
      submissions,
      rejections,
      killed,
      survived,
      measurements: {
        workers,
        hiddenWaitMs: hiddenWait(),
        checkMs:
          Date.parse(timeline.find((e) => e.step === "check-finished")?.at ?? "0") -
            Date.parse(timeline.find((e) => e.step === "check-issued")?.at ?? "0") || 0,
        hostChecks,
        hostMs,
        reopens,
      },
      accepted: gate.accepted(),
      composed: { verdict: composed.verdict, files: Object.keys(abFiles) },
    };
  } finally {
    gate.close();
    if (!options.databaseDir) rmSync(directory, { recursive: true, force: true });
  }
}
