/**
 * What a session decision leaves behind. The decision itself is `nextSessionMove`'s own pure
 * function; these tests are about the record: a move written to the run's log reads back as the
 * same move, writing it twice records it once, and a log with no move reads as empty - while a
 * payload this module did not write is skipped rather than trusted.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import { type DispatchTask, type SessionPlan } from "../../src/integration/ooo-execution.ts";
import {
  SESSION_MOVE_FACT,
  decideSessionMove,
  openUnitSession,
  parseSessionMove,
  recordedSessionMoves,
  recordSessionMove,
  sessionKey,
} from "../../src/integration/ooo-session-facts.ts";
import { RUN_CANCELLED_FACT } from "../../src/integration/task-coordinator.ts";

/** Windows can still hold a handle to a just-closed store for a few milliseconds. */
const REMOVE_TEMP_TREE = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-session-facts-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, REMOVE_TEMP_TREE);
  }
}

function register(store: NmgStore, runId: string): void {
  store.registerTaskRun({
    runId,
    planDigest: "plan-a",
    policy: "checks-a",
    revision: "v1",
    retention: "keep:evidence",
  });
}

test("a recorded move reads back as the move that was made", () => {
  withStore((store) => {
    register(store, "run-1");
    const appended = recordSessionMove(store, {
      runId: "run-1",
      taskId: "alpha",
      move: { kind: "admit", unit: "beta" },
    });
    assert.equal(appended.recorded, true);
    assert.deepEqual(recordedSessionMoves(store, "run-1"), [
      { sequence: appended.sequence, move: { kind: "admit", unit: "beta" } },
    ]);
  });
});

test("a close carries the condition that closed the session, through the log and back", () => {
  withStore((store) => {
    register(store, "run-2");
    recordSessionMove(store, {
      runId: "run-2",
      taskId: "beta",
      move: { kind: "close", reason: "the declared bound is reached" },
    });
    assert.deepEqual(recordedSessionMoves(store, "run-2"), [
      { sequence: 1, move: { kind: "close", reason: "the declared bound is reached" } },
    ]);
  });
});

test("the same move twice is one fact, and the second write says it was already known", () => {
  withStore((store) => {
    register(store, "run-3");
    const move = { kind: "admit", unit: "beta" } as const;
    const first = recordSessionMove(store, { runId: "run-3", taskId: "alpha", move });
    const second = recordSessionMove(store, { runId: "run-3", taskId: "alpha", move });
    assert.equal(first.recorded, true);
    assert.equal(second.recorded, false);
    assert.equal(second.sequence, first.sequence);
    assert.equal(recordedSessionMoves(store, "run-3").length, 1);
  });
});

test("a log with no move reads as empty, and a foreign payload is skipped rather than trusted", () => {
  withStore((store) => {
    register(store, "run-4");
    assert.deepEqual(recordedSessionMoves(store, "run-4"), []);
    // A payload under this module's kind that this module did not write: an admit without a unit.
    store.appendTaskRunFact({
      runId: "run-4",
      kind: SESSION_MOVE_FACT,
      taskId: "gamma",
      payload: JSON.stringify({ kind: "admit" }),
    });
    assert.deepEqual(recordedSessionMoves(store, "run-4"), []);
    assert.equal(parseSessionMove("not json at all"), null);
    assert.equal(parseSessionMove(undefined), null);
  });
});

/** Units `one`, `two`, `three` in one chain: each is the next one's only legal predecessor. */
function linearPlan(): SessionPlan {
  const names = ["one", "two", "three"];
  const tasks: DispatchTask[] = names.map((name, index) => ({
    id: name,
    effect: "isolated-artifact",
    sourceVersion: "v1",
    observedVersion: "v1",
    dependencies: index === 0 ? [] : [names[index - 1]!],
    accepted: true,
    claimed: false,
    externalReady: true,
  }));
  return {
    tasks,
    declarations: Object.fromEntries(
      names.map((name) => [
        name,
        { capability: "patch", authority: "host", visible: ["src/a.ts"] },
      ]),
    ),
  };
}

test("the boundary decides and records the same move, and the log agrees with the answer", () => {
  withStore((store) => {
    register(store, "run-5");
    const decision = decideSessionMove(store, {
      runId: "run-5",
      plan: linearPlan(),
      current: "one",
      size: 1,
      bound: 2,
      onOffer: ["three", "two"],
      taskId: "one",
    });
    assert.deepEqual(decision.move, { kind: "admit", unit: "two" });
    assert.equal(decision.recorded, true);
    assert.deepEqual(recordedSessionMoves(store, "run-5"), [
      { sequence: decision.sequence, move: { kind: "admit", unit: "two" } },
    ]);
  });
});

test("a session that cannot continue closes by name rather than guessing", () => {
  withStore((store) => {
    register(store, "run-6");
    const atBound = decideSessionMove(store, {
      runId: "run-6",
      plan: linearPlan(),
      current: "one",
      size: 2,
      bound: 2,
      onOffer: ["two"],
      taskId: "one",
    });
    assert.deepEqual(atBound.move, { kind: "close", reason: "the declared bound is reached" });
    const noSuccessor = decideSessionMove(store, {
      runId: "run-6",
      plan: linearPlan(),
      current: "three",
      size: 1,
      bound: 4,
      onOffer: [],
      taskId: "three",
    });
    assert.deepEqual(noSuccessor.move, { kind: "close", reason: "no legal successor is on offer" });
    assert.equal(recordedSessionMoves(store, "run-6").length, 2);
  });
});

test("a cancelled run admits nothing further, whatever the plan says", () => {
  withStore((store) => {
    register(store, "run-7");
    store.appendTaskRunFact({
      runId: "run-7",
      kind: RUN_CANCELLED_FACT,
      payload: JSON.stringify({ reason: "the operator stopped it" }),
    });
    const decision = decideSessionMove(store, {
      runId: "run-7",
      plan: linearPlan(),
      current: "one",
      size: 1,
      bound: 4,
      onOffer: ["two"],
    });
    assert.deepEqual(decision.move, {
      kind: "close",
      reason: "the run was cancelled at sequence 1",
    });
  });
});

/**
 * The cancellation is scoped to a task, so one cancelled task must not end the sessions of the others.
 * This module and the managed-write fence read the same predicate for exactly that reason: they were two
 * copies of `kind === RUN_CANCELLED_FACT`, and both closed everything a run had.
 */
test("a cancellation closes the cancelled unit's session, and only that one", () => {
  withStore((store) => {
    register(store, "run-10");
    const boundary = {
      runId: "run-10",
      plan: linearPlan(),
      current: "one",
      size: 1,
      bound: 4,
      onOffer: ["two"],
      taskId: "one",
      attempt: 1,
    };
    // Another task of the same run is cancelled first: this unit's session carries on.
    store.appendTaskRunFact({ runId: "run-10", kind: RUN_CANCELLED_FACT, taskId: "other" });
    assert.deepEqual(decideSessionMove(store, boundary).move, { kind: "admit", unit: "two" });

    store.appendTaskRunFact({ runId: "run-10", kind: RUN_CANCELLED_FACT, taskId: "one" });
    assert.deepEqual(decideSessionMove(store, { ...boundary, attempt: 2 }).move, {
      kind: "close",
      reason: "task one was cancelled at sequence 3",
    });
  });
});

/**
 * A move belongs to a boundary, and a boundary is a unit and an attempt - which is also the fact
 * identity the store keys on. So one boundary is one move however often the caller asks, and the
 * second answer is the first one rather than a second fact. A caller that decides again after the
 * facts changed must say that it is a new attempt, or its second decision is not recorded and the
 * log stops describing what the code did.
 */
test("one boundary is one move, and a new attempt is a new fact", () => {
  withStore((store) => {
    register(store, "run-8");
    const boundary = {
      runId: "run-8",
      plan: linearPlan(),
      current: "one",
      size: 1,
      bound: 4,
      onOffer: ["two"],
      taskId: "one",
      attempt: 1,
    };
    const first = decideSessionMove(store, boundary);
    const again = decideSessionMove(store, boundary);
    assert.equal(first.recorded, true);
    assert.equal(again.recorded, false);
    assert.equal(again.sequence, first.sequence);
    const secondAttempt = decideSessionMove(store, { ...boundary, attempt: 2 });
    assert.equal(secondAttempt.recorded, true);
    assert.deepEqual(
      recordedSessionMoves(store, "run-8").map((entry) => entry.move),
      [
        { kind: "admit", unit: "two" },
        { kind: "admit", unit: "two" },
      ],
    );
  });
});

/**
 * The key is what makes reuse a shared mechanism rather than a harness habit: it is computed from
 * what the board holds, so two callers that see the same run and session agree without talking to
 * each other, and a missing part refuses rather than composing a key that could collide with a
 * real one.
 */
test("the session key is a function of the run and the session, and refuses a missing part", () => {
  assert.equal(sessionKey("run-1", "session-a"), sessionKey("run-1", "session-a"));
  assert.notEqual(sessionKey("run-1", "session-a"), sessionKey("run-2", "session-a"));
  assert.notEqual(sessionKey("run-1", "session-a"), sessionKey("run-1", "session-b"));
  assert.throws(() => sessionKey("", "session-a"), /needs the run/);
  assert.throws(() => sessionKey("run-1", "  "), /needs the session/);
});

/**
 * One call for the caller: the key its runner is held under, plus the move that boundary implies,
 * recorded. The caller knows the run, its own session, and where the session stands; everything
 * else is the board's, so two harnesses holding the same facts hold the same key.
 */
test("opening a unit's session yields its key and records the move that put it there", () => {
  withStore((store) => {
    register(store, "run-9");
    const boundary = {
      runId: "run-9",
      plan: linearPlan(),
      current: "one",
      size: 1,
      bound: 2,
      onOffer: ["two"],
      taskId: "one",
      attempt: 1,
    };
    const opened = openUnitSession(store, { ...boundary, sessionId: "session-a" });
    assert.equal(opened.key, sessionKey("run-9", "session-a"));
    assert.deepEqual(opened.move, { kind: "admit", unit: "two" });
    assert.equal(opened.recorded, true);
    // A second caller in the same session asks again: same key, and the first answer stands.
    const again = openUnitSession(store, { ...boundary, sessionId: "session-a" });
    assert.equal(again.key, opened.key);
    assert.equal(again.recorded, false);
    assert.equal(again.sequence, opened.sequence);
    // A different session is a different runner - and the move is a fact about the boundary, not
    // about the session that asked: a move is keyed on (run, unit, attempt), so a second session
    // asking about the same boundary is the same fact and gets the first answer. A unit belongs to
    // one session; a caller that would decide one boundary again must say it is a new attempt.
    const other = openUnitSession(store, { ...boundary, sessionId: "session-b" });
    assert.notEqual(other.key, opened.key);
    assert.equal(other.recorded, false);
    assert.equal(other.sequence, opened.sequence);
    assert.equal(recordedSessionMoves(store, "run-9").length, 1);
    const nextAttempt = openUnitSession(store, {
      ...boundary,
      attempt: 2,
      sessionId: "session-b",
    });
    assert.equal(nextAttempt.recorded, true);
    assert.equal(recordedSessionMoves(store, "run-9").length, 2);
  });
});
