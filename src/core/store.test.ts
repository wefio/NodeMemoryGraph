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

test("session archives checkpoint changes without entering semantic search", () => {
  withStore((store) => {
    const first = store.archiveSession({
      sessionId: "session-1",
      transcript: "USER: hello\nASSISTANT: hi",
    });
    const second = store.archiveSession({
      sessionId: "session-1",
      transcript: "USER: hello\nASSISTANT: hi",
    });
    const updated = store.archiveSession({
      sessionId: "session-1",
      transcript: "USER: hello\nASSISTANT: hi\nUSER: next turn",
    });

    assert.deepEqual(second, first);
    assert.notEqual(updated.historyId, first.historyId);
    assert.deepEqual(store.search("hello", { maxTier: 3 }), []);
    assert.equal(store.getSessionArchive("session-1")?.historyId, updated.historyId);
  });
});

test("stateKey automatically supersedes the active state in the same scope", () => {
  withStore((store) => {
    const previous = store.remember({
      statement: "Charity 5K personal best is 27:12",
      nodeName: "running personal best",
      memoryType: "state",
      stateKey: "running.charity_5k.personal_best",
      scope: { project: "fitness", user: "primary" },
      validFrom: "2023-05-25T00:00:00Z",
    });
    const current = store.remember({
      statement: "Charity 5K personal best is 25:50",
      nodeName: "running personal best",
      memoryType: "state",
      stateKey: "running.charity_5k.personal_best",
      scope: { user: "primary", project: "fitness" },
      validFrom: "2023-05-27T00:00:00Z",
    });

    assert.equal(current.memory.supersedesId, previous.memory.id);
    assert.equal(current.memory.evidenceRole, "update");
    assert.deepEqual(
      store.search("Charity 5K personal best", { maxTier: 3 })
        .map((result) => result.memory.statement),
      ["Charity 5K personal best is 25:50"],
    );
  });
});

test("events and conversation evidence preserve time, actor, and truth status", () => {
  withStore((store) => {
    const event = store.remember({
      statement: "User visited MoMA",
      nodeName: "MoMA visit",
      memoryType: "event",
      eventTime: "2023-01-08T00:00:00Z",
    });
    const assistantEvidence = store.remember({
      statement: "Assistant assigned Admon the Sunday day shift",
      nodeName: "GM Sunday rotation",
      memoryType: "conversation_evidence",
      sourceActor: "assistant",
      truthStatus: "unverified",
    });

    assert.equal(event.memory.eventTime, "2023-01-08T00:00:00Z");
    assert.equal(assistantEvidence.memory.sourceActor, "assistant");
    assert.equal(assistantEvidence.memory.truthStatus, "unverified");
  });
});

test("derived memories retain every source evidence and graph relation", () => {
  withStore((store) => {
    const first = store.remember({
      statement: "The blazer must be picked up",
      nodeName: "blazer pickup",
      memoryType: "event",
    });
    const second = store.remember({
      statement: "The boots must be picked up",
      nodeName: "boots pickup",
      memoryType: "event",
    });
    const derived = store.deriveMemory({
      statement: "Two store pickups remain",
      nodeName: "pending clothing errands",
      memoryType: "derived",
      sourceMemoryIds: [first.memory.id, second.memory.id],
      derivation: "Counted two active store pickup events.",
    });

    const [result] = store.search("store pickups", { maxTier: 3 });
    assert.equal(result?.memory.id, derived.memory.id);
    assert.deepEqual(
      new Set(result?.memory.evidenceIds),
      new Set([first.history.id, second.history.id, derived.history.id]),
    );
    assert.equal(result?.evidenceRecords.length, 3);
    assert.equal(store.getRelations([derived.node.id], 1).length, 2);
  });
});

test("searchContext combines matching memories with typed graph edges", () => {
  withStore((store) => {
    const preference = store.remember({
      statement: "User prefers Adobe Premiere Pro advanced tutorials",
      nodeName: "video editing preference",
      memoryType: "preference",
    });
    const task = store.remember({
      statement: "Recommend video editing learning resources",
      nodeName: "video editing recommendations",
      memoryType: "strategy",
    });
    store.linkNodes({
      sourceNodeId: preference.node.id,
      targetNodeId: task.node.id,
      type: "applies_to",
      evidenceIds: [preference.history.id],
    });

    const context = store.searchContext("Adobe Premiere video editing", {
      maxTier: 3,
      graphHops: 1,
    });
    assert.equal(context.results[0]?.memory.id, preference.memory.id);
    assert.ok(context.results.some((result) => result.memory.id === task.memory.id));
    assert.equal(context.relations[0]?.type, "applies_to");
  });
});
