import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-task-board-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("task board shares attributed entries within one task and isolates other tasks", () => {
  withStore((store) => {
    const first = store.putTaskBoardEntry({
      taskId: "release-42",
      agentId: "scout-a",
      sourceSessionId: "session-a",
      kind: "result",
      content: "The parser tests pass.",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const second = store.putTaskBoardEntry({
      taskId: "release-42",
      agentId: "scout-b",
      kind: "handoff",
      content: "Review the serializer next.",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    store.putTaskBoardEntry({
      taskId: "unrelated",
      agentId: "scout-c",
      kind: "note",
      content: "Must remain isolated.",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const page = store.readTaskBoard({ taskId: "release-42" });
    assert.deepEqual(page.entries.map((entry) => entry.id), [first.id, second.id]);
    assert.deepEqual(page.entries.map((entry) => entry.agentId), ["scout-a", "scout-b"]);
    assert.equal(page.entries[0]!.sourceSessionId, "session-a");
    assert.equal(page.nextCursor, 2);
    assert.equal(store.readTaskBoard({ taskId: "unrelated" }).entries.length, 1);
  });
});

test("task board supports cursor reads, cross-agent resolution, and expiry", () => {
  withStore((store) => {
    const first = store.putTaskBoardEntry({
      taskId: "task-a",
      agentId: "agent-a",
      kind: "question",
      content: "Which schema should we use?",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const second = store.putTaskBoardEntry({
      taskId: "task-a",
      agentId: "agent-b",
      kind: "decision",
      content: "Use the versioned schema.",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    store.putTaskBoardEntry({
      taskId: "task-a",
      agentId: "agent-c",
      kind: "note",
      content: "Expired scratch state.",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    const page = store.readTaskBoard({ taskId: "task-a", afterCursor: first.sequence });
    assert.deepEqual(page.entries.map((entry) => entry.id), [second.id]);

    const resolved = store.resolveTaskBoardEntry({
      taskId: "task-a",
      entryId: first.id,
      agentId: "agent-b",
      resolution: "Answered by entry #2.",
    });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolvedBy, "agent-b");
    assert.equal(store.readTaskBoard({ taskId: "task-a" }).entries.length, 1);
    assert.equal(
      store.readTaskBoard({ taskId: "task-a", includeResolved: true }).entries.length,
      2,
    );
  });
});

test("task board content never enters semantic memory search", () => {
  withStore((store) => {
    store.putTaskBoardEntry({
      taskId: "task-a",
      agentId: "agent-a",
      kind: "note",
      content: "uniqueboardtoken should remain coordination-only",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.deepEqual(store.search("uniqueboardtoken"), []);
  });
});

test("task board lobby lists active named channels and hides the world channel", () => {
  withStore((store) => {
    const future = "2099-01-01T00:00:00.000Z";
    store.putTaskBoardEntry({
      taskId: "alpha",
      agentId: "agent-a",
      kind: "goal",
      content: "Alpha channel goal.",
      expiresAt: future,
    });
    store.putTaskBoardEntry({
      taskId: "beta",
      agentId: "agent-b",
      kind: "note",
      content: "Beta channel note.",
      expiresAt: future,
    });
    // The world channel itself must not appear in the lobby directory.
    store.putTaskBoardEntry({
      taskId: "default",
      agentId: "agent-c",
      kind: "note",
      content: "A lobby message.",
      expiresAt: future,
    });
    // Expired channels are pruned before listing.
    store.putTaskBoardEntry({
      taskId: "gone",
      agentId: "agent-d",
      kind: "note",
      content: "Expired.",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    // Fully resolved channels are not advertised as active.
    const done = store.putTaskBoardEntry({
      taskId: "done",
      agentId: "agent-e",
      kind: "result",
      content: "Finished.",
      expiresAt: future,
    });
    store.resolveTaskBoardEntry({ taskId: "done", entryId: done.id, agentId: "agent-e" });

    const boards = store.listTaskBoards();
    assert.deepEqual(
      boards.map((board) => board.taskId).sort(),
      ["alpha", "beta"],
    );
    const alpha = boards.find((board) => board.taskId === "alpha");
    assert.equal(alpha?.entryCount, 1);
    assert.ok(alpha?.lastUpdatedAt);
  });
});

test("task board claims are lease-based: CAS, conflict, heartbeat, lazy expiry", () => {
  withStore((store) => {
    const task = store.putTaskBoardEntry({
      taskId: "claim-1",
      agentId: "sender",
      kind: "question",
      content: "Who owns the SkillOpt gate?",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    // Open + unclaimed → claim succeeds with a lease.
    const claimed = store.claimTaskBoardEntry({
      taskId: "claim-1",
      entryId: task.id,
      agentId: "worker-a",
      leaseSeconds: 600,
      now: "2026-08-12T00:00:00.000Z",
    });
    assert.equal(claimed.claimedBy, "worker-a");
    assert.equal(claimed.claimExpiresAt, "2026-08-12T00:10:00.000Z");
    assert.equal(claimed.status, "open");

    // Another agent → CAS loses with a conflict diagnosis.
    assert.throws(
      () =>
        store.claimTaskBoardEntry({
          taskId: "claim-1",
          entryId: task.id,
          agentId: "worker-b",
          now: "2026-08-12T00:01:00.000Z",
        }),
      /already claimed by worker-a/,
    );

    // The holder re-claims → heartbeat refreshes the lease.
    const heartbeated = store.claimTaskBoardEntry({
      taskId: "claim-1",
      entryId: task.id,
      agentId: "worker-a",
      leaseSeconds: 600,
      now: "2026-08-12T00:05:00.000Z",
    });
    assert.equal(heartbeated.claimExpiresAt, "2026-08-12T00:15:00.000Z");

    // After the lease lapses, another agent can claim (lazy expiry, no sweeper).
    const stolen = store.claimTaskBoardEntry({
      taskId: "claim-1",
      entryId: task.id,
      agentId: "worker-b",
      leaseSeconds: 600,
      now: "2026-08-12T00:16:00.000Z",
    });
    assert.equal(stolen.claimedBy, "worker-b");
  });
});

test("task board claims: only the holder releases; resolving clears the claim", () => {
  withStore((store) => {
    const task = store.putTaskBoardEntry({
      taskId: "claim-2",
      agentId: "sender",
      kind: "handoff",
      content: "Verify the wake loop.",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    store.claimTaskBoardEntry({
      taskId: "claim-2",
      entryId: task.id,
      agentId: "worker-a",
      leaseSeconds: 600,
      now: "2026-08-12T00:00:00.000Z",
    });

    // Non-holder release is refused.
    assert.throws(
      () =>
        store.releaseTaskBoardEntry({
          taskId: "claim-2",
          entryId: task.id,
          agentId: "worker-b",
        }),
      /not claimed by worker-b/,
    );

    // Holder releases → back to unclaimed, claimable by anyone.
    const released = store.releaseTaskBoardEntry({
      taskId: "claim-2",
      entryId: task.id,
      agentId: "worker-a",
    });
    assert.equal(released.claimedBy, null);
    assert.equal(released.claimExpiresAt, null);

    const reclaimed = store.claimTaskBoardEntry({
      taskId: "claim-2",
      entryId: task.id,
      agentId: "worker-c",
      leaseSeconds: 600,
      now: "2026-08-12T00:01:00.000Z",
    });
    assert.equal(reclaimed.claimedBy, "worker-c");

    // Resolving clears the claim, and a claim on a resolved entry is refused.
    const resolved = store.resolveTaskBoardEntry({
      taskId: "claim-2",
      entryId: task.id,
      agentId: "worker-c",
      resolution: "done",
    });
    assert.equal(resolved.claimedBy, null);
    assert.throws(
      () =>
        store.claimTaskBoardEntry({
          taskId: "claim-2",
          entryId: task.id,
          agentId: "worker-d",
          now: "2026-08-12T00:02:00.000Z",
        }),
      /already resolved/,
    );
  });
});
