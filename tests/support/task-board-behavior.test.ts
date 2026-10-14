import assert from "node:assert/strict";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import type { TaskBoardEntry } from "../../src/core/types.ts";
import { claimAndDeliver } from "./task-board-behavior.ts";

const WHEN_LIVE = "1999-12-31T23:59:00.000Z";
const LATER = "1999-12-31T23:59:30.000Z";

function withStore(run: (store: NmgStore) => void): void {
  const store = new NmgStore(":memory:");
  try {
    run(store);
  } finally {
    store.close();
  }
}

function workItem(store: NmgStore): TaskBoardEntry {
  return store.putTaskBoardEntry({
    taskId: "clocked-work",
    agentId: "coordinator",
    kind: "result",
    content: "An existing entry on a historical test timeline.",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
}

test("claimAndDeliver uses the supplied entry, actor, lease and historical clock", () => {
  withStore((store) => {
    const entry = workItem(store);
    const delivered = claimAndDeliver(store, entry, {
      agentId: "worker-a",
      digest: "d1",
      now: WHEN_LIVE,
      leaseSeconds: 600,
    });

    assert.equal(delivered.id, entry.id);
    assert.equal(delivered.taskId, "clocked-work");
    assert.equal(delivered.claimedBy, "worker-a");
    assert.equal(delivered.deliveredBy, "worker-a");
    assert.equal(delivered.deliverableDigest, "d1");
    assert.equal(delivered.claimedAt, WHEN_LIVE);
    assert.equal(delivered.deliveredAt, WHEN_LIVE);
    assert.equal(delivered.claimExpiresAt, "2000-01-01T00:09:00.000Z");
    assert.equal(store.readTaskBoard({ taskId: entry.taskId, now: WHEN_LIVE }).entries.length, 1);
  });
});

test("claimAndDeliver can renew and redeliver the same entry after an independent verdict", () => {
  withStore((store) => {
    const entry = workItem(store);
    const first = claimAndDeliver(store, entry, {
      agentId: "worker-a",
      digest: "d1",
      now: WHEN_LIVE,
      leaseSeconds: 600,
    });
    const judged = store.judgeTaskBoardEntry({
      taskId: first.taskId,
      entryId: first.id,
      agentId: "verifier-b",
      verdict: "accepted",
      now: WHEN_LIVE,
    });
    assert.equal(judged.verdict, "accepted");
    assert.equal(judged.judgedDigest, "d1");

    const second = claimAndDeliver(store, first, {
      agentId: "worker-a",
      digest: "d2",
      now: LATER,
      leaseSeconds: 600,
    });
    assert.equal(second.id, first.id);
    assert.equal(second.attempt, 1);
    assert.equal(second.deliverableDigest, "d2");
    assert.equal(second.claimedAt, LATER);
    assert.equal(second.deliveredAt, LATER);
    assert.equal(second.verdict, null);
    assert.equal(second.judgedBy, null);
    assert.equal(second.judgedDigest, null);
    assert.equal(first.deliverableDigest, "d1", "the earlier observation remains a snapshot");
  });
});

test("claimAndDeliver propagates a conflicting claim and allows the holder to continue", () => {
  withStore((store) => {
    const entry = workItem(store);
    const claimed = store.claimTaskBoardEntry({
      taskId: entry.taskId,
      entryId: entry.id,
      agentId: "worker-a",
      now: WHEN_LIVE,
      leaseSeconds: 600,
    });

    assert.throws(
      () =>
        claimAndDeliver(store, entry, {
          agentId: "worker-b",
          digest: "wrong-owner",
          now: LATER,
          leaseSeconds: 600,
        }),
      /already claimed by worker-a/u,
    );
    assert.deepEqual(store.getTaskBoardEntryById(entry.taskId, entry.id), claimed);

    const delivered = claimAndDeliver(store, entry, {
      agentId: "worker-a",
      digest: "d1",
      now: LATER,
      leaseSeconds: 600,
    });
    assert.equal(delivered.deliveredBy, "worker-a");
    assert.equal(delivered.deliverableDigest, "d1");
    assert.equal(delivered.attempt, 1);
  });
});

test("claimAndDeliver propagates delivery failure without undoing its successful claim", () => {
  withStore((store) => {
    const entry = workItem(store);
    const failure = new Error("injected delivery failure");
    store.deliverTaskBoardEntry = () => {
      throw failure;
    };

    assert.throws(
      () =>
        claimAndDeliver(store, entry, {
          agentId: "worker-a",
          digest: "d1",
          now: WHEN_LIVE,
          leaseSeconds: 600,
        }),
      (error) => error === failure,
    );
    const claimed = store.getTaskBoardEntryById(entry.taskId, entry.id);
    assert.ok(claimed);
    assert.equal(claimed.claimedBy, "worker-a");
    assert.equal(claimed.claimedAt, WHEN_LIVE);
    assert.equal(claimed.attempt, 1);
    assert.equal(claimed.deliverableDigest, null);
  });
});
