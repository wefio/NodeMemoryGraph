import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";

/** Windows can still hold a handle to a just-closed store for a few milliseconds, so a plain
 *  recursive remove intermittently fails with EPERM on an otherwise green run. */
const REMOVE_TEMP_TREE = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
/** Far enough out that nothing here is ever pruned as expired. */
const NEVER = new Date(Date.now() + 86_400_000).toISOString();

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-task-runs-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, REMOVE_TEMP_TREE);
  }
}

function register(
  store: NmgStore,
  runId: string,
  planDigest = "plan-a",
  policy = "checks-a",
): void {
  store.registerTaskRun({ runId, planDigest, policy, revision: "v1", retention: "keep:evidence" });
}

function freeze(
  store: NmgStore,
  runId: string,
  taskId: string,
  input = `${taskId} input`,
  position = 0,
): void {
  store.freezeTaskRunTask({
    runId,
    taskId,
    position,
    revision: "v1",
    input,
    dependencies: [],
    effect: "isolated-artifact",
  });
}

function put(store: NmgStore, taskId: string, content: string): string {
  return store.putTaskBoardEntry({
    taskId,
    agentId: "host",
    kind: "handoff",
    content,
    expiresAt: NEVER,
  }).id;
}

test("a run registers once, and a second plan for the same run is refused", () => {
  withStore((store) => {
    register(store, "run-1");
    // A retry after a lost response re-registers the same identity: a no-op, not a conflict.
    register(store, "run-1");
    assert.equal(store.taskRunManifest("run-1")?.planDigest, "plan-a");

    assert.throws(
      () => register(store, "run-1", "plan-b"),
      /already froze a different plan/,
      "a run cannot be re-opened onto a different plan",
    );
    assert.equal(
      store.taskRunManifest("run-1")?.planDigest,
      "plan-a",
      "the refusal changed nothing",
    );
    assert.equal(store.taskRunManifest("run-2"), null);
  });
});

test("freezing a task twice is a no-op, and a different definition for it is refused", () => {
  withStore((store) => {
    register(store, "run-1");
    freeze(store, "run-1", "T1");
    freeze(store, "run-1", "T1");
    assert.equal(store.taskRunTasks("run-1").length, 1);

    assert.throws(
      () => freeze(store, "run-1", "T1", "a different input"),
      /already froze task T1 with a different definition/,
    );
    assert.throws(
      () => freeze(store, "run-absent", "T1"),
      /is not registered/,
      "a task cannot be frozen into a run that was never registered",
    );
  });
});

test("appending the same fact twice records it once and keeps the first sequence", () => {
  withStore((store) => {
    register(store, "run-1");
    const first = store.appendTaskRunFact({ runId: "run-1", kind: "entry-bound", taskId: "T1" });
    assert.deepEqual(first, { sequence: 1, recorded: true });

    // The retry carries the same identity (run, kind, task, attempt), so it is the same fact.
    const retry = store.appendTaskRunFact({ runId: "run-1", kind: "entry-bound", taskId: "T1" });
    assert.deepEqual(retry, { sequence: 1, recorded: false });
    assert.equal(store.taskRunFacts("run-1").length, 1);

    // The next attempt of the same kind is a different fact, and gets the next sequence.
    const second = store.appendTaskRunFact({
      runId: "run-1",
      kind: "entry-bound",
      taskId: "T1",
      attempt: 1,
    });
    assert.deepEqual(second, { sequence: 2, recorded: true });

    // A run-level fact carries no task id, and does not collide with a task's fact of the same kind.
    const runLevel = store.appendTaskRunFact({ runId: "run-1", kind: "entry-bound" });
    assert.deepEqual(runLevel, { sequence: 3, recorded: true });
  });
});

test("the facts as of one sequence are a prefix of the log, not a filter over it", () => {
  withStore((store) => {
    register(store, "run-1");
    for (const kind of ["a", "b", "c"])
      store.appendTaskRunFact({ runId: "run-1", kind, taskId: "T1" });
    assert.deepEqual(
      store.taskRunFacts("run-1", 2).map((fact) => fact.kind),
      ["a", "b"],
    );
    assert.deepEqual(
      store.taskRunFacts("run-1").map((fact) => fact.sequence),
      [1, 2, 3],
    );
  });
});

test("two runs in one store do not see each other's tasks or facts", () => {
  withStore((store) => {
    register(store, "run-1", "plan-a", "checks-a");
    register(store, "run-2", "plan-a", "checks-a");
    // The same task id in two runs is two frozen tasks, not one collision.
    freeze(store, "run-1", "T1", "input of run 1");
    freeze(store, "run-2", "T1", "input of run 2");
    assert.equal(store.taskRunTasks("run-1")[0]?.input, "input of run 1");
    assert.equal(store.taskRunTasks("run-2")[0]?.input, "input of run 2");

    const entryOne = store.appendTaskRunFact({
      runId: "run-1",
      kind: "entry-bound",
      taskId: "T1",
      entryId: put(store, "board", "for run 1"),
    });
    const entryTwo = store.appendTaskRunFact({
      runId: "run-2",
      kind: "entry-bound",
      taskId: "T1",
      entryId: put(store, "board", "for run 2"),
    });
    assert.deepEqual([entryOne.sequence, entryTwo.sequence], [1, 1], "each run counts its own");
    assert.equal(store.taskRunFacts("run-1").length, 1);
    assert.equal(store.taskRunFacts("run-2").length, 1);
  });
});

test("a board write and a run fact land together, and neither lands alone", () => {
  withStore((store) => {
    register(store, "run-1");
    // One transition: the entry the board records and the binding the run records are written
    // through the same port, so the store's boundary decides for both.
    const entryId = store.writeTransaction((port) => {
      const entry = store.putTaskBoardEntry(
        { taskId: "board", agentId: "host", kind: "handoff", content: "managed", expiresAt: NEVER },
        port,
      );
      store.appendTaskRunFact(
        { runId: "run-1", kind: "entry-bound", taskId: "T1", entryId: entry.id },
        port,
      );
      return entry.id;
    });
    assert.equal(store.taskRunForEntry(entryId)?.runId, "run-1");
    assert.equal(store.taskRunFacts("run-1").length, 1);

    // Now the same shape with the fact failing: the run was never registered. The board row was
    // already written inside this transaction, and it must not survive the failure with it.
    assert.throws(
      () =>
        store.writeTransaction((port) => {
          const entry = store.putTaskBoardEntry(
            {
              taskId: "board",
              agentId: "host",
              kind: "handoff",
              content: "orphan",
              expiresAt: NEVER,
            },
            port,
          );
          store.appendTaskRunFact(
            { runId: "run-absent", kind: "entry-bound", entryId: entry.id },
            port,
          );
        }),
      /is not registered/,
    );
    assert.deepEqual(
      store.readTaskBoard({ taskId: "board" }).entries.map((entry) => entry.content),
      ["managed"],
      "the verdict-side row of a failed transition is not left behind",
    );
    assert.equal(store.taskRunFacts("run-absent").length, 0);

    // The store is still usable: one failed transition does not quarantine a connection that
    // rolled back cleanly.
    assert.deepEqual(store.appendTaskRunFact({ runId: "run-1", kind: "entry-bound", attempt: 1 }), {
      sequence: 2,
      recorded: true,
    });
  });
});

test("an entry bound by two runs is refused rather than answered with one of them", () => {
  withStore((store) => {
    register(store, "run-1");
    register(store, "run-2");
    const entryId = put(store, "board", "shared by mistake");
    store.appendTaskRunFact({ runId: "run-1", kind: "entry-bound", taskId: "T1", entryId });
    assert.equal(store.taskRunForEntry(entryId)?.taskId, "T1");
    store.appendTaskRunFact({ runId: "run-2", kind: "entry-bound", taskId: "T1", entryId });
    assert.throws(() => store.taskRunForEntry(entryId), /is bound by 2 runs/);
  });
});

test("reads create nothing: an unknown run stays unknown", () => {
  withStore((store) => {
    assert.equal(store.taskRunManifest("ghost"), null);
    assert.deepEqual(store.taskRunTasks("ghost"), []);
    assert.deepEqual(store.taskRunFacts("ghost"), []);
    assert.equal(store.taskRunForEntry("no-such-entry"), null);
    // If any read had registered the run as a side effect, this would not refuse.
    assert.throws(
      () => store.appendTaskRunFact({ runId: "ghost", kind: "x" }),
      /is not registered/,
    );
  });
});
