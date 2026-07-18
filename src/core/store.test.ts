import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "./store.ts";
import type { VectorEmbedder } from "./types.ts";

function withStore(
  run: (store: NmgStore) => void,
  embedder?: VectorEmbedder,
): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-test-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"), embedder);
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

test("node merge preserves memories, evidence, relations, and redirects", () => {
  withStore((store) => {
    const first = store.remember({ statement: "Uses TypeScript", nodeName: "NMG language" });
    const second = store.remember({ statement: "Uses SQLite", nodeName: "NMG database" });
    const host = store.remember({ statement: "Pi hosts NMG", nodeName: "Pi host" });
    store.linkNodes({ sourceNodeId: first.node.id, targetNodeId: host.node.id, type: "applies_to" });

    const transform = store.mergeNodes({
      sourceNodeIds: [first.node.id, second.node.id],
      targetName: "NMG implementation",
      targetKind: "project",
    });
    const typescript = store.search("TypeScript", { maxTier: 3 })[0];
    const sqlite = store.search("SQLite", { maxTier: 3 })[0];

    assert.equal(transform.type, "merge");
    assert.equal(transform.movedMemoryIds.length, 2);
    assert.deepEqual(store.getNodeTransform(transform.id), transform);
    assert.equal(typescript?.node.id, transform.targetNodeIds[0]);
    assert.equal(sqlite?.node.id, transform.targetNodeIds[0]);
    assert.equal(typescript?.evidence.id, first.history.id);
    assert.ok(store.getRelations([transform.targetNodeIds[0]!], 1)
      .some((relation) => relation.targetNodeId === host.node.id));
    const later = store.remember({ statement: "Uses Node.js", nodeName: "NMG language" });
    assert.equal(later.node.id, transform.targetNodeIds[0]);
    assert.equal(store.search("Node.js", { nodeName: "NMG language", maxTier: 3 })[0]?.memory.id,
      later.memory.id);
  });
});

test("node split requires a complete partition and preserves every memory", () => {
  withStore((store) => {
    const first = store.remember({ statement: "Python 2 for ROS", nodeName: "Python environment" });
    const second = store.remember({ statement: "Python 3.12 for Windows", nodeName: "Python environment" });
    const transform = store.splitNode({
      sourceNodeId: first.node.id,
      partitions: [
        { nodeName: "ROS Python", memoryIds: [first.memory.id] },
        { nodeName: "Windows Python", memoryIds: [second.memory.id] },
      ],
    });

    assert.equal(transform.type, "split");
    assert.equal(transform.targetNodeIds.length, 2);
    assert.equal(store.search("Python 2 ROS", { maxTier: 3 })[0]?.node.canonicalName, "ROS Python");
    assert.equal(store.search("Python 3.12 Windows", { maxTier: 3 })[0]?.node.canonicalName,
      "Windows Python");
    assert.throws(
      () => store.remember({ statement: "Ambiguous Python", nodeName: "Python environment" }),
      /choose a more specific node/,
    );
  });
});

test("vector retrieval finds a semantic synonym without lexical overlap", () => {
  const synonymEmbedder: VectorEmbedder = {
    dimensions: 3,
    model: "test-synonyms",
    embed(text) {
      const value = text.toLowerCase();
      if (value.includes("automobile") || value.includes("car")) return [1, 0, 0];
      if (value.includes("bicycle") || value.includes("bike")) return [0, 1, 0];
      return [0, 0, 1];
    },
  };
  withStore((store) => {
    const saved = store.remember({
      statement: "The automobile needs a service",
      nodeName: "vehicle maintenance",
    });
    const result = store.search("car", { maxTier: 3 })[0];
    assert.equal(result?.memory.id, saved.memory.id);
    assert.equal(result?.lexicalScore, 0);
    assert.equal(result?.vectorScore, 1);
  }, synonymEmbedder);
});

test("learning router changes node ranking from explicit feedback", () => {
  withStore((store) => {
    const first = store.remember({ statement: "One", nodeName: "first project" });
    store.remember({ statement: "Two", nodeName: "second project" });
    assert.deepEqual(store.routeNodes("alpha signal"), []);

    store.trainRouter("alpha signal", [first.node.id], 1);
    const routes = store.routeNodes("alpha signal");
    assert.equal(routes[0]?.node.id, first.node.id);
    assert.ok((routes[0]?.score ?? 0) > 0.6);
  });
});

test("vector index and learned router persist across restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-test-"));
  const database = join(directory, "nmg.sqlite");
  const embedder: VectorEmbedder = {
    dimensions: 3,
    model: "persistent-test",
    embed(text) {
      return /car|automobile/i.test(text) ? [1, 0, 0] :
        /alpha/i.test(text) ? [0, 1, 0] : [0, 0, 1];
    },
  };
  const writer = new NmgStore(database, embedder);
  const saved = writer.remember({ statement: "Automobile service", nodeName: "vehicle" });
  writer.trainRouter("alpha", [saved.node.id], 1);
  writer.close();

  const reader = new NmgStore(database, embedder);
  try {
    assert.equal(reader.search("car", { maxTier: 3 })[0]?.memory.id, saved.memory.id);
    assert.equal(reader.routeNodes("alpha")[0]?.node.id, saved.node.id);
  } finally {
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Huffman-like block rebalance promotes frequent memory only in batches", () => {
  withStore((store) => {
    const memories = Array.from({ length: 5 }, (_, index) => store.remember({
      statement: `Shared topic memory ${index}`,
      nodeName: "shared topic",
      tier: 1,
    }));
    const hot = memories[4]!.memory.id;
    store.recordUsage([hot]);
    store.recordUsage([hot]);
    assert.deepEqual(store.rebalanceDueNodes(3), []);
    store.recordUsage([hot]);
    const [rebalanced] = store.rebalanceDueNodes(3, [1, 1, 1]);

    assert.equal(rebalanced?.pendingAccesses, 3);
    assert.ok((rebalanced?.expectedDepth ?? 99) > 0);
    const results = store.search("Shared topic", { maxTier: 3, limit: 10 });
    assert.equal(results.length, 5);
    assert.equal(results.find((result) => result.memory.id === hot)?.memory.tier, 0);
    assert.equal(results.filter((result) => result.memory.tier === 3).length, 2);
  });
});
