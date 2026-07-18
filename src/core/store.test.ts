import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "./store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-test-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("remember persists a memory with traceable evidence", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "NMG uses Pi as its agent harness",
      nodeName: "NMG architecture",
      nodeKind: "project",
      evidence: "The user chose Pi as the NMG agent host.",
      tier: 0,
      importance: 0.9,
    });

    const results = store.search("Pi agent", { maxTier: 0 });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.memory.id, saved.memory.id);
    assert.equal(results[0]?.evidence.id, saved.history.id);
    assert.equal(results[0]?.node.id, saved.node.id);
  });
});

test("memory survives closing and reopening the local database", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-test-"));
  const database = join(directory, "nmg.sqlite");

  const writer = new NmgStore(database);
  const saved = writer.remember({
    statement: "SQLite is the local source of truth",
    nodeName: "NMG storage",
    tier: 0,
  });
  writer.close();

  const reader = new NmgStore(database);
  try {
    const [reloaded] = reader.search("local source", { maxTier: 0 });
    assert.equal(reloaded?.memory.id, saved.memory.id);
    assert.equal(reloaded?.evidence.id, saved.history.id);
  } finally {
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("search respects local tier and result budgets", () => {
  withStore((store) => {
    store.remember({
      statement: "Docker is only an optional execution backend",
      nodeName: "sandbox boundary",
      tier: 2,
    });

    assert.deepEqual(store.search("Docker", { maxTier: 1 }), []);
    assert.equal(store.search("Docker", { maxTier: 2, limit: 1 }).length, 1);
  });
});

test("the same semantic node is reused without merging evidence", () => {
  withStore((store) => {
    const first = store.remember({
      statement: "Cloud sync is optional",
      nodeName: "deployment",
    });
    const second = store.remember({
      statement: "Local SQLite is authoritative",
      nodeName: "deployment",
    });

    assert.equal(first.node.id, second.node.id);
    assert.notEqual(first.history.id, second.history.id);
    assert.notEqual(first.memory.id, second.memory.id);
  });
});
