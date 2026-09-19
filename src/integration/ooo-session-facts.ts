/**
 * The session decision a unit was admitted or closed under, recorded as a run fact.
 *
 * The board already records which session wrote an entry, so a unit's session is not declared
 * twice. What it did not record is the decision itself: which move was taken at a boundary, and
 * what the facts were when it was taken. That is what this module writes, under a kind declared
 * here - one home for the vocabulary, the rule `task-coordinator.ts` states for its own kinds,
 * because the write that appends a fact and the read that acts on it must agree and neither may
 * guess at the string.
 *
 * Nothing here decides: the decision is `nextSessionMove`'s, a pure function of the plan and the
 * facts. This module only gives that decision a name and a home in the run's log.
 */
import type { NmgStore } from "../core/store.ts";
import type { SessionMove } from "./ooo-fusion-plan.ts";

/** The fact kind that records one session move. Declared next to its one write. */
export const SESSION_MOVE_FACT = "session-move";

/** One recorded move, with the sequence number the run's log gave it. */
export interface RecordedSessionMove {
  readonly sequence: number;
  readonly move: SessionMove;
}

/** The move as the payload a run fact carries: JSON, so the fact stays readable and replayable. */
export function sessionMovePayload(move: SessionMove): string {
  return JSON.stringify(move);
}

/** A fact's payload, read as the unknown value it is rather than assumed to be one. */
function payloadOf(fact: unknown): unknown {
  return typeof fact === "object" && fact !== null
    ? (fact as { payload?: unknown }).payload
    : undefined;
}

/** Read a payload back as a move, or null when it is absent or is not one this module wrote. */
export function parseSessionMove(payload: unknown): SessionMove | null {
  if (typeof payload !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as { kind?: unknown; unit?: unknown; reason?: unknown };
  if (candidate.kind === "admit" && typeof candidate.unit === "string")
    return { kind: "admit", unit: candidate.unit };
  if (candidate.kind === "close" && typeof candidate.reason === "string")
    return { kind: "close", reason: candidate.reason };
  return null;
}

/**
 * Append this move to the run's log. A fact's identity is (run, kind, task, attempt), so recording
 * the same move twice records it once - which is what makes a retry after a lost response safe.
 */
export function recordSessionMove(
  store: NmgStore,
  input: {
    runId: string;
    move: SessionMove;
    taskId?: string;
    attempt?: number;
    entryId?: string | null;
  },
): { sequence: number; recorded: boolean } {
  return store.appendTaskRunFact({
    runId: input.runId,
    kind: SESSION_MOVE_FACT,
    taskId: input.taskId,
    attempt: input.attempt,
    entryId: input.entryId,
    payload: sessionMovePayload(input.move),
  });
}

/** Every move this run recorded, oldest first, skipping facts this module does not recognise. */
export function recordedSessionMoves(store: NmgStore, runId: string): RecordedSessionMove[] {
  const moves: RecordedSessionMove[] = [];
  for (const fact of store.taskRunFacts(runId)) {
    if (fact.kind !== SESSION_MOVE_FACT) continue;
    const move = parseSessionMove(payloadOf(fact));
    if (move) moves.push({ sequence: fact.sequence, move });
  }
  return moves;
}
