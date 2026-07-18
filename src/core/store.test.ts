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

test("scope filters memories without discarding other scopes", () => {
  withStore((store) => {
    store.remember({
      statement: "The production database is PostgreSQL",
      nodeName: "database",
      scope: { environment: "production" },
    });
    store.remember({
      statement: "The test database is SQLite",
      nodeName: "database",
      scope: { environment: "test" },
    });

    const results = store.search("database", {
      maxTier: 3,
      scope: { environment: "production" },
    });
    assert.equal(results.length, 1);
    assert.match(results[0]?.memory.statement ?? "", /PostgreSQL/);
  });
});

test("a newer state supersedes but does not delete the old memory", () => {
  withStore((store) => {
    const previous = store.remember({
      statement: "Project Atlas uses Python 3.11",
      nodeName: "Project Atlas runtime",
      evidenceRole: "origin",
    });
    const current = store.remember({
      statement: "Project Atlas uses Python 3.12",
      nodeName: "Project Atlas runtime",
      evidenceRole: "update",
      supersedesId: previous.memory.id,
    });

    const active = store.search("Project Atlas Python", { maxTier: 3 });
    assert.deepEqual(active.map((result) => result.memory.id), [current.memory.id]);

    const historical = store.search("Project Atlas Python", {
      maxTier: 3,
      includeHistorical: true,
    });
    assert.equal(historical.length, 2);
    assert.equal(
      historical.find((result) => result.memory.id === previous.memory.id)?.memory.status,
      "superseded",
    );
  });
});

test("session archives are idempotent and remain outside semantic search", () => {
  withStore((store) => {
    const first = store.archiveSession({
      sessionId: "session-1",
      transcript: "USER: hello\nASSISTANT: hi",
    });
    const second = store.archiveSession({
      sessionId: "session-1",
      transcript: "this duplicate must not be stored",
    });

    assert.deepEqual(second, first);
    assert.deepEqual(store.search("hello", { maxTier: 3 }), []);
    assert.equal(store.getSessionArchive("session-1")?.historyId, first.historyId);
  });
});
