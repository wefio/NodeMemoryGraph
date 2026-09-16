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
