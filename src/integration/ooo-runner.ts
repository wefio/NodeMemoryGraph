/**
 * The store's own board: one run driven through the product's record.
 *
 * This is the third implementation of `DispatchBoard` - the probe board and the dispatch test's stub
 * are the other two - and it is deliberately the thinnest of the three. No legality rule lives here:
 * the plan is compiled by `compileTaskUnits`, the legal set is `dispatchTasks` and `selectableTasks`,
 * cancellations are read through the coordinator's own reader, and the verdict belongs to the
 * caller's acceptance. What this module adds is a **projection** from the product's run tables and
 * board entries into the facts those pure functions read, plus the six board operations. A rule that
 * turns out to be needed here belongs in `task-semantics.ts` instead: needing one is how this module
 * would show that the abstraction leaked.
 *
 * Two things the projection cannot read from the store are the caller's, and both are existing
 * divisions rather than new ones: a task's declared file contents (the store freezes paths, and
 * preparing the workspace belongs to the patch path's caller) and an acceptance whose identity is
 * independent of the deliverer (the store refuses a deliverer that judges its own delivery).
 */
import { workDigest } from "./work-identity.ts";
import type { NmgStore } from "../core/store.ts";
import { taskBoardClaimIsLive } from "../core/store/base.ts";
import { TASK_BOARD_VERDICTS } from "../core/types.ts";
import type { DispatchBoard, DispatchEntry, DispatchTicket } from "./ooo-dispatch.ts";
import type { PatchTaskSpec, ProbeOperation, ProbePlan } from "./ooo-board.ts";
import {
  patchSubmission,
  preparePatchWork,
  type PatchSubmission,
  type PatchWork,
} from "./ooo-patch.ts";
import { selectableTasks } from "./ooo-execution.ts";
import { compileTaskUnits, dispatchTasks, type RecordedFacts } from "./task-semantics.ts";
import { coordinatedBoardWrite, taskCancellation, taskRunStatus } from "./task-coordinator.ts";

/** The words a board verdict may use, as the store defines them. */
export type RunVerdict = (typeof TASK_BOARD_VERDICTS)[number];

/** The words an acceptance may answer with, as a patch spec defines them. */
export type AcceptanceAnswer = "accept" | "reject" | "undecidable";

export interface RunBoardOptions {
  runId: string;
  /** The channel this run's entries live on. The caller declares it, because an entry is looked up by
   *  the channel it was put on rather than by the run owning exactly one. */
  channel: string;
  /** How many units of the legal set may be in flight at once. Declared by the run, read as given. */
  slots: number;
  /** The declared files' contents: the store froze the paths a task declares, and the bytes are the
   *  caller's, which is the division the patch work already assumes. */
  workspace: (taskId: string, files: readonly string[]) => Readonly<Record<string, string>>;
  /** The acceptance, and a name that need not be the deliverer's: the store refuses a deliverer that
   *  judges its own delivery, so a run whose judge is its worker is refused by the board and not by
   *  this module. One acceptance is read twice - the compiler freezes it into each spec and the board
   *  asks it again when a delivery arrives - so a unit's declared acceptance and its verdict cannot
   *  come to mean two things. */
  acceptance: {
    agentId: string;
    verify: (input: {
      taskId: string;
      submission: PatchSubmission;
    }) => Promise<AcceptanceAnswer> | AcceptanceAnswer;
  };
  /** The clock the loop stamps entries with. Omitted, the process clock. */
  now?: () => number;
}

/** One task of the frozen plan, as the store has it. */
type RunTask = ReturnType<NmgStore["taskRunTasks"]>[number];

/** One binding: the entry a task's work is carried by. */
type RunBinding = ReturnType<typeof taskRunStatus>["bindings"][number];

/** The store's board for one run, satisfying the loop's port and nothing else. */
export class StoreRunBoard implements DispatchBoard {
  readonly channel: string;
  readonly #store: NmgStore;
  readonly #options: RunBoardOptions;

  constructor(store: NmgStore, options: RunBoardOptions) {
    this.#store = store;
    this.#options = options;
    this.channel = options.channel;
  }

  get now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  /** What the loop may claim right now, in the shared rule's own order. */
  candidates(): readonly string[] {
    const { compiled, facts } = this.#projection();
    return selectableTasks(dispatchTasks(compiled.units, facts), this.#options.slots);
  }

  /** The accepted artifact per task id: the same map the rules read, so the two cannot disagree. */
  accepted(): Readonly<Record<string, string>> {
    return this.#projection().facts.artifacts ?? {};
  }

  /** Take one unit. The claim is the store's compare-and-set on the entry its binding names. */
  claim(taskId: string, owner: string): DispatchTicket {
    const binding = this.#bindingFor(taskId);
    const entry = coordinatedBoardWrite(this.#store, {
      runId: this.#options.runId,
      entryId: binding.entryId,
      verb: "claim",
      actorId: owner,
      apply: () =>
        this.#store.claimTaskBoardEntry({
          taskId: this.channel,
          entryId: binding.entryId,
          agentId: owner,
        }),
    }).entry;
    const attempt = entry.attempt ?? binding.attempt;
    const task = this.#task(taskId);
    const accepted = this.accepted();
    return {
      attempt,
      dependencies: Object.fromEntries(
        task.dependencies
          .filter((dependency) => dependency in accepted)
          .map((dependency) => [dependency, accepted[dependency]!]),
      ),
      patch: this.#work(task, attempt) ?? undefined,
    };
  }

  /**
   * The port's "put a result" is the product's delivery: the artifact lands on the entry the unit was
   * claimed on, which is where this board keeps deliverables and where a judge looks for one. The unit
   * is resolved from the claim - the identity the loop claimed with - and not from the content, because
   * how a body is shaped is the shape owner's business while a claim is the board's own fact.
   *
   * The returned identity is therefore the claimed entry rather than a new one: this board records a
   * unit's work once, on the entry that carries the unit, instead of once on that entry and again on a
   * result entry nothing would read.
   */
  putTaskBoardEntry(input: {
    taskId: string;
    agentId: string;
    kind: "result";
    content: string;
    expiresAt: string;
  }): DispatchEntry {
    const binding = this.#claimedBy(input.agentId);
    const artifact = artifactOf(input.content);
    coordinatedBoardWrite(this.#store, {
      runId: this.#options.runId,
      entryId: binding.entryId,
      verb: "deliver",
      actorId: input.agentId,
      apply: () =>
        this.#store.deliverTaskBoardEntry({
          taskId: this.channel,
          entryId: binding.entryId,
          agentId: input.agentId,
          digest: workDigest(artifact),
          ref: artifact,
        }),
    });
    return { id: binding.entryId };
  }

  /**
   * Let the acceptance decide the verdict of what was delivered, under the judge's own name. The
   * frozen envelope is rebuilt here for the same reason the loop rebuilds it: the digest is the
   * artifact's identity, and recomputing it is how a caller holding only an entry id gets it back.
   */
  async submit(entryId: string): Promise<string> {
    const binding = this.#store.taskRunForEntry(entryId);
    if (!binding) throw new Error(`entry ${entryId} is not adopted by a run, so it has no verdict`);
    const entry = this.#store.getTaskBoardEntryById(this.channel, entryId);
    if (!entry) throw new Error(`no board entry ${entryId} on channel ${this.channel}`);
    if (entry.deliverableRef === null && entry.deliverableDigest === null)
      throw new Error(`entry ${entryId} holds no deliverable, so there is nothing to judge`);
    const task = this.#task(binding.taskId);
    const artifact = entry.deliverableRef ?? entry.deliverableDigest!;
    const verdict = verdictOf(
      await this.#options.acceptance.verify({
        taskId: task.taskId,
        submission: patchSubmission(
          frozenOf(this.#declarationOnly(task, entry.attempt ?? binding.attempt)),
          artifact,
        ),
      }),
    );
    coordinatedBoardWrite(this.#store, {
      runId: this.#options.runId,
      entryId,
      verb: "judge",
      actorId: this.#options.acceptance.agentId,
      apply: () =>
        this.#store.judgeTaskBoardEntry({
          taskId: this.channel,
          entryId,
          agentId: this.#options.acceptance.agentId,
          verdict,
        }),
    });
    return verdict;
  }

  /** The frozen plan compiled by the shared compiler, and the facts the run's entries record. */
  #projection(): { compiled: ReturnType<typeof compileTaskUnits>; facts: RecordedFacts } {
    const tasks = this.#tasks();
    const specs: Record<string, PatchTaskSpec> = {};
    for (const task of tasks) {
      const declared = task.patchFiles ?? [];
      if (declared.length === 0 && task.patchEditable === null) continue;
      specs[task.taskId] = {
        instruction: task.input,
        files: this.#options.workspace(task.taskId, declared),
        editable: [...(task.patchEditable ?? [])],
        visible: [...declared],
        verify: async (submission) =>
          this.#options.acceptance.verify({ taskId: task.taskId, submission }),
      };
    }
    const compiled = compileTaskUnits({ plan: this.#plan(tasks), specs });
    if (!compiled.legal) {
      // A plan the shared compiler refuses is refused here by name, with the refusals that say why.
      const first = compiled.refusals[0];
      throw new Error(
        `plan refused by the shared semantics: ${compiled.refusals.length} refusal(s); first is ` +
          `${String(first?.task)}/${String(first?.field)}: ${String(first?.reason)}`,
      );
    }
    return { compiled, facts: this.#recordedFacts() };
  }

  /** The frozen plan in the row shape the shared compiler reads. */
  #plan(tasks: readonly RunTask[]): ProbePlan {
    return tasks.map((task) => [
      task.taskId,
      task.input,
      [...task.dependencies],
      task.effect,
      task.waitEvent,
      (task.operation === "" ? null : task.operation) as ProbeOperation | null,
    ]);
  }

  /**
   * The run's record as the pure rules read it. Every fact comes from where it is authoritative - the
   * entries for claims and verdicts, the run's log for cancellations - and nothing is derived here.
   */
  #recordedFacts(): RecordedFacts {
    const artifacts: Record<string, string> = {};
    const verdicts: Record<string, { digest: string; verdict: RunVerdict }> = {};
    const claimed: string[] = [];
    const now = new Date(this.now).toISOString();
    for (const binding of this.#bindings()) {
      const entry = binding.entryId
        ? this.#store.getTaskBoardEntryById(this.channel, binding.entryId)
        : null;
      if (!entry) continue;
      if (entry.verdict !== null && entry.deliverableDigest !== null) {
        // Two identities meet here and only one of them is the rule's. The store keeps a hash of the
        // deliverable in its own column, while the shared acceptance rule binds a verdict to the
        // artifact value the run carries: it compares the verdict's digest against the artifact, so a
        // verdict about another artifact cannot pass as acceptance. This projection therefore reports
        // the artifact as the digest, and the store's hash stays where it is authoritative - the
        // judge's own guard, which refuses a verdict once the deliverable has changed.
        const artifact = entry.deliverableRef ?? artifactOf(entry.content);
        verdicts[binding.taskId] = { digest: artifact, verdict: entry.verdict as RunVerdict };
        if (entry.verdict === "accepted") artifacts[binding.taskId] = artifact;
      }
      if (taskBoardClaimIsLive(entry, now)) claimed.push(binding.taskId);
    }
    const cancellations = this.#tasks()
      .filter((task) => taskCancellation(this.#store, this.#options.runId, task.taskId) !== null)
      .map((task) => task.taskId);
    return { artifacts, verdicts, claimed, cancellations };
  }

  /** The entry each task of the plan is bound to, from the run's own record of its bindings. */
  #bindings(): readonly RunBinding[] {
    return taskRunStatus(this.#store, this.#options.runId).bindings;
  }

  /** The entry a claim holder's work belongs to: the one live claim that is theirs, by name. */
  #claimedBy(owner: string): { taskId: string; attempt: number; entryId: string } {
    const now = new Date(this.now).toISOString();
    const held = this.#bindings().filter((binding) => {
      const entry = binding.entryId
        ? this.#store.getTaskBoardEntryById(this.channel, binding.entryId)
        : null;
      return entry !== null && entry.claimedBy === owner && taskBoardClaimIsLive(entry, now);
    });
    const only = held.length === 1 ? held[0] : undefined;
    if (!only?.entryId)
      throw new Error(
        held.length === 0
          ? `${owner} holds no live claim on channel ${this.channel}, so a result has no unit to belong to`
          : `${owner} holds ${held.length} live claims on channel ${this.channel}, so a result cannot be placed`,
      );
    return { taskId: only.taskId, attempt: only.attempt, entryId: only.entryId };
  }

  #bindingFor(taskId: string): { taskId: string; attempt: number; entryId: string } {
    const binding = [...this.#bindings()]
      .reverse()
      .find((candidate) => candidate.taskId === taskId);
    if (!binding?.entryId)
      throw new Error(
        `no entry is adopted for task ${taskId} of run ${this.#options.runId} on channel ${this.channel}`,
      );
    return { taskId: binding.taskId, attempt: binding.attempt, entryId: binding.entryId };
  }

  #tasks(): readonly RunTask[] {
    return [...this.#store.taskRunTasks(this.#options.runId)].sort(
      (left, right) => left.position - right.position,
    );
  }

  #task(taskId: string): RunTask {
    const task = this.#tasks().find((candidate) => candidate.taskId === taskId);
    if (!task) throw new Error(`run ${this.#options.runId} freezes no task ${taskId}`);
    return task;
  }

  /**
   * The work a claim admits: the declaration the store froze, with the caller's bytes in it. Null when
   * the task declares no patch files, which is the store's own reading of a non-patch unit.
   */
  #work(task: RunTask, attempt: number): PatchWork | null {
    const declared = task.patchFiles ?? [];
    if (declared.length === 0 && task.patchEditable === null) return null;
    return this.#declarationOnly(task, attempt);
  }

  #declarationOnly(task: RunTask, attempt: number): PatchWork {
    const declared = task.patchFiles ?? [];
    return {
      taskId: task.taskId,
      attempt,
      instruction: task.input,
      files: this.#options.workspace(task.taskId, declared),
      editable: [...(task.patchEditable ?? [])],
      visible: [...declared],
    };
  }
}

/** The frozen envelope of a declaration, which is what the shape's own parser needs. */
function frozenOf(work: PatchWork) {
  return preparePatchWork({
    taskId: work.taskId,
    attempt: work.attempt,
    instruction: work.instruction,
    files: work.files,
    editable: work.editable,
    visible: work.visible,
  });
}

/** The artifact a worker's entry carries: the loop's own put shape, read back without interpretation. */
function artifactOf(content: string): string {
  try {
    const parsed = JSON.parse(content) as { artifact?: unknown };
    if (typeof parsed.artifact === "string") return parsed.artifact;
  } catch {
    // Not the loop's shape: the content is the artifact itself.
  }
  return content;
}

/** One acceptance's answer as the board's word for it. */
function verdictOf(answer: AcceptanceAnswer): RunVerdict {
  if (answer === "accept") return "accepted";
  if (answer === "reject") return "rejected";
  return "undecidable";
}
