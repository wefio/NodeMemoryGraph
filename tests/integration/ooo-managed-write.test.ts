/**
 * The managed-entry write path: a board entry a run has adopted cannot be moved beside its run.
 *
 * Three properties, all of them checked by what the store ends up holding rather than by what a
 * call returns:
 *
 *   - a direct board verb on a managed entry is refused, and an entry no run manages takes the
 *     same path it always did;
 *   - a coordinated write lands the board transition and the run's own fact in one transaction,
 *     and a failure inside it leaves neither;
 *   - a cancelled run accepts no further lifecycle writes, and the entry it adopted does not move.
 *
 * The ordinary board is deliberately not re-tested here: `tests/core/task-board-*.test.ts` and
 * `tests/cli/service.test.ts` drive the same verbs on unmanaged entries and are the regression
 * evidence that the guard did not reach them.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import { NmgService } from "../../src/cli/service.ts";
import {
  RUN_CANCELLED_FACT,
  coordinatedBoardWrite,
  managedTransitionKind,
  managedWriteRefusal,
} from "../../src/integration/task-coordinator.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

// The daemon case below runs an in-process NmgService, which inherits process.env; keep recall
// lexical (tests/helpers/test-env.ts), as every daemon-spawning test must.
stripProviderEnv();

/** Windows can hold a handle to a just-closed store for a few milliseconds. */
const REMOVE_TEMP_TREE = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
const NEVER = new Date(Date.now() + 86_400_000).toISOString();
const CHANNEL = "board";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-managed-write-"));
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

/** Register a run, freeze one task, and adopt an entry as that task's own. */
function adopt(store: NmgStore, runId: string, taskId: string, entryId: string): void {
  store.registerTaskRun({
    runId,
    planDigest: "plan-a",
    policy: "checks-a",
    revision: "v1",
    retention: "keep:evidence",
  });
  store.freezeTaskRunTask({
    runId,
    taskId,
    position: 0,
    revision: "v1",
    input: `${taskId} input`,
    dependencies: [],
    effect: "isolated-artifact",
  });
  store.appendTaskRunFact({ runId, kind: "entry-bound", taskId, entryId });
}

function claim(
  store: NmgStore,
  entryId: string,
  agentId = "worker-one",
  taskId = CHANNEL,
): unknown {
  return store.claimTaskBoardEntry({ taskId, entryId, agentId, leaseSeconds: 600 });
}

function runFacts(store: NmgStore, runId: string): Array<{ kind: string; sequence: number }> {
  return store.taskRunFacts(runId).map((fact) => ({
    kind: fact.kind,
    sequence: fact.sequence,
  }));
}

test("a direct board verb cannot move an entry a run has adopted", () => {
  withStore((store) => {
    const managed = publish(store, "managed");
    // A second handoff in the same channel waits for the first (reply-gated serial handoff), so the
    // ordinary entry the guard must not touch lives in a channel of its own.
    const ordinary = publish(store, "ordinary", "other");
    adopt(store, "run-1", "T1", managed);

    assert.throws(
      () => claim(store, managed),
      /go through the run's coordinated transition/,
      "a managed entry's lifecycle write belongs to the run, not to a direct verb",
    );
    const unchanged = store.getTaskBoardEntryById(CHANNEL, managed)!;
    assert.equal(unchanged.claimedBy, null);
    assert.equal(unchanged.status, "open");

    // The same verb on an entry no run manages is the path it always was: no transaction, no
    // lookup result, nothing to coordinate.
    assert.equal(
      (claim(store, ordinary, "worker-one", "other") as { claimedBy: string | null }).claimedBy,
      "worker-one",
    );
    assert.equal(store.getTaskBoardEntryById("other", ordinary)!.claimedBy, "worker-one");
  });
});

test("a coordinated write lands the board transition and the run's fact together", () => {
  withStore((store) => {
    const entryId = publish(store, "managed");
    adopt(store, "run-1", "T1", entryId);

    const outcome = coordinatedBoardWrite(store, {
      runId: "run-1",
      entryId,
      verb: "claim",
      actorId: "worker-one",
      apply: () => claim(store, entryId),
    });
    assert.equal((outcome.entry as { claimedBy: string }).claimedBy, "worker-one");
    assert.equal(store.getTaskBoardEntryById(CHANNEL, entryId)!.claimedBy, "worker-one");

    const fact = store
      .taskRunFacts("run-1")
      .find((f) => f.kind === managedTransitionKind("claim"))!;
    assert.equal(fact.entryId, entryId, "the transition is recorded against the entry it moved");
    assert.equal(fact.taskId, "T1");
    assert.equal(fact.sequence, outcome.fact.sequence);
    assert.deepEqual(
      JSON.parse(fact.payload!),
      { actorId: "worker-one", status: "open" },
      "the log keeps which agent moved it and to what state, since the board only keeps the state",
    );

    // A retry of the same transition on the same attempt is the same fact, not a second one.
    const retry = coordinatedBoardWrite(store, {
      runId: "run-1",
      entryId,
      verb: "claim",
      actorId: "worker-one",
      apply: () => claim(store, entryId),
    });
    assert.deepEqual(retry.fact, { sequence: fact.sequence, recorded: false });
    assert.deepEqual(runFacts(store, "run-1"), [
      { kind: "entry-bound", sequence: 1 },
      { kind: "board-claim", sequence: 2 },
    ]);
  });
});

test("a failure inside the coordinated write leaves neither the transition nor the fact", () => {
  withStore((store) => {
    const entryId = publish(store, "managed");
    adopt(store, "run-1", "T1", entryId);

    assert.throws(
      () =>
        coordinatedBoardWrite(store, {
          runId: "run-1",
          entryId,
          verb: "claim",
          actorId: "worker-one",
          apply: () => {
            claim(store, entryId);
            // The board transition already happened on this connection; the transition as a whole
            // still fails, and the store decides that nothing commits.
            throw new Error("the check result arrived after the commit window closed");
          },
        }),
      /after the commit window closed/,
    );
    assert.equal(
      store.getTaskBoardEntryById(CHANNEL, entryId)!.claimedBy,
      null,
      "the claim does not survive a transition that failed after it",
    );
    assert.deepEqual(runFacts(store, "run-1"), [{ kind: "entry-bound", sequence: 1 }]);
  });
});

test("a cancelled run takes no further lifecycle writes on what it adopted", () => {
  withStore((store) => {
    const entryId = publish(store, "managed");
    adopt(store, "run-1", "T1", entryId);
    store.appendTaskRunFact({ runId: "run-1", kind: RUN_CANCELLED_FACT, taskId: "T1" });

    const refusal = managedWriteRefusal(store, "run-1");
    assert.match(refusal!, /was cancelled at sequence 2/);

    assert.throws(
      () =>
        coordinatedBoardWrite(store, {
          runId: "run-1",
          entryId,
          verb: "claim",
          actorId: "worker-one",
          apply: () => claim(store, entryId),
        }),
      /was cancelled at sequence 2; its managed entries take no further lifecycle writes/,
    );
    assert.equal(store.getTaskBoardEntryById(CHANNEL, entryId)!.claimedBy, null);
    assert.deepEqual(runFacts(store, "run-1"), [
      { kind: "entry-bound", sequence: 1 },
      { kind: RUN_CANCELLED_FACT, sequence: 2 },
    ]);
  });
});

test("a coordinated write refuses an entry that is not this run's", () => {
  withStore((store) => {
    const entryId = publish(store, "managed");
    const loose = publish(store, "unadopted");
    adopt(store, "run-1", "T1", entryId);
    store.registerTaskRun({
      runId: "run-2",
      planDigest: "plan-a",
      policy: "checks-a",
      revision: "v1",
      retention: "keep:evidence",
    });

    assert.throws(
      () =>
        coordinatedBoardWrite(store, {
          runId: "run-2",
          entryId,
          verb: "claim",
          actorId: "worker-one",
          apply: () => claim(store, entryId),
        }),
      /belongs to run run-1, not run-2/,
    );
    assert.throws(
      () =>
        coordinatedBoardWrite(store, {
          runId: "run-1",
          entryId: loose,
          verb: "claim",
          actorId: "worker-one",
          apply: () => claim(store, loose),
        }),
      /is not adopted by a run/,
    );
    // A scope for a run this store cannot name is refused before anything is written.
    assert.throws(
      () => store.coordinateRunWrite("run-absent", () => claim(store, entryId)),
      /is not registered; a managed write needs the run it belongs to/,
    );
    assert.equal(store.getTaskBoardEntryById(CHANNEL, entryId)!.claimedBy, null);
    assert.equal(store.getTaskBoardEntryById(CHANNEL, loose)!.claimedBy, null);
  });
});

test("a daemon board verb routes a managed entry through the run's transition", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-managed-daemon-"));
  const databasePath = join(directory, "nmg.sqlite");
  const service = new NmgService({ databasePath, environment: {} });
  try {
    const written = await service.invoke("taskBoard", {
      action: "put",
      taskId: CHANNEL,
      agentId: "host",
      kind: "handoff",
      content: "managed",
      ttlSeconds: 3600,
    });
    if (written.action !== "put") throw new Error("expected a put result");
    const entryId = written.entry.id;

    // Adopt the entry from another connection to the same file: the shape the coordinator has when
    // it is not the daemon's own process.
    const adopter = new NmgStore(databasePath);
    try {
      adopt(adopter, "run-1", "T1", entryId);
    } finally {
      adopter.close();
    }

    const claimed = await service.invoke("taskBoard", {
      action: "claim",
      taskId: CHANNEL,
      entryId,
      agentId: "worker-one",
      leaseSeconds: 600,
    });
    if (claimed.action !== "claim") throw new Error("expected a claim result");
    assert.equal(claimed.entry.claimedBy, "worker-one");

    // The daemon's own store wrote the transition into the run's log, in the transaction that moved
    // the board: the fact is there with nobody else having written it.
    const reader = new NmgStore(databasePath);
    try {
      const fact = reader
        .taskRunFacts("run-1")
        .find((f) => f.kind === managedTransitionKind("claim"));
      assert.equal(fact?.entryId, entryId);
      assert.equal(JSON.parse(fact!.payload!).actorId, "worker-one");
    } finally {
      reader.close();
    }

    // A managed entry's write is the coordinator's to make, and the daemon's protocol has no verb
    // for it: the same file through the store directly is refused, which is what stops a client
    // from moving the entry beside its run.
    const bystander = new NmgStore(databasePath);
    try {
      assert.throws(
        () => claim(bystander, entryId, "worker-two"),
        /go through the run's coordinated transition/,
      );
    } finally {
      bystander.close();
    }
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});
