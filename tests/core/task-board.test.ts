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
