import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import type { TaskBoardEntry } from "../../src/core/types.ts";

/** Board-governance P1 slice: deliverable + independent verdict.
 *
 * The point of these tests is the invariant, not the happy path: acceptance must
 * not be the claimer's self-report, and a verdict must never outlive the
 * artifact it judged. Each test fails by name when the mechanism is removed. */

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-board-deliverable-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const EXPIRES = "2099-01-01T00:00:00.000Z";

function workItem(store: NmgStore, taskId = "round-1"): TaskBoardEntry {
  return store.putTaskBoardEntry({
    taskId,
    agentId: "coordinator",
    kind: "handoff",
    content: "Add the missing regression for the metric.",
    expiresAt: EXPIRES,
  });
}

test("only the live claim holder may deliver an artifact", () => {
  withStore((store) => {
    const entry = workItem(store);
    store.claimTaskBoardEntry({ taskId: "round-1", entryId: entry.id, agentId: "worker-b" });

    assert.throws(
      () =>
        store.deliverTaskBoardEntry({
          taskId: "round-1",
          entryId: entry.id,
          agentId: "bystander",
          digest: "d1",
        }),
      /requires the live claim holder/,
      "an artifact nobody claimed the work for is not a deliverable",
    );

    const delivered = store.deliverTaskBoardEntry({
      taskId: "round-1",
      entryId: entry.id,
      agentId: "worker-b",
      digest: "d1",
      ref: "candidate/d1.patch",
      summary: "adds the failing case",
    });
    assert.equal(delivered.deliveredBy, "worker-b");
    assert.equal(delivered.deliverableDigest, "d1");
    assert.equal(delivered.attempt, 1);
    assert.equal(delivered.status, "open", "delivering does not finalize the entry");
  });
});

test("the deliverer cannot judge its own deliverable", () => {
  withStore((store) => {
    const entry = workItem(store);
    store.claimTaskBoardEntry({ taskId: "round-1", entryId: entry.id, agentId: "worker-b" });
    store.deliverTaskBoardEntry({
      taskId: "round-1",
      entryId: entry.id,
      agentId: "worker-b",
      digest: "d1",
    });

    assert.throws(
      () =>
        store.judgeTaskBoardEntry({
          taskId: "round-1",
          entryId: entry.id,
          agentId: "worker-b",
          verdict: "accepted",
        }),
      /cannot judge its own deliverable/,
      "acceptance is not a self-report",
    );

    const judged = store.judgeTaskBoardEntry({
      taskId: "round-1",
      entryId: entry.id,
      agentId: "verifier-c",
      verdict: "accepted",
      reason: "mutant killed by the new case",
    });
    assert.equal(judged.judgedBy, "verifier-c");
    assert.equal(judged.verdict, "accepted");
    assert.equal(judged.judgedDigest, "d1", "the verdict names what it judged");
  });
});

test("a verdict cannot be inherited by a different artifact", () => {
  withStore((store) => {
    const entry = workItem(store);
    store.claimTaskBoardEntry({ taskId: "round-1", entryId: entry.id, agentId: "worker-b" });
    store.deliverTaskBoardEntry({
      taskId: "round-1",
      entryId: entry.id,
      agentId: "worker-b",
      digest: "d1",
    });
    store.judgeTaskBoardEntry({
      taskId: "round-1",
      entryId: entry.id,
      agentId: "verifier-c",
      verdict: "accepted",
    });

    const redelivered = store.deliverTaskBoardEntry({
      taskId: "round-1",
      entryId: entry.id,
      agentId: "worker-b",
      digest: "d2",
    });
    assert.equal(redelivered.deliverableDigest, "d2");
    assert.equal(redelivered.verdict, null, "revising the artifact voids the verdict about d1");
    assert.equal(redelivered.judgedBy, null);
    assert.equal(redelivered.judgedDigest, null);
  });
});

test("a new attempt fences the previous deliverable and verdict", () => {
  withStore((store) => {
    const entry = workItem(store);
    store.claimTaskBoardEntry({ taskId: "round-1", entryId: entry.id, agentId: "worker-b" });
    store.deliverTaskBoardEntry({
      taskId: "round-1",
      entryId: entry.id,
      agentId: "worker-b",
      digest: "d1",
    });
    store.judgeTaskBoardEntry({
      taskId: "round-1",
      entryId: entry.id,
      agentId: "verifier-c",
      verdict: "rejected",
    });
    store.releaseTaskBoardEntry({ taskId: "round-1", entryId: entry.id, agentId: "worker-b" });

    const reassigned = store.claimTaskBoardEntry({
      taskId: "round-1",
      entryId: entry.id,
      agentId: "worker-d",
    });
    assert.equal(reassigned.attempt, 2, "reassignment starts a new attempt");
    assert.equal(reassigned.deliverableDigest, null, "the old artifact is not this attempt's");
    assert.equal(reassigned.deliveredBy, null);
    assert.equal(reassigned.verdict, null, "nor is the old verdict");
  });
});

test("renewing your own live claim does not start a new attempt", () => {
  withStore((store) => {
    const entry = workItem(store);
    store.claimTaskBoardEntry({ taskId: "round-1", entryId: entry.id, agentId: "worker-b" });
    store.deliverTaskBoardEntry({
      taskId: "round-1",
      entryId: entry.id,
      agentId: "worker-b",
      digest: "d1",
    });

    const renewed = store.claimTaskBoardEntry({
      taskId: "round-1",
      entryId: entry.id,
      agentId: "worker-b",
    });
    assert.equal(renewed.attempt, 1, "a heartbeat is not a new attempt");
    assert.equal(
      renewed.deliverableDigest,
      "d1",
      "a heartbeat must not discard work in progress",
    );
  });
});

test("undecidable is recorded as itself, not as rejected", () => {
  withStore((store) => {
    const entry = workItem(store);
    store.claimTaskBoardEntry({ taskId: "round-1", entryId: entry.id, agentId: "worker-b" });
    store.deliverTaskBoardEntry({
      taskId: "round-1",
      entryId: entry.id,
      agentId: "worker-b",
      digest: "d1",
    });

    const judged = store.judgeTaskBoardEntry({
      taskId: "round-1",
      entryId: entry.id,
      agentId: "verifier-c",
      verdict: "undecidable",
      reason: "no baseline to compare against",
    });
    assert.equal(judged.verdict, "undecidable");
    assert.equal(judged.status, "open", "an undecidable verdict neither accepts nor finalizes");
    assert.notEqual(judged.verdict, "rejected", "could not measure is not measured and failed");

    assert.throws(
      () =>
        store.judgeTaskBoardEntry({
          taskId: "round-1",
          entryId: entry.id,
          agentId: "verifier-c",
          // @ts-expect-error the vocabulary is closed: an unlisted verdict is refused
          verdict: "probably fine",
        }),
      /unknown task board verdict/,
    );
  });
});

test("a deliverable cannot be attached after the entry was finalized", () => {
  withStore((store) => {
    const entry = workItem(store);
    store.claimTaskBoardEntry({ taskId: "round-1", entryId: entry.id, agentId: "worker-b" });
    store.resolveTaskBoardEntry({
      taskId: "round-1",
      entryId: entry.id,
      agentId: "worker-b",
      resolution: "done",
    });

    assert.throws(
      () =>
        store.deliverTaskBoardEntry({
          taskId: "round-1",
          entryId: entry.id,
          agentId: "worker-b",
          digest: "d1",
        }),
      /belongs to an open claim/,
    );
  });
});

test("judging without a deliverable is refused by name", () => {
  withStore((store) => {
    const entry = workItem(store);
    store.claimTaskBoardEntry({ taskId: "round-1", entryId: entry.id, agentId: "worker-b" });
    assert.throws(
      () =>
        store.judgeTaskBoardEntry({
          taskId: "round-1",
          entryId: entry.id,
          agentId: "verifier-c",
          verdict: "accepted",
        }),
      /has no deliverable to judge/,
    );
  });
});
