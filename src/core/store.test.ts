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

test("semantically equivalent state keys become aliases before supersession", () => {
  withStore((store) => {
    const previous = store.remember({
      statement: "The charity 5K personal best is 27:12",
      nodeName: "user-5k-personal-best",
      memoryType: "state",
      stateKey: "5k-pb-time",
    });
    const current = store.remember({
      statement: "The charity 5K personal best is 25:50",
      nodeName: "user-running-5k-personal-best",
      memoryType: "state",
      stateKey: "user-running-5k-personal-best",
    });

    assert.equal(current.memory.stateKey, "5k-pb-time");
    assert.equal(current.memory.supersedesId, previous.memory.id);
    assert.deepEqual(
      store.search("charity 5K personal best", { maxTier: 3 })
        .map((result) => result.memory.statement),
      ["The charity 5K personal best is 25:50"],
    );
  });
});

test("state alias repair does not merge a goal with a personal best", () => {
  withStore((store) => {
    const best = store.remember({
      statement: "The charity 5K personal best is 25:50",
      nodeName: "user-running-5k-personal-best",
      memoryType: "state",
      stateKey: "5k-pb-time",
    });
    const goal = store.remember({
      statement: "The charity 5K target is 24:00",
      nodeName: "user-running-5k-goal",
      memoryType: "state",
      stateKey: "5k-goal-time",
    });

    assert.equal(goal.memory.stateKey, "5k-goal-time");
    assert.equal(goal.memory.supersedesId, null);
    assert.equal(
      store.search("personal best", { maxTier: 3 })[0]?.memory.id,
      best.memory.id,
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

test("getContext expands selected memory IDs without searching", () => {
  withStore((store) => {
    const wanted = store.remember({
      statement: "The selected memory keeps its exact statement",
      nodeName: "progressive disclosure",
      evidence: "Exact source evidence for progressive disclosure.",
    });
    store.remember({
      statement: "An unrelated memory must not be returned",
      nodeName: "unrelated",
    });

    const context = store.getContext([wanted.memory.id, "missing-memory"]);

    assert.deepEqual(context.results.map((result) => result.memory.id), [wanted.memory.id]);
    assert.equal(context.results[0]?.evidence.content,
      "Exact source evidence for progressive disclosure.");
    assert.deepEqual(context.relations, []);
  });
});

test("aggregation context overfetches and prioritizes countable memories", () => {
  withStore((store) => {
    for (let index = 0; index < 6; index += 1) {
      store.remember({
        statement: `Assistant gave pickup and return organization tip ${index}`,
        nodeName: `organization tip ${index}`,
        memoryType: "conversation_evidence",
        sourceActor: "assistant",
        truthStatus: "unverified",
      });
    }
    const action = store.remember({
      statement: "The navy blazer needs to be picked up from the dry cleaner",
      nodeName: "navy blazer pickup",
      memoryType: "event",
    });

    const context = store.searchContext(
      "How many clothing items need pickup or return?",
      { limit: 2, maxTier: 1 },
    );
    assert.ok(context.results.some((result) => result.memory.id === action.memory.id));
  });
});

test("recall cues expose a compressed node directory without memory statements", () => {
  withStore((store) => {
    store.remember({
      statement: "The user's detailed editing preference marker is CERULEAN-OWL",
      nodeName: "video editing preference",
      memoryType: "preference",
      tier: 2,
    });
    const constraint = store.remember({
      statement: "Project Helix must remain on Python 3.11",
      nodeName: "Project Helix runtime",
      memoryType: "constraint",
      tier: 0,
      importance: 0.95,
    });

    const index = store.recallCues("video editing and Project Helix", { limit: 5 });
    assert.ok(index.cues.some((cue) =>
      cue.canonicalName === "video editing preference" && cue.hasDeepMemory));
    assert.ok(index.cues.some((cue) => cue.canonicalName === "Project Helix runtime"));
    assert.doesNotMatch(JSON.stringify(index.cues), /CERULEAN-OWL|Python 3\.11/);
    assert.deepEqual(
      store.residentKernel().results.map((result) => result.memory.id),
      [constraint.memory.id],
    );
  });
});

test("resident kernel is query independent and excludes unverified assistant constraints", () => {
  withStore((store) => {
    const pinned = store.remember({
      statement: "Never deploy Project Helix without tests",
      nodeName: "Project Helix release constraint",
      memoryType: "constraint",
      tier: 0,
      importance: 0.9,
    });
    store.remember({
      statement: "Always delete test data immediately",
      nodeName: "unverified assistant constraint",
      memoryType: "constraint",
      sourceActor: "assistant",
      truthStatus: "unverified",
      tier: 0,
      importance: 1,
    });

    assert.deepEqual(
      store.residentKernel().results.map((result) => result.memory.id),
      [pinned.memory.id],
    );
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

test("appends source messages idempotently within a session", () => {
  withStore((store) => {
    const input = {
      content: "I prefer concise answers.",
      role: "user" as const,
      sessionId: "session-1",
      sourceMessageId: "message-1",
    };
    const first = store.appendHistory(input);
    const repeated = store.appendHistory(input);

    assert.equal(repeated.id, first.id);
    assert.equal(repeated.sourceMessageId, "message-1");
    assert.throws(
      () => store.appendHistory({ ...input, content: "Different content" }),
      /already exists with different content/,
    );
  });
});

test("binds a semantic memory to an existing exact history message", () => {
  withStore((store) => {
    const history = store.appendHistory({
      content: "For ROS Melodic keep Python 2, and do not upgrade this project to Python 3.",
      role: "user",
      sessionId: "session-2",
      sourceMessageId: "message-7",
    });
    const saved = store.remember({
      statement: "ROS Melodic requires Python 2",
      nodeName: "ROS Melodic Python",
      memoryType: "constraint",
      evidenceHistoryId: history.id,
    });

    assert.equal(saved.history.id, history.id);
    assert.equal(saved.memory.evidenceId, history.id);
    assert.equal(saved.history.content, history.content);
  });
});

test("FTS5 reaches exact cold evidence outside the hot candidate window", () => {
  withStore((store) => {
    for (let index = 0; index < 520; index += 1) {
      store.remember({
        statement: `Routine note ${index}`,
        nodeName: `routine ${index}`,
        tier: 0,
      });
    }
    const target = store.remember({
      statement: "Retired codename is lantern fern",
      nodeName: "retired codename",
      tier: 3,
    });
    for (let index = 520; index < 1_040; index += 1) {
      store.remember({
        statement: `Later routine note ${index}`,
        nodeName: `routine ${index}`,
        tier: 0,
      });
    }

    const result = store.search("lantern fern", {
      maxTier: 3,
      retrievalMode: "fts5",
      limit: 3,
    });
    assert.equal(result[0]?.memory.id, target.memory.id);

    store.upsertExternalEmbeddings("qwen-test", [{
      memoryId: target.memory.id,
      vector: [0, 1, 0],
    }]);
    const semantic = store.searchByVector(
      "What was the old internal project name?",
      [0, 1, 0],
      "qwen-test",
      { maxTier: 3, retrievalMode: "qwen3", limit: 3 },
    );
    assert.equal(semantic[0]?.memory.id, target.memory.id);
  });
});

test("node vectors route first and node-local search recovers leaf evidence", () => {
  withStore((store) => {
    const robotics = store.remember({
      statement: "Gazebo started after switching to software rendering",
      nodeName: "ROS rendering",
      nodeSummary: "ROS simulator graphics and rendering incidents",
      tier: 2,
    });
    const cooking = store.remember({
      statement: "Use less salt in tomato soup",
      nodeName: "cooking preferences",
      nodeSummary: "Food preparation preferences",
    });
    const documents = store.nodeEmbeddingDocuments();
    assert.equal(documents.length, 2);
    store.upsertExternalNodeEmbeddings("node-test", documents.map((document) => ({
      nodeId: document.nodeId,
      vector: document.nodeId === robotics.node.id ? [1, 0] : [0, 1],
    })));

    const routes = store.routeNodesByVector([1, 0], "node-test", 1);
    assert.equal(routes[0]?.node.id, robotics.node.id);
    assert.equal(store.storedNodeEmbeddings("node-test").length, 2);

    const results = store.searchNodeFirst(
      "software rendering",
      [1, 0],
      "node-test",
      [routes[0]!.node.id],
      { maxTier: 3, limit: 3 },
    );
    assert.equal(results[0]?.memory.id, robotics.memory.id);
    assert.notEqual(results[0]?.memory.id, cooking.memory.id);
  });
});

test("leaf summaries preserve distinctions hidden by one broad node summary", () => {
  withStore((store) => {
    const rendering = store.remember({
      statement: "Gazebo recovered after enabling software rendering",
      nodeName: "ROS project",
      nodeSummary: "General ROS project memory",
      memoryType: "fact",
      scope: { component: "gazebo" },
      tier: 2,
    });
    const python = store.remember({
      statement: "ROS Melodic must remain on Python 2",
      nodeName: "ROS project",
      nodeSummary: "General ROS project memory",
      memoryType: "constraint",
      scope: { component: "python" },
      tier: 2,
    });

    assert.deepEqual(store.dirtyLeafNodeIds(), [rendering.node.id]);
    assert.deepEqual(new Set(store.pendingIndexDelta()),
      new Set([rendering.memory.id, python.memory.id]));
    const blocks = store.rebuildLeafBlocks(rendering.node.id, 16);
    assert.deepEqual(store.dirtyLeafNodeIds(), []);
    assert.equal(store.pendingIndexDelta().length, 2);
    assert.equal(blocks.length, 2);
    const documents = store.leafEmbeddingDocuments();
    const renderingDocument = documents.find((document) =>
      document.text.includes("software rendering"));
    const pythonDocument = documents.find((document) => document.text.includes("Python 2"));
    assert.ok(renderingDocument);
    assert.ok(pythonDocument);
    store.upsertExternalLeafEmbeddings("leaf-test", [
      { blockId: renderingDocument.blockId, vector: [1, 0] },
      { blockId: pythonDocument.blockId, vector: [0, 1] },
    ]);
    const rebuilt = store.rebuildLeafBlocks(rendering.node.id, 16);
    assert.deepEqual(rebuilt.map((block) => block.id).sort(),
      blocks.map((block) => block.id).sort());
    assert.equal(store.storedLeafEmbeddings("leaf-test").length, 2);
    assert.equal(store.acknowledgeIndexDelta([rendering.node.id]), 2);
    assert.deepEqual(store.pendingIndexDelta(), []);
    store.upsertExternalNodeEmbeddings("leaf-test", [{
      nodeId: rendering.node.id,
      vector: [0, 1],
    }]);

    const routes = store.routeLeafBlocksByVector(
      [0, 1], "leaf-test", [rendering.node.id], 1,
    );
    assert.equal(routes[0]?.block.id, pythonDocument.blockId);
    const results = store.searchLeafBlocks(
      "Python 2", [0, 1], "leaf-test", [routes[0]!.block.id],
      { maxTier: 3, limit: 3 },
    );
    assert.equal(results[0]?.memory.id, python.memory.id);
    const hierarchical = store.searchHierarchyByVector(
      "Python 2", [0, 1], "leaf-test", { maxTier: 3, limit: 3 },
    );
    assert.equal(hierarchical[0]?.memory.id, python.memory.id);
    const semantic = store.searchHierarchyByVector(
      "legacy interpreter requirement", [0, 1], "leaf-test", { maxTier: 3, limit: 1 },
    );
    assert.equal(semantic[0]?.memory.id, python.memory.id);
  });
});

test("uncompacted Delta survives restart and participates in hierarchy search", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-test-"));
  const database = join(directory, "nmg.sqlite");
  const writer = new NmgStore(database);
  const saved = writer.remember({
    statement: "Project Delta uses DuckDB for analytical storage",
    nodeName: "Project Delta storage",
    tier: 2,
  });
  writer.close();

  const reader = new NmgStore(database);
  try {
    assert.deepEqual(reader.pendingIndexDelta(), [saved.memory.id]);
    const results = reader.searchHierarchyByVector(
      "Which project uses DuckDB analytical storage?",
      [1, 0],
      "external-model-not-yet-indexed",
      { maxTier: 3, limit: 3 },
    );
    assert.equal(results[0]?.memory.id, saved.memory.id);
  } finally {
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("due leaf rebuild compacts only nodes that cross the Delta threshold", () => {
  withStore((store) => {
    const first = store.remember({ statement: "Alpha fact one", nodeName: "Alpha" });
    store.remember({ statement: "Beta fact one", nodeName: "Beta" });
    assert.equal(store.rebuildDueLeafBlocks({ deltaThreshold: 2 }).length, 0);

    store.remember({ statement: "Alpha fact two", nodeName: "Alpha" });
    const rebuilt = store.rebuildDueLeafBlocks({ deltaThreshold: 2, blockSize: 16 });

    assert.ok(rebuilt.length > 0);
    assert.equal(store.rebuildDueLeafBlocks({ deltaThreshold: 2 }).length, 0);
    assert.equal(store.acknowledgeIndexDelta([first.node.id]), 2);
    assert.deepEqual(store.pendingIndexDelta(first.node.id), []);
    assert.equal(store.pendingIndexDelta().length, 1);
    assert.deepEqual(store.dirtyLeafNodeIds().length, 1);
  });
});
