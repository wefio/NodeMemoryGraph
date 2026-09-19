/**
 * The binding of a logical task to the board entry that carries it.
 *
 * The board cannot keep this fact (an entry that a later attempt replaces must not lose the record
 * of what it used to carry), so it lives in the run's appended facts - and it is the fact that makes
 * an entry managed. These cases check what the store ends up holding:
 *
 *   - binding is what turns a board entry into a managed one, and its writes then go through the
 *     run's coordinated transition rather than beside it;
 *   - the same task and attempt bound twice is a retry, not a second binding, and a different entry
 *     for that task and attempt is refused rather than silently dropped;
 *   - every refusal names a fact the store holds: an unregistered or cancelled run, a task the run
 *     never froze, an entry that is not on the channel the caller names, an entry that already
 *     carries something else;
 *   - the binding joins the transition that creates the entry, so there is never an entry on the
 *     board that no run manages.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import {
  ENTRY_BOUND_FACT,
  RUN_CANCELLED_FACT,
  bindRunEntry,
  coordinatedEntryWrite,
} from "../../src/integration/task-coordinator.ts";

/** Windows can hold a handle to a just-closed store for a few milliseconds. */
const REMOVE_TEMP_TREE = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
const NEVER = new Date(Date.now() + 86_400_000).toISOString();
const CHANNEL = "board";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-managed-adopt-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, REMOVE_TEMP_TREE);
  }
}

function publish(store: NmgStore, content: string, taskId = CHANNEL): string {
  return store.putTaskBoardEntry({
    taskId,
    agentId: "host",
    kind: "handoff",
    content,
    expiresAt: NEVER,
  }).id;
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

function freeze(store: NmgStore, runId: string, taskId: string, position = 0): void {
  store.freezeTaskRunTask({
    runId,
    taskId,
    position,
    revision: "v1",
    input: `${taskId} input`,
    dependencies: [],
    effect: "isolated-artifact",
  });
}

function bindings(store: NmgStore, runId: string) {
  return store
    .taskRunFacts(runId)
    .filter((fact) => fact.kind === ENTRY_BOUND_FACT)
    .map((fact) => ({ sequence: fact.sequence, taskId: fact.taskId, entryId: fact.entryId }));
}

test("binding is what makes an entry managed, and its writes then go through the run", () => {
  withStore((store) => {
    register(store, "run-1");
    freeze(store, "run-1", "T1");
    const entryId = publish(store, "managed");

    // Before the binding the entry is nobody's: the board verb lands directly.
    store.claimTaskBoardEntry({
      taskId: CHANNEL,
      entryId,
      agentId: "worker-one",
      leaseSeconds: 60,
    });
    store.releaseTaskBoardEntry({ taskId: CHANNEL, entryId, agentId: "worker-one" });

    const bound = bindRunEntry(store, {
      runId: "run-1",
      taskId: "T1",
      boardTaskId: CHANNEL,
      entryId,
    });
    assert.equal(bound.recorded, true);
    assert.deepEqual(bindings(store, "run-1"), [{ sequence: 1, taskId: "T1", entryId }]);
    assert.deepEqual(
      store.taskRunForEntry(entryId),
      { runId: "run-1", kind: ENTRY_BOUND_FACT, taskId: "T1", attempt: 1 },
      "the binding is readable from the entry alone, which is what the fence reads",
    );

    assert.throws(
      () =>
        store.claimTaskBoardEntry({
          taskId: CHANNEL,
          entryId,
          agentId: "worker-one",
          leaseSeconds: 60,
        }),
      /go through the run's coordinated transition/,
      "after the binding, the entry's lifecycle writes belong to the run",
    );
    assert.equal(store.getTaskBoardEntryById(CHANNEL, entryId)!.claimedBy, null);
  });
});

test("a binding is idempotent for its task and attempt, and refuses a second entry", () => {
  withStore((store) => {
    register(store, "run-1");
    freeze(store, "run-1", "T1");
    const entryId = publish(store, "managed");
    const other = publish(store, "another", "other-channel");

    const first = bindRunEntry(store, {
      runId: "run-1",
      taskId: "T1",
      boardTaskId: CHANNEL,
      entryId,
    });
    const retry = bindRunEntry(store, {
      runId: "run-1",
      taskId: "T1",
      boardTaskId: CHANNEL,
      entryId,
    });
    assert.deepEqual(retry, { sequence: first.sequence, recorded: false });
    assert.equal(bindings(store, "run-1").length, 1, "a retry is the same binding");

    // Another entry for the same task and attempt is a disagreement, not a retry: the stored fact
    // is keyed by task and attempt, so accepting it would silently keep the first entry and report
    // the second as bound.
    assert.throws(
      () =>
        bindRunEntry(store, {
          runId: "run-1",
          taskId: "T1",
          boardTaskId: "other-channel",
          entryId: other,
        }),
      /already carries entry .*another entry is another attempt, not a rebinding/,
    );

    // A second attempt is its own binding, and the first attempt's entry keeps its own.
    const attemptTwo = publish(store, "managed-again");
    const second = bindRunEntry(store, {
      runId: "run-1",
      taskId: "T1",
      boardTaskId: CHANNEL,
      entryId: attemptTwo,
      attempt: 2,
    });
    assert.equal(second.recorded, true);
    assert.deepEqual(bindings(store, "run-1"), [
      { sequence: 1, taskId: "T1", entryId },
      { sequence: 2, taskId: "T1", entryId: attemptTwo },
    ]);
    assert.equal(store.taskRunForEntry(entryId)!.attempt, 1);
    assert.equal(store.taskRunForEntry(attemptTwo)!.attempt, 2);
  });
});

test("a binding refuses what the store does not hold", () => {
  withStore((store) => {
    const entryId = publish(store, "managed");

    // An unregistered run: there is no run state for the binding to belong to.
    assert.throws(
      () =>
        bindRunEntry(store, { runId: "run-absent", taskId: "T1", boardTaskId: CHANNEL, entryId }),
      /is not registered; a managed write needs the run it belongs to/,
    );

    register(store, "run-1");
    // A task the run never froze: a run cannot adopt an entry for work it never committed to.
    assert.throws(
      () => bindRunEntry(store, { runId: "run-1", taskId: "T9", boardTaskId: CHANNEL, entryId }),
      /never froze task T9; there is no task to bind an entry to/,
    );

    freeze(store, "run-1", "T1");
    // An entry that is not on the channel the caller names: the binding names what the board holds.
    assert.throws(
      () =>
        bindRunEntry(store, {
          runId: "run-1",
          taskId: "T1",
          boardTaskId: "other-channel",
          entryId,
        }),
      /no board entry .* on other-channel/,
    );

    // An entry another run already carries: one entry carries one task.
    bindRunEntry(store, { runId: "run-1", taskId: "T1", boardTaskId: CHANNEL, entryId });
    register(store, "run-2");
    freeze(store, "run-2", "T2");
    assert.throws(
      () => bindRunEntry(store, { runId: "run-2", taskId: "T2", boardTaskId: CHANNEL, entryId }),
      /already carries task T1 of run run-1; one entry carries one task/,
    );

    // A cancelled run binds nothing further (this run's only fact so far is the cancellation).
    store.appendTaskRunFact({ runId: "run-2", kind: RUN_CANCELLED_FACT, taskId: "T2" });
    assert.throws(
      () => bindRunEntry(store, { runId: "run-2", taskId: "T2", boardTaskId: CHANNEL, entryId }),
      /was cancelled at sequence 1/,
    );

    assert.deepEqual(bindings(store, "run-1"), [{ sequence: 1, taskId: "T1", entryId }]);
    assert.deepEqual(bindings(store, "run-2"), []);
  });
});

test("the binding joins the transition that creates the entry", () => {
  withStore((store) => {
    register(store, "run-1");
    freeze(store, "run-1", "T1");

    // One transition: the entry exists and is a managed one, or neither happened. There is no
    // moment where the board holds an entry the run does not.
    const entryId = store.coordinateRunWrite("run-1", (port) => {
      const entry = store.putTaskBoardEntry(
        {
          taskId: CHANNEL,
          agentId: "host",
          kind: "handoff",
          content: "managed",
          expiresAt: NEVER,
        },
        port,
      );
      bindRunEntry(
        store,
        { runId: "run-1", taskId: "T1", boardTaskId: CHANNEL, entryId: entry.id },
        port,
      );
      return entry.id;
    });
    assert.deepEqual(bindings(store, "run-1"), [{ sequence: 1, taskId: "T1", entryId }]);

    // And when the transition fails, neither lands: not the binding, and not the entry.
    assert.throws(
      () =>
        store.coordinateRunWrite("run-1", (port) => {
          const entry = store.putTaskBoardEntry(
            {
              taskId: CHANNEL,
              agentId: "host",
              kind: "handoff",
              content: "rolled back",
              expiresAt: NEVER,
            },
            port,
          );
          bindRunEntry(
            store,
            { runId: "run-1", taskId: "T1", boardTaskId: CHANNEL, entryId: entry.id, attempt: 3 },
            port,
          );
          throw new Error("the harness died before the round could record its own start");
        }),
      /before the round could record its own start/,
    );
    assert.deepEqual(bindings(store, "run-1"), [{ sequence: 1, taskId: "T1", entryId }]);
    assert.equal(
      store.readTaskBoard({ taskId: CHANNEL, limit: 50 }).entries.length,
      1,
      "the rolled-back entry is not on the board either",
    );
  });
});

test("the routing rule sends a managed entry to its run and leaves an unmanaged one alone", () => {
  withStore((store) => {
    register(store, "run-1");
    freeze(store, "run-1", "T1");
    const managed = publish(store, "managed");
    const loose = publish(store, "loose", "other-channel");
    bindRunEntry(store, { runId: "run-1", taskId: "T1", boardTaskId: CHANNEL, entryId: managed });

    const claimedLoose = coordinatedEntryWrite(store, {
      verb: "claim",
      entryId: loose,
      actorId: "worker-one",
      apply: () =>
        store.claimTaskBoardEntry({
          taskId: "other-channel",
          entryId: loose,
          agentId: "worker-one",
          leaseSeconds: 60,
        }),
    });
    assert.equal(claimedLoose.claimedBy, "worker-one");
    assert.deepEqual(
      store.taskRunFacts("run-1").map((fact) => fact.kind),
      [ENTRY_BOUND_FACT],
      "an unmanaged entry takes the path it always took and writes no run fact",
    );

    const claimed = coordinatedEntryWrite(store, {
      verb: "claim",
      entryId: managed,
      actorId: "worker-two",
      apply: () =>
        store.claimTaskBoardEntry({
          taskId: CHANNEL,
          entryId: managed,
          agentId: "worker-two",
          leaseSeconds: 60,
        }),
    });
    assert.equal(claimed.claimedBy, "worker-two");
    const transition = store.taskRunFacts("run-1").at(-1)!;
    assert.equal(transition.kind, "board-claim");
    assert.equal(transition.entryId, managed);
    assert.equal(JSON.parse(transition.payload!).actorId, "worker-two");

    // The routing rule reads the binding rather than trusting the caller: a caller that calls the
    // board verb itself instead of going through it is refused by the store.
    assert.throws(
      () =>
        store.claimTaskBoardEntry({
          taskId: CHANNEL,
          entryId: managed,
          agentId: "worker-three",
          leaseSeconds: 60,
        }),
      /go through the run's coordinated transition/,
    );
  });
});
