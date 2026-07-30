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
    });
    assert.throws(
      () => store.setMemoryStorageState(provisional.memory.id, "dormant"),
      /only to shared LTG/,
    );
  });
});
