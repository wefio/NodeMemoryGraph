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
import {
  SESSION_MOVE_FACT,
  parseSessionMove,
  recordedSessionMoves,
  recordSessionMove,
} from "../../src/integration/ooo-session-facts.ts";

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
