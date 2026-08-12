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
