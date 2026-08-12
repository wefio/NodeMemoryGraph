import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-retention-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("L4 removes LTG memory from retrieval while stable-ID access and restore remain available", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "The retired project codename was silver heron",
      nodeName: "project codename",
      memoryType: "event",
      importance: 0.1,
    });
    store.upsertExternalEmbeddings("retention-test", [
      { memoryId: saved.memory.id, vector: [0, 1] },
    ]);
    assert.equal(store.search("silver heron")[0]?.memory.id, saved.memory.id);

    assert.equal(store.setMemoryStorageState(saved.memory.id, "dormant"), "dormant");
    assert.equal(store.search("silver heron").length, 0);
    assert.equal(
      store.searchByVector("codename", [0, 1], "retention-test", {
        retrievalMode: "qwen3",
      }).length,
      0,
    );
    assert.equal(
      store.getContext([saved.memory.id]).results[0]?.memory.statement,
      saved.memory.statement,
    );
    assert.equal(
      store
        .embeddingDocuments("", 100, "retention-test")
        .some((document) => document.memoryId === saved.memory.id),
      false,
    );

    assert.equal(store.setMemoryStorageState(saved.memory.id, "indexed"), "indexed");
    assert.equal(store.search("silver heron")[0]?.memory.id, saved.memory.id);
    assert.equal(
      store
        .embeddingDocuments("", 100, "retention-test")
        .some((document) => document.memoryId === saved.memory.id),
      true,
    );
  });
});

test("L4 and L5 candidate reporting is conservative and never mutates storage", () => {
  withStore((store) => {
    const oldEvent = store.remember({
      statement: "A disposable historical experiment was attempted",
      nodeName: "historical experiment",
      memoryType: "event",
      importance: 0.1,
    });
    const protectedConstraint = store.remember({
      statement: "Never erase the production database",
      nodeName: "production safety",
      memoryType: "constraint",
      importance: 0.1,
    });
    const future = new Date(Date.now() + 800 * 86_400_000);
    const first = store.retentionCandidates({
      dormantAfterDays: 365,
      quarantineAfterDays: 365,
      now: future,
    });
    assert.deepEqual(
      first.map((candidate) => candidate.memoryId),
      [oldEvent.memory.id],
    );
    assert.equal(first[0]?.recommendedState, "dormant");
    assert.equal(
      store
        .search("historical experiment")
        .some((result) => result.memory.id === oldEvent.memory.id),
      true,
    );
    assert.equal(
      first.some((candidate) => candidate.memoryId === protectedConstraint.memory.id),
      false,
    );

    store.setMemoryStorageState(oldEvent.memory.id, "dormant");
    const second = store.retentionCandidates({
      quarantineAfterDays: 365,
      now: future,
    });
    assert.equal(second[0]?.memoryId, oldEvent.memory.id);
    assert.equal(second[0]?.recommendedState, "quarantine");
  });
});

test("session-private STG memories do not enter the shared LTG retention lifecycle", () => {
  withStore((store) => {
    const provisional = store.remember({
      statement: "Temporary hypothesis for this session",
      nodeName: "session hypothesis",
      memoryType: "derived",
      residence: "stg",
        sessionId: "test-session",
    });
    assert.throws(
      () => store.setMemoryStorageState(provisional.memory.id, "dormant"),
      /only to shared LTG/,
    );
  });
});

test("open memories remain indexed until explicitly resolved", () => {
  withStore((store) => {
    const anchor = store.remember({
      statement: "Atlas deployment is blocked on the storage decision",
      nodeName: "Atlas deployment",
      memoryType: "event",
      importance: 0.1,
    });
    const open = store.remember({
      statement: "Decide whether Atlas should use SQLite or PostgreSQL",
      nodeName: "Atlas database decision",
      memoryType: "event",
      importance: 0.1,
      resolution: "open",
      openedAt: "2025-01-01T00:00:00.000Z",
      relatedMemoryIds: [anchor.memory.id],
    });

    assert.equal(open.memory.resolution, "open");
    assert.equal(open.memory.openedAt, "2025-01-01T00:00:00.000Z");
    assert.deepEqual(open.memory.relatedMemoryIds, [anchor.memory.id]);
    assert.throws(
      () => store.setMemoryStorageState(open.memory.id, "dormant"),
      /open memories must be resolved before archival or quarantine/,
    );
    const future = new Date(Date.now() + 800 * 86_400_000);
    assert.equal(
      store
        .retentionCandidates({ dormantAfterDays: 365, now: future })
        .some((candidate) => candidate.memoryId === open.memory.id),
      false,
    );

    const resolved = store.setMemoryResolution(open.memory.id, "resolved", {
      reason: "The database choice was made.",
    });
    assert.equal(resolved.resolution, "resolved");
    assert.equal(
      store
        .retentionCandidates({ dormantAfterDays: 365, now: future })
        .some((candidate) => candidate.memoryId === open.memory.id),
      true,
    );

    store.setMemoryStorageState(open.memory.id, "dormant");
    const reopened = store.setMemoryResolution(open.memory.id, "reopened", {
      relatedMemoryIds: [anchor.memory.id],
      reason: "New evidence invalidated the choice.",
    });
    assert.equal(reopened.resolution, "reopened");
    assert.equal(store.search("SQLite PostgreSQL")[0]?.memory.id, open.memory.id);
  });
});

test("open STG memories do not expire before resolution", () => {
  withStore((store) => {
    const anchor = store.remember({
      statement: "The current session is testing Atlas storage",
      nodeName: "Atlas storage session",
      residence: "stg",
        sessionId: "test-session",
    });
    const open = store.remember({
      statement: "Check the Atlas storage benchmark result",
      nodeName: "Atlas storage benchmark",
      residence: "stg",
        sessionId: "test-session",
      resolution: "open",
      relatedMemoryIds: [anchor.memory.id],
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    assert.deepEqual(store.expireShortTermMemories("2000-01-02T00:00:00.000Z"), []);
    store.setMemoryResolution(open.memory.id, "resolved");
    assert.deepEqual(store.expireShortTermMemories("2000-01-02T00:00:00.000Z"), [open.memory.id]);
  });
});
