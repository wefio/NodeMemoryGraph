/**
 * The store's board is the third implementation of the loop's port, and the first that reads the
 * product's own record instead of a probe's.
 *
 * What is asserted here is the projection - what the run's frozen table and its board entries add up
 * to once the shared rules read them - and the two ends the store owns: a claim is the store's
 * compare-and-set, and a delivery is judged under a name other than the deliverer's. No legality rule
 * is asserted because none lives in the board; the plan order and the dependency gate come from
 * `task-semantics.ts`, which the probe board reads too.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import { dispatchPlan, type PlanWorker } from "../../src/integration/ooo-dispatch.ts";
import type { SessionPlan } from "../../src/integration/ooo-execution.ts";
import { StoreRunBoard, type AcceptanceAnswer } from "../../src/integration/ooo-runner.ts";
import {
  preparePatchWork,
  type FrozenPatchWork,
  type PatchSubmission,
} from "../../src/integration/ooo-patch.ts";
import {
  coordinatedBoardWrite,
  createBoundEntry,
  freezeRunPlan,
  registerRun,
} from "../../src/integration/task-coordinator.ts";

const RUN = "run-1";
const CHANNEL = "run-1-board";
const FILE = "src/work.ts";
const baseline: Readonly<Record<string, string>> = { [FILE]: "export const value = 1;\n" };

/** Two units of one plan, the second depending on the first, both patch work. */
function tasks() {
  return [
    {
      taskId: "P",
      revision: "r1",
      input: "add the first line",
      dependencies: [],
      effect: "isolated-artifact",
      kind: "patch",
      patchFiles: [FILE],
      patchEditable: [FILE],
    },
    {
      taskId: "T",
      revision: "r1",
      input: "add the second line",
      dependencies: ["P"],
      effect: "isolated-artifact",
      kind: "patch",
      patchFiles: [FILE],
      patchEditable: [FILE],
    },
  ];
}

/** A run registered, frozen and adopted: what the runner owns before any unit runs. */
function openRun(store: NmgStore, taskIds: readonly string[] = ["P", "T"]): void {
  registerRun(store, {
    runId: RUN,
    planDigest: "d1",
    policy: "repair-first",
    revision: "r1",
    retention: "run",
  });
  freezeRunPlan(store, {
    runId: RUN,
    tasks: tasks().filter((task) => taskIds.includes(task.taskId)),
  });
  for (const taskId of taskIds) {
    createBoundEntry(store, {
      entry: {
        taskId: CHANNEL,
        agentId: "runner",
        kind: "handoff",
        content: `work on ${taskId}`,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      runId: RUN,
      taskId,
      attempt: 0,
    });
  }
}

/** The caller's bytes for a task's declared files: the store froze paths, not contents. */
function workspace(_taskId: string, files: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(files.map((path) => [path, baseline[path] ?? ""]));
}

/** The artifact a task's worker produces: the wire shape the host validates, with the task's marker. */
function artifactFor(taskId: string, frozen: FrozenPatchWork): string {
  return JSON.stringify({
    digest: frozen.digest,
    files: [{ path: FILE, content: `${baseline[FILE]}// ${taskId}\n` }],
  });
}

const worker: PlanWorker = async (taskId, frozen) => artifactFor(taskId, frozen);

/** The acceptance reads the submission and answers; its name is not the deliverer's. */
const acceptance = {
  agentId: "judge",
  verify: ({
    taskId,
    submission,
  }: {
    taskId: string;
    submission: PatchSubmission;
  }): AcceptanceAnswer => {
    if (submission.kind !== "patch") return "undecidable";
    return (submission.files[FILE] ?? "").includes(`// ${taskId}`) ? "accept" : "reject";
  },
};

/** The session view the loop asks when a chain continues. This run declares no sessions. */
function legality(): SessionPlan {
  return { tasks: [], declarations: {} };
}

async function withStore(run: (store: NmgStore) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "nmg-run-board-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    await run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("one plan runs through the product's own board, judged by someone other than the deliverer", async () => {
  await withStore(async (store) => {
    openRun(store);
    const board = new StoreRunBoard(store, {
      runId: RUN,
      channel: CHANNEL,
      slots: 1,
      workspace,
      acceptance,
    });

    // Before anything runs, exactly the plan's first unit is legal: the dependency gate is the
    // shared rule's, read through this board's projection.
    assert.deepEqual(board.candidates(), ["P"], "a dependent unit is not offered early");

    const outcome = await dispatchPlan({
      board,
      plan: ["P", "T"],
      slots: 1,
      legality,
      worker,
      ownerOf: (taskId) => `worker:${taskId}`,
    });

    assert.deepEqual(outcome.failures, [], "no unit failed");
    assert.deepEqual(outcome.order, ["P", "T"], "the plan order held");
    assert.deepEqual(
      outcome.units.map((unit) => unit.verdict),
      ["accepted", "accepted"],
      "the acceptance accepted both units",
    );

    // The run's own record says the same: both units are accepted, and the judge is not the worker.
    const accepted = board.accepted();
    assert.deepEqual(Object.keys(accepted).sort(), ["P", "T"]);
    assert.match(accepted.P!, /\/\/ P/u);
    for (const taskId of ["P", "T"]) {
      const entry = store.getTaskBoardEntryById(CHANNEL, bindingEntry(store, taskId));
      assert.ok(entry, `task ${taskId} has an entry`);
      assert.equal(entry.verdict, "accepted");
      assert.equal(entry.judgedBy, acceptance.agentId);
      assert.equal(entry.deliveredBy, `worker:${taskId}`);
      assert.ok(entry.deliverableDigest, "the deliverable the judge bound to is recorded");
    }
  });
});

test("the deliverer cannot judge its own delivery, so a run cannot self-accept", async () => {
  await withStore(async (store) => {
    openRun(store, ["P"]);
    const board = new StoreRunBoard(store, {
      runId: RUN,
      channel: CHANNEL,
      slots: 1,
      workspace,
      acceptance,
    });
    const entryId = bindingEntry(store, "P");
    const ticket = board.claim("P", "worker:P");
    // The artifact the loop would have delivered, frozen the way the loop freezes it. Reading a digest
    // off the ticket wrote an artifact with no digest at all, and the store took it: a delivery is a
    // digest and a reference, and the wire shape is the host's check rather than the board's.
    const frozen = preparePatchWork({ ...ticket.patch!, attempt: ticket.attempt });
    const artifact = artifactFor("P", frozen);
    coordinatedBoardWrite(store, {
      runId: RUN,
      entryId,
      verb: "deliver",
      actorId: "worker:P",
      apply: () =>
        store.deliverTaskBoardEntry({
          taskId: CHANNEL,
          entryId,
          agentId: "worker:P",
          digest: "d",
          ref: artifact,
        }),
    });
    // The lifecycle write of a managed entry goes through the run's coordinated transition, so the
    // refusal below is the board's own check reached the way a caller reaches it.
    assert.throws(
      () =>
        coordinatedBoardWrite(store, {
          runId: RUN,
          entryId,
          verb: "judge",
          actorId: "worker:P",
          apply: () =>
            store.judgeTaskBoardEntry({
              taskId: CHANNEL,
              entryId,
              agentId: "worker:P",
              verdict: "accepted",
            }),
        }),
      /deliverer cannot judge its own deliverable/u,
      "the board refuses a self-judged delivery, which is why the acceptance has its own name",
    );
  });
});

test("the board answers what is legal and why, and asking changes nothing", async () => {
  await withStore(async (store) => {
    openRun(store);
    const board = new StoreRunBoard(store, {
      runId: RUN,
      channel: CHANNEL,
      slots: 1,
      workspace,
      acceptance,
    });
    const entryId = bindingEntry(store, "P");
    // What the answer reads, so the read can be shown to leave it as it found it.
    const recorded = () => ({
      facts: store.taskRunFacts(RUN).length,
      entry: store.getTaskBoardEntryById(CHANNEL, entryId),
    });

    const before = recorded();
    const first = board.legality();
    assert.deepEqual(
      board.legality(),
      first,
      "asking twice on an unchanged store returns the same answer",
    );
    assert.deepEqual(recorded(), before, "the read wrote no run fact and moved no entry");

    // Per unit, in plan order, with the reason on the unit that is not on offer: the dependency gate
    // is the shared rule's, read through this board's projection.
    assert.deepEqual(first.legal, ["P"], "the dependent unit is not offered early");
    assert.equal(first.room, 1, "the declared budget is reported, and asking does not spend it");
    assert.deepEqual(first.units, [
      { id: "P", legal: true, reasons: [] },
      { id: "T", legal: false, reasons: ["dependency-not-accepted"] },
    ]);

    // The answer names nobody. The store's own refusal names the holder; this read does not, because
    // who claimed, who delivered and who judged are board facts rather than answer fields.
    const printed = JSON.stringify(first);
    for (const name of ["worker", acceptance.agentId, "runner", "repair-first"])
      assert.ok(!printed.includes(name), `the answer does not name ${name}`);

    // The structural rule in the answer's own terms: a claim takes the unit out of the set and says
    // which gate did it, while the claim itself stays the store's.
    board.claim("P", "worker:P");
    const claimed = board.legality();
    assert.deepEqual(claimed.legal, [], "the single declared slot is spent");
    assert.equal(claimed.room, 0, "the claim spent the declared budget");
    assert.deepEqual(
      claimed.units.map((unit) => [unit.id, unit.reasons]),
      [
        ["P", ["claimed"]],
        ["T", ["dependency-not-accepted"]],
      ],
    );
    assert.equal(store.getTaskBoardEntryById(CHANNEL, entryId)?.claimedBy, "worker:P");
    assert.throws(() => board.claim("P", "worker:other"), /already claimed by worker:P/u);

    // Bytes are delivered and nobody has decided the verdict yet, so the unit is still its
    // claimant's: this board's facts carry acceptance rather than delivery (the probe's carry the
    // other), which is why the gate named here is the claim. In-doubt work across runs is the
    // umbrella's own open gap, not something this read may paper over.
    const ticket = board.claim("P", "worker:P");
    const frozen = preparePatchWork({ ...ticket.patch!, attempt: ticket.attempt });
    coordinatedBoardWrite(store, {
      runId: RUN,
      entryId,
      verb: "deliver",
      actorId: "worker:P",
      apply: () =>
        store.deliverTaskBoardEntry({
          taskId: CHANNEL,
          entryId,
          agentId: "worker:P",
          digest: "d",
          ref: artifactFor("P", frozen),
        }),
    });
    const delivered = board.legality();
    assert.deepEqual(delivered.legal, [], "a delivered unit nobody judged is still not on offer");
    assert.deepEqual(delivered.units.find((unit) => unit.id === "P")!.reasons, ["claimed"]);
    assert.deepEqual(delivered.units.find((unit) => unit.id === "T")!.reasons, [
      "dependency-not-accepted",
    ]);
  });
});

/** The entry a task's binding holds, read from the run's own record. */
function bindingEntry(store: NmgStore, taskId: string): string {
  const fact = store
    .taskRunFacts(RUN)
    .filter((candidate) => candidate.taskId === taskId && candidate.entryId !== null)
    .at(-1);
  assert.ok(fact?.entryId, `task ${taskId} has a bound entry`);
  return fact.entryId;
}
