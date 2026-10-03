import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import { StoreRunBoard, type RunBoardOptions } from "../../src/integration/ooo-runner.ts";
import { workDigest } from "../../src/integration/work-identity.ts";
import {
  PATCH_INPUTS_FROZEN_FACT,
  restorePatchInputs,
} from "../../src/integration/ooo-declaration-store.ts";
import {
  coordinatedBoardWrite,
  createBoundEntry,
  freezeRunPlan,
  registerRun,
} from "../../src/integration/task-coordinator.ts";

const RUN = "restore-declaration";
const CHANNEL = "restore-board";
const FILE = "src/value.ts";
const definition = {
  taskId: "T",
  revision: "r1",
  input: "set value to two",
  dependencies: [],
  effect: "isolated-artifact",
  kind: "patch",
  patchFiles: [FILE],
  patchEditable: [FILE],
};

function open(store: NmgStore): string {
  registerRun(store, {
    runId: RUN,
    planDigest: "plan",
    policy: "declared",
    revision: "r1",
    retention: "run",
  });
  freezeRunPlan(store, { runId: RUN, tasks: [definition] });
  return createBoundEntry(store, {
    entry: {
      taskId: CHANNEL,
      agentId: "host",
      kind: "handoff",
      content: "task T",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    runId: RUN,
    taskId: "T",
    attempt: 0,
  }).entry.id;
}

function options(workspace: RunBoardOptions["workspace"]): RunBoardOptions {
  return {
    runId: RUN,
    channel: CHANNEL,
    slots: 1,
    workspace,
    acceptance: { agentId: "judge", verify: () => "accept" },
  };
}

test("a restarted adopter judges against the original frozen bytes, not the current workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-declaration-restore-"));
  const path = join(directory, "nmg.sqlite");
  let store = new NmgStore(path);
  try {
    const entryId = open(store);
    const board = new StoreRunBoard(
      store,
      options(() => ({ [FILE]: "export const value = 1;" })),
    );
    const frozen = board.claim("T", "worker").declaration!;
    const artifact = JSON.stringify({
      digest: frozen.digest,
      files: [{ path: FILE, content: "export const value = 2;" }],
    });
    coordinatedBoardWrite(store, {
      runId: RUN,
      entryId,
      verb: "deliver",
      actorId: "worker",
      apply: () =>
        store.deliverTaskBoardEntry({
          taskId: CHANNEL,
          entryId,
          agentId: "worker",
          digest: workDigest(artifact),
          ref: artifact,
        }),
    });
    store.close();
    store = new NmgStore(path);
    const restored = new StoreRunBoard(
      store,
      options(() => {
        throw new Error("the current workspace must not rebuild an old attempt");
      }),
    );
    const factsBeforeRead = store.taskRunFacts(RUN);
    assert.deepEqual(
      restored.legality().legal,
      [],
      "a restarted projection reads the frozen inputs without new workspace bytes",
    );
    assert.deepEqual(
      store.taskRunFacts(RUN),
      factsBeforeRead,
      "restoration and legality append nothing",
    );
    assert.equal(await restored.submit(entryId), "accepted");
    assert.equal(store.getTaskBoardEntryById(CHANNEL, entryId)?.judgedBy, "judge");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid input freezing rolls back the claim and its facts", () => {
  const store = new NmgStore(":memory:");
  try {
    const entryId = open(store);
    const before = {
      entry: store.getTaskBoardEntryById(CHANNEL, entryId),
      facts: store.taskRunFacts(RUN),
    };
    const board = new StoreRunBoard(
      store,
      options(() => ({ "src/other.ts": "not the declared input" })),
    );
    assert.throws(() => board.claim("T", "worker"), /editable|visible/u);
    assert.deepEqual(
      { entry: store.getTaskBoardEntryById(CHANNEL, entryId), facts: store.taskRunFacts(RUN) },
      before,
    );
  } finally {
    store.close();
  }
});

test("a frozen task definition compares permissions and effect, not only its instruction", () => {
  const store = new NmgStore(":memory:");
  try {
    open(store);
    for (const changed of [
      { ...definition, patchEditable: [] },
      { ...definition, patchFiles: [] },
      { ...definition, effect: "local-write" },
      { ...definition, revision: "r2" },
      { ...definition, kind: "snapshot" },
      { ...definition, waitEvent: "event" },
    ]) {
      assert.throws(
        () => freezeRunPlan(store, { runId: RUN, tasks: [changed] }),
        /different definition/u,
      );
    }
  } finally {
    store.close();
  }
});

test("a renewed claim restores its original inputs and a fresh attempt freezes new ones", () => {
  const store = new NmgStore(":memory:");
  try {
    const entryId = open(store);
    let bytes = "original";
    const board = new StoreRunBoard(
      store,
      options(() => ({ [FILE]: bytes })),
    );
    const first = board.claim("T", "worker");
    bytes = "changed";
    const renewed = board.claim("T", "worker");
    assert.equal(renewed.attempt, first.attempt);
    assert.equal(renewed.declaration?.digest, first.declaration?.digest);
    assert.equal(renewed.declaration?.work.files[FILE], "original");
    coordinatedBoardWrite(store, {
      runId: RUN,
      entryId,
      verb: "release",
      actorId: "worker",
      apply: () => store.releaseTaskBoardEntry({ taskId: CHANNEL, entryId, agentId: "worker" }),
    });
    const next = board.claim("T", "next-worker");
    assert.equal(next.attempt, first.attempt + 1);
    assert.equal(next.declaration?.work.files[FILE], "changed");
    assert.notEqual(next.declaration?.digest, first.declaration?.digest);
    assert.equal(
      store.taskRunFacts(RUN).filter((fact) => fact.kind === PATCH_INPUTS_FROZEN_FACT).length,
      2,
    );
  } finally {
    store.close();
  }
});

test("a legacy attempt without input evidence refuses reads and judgment rather than rebuilding it", async () => {
  const store = new NmgStore(":memory:");
  try {
    const entryId = open(store);
    coordinatedBoardWrite(store, {
      runId: RUN,
      entryId,
      verb: "claim",
      actorId: "worker",
      apply: () => store.claimTaskBoardEntry({ taskId: CHANNEL, entryId, agentId: "worker" }),
    });
    coordinatedBoardWrite(store, {
      runId: RUN,
      entryId,
      verb: "deliver",
      actorId: "worker",
      apply: () =>
        store.deliverTaskBoardEntry({
          taskId: CHANNEL,
          entryId,
          agentId: "worker",
          digest: "legacy",
          ref: "legacy artifact",
        }),
    });
    const board = new StoreRunBoard(
      store,
      options(() => {
        throw new Error("legacy attempt must not read current workspace bytes");
      }),
    );
    const before = {
      facts: store.taskRunFacts(RUN),
      entry: store.getTaskBoardEntryById(CHANNEL, entryId),
    };
    assert.throws(() => board.legality(), /has no frozen patch inputs/u);
    await assert.rejects(board.submit(entryId), /has no frozen patch inputs/u);
    assert.deepEqual(
      { facts: store.taskRunFacts(RUN), entry: store.getTaskBoardEntryById(CHANNEL, entryId) },
      before,
    );
  } finally {
    store.close();
  }
});

test("unsupported or corrupted attempt input records fail closed without replacing their task definition", () => {
  const store = new NmgStore(":memory:");
  try {
    open(store);
    const frozen = new StoreRunBoard(
      store,
      options(() => ({ [FILE]: "original" })),
    ).claim("T", "worker").declaration!;
    const facts = store.taskRunFacts(RUN);
    const receipt = facts.find((fact) => fact.kind === PATCH_INPUTS_FROZEN_FACT)!;
    const payload = JSON.parse(receipt.payload!) as Record<string, unknown>;
    assert.equal(Object.hasOwn(payload, "instruction"), false);
    assert.equal(Object.hasOwn(payload, "editable"), false);
    const task = store.taskRunTasks(RUN)[0]!;
    for (const [changed, reason] of [
      [{ ...payload, version: 99 }, /unsupported.*version/u],
      [{ ...payload, files: { [FILE]: "changed" } }, /digest mismatch/u],
      [{ ...payload, instruction: "another definition" }, /input fields/u],
    ] as const) {
      const reader = {
        taskRunFacts: () =>
          facts.map((fact) =>
            fact === receipt ? { ...fact, payload: JSON.stringify(changed) } : fact,
          ),
      };
      assert.throws(() => restorePatchInputs(reader, RUN, task, frozen.work.attempt), reason);
    }
    assert.equal(restorePatchInputs({ taskRunFacts: () => [] }, RUN, task, 1), null);
    assert.equal(restorePatchInputs(store, RUN, task, frozen.work.attempt)?.digest, frozen.digest);
  } finally {
    store.close();
  }
});
