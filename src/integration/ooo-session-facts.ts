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
import { nextSessionMove, type SessionMove, type SessionMoveInput } from "./ooo-fusion-plan.ts";
import { RUN_CANCELLED_FACT } from "./task-coordinator.ts";

/** The fact kind that records one session move. Declared next to its one write. */
export const SESSION_MOVE_FACT = "session-move";

/**
 * The key one board session's runner is held under.
 *
 * Grouping and reuse are the mechanism, so they live here rather than in the harness that happens to
 * be running the unit: the key is a function of what the board already holds - the run and the
 * session that owns its entries - and of nothing else. Two callers that see the same run and the
 * same session therefore compute the same key and reuse the same runner, whatever they are, and a
 * replay computes it again rather than remembering it.
 *
 * A missing part refuses instead of composing a key that could collide with a real one.
 */
export function sessionKey(runId: string, sessionId: string): string {
  if (!runId.trim()) throw new Error("a session key needs the run it belongs to");
  if (!sessionId.trim()) throw new Error("a session key needs the session that owns the entries");
  return `board-session:${runId}:${sessionId}`;
}

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

/** What the board and the plan say at one boundary: the plan's order, where the session is now, and
 *  what is still on offer. Only the two enders below are read from the run's own log. */
export interface SessionBoundary {
  readonly runId: string;
  readonly plan: SessionMoveInput["plan"];
  /** The unit that just ran in this session. */
  readonly current: string;
  /** How many units this session has already carried. */
  readonly size: number;
  /** The declared bound on units per session. */
  readonly bound: number;
  /** The units the board still has on offer, in plan order. */
  readonly onOffer: readonly string[];
  readonly taskId?: string;
  readonly attempt?: number;
  readonly entryId?: string | null;
}

/** One boundary's decision, with where the record of it landed. */
export interface SessionDecision {
  readonly move: SessionMove;
  readonly sequence: number;
  readonly recorded: boolean;
}

/**
 * Decide the next move at a boundary and record it, in that order, once.
 *
 * This function decides nothing of its own: the move is `nextSessionMove`'s, and its one added
 * input is the fact that can end a session early - a cancelled run admits nothing further, whatever
 * the plan says. That fact is re-read here from the run's own log rather than taken from the caller,
 * the way the managed-write fence reads its two refusals, because a caller remembers what was true
 * when it decided to write.
 */
export function decideSessionMove(store: NmgStore, boundary: SessionBoundary): SessionDecision {
  const cancelled = store
    .taskRunFacts(boundary.runId)
    .find((fact) => fact.kind === RUN_CANCELLED_FACT);
  const move: SessionMove = cancelled
    ? { kind: "close", reason: `the run was cancelled at sequence ${cancelled.sequence}` }
    : nextSessionMove({
        plan: boundary.plan,
        current: boundary.current,
        size: boundary.size,
        bound: boundary.bound,
        onOffer: boundary.onOffer,
      });
  const appended = recordSessionMove(store, {
    runId: boundary.runId,
    move,
    taskId: boundary.taskId,
    attempt: boundary.attempt,
    entryId: boundary.entryId,
  });
  return { move, sequence: appended.sequence, recorded: appended.recorded };
}
