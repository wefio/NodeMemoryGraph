/**
 * The shared coordinator's write path for a managed entry.
 *
 * A board entry that a run has adopted is not the board's alone to move. The design puts the
 * lifecycle operations (`claim`, `deliver`, `judge`, `resolve`, retention) in the board and the
 * coordination in the run: a generic write request on a managed entry is applied *inside the same
 * transition* that appends the run's own fact, so the board transition and the run's record of it
 * stand or fall together, and a direct board verb cannot move a managed entry beside its run. The
 * store refuses that direct write (`requireManagedWriteScope`); this module is what the caller is
 * supposed to reach instead.
 *
 * What is here is deliberately only the write path. Deriving ready/blocked/accepted stays in
 * `task-semantics.ts` as pure functions over the same facts, and the board keeps the authoritative
 * current state: this records the *transitions* the board's current state cannot keep.
 */
import type { NmgStore } from "../core/store.ts";
import type { TransactionPort } from "../core/store/base.ts";

/** The fact kind that says a run was cancelled. One home for the vocabulary: the write that appends
 *  it and the fence that reads it must agree, and neither may guess at the string. */
export const RUN_CANCELLED_FACT = "run-cancelled";

/** The fact kind that binds a logical task to the board entry that carries it. The binding is a run
 *  fact and not a board column because the board cannot keep it: an entry that a later attempt
 *  replaces must not lose the record of what it used to carry. */
export const ENTRY_BOUND_FACT = "entry-bound";

/** A managed transition records itself under its own kind, so the run's log keeps claim, delivery,
 *  judgement and resolution apart instead of collapsing them into one per-(task, attempt) row. */
export function managedTransitionKind(verb: string): string {
  return `board-${verb}`;
}

/** Why this run refuses a managed write at this moment, or null when it accepts one. The two
 *  reasons are facts about the run's own log, so both are re-read inside the transition rather
 *  than remembered from when the caller decided to write. */
export function managedWriteRefusal(store: NmgStore, runId: string): string | null {
  if (!store.taskRunManifest(runId))
    return `run ${runId} is not registered; a managed write needs the run it belongs to`;
  const cancelled = store.taskRunFacts(runId).find((fact) => fact.kind === RUN_CANCELLED_FACT);
  if (cancelled)
    return `run ${runId} was cancelled at sequence ${cancelled.sequence}; its managed entries take no further lifecycle writes`;
  return null;
}

export interface ManagedWriteRequest<T> {
  runId: string;
  entryId: string;
  /** The board verb being applied. It keys the run's fact, so retrying the same verb on the same
   *  attempt appends once instead of twice. */
  verb: string;
  actorId: string;
  /** The board transition itself. It runs inside the coordinated transition, on the same
   *  connection, so a verb that owns a boundary of its own must join with the port it is given. */
  apply: (port: TransactionPort) => T;
}

export interface ManagedWriteOutcome<T> {
  entry: T;
  fact: { sequence: number; recorded: boolean };
}

/**
 * Route one board write on an entry through its run when a run manages it, and leave an unmanaged
 * entry on exactly the path it always took.
 *
 * This is the single routing rule: the daemon's board verbs and every in-process writer use it, so
 * "managed" is decided in one place instead of by each caller's belief about the entry. An entry
 * that no run has bound costs one indexed lookup and no transaction of its own.
 */
export function coordinatedEntryWrite<T>(
  store: NmgStore,
  request: {
    verb: string;
    entryId: string;
    actorId: string;
    apply: () => T;
  },
): T {
  const binding = store.taskRunForEntry(request.entryId);
  if (!binding) return request.apply();
  return coordinatedBoardWrite(store, {
    runId: binding.runId,
    entryId: request.entryId,
    verb: request.verb,
    actorId: request.actorId,
    apply: () => request.apply(),
  }).entry;
}

/**
 * Apply one board transition to a managed entry, with the run's fact in the same transaction.
 *
 * The order is the design's: check the run's own state, re-read the binding at the moment of the
 * write (not when the caller decided to make it), apply the board verb, record the transition. Any
 * failure - including one the caller catches - is the transition's failure, and the store's
 * boundary rolls the whole thing back rather than leaving a verdict without its binding.
 */
export function coordinatedBoardWrite<T>(
  store: NmgStore,
  request: ManagedWriteRequest<T>,
): ManagedWriteOutcome<T> {
  return store.coordinateRunWrite(request.runId, (port) => {
    const refusal = managedWriteRefusal(store, request.runId);
    if (refusal) throw new Error(refusal);
    const binding = store.taskRunForEntry(request.entryId);
    if (!binding)
      throw new Error(
        `entry ${request.entryId} is not adopted by a run, so there is nothing to coordinate it with`,
      );
    if (binding.runId !== request.runId)
      throw new Error(
        `entry ${request.entryId} belongs to run ${binding.runId}, not ${request.runId}`,
      );
    const entry = request.apply(port);
    // The board is authoritative for current state, so the payload only has to make the transition
    // readable later: which agent moved it, and to what state the board moved.
    const status =
      typeof entry === "object" && entry !== null && "status" in entry
        ? String((entry as { status: unknown }).status)
        : null;
    const fact = store.appendTaskRunFact(
      {
        runId: request.runId,
        kind: managedTransitionKind(request.verb),
        taskId: binding.taskId,
        attempt: binding.attempt,
        entryId: request.entryId,
        payload: JSON.stringify({ actorId: request.actorId, status }),
      },
      port,
    );
    return { entry, fact };
  });
}

export interface EntryBindingRequest {
  runId: string;
  /** The logical task, as the run froze it. */
  taskId: string;
  /** The board channel the entry lives on. */
  boardTaskId: string;
  entryId: string;
  /** Which attempt of that task the entry carries. A retry is a new attempt with its own entry. */
  attempt?: number;
}

/**
 * Bind one board entry to one of the run's frozen tasks, so that the entry's later lifecycle writes
 * go through the run's coordinated transition instead of beside it.
 *
 * Every condition here is a fact this store already holds rather than a caller's claim: the run is
 * registered and live, the task was frozen (a run cannot adopt an entry for work it never froze),
 * the entry really is on the channel the caller names, and one entry carries one task. Re-binding
 * the same task and attempt to the same entry is a retry and is not recorded twice; binding it to a
 * different entry is refused rather than silently dropped, because the stored fact is keyed by task
 * and attempt and would otherwise hide the disagreement.
 */
export function bindRunEntry(
  store: NmgStore,
  request: EntryBindingRequest,
  port?: TransactionPort,
): { sequence: number; recorded: boolean } {
  const attempt = request.attempt ?? 1;
  const work = (inner: TransactionPort): { sequence: number; recorded: boolean } => {
    const refusal = managedWriteRefusal(store, request.runId);
    if (refusal) throw new Error(refusal);
    if (!isFrozen(store, request.runId, request.taskId))
      throw new Error(
        `run ${request.runId} never froze task ${request.taskId}; there is no task to bind an entry to`,
      );
    if (!store.getTaskBoardEntryById(request.boardTaskId, request.entryId))
      throw new Error(
        `no board entry ${request.entryId} on ${request.boardTaskId}; the binding names the entry it carries`,
      );
    const bound = store.taskRunForEntry(request.entryId);
    if (bound && (bound.runId !== request.runId || bound.taskId !== request.taskId))
      throw new Error(
        `entry ${request.entryId} already carries task ${bound.taskId} of run ${bound.runId}; one entry carries one task`,
      );
    const existing = boundFact(store, request.runId, request.taskId, attempt);
    if (existing && existing.entryId !== request.entryId)
      throw new Error(
        `task ${request.taskId} of run ${request.runId} already carries entry ${existing.entryId}; another entry is another attempt, not a rebinding`,
      );
    if (existing) return { sequence: existing.sequence, recorded: false };
    return store.appendTaskRunFact(
      {
        runId: request.runId,
        kind: ENTRY_BOUND_FACT,
        taskId: request.taskId,
        attempt,
        entryId: request.entryId,
      },
      inner,
    );
  };
  return port ? work(port) : store.coordinateRunWrite(request.runId, work);
}

/** Whether this run froze that task. Frozen is what a binding is a binding *to*. */
function isFrozen(store: NmgStore, runId: string, taskId: string): boolean {
  return store.taskRunTasks(runId).some((task) => task.taskId === taskId);
}

/** The binding already recorded for this task and attempt, if any. */
function boundFact(
  store: NmgStore,
  runId: string,
  taskId: string,
  attempt: number,
): { sequence: number; entryId: string | null } | undefined {
  const fact = store
    .taskRunFacts(runId)
    .find(
      (candidate) =>
        candidate.kind === ENTRY_BOUND_FACT &&
        candidate.taskId === taskId &&
        candidate.attempt === attempt,
    );
  return fact && { sequence: fact.sequence, entryId: fact.entryId };
}
