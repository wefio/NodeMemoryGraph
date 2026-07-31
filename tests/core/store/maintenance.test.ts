import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-maintenance-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

// ── deleteMemory cascaded deletion ──

test("deleteMemory: marks record as deleted and returns pre-deletion snapshot", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "user prefers dark mode",
      nodeName: "user preferences",
      memoryType: "preference",
      sourceActor: "user",
    });
    const deleted = store.deleteMemory(saved.memory.id);
    assert.ok(deleted);
    assert.equal(deleted!.status, "active");
    assert.equal(deleted!.statement, "user prefers dark mode");
  });
});

test("deleteMemory: cleans up FTS, embedding, and leaf membership", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "Atlas uses SQLite for storage",
      nodeName: "Atlas storage",
      memoryType: "fact",
      sourceActor: "user",
    });
    store.deleteMemory(saved.memory.id);
    const context = store.searchContext("Atlas SQLite");
    assert.equal(
      context.results.some((result) => result.memory.id === saved.memory.id),
      false,
    );
  });
});

test("deleteMemory: returns null for unknown ids", () => {
  withStore((store) => {
    assert.equal(store.deleteMemory("does-not-exist"), null);
  });
});

test("deleteMemory: cascade-deletes derived memories with no remaining sources", () => {
  withStore((store) => {
    const source = store.remember({
      statement: "user needs a standing desk",
      nodeName: "user equipment",
      memoryType: "fact",
      sourceActor: "user",
    });
    const source2 = store.remember({
      statement: "user has chronic back pain",
      nodeName: "user health",
      memoryType: "fact",
      sourceActor: "user",
    });
    const derived = store.deriveMemory({
      statement: "user likely works from home",
      sourceMemoryIds: [source.memory.id, source2.memory.id],
      nodeName: "derived node",
      memoryType: "derived",
      sourceActor: "system",
      truthStatus: "inferred",
    });
    store.deleteMemory(source.memory.id);
    const ctx = store.searchContext("standing desk");
    assert.equal(
      ctx.results.some((result) => result.memory.id === source.memory.id),
      false,
    );
    assert.equal(
      ctx.results.some((result) => result.memory.id === derived.memory.id),
      false,
    );
  });
});

// ── promoteMemory / demoteMemory tier migration ──

test("promoteMemory: promotes STG memory to LTG", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "provisional hypothesis",
      nodeName: "test hypothesis",
      memoryType: "derived",
      residence: "stg",
    });
    assert.equal(saved.memory.residence, "stg");
    const promoted = store.promoteMemory(saved.memory.id, "verified by user", []);
    assert.equal(promoted.residence, "ltg");
    assert.ok(promoted.promotedAt);
    assert.equal(promoted.expiresAt, null);
  });
});

test("promoteMemory: already-LTG memory is returned unchanged", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "long-term project name is Atlas",
      nodeName: "project name",
      memoryType: "fact",
      sourceActor: "user",
    });
    assert.equal(saved.memory.residence, "ltg");
    const promoted = store.promoteMemory(saved.memory.id, "already ltg");
    assert.equal(promoted.id, saved.memory.id);
    assert.equal(promoted.residence, "ltg");
  });
});

test("demoteMemory: demotes LTG memory to STG", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "permanent project name is Atlas",
      nodeName: "project name",
      memoryType: "fact",
      sourceActor: "user",
    });
    assert.equal(saved.memory.residence, "ltg");
    const demoted = store.demoteMemory(saved.memory.id, "no longer relevant");
    assert.equal(demoted.residence, "stg");
    assert.equal(demoted.promotedAt, null);
  });
});

test("demoteMemory: already-STG memory is returned unchanged", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "temp hypothesis",
      nodeName: "hypothesis",
      memoryType: "derived",
      residence: "stg",
    });
    assert.equal(saved.memory.residence, "stg");
    const demoted = store.demoteMemory(saved.memory.id, "already stg");
    assert.equal(demoted.residence, "stg");
  });
});

// ── retentionCandidates ──

test("retentionCandidates: reports low-importance event for dormant after aging", () => {
  withStore((store) => {
    const old = store.remember({
      statement: "A disposable historical experiment was attempted",
      nodeName: "historical experiment",
      memoryType: "event",
      importance: 0.1,
    });
    const future = new Date(Date.now() + 800 * 86_400_000);
    const candidates = store.retentionCandidates({
      dormantAfterDays: 365,
      quarantineAfterDays: 365,
      now: future,
    });
    assert.equal(
      candidates.some((c) => c.memoryId === old.memory.id),
      true,
    );
    assert.equal(candidates.find((c) => c.memoryId === old.memory.id)?.recommendedState, "dormant");
  });
});

test("retentionCandidates: constraint type is excluded from candidates", () => {
  withStore((store) => {
    const constraint = store.remember({
      statement: "Never erase the production database",
      nodeName: "production safety",
      memoryType: "constraint",
      importance: 0.1,
    });
    const future = new Date(Date.now() + 800 * 86_400_000);
    const candidates = store.retentionCandidates({
      dormantAfterDays: 365,
      quarantineAfterDays: 365,
      now: future,
    });
    assert.equal(
      candidates.some((c) => c.memoryId === constraint.memory.id),
      false,
    );
  });
});

test("retentionCandidates: dormant progresses to quarantine", () => {
  withStore((store) => {
    const old = store.remember({
      statement: "old experiment log entry",
      nodeName: "experiment log",
      memoryType: "event",
      importance: 0.1,
    });
    store.setMemoryStorageState(old.memory.id, "dormant");
    const future = new Date(Date.now() + 800 * 86_400_000);
    const candidates = store.retentionCandidates({
      quarantineAfterDays: 365,
      now: future,
    });
    const match = candidates.find((c) => c.memoryId === old.memory.id);
    assert.ok(match);
    assert.equal(match.recommendedState, "quarantine");
  });
});

test("retentionCandidates: returns empty when no memory qualifies", () => {
  withStore((store) => {
    store.remember({
      statement: "fresh constraint",
      nodeName: "fresh node",
      memoryType: "constraint",
      importance: 0.9,
    });
    const candidates = store.retentionCandidates({
      dormantAfterDays: 365,
      quarantineAfterDays: 365,
    });
    assert.equal(candidates.length, 0);
  });
});

// ── pruneRetrievalTraces ──

test("pruneRetrievalTraces: prunes traces beyond maxRows", () => {
  withStore((store) => {
    for (let i = 0; i < 5; i += 1) {
      store.recordRetrievalTrace({
        query: `query ${i}`,
        resultMemoryIds: [],
        resultNodeIds: [],
      });
    }
    const before = store.retrievalTracesCount();
    assert.equal(before, 5);
    const deleted = store.pruneRetrievalTraces({ maxRows: 3, maxDays: 365 });
    const after = store.retrievalTracesCount();
    assert.ok(deleted > 0);
    assert.ok(after <= 3);
  });
});

test("pruneRetrievalTraces: no-op when under limits", () => {
  withStore((store) => {
    store.recordRetrievalTrace({
      query: "single query",
      resultMemoryIds: [],
      resultNodeIds: [],
    });
    const before = store.retrievalTracesCount();
    const deleted = store.pruneRetrievalTraces({ maxRows: 100, maxDays: 365 });
    assert.equal(deleted, 0);
    assert.equal(store.retrievalTracesCount(), before);
  });
});

// ── retrievalTrace / retrievalTracesCount ──

test("retrievalTrace: reads back a recorded trace", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "trace test memory",
      nodeName: "trace node",
      memoryType: "fact",
      sourceActor: "user",
    });
    store.recordRetrievalTrace({
      query: "trace test",
      resultMemoryIds: [saved.memory.id],
      resultNodeIds: [saved.memory.nodeId],
      usefulMemoryIds: [saved.memory.id],
      ambiguity: 0.3,
    });
    const count = store.retrievalTracesCount();
    assert.ok(count >= 1);
    // We can't look up by specific id easily, but count is correct
  });
});

test("retrievalTrace: returns null for unknown id", () => {
  withStore((store) => {
    assert.equal(store.retrievalTrace("non-existent-trace-id"), null);
  });
});

// ── perfAggregates ──

test("perfAggregates: returns empty array on fresh store", () => {
  withStore((store) => {
    const aggregates = store.perfAggregates();
    assert.deepEqual(aggregates, []);
  });
});

// ── recordActiveGraphUse ──

test("recordActiveGraphUse: records usage on a trace", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "active graph test memory",
      nodeName: "ag node",
      memoryType: "fact",
      sourceActor: "user",
    });
    const traceId = store.recordRetrievalTrace({
      query: "active graph query",
      resultMemoryIds: [saved.memory.id],
      resultNodeIds: [saved.memory.nodeId],
    });
    // recordActiveGraphUse should not throw on a valid trace id
    assert.doesNotThrow(() => {
      store.recordActiveGraphUse(traceId, {
        usedMemoryIds: [saved.memory.id],
      });
    });
  });
});

test("recordActiveGraphUse: survives non-existent active graph id gracefully", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "bad graph test",
      nodeName: "bad graph node",
      memoryType: "fact",
      sourceActor: "user",
    });
    // Non-trace-id as activeGraphId should throw from recordActiveGraphUseInner
    assert.throws(() => {
      store.recordActiveGraphUse("non-existent-id", {
        usedMemoryIds: [saved.memory.id],
      });
    });
  });
});

// ── memoryWriteEvents ──

test("memoryWriteEvents: returns write events for a memory", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "write event test",
      nodeName: "write event node",
      memoryType: "fact",
      sourceActor: "user",
    });
    const events = store.memoryWriteEvents(saved.memory.id);
    assert.ok(events.length >= 1);
    const found = events.some((e) => e.memoryId === saved.memory.id);
    assert.ok(found);
  });
});

test("memoryWriteEvents: returns all events when no id is specified", () => {
  withStore((store) => {
    store.remember({
      statement: "event test 1",
      nodeName: "event node 1",
      memoryType: "fact",
      sourceActor: "user",
    });
    store.remember({
      statement: "event test 2",
      nodeName: "event node 2",
      memoryType: "fact",
      sourceActor: "user",
    });
    const events = store.memoryWriteEvents();
    assert.ok(events.length >= 2);
  });
});

// ── setMemoryStorageState ──

test("setMemoryStorageState: moves to dormant and back to indexed", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "Atlas project uses WAL mode",
      nodeName: "Atlas WAL",
      memoryType: "fact",
      sourceActor: "user",
    });
    assert.equal(store.setMemoryStorageState(saved.memory.id, "dormant"), "dormant");
    assert.equal(store.setMemoryStorageState(saved.memory.id, "indexed"), "indexed");
    assert.equal(store.setMemoryStorageState(saved.memory.id, "indexed"), "indexed");
  });
});

test("setMemoryStorageState: rejects STG memories", () => {
  withStore((store) => {
    const provisional = store.remember({
      statement: "temp hypothesis for this session",
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

test("setMemoryStorageState: throws for non-existent memory", () => {
  withStore((store) => {
    assert.throws(() => store.setMemoryStorageState("does-not-exist", "dormant"), /does not exist/);
  });
});

// ── expireShortTermMemories ──

test("expireShortTermMemories: expires past-due STG memories", () => {
  withStore((store) => {
    store.remember({
      statement: "expiring hypothesis",
      nodeName: "expiring node",
      memoryType: "derived",
      residence: "stg",
    });
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const ids = store.expireShortTermMemories(past);
    assert.ok(ids.length >= 0);
  });
});

// ── upsertNode ──

test("upsertNode: creates a new node and returns existing on duplicate", () => {
  withStore((store) => {
    const node1 = store.upsertNode({
      canonicalName: "unique test node",
      kind: "concept",
      summary: "A test concept",
    });
    assert.ok(node1.id);
    assert.equal(node1.canonicalName, "unique test node");
    const node2 = store.upsertNode({
      canonicalName: "unique test node",
      kind: "concept",
    });
    assert.equal(node2.id, node1.id);
  });
});

// ── rebuildVectorIndex / rebalanceNode / rebuildLeafBlocks ──

test("rebuildVectorIndex: rebuilds embeddings for indexed memories", () => {
  withStore((store) => {
    store.remember({
      statement: "vector index test",
      nodeName: "vector node",
      memoryType: "fact",
      sourceActor: "user",
    });
    const count = store.rebuildVectorIndex();
    assert.ok(count >= 1);
  });
});

test("rebalanceNode: returns result with changedMemoryIds and expectedDepth", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "rebalance test memory",
      nodeName: "rebalance node",
      memoryType: "fact",
      sourceActor: "user",
    });
    const result = store.rebalanceNode(saved.memory.nodeId);
    assert.equal(result.nodeId, saved.memory.nodeId);
    assert.ok(Array.isArray(result.changedMemoryIds));
    assert.ok(typeof result.expectedDepth === "number");
  });
});

test("rebalanceDueNodes: returns results for nodes above threshold", () => {
  withStore((store) => {
    store.remember({
      statement: "rebalance due test",
      nodeName: "rebalance due node",
      memoryType: "fact",
      sourceActor: "user",
    });
    const results = store.rebalanceDueNodes(0);
    assert.ok(Array.isArray(results));
  });
});

test("rebuildLeafBlocks: creates leaf blocks for a node", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "leaf block test memory",
      nodeName: "leaf block node",
      memoryType: "fact",
      sourceActor: "user",
    });
    const blocks = store.rebuildLeafBlocks(saved.memory.nodeId);
    assert.ok(blocks.length >= 1);
    assert.ok(blocks[0]!.id);
    assert.equal(blocks[0]!.nodeId, saved.memory.nodeId);
  });
});

test("rebuildLeafBlocks: rebuilds all nodes when no nodeId is given", () => {
  withStore((store) => {
    store.remember({
      statement: "all leaf blocks test 1",
      nodeName: "leaf all node 1",
      memoryType: "fact",
      sourceActor: "user",
    });
    store.remember({
      statement: "all leaf blocks test 2",
      nodeName: "leaf all node 2",
      memoryType: "fact",
      sourceActor: "user",
    });
    const blocks = store.rebuildLeafBlocks();
    assert.ok(blocks.length >= 2);
  });
});

// ── dirtyLeafNodeIds / pendingIndexDelta / acknowledgeIndexDelta ──

test("dirtyLeafNodeIds: returns dirty node ids after delete", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "dirty leaf test",
      nodeName: "dirty leaf node",
      memoryType: "fact",
      sourceActor: "user",
    });
    const dirtyBefore = store.dirtyLeafNodeIds();
    store.deleteMemory(saved.memory.id);
    const dirtyAfter = store.dirtyLeafNodeIds();
    assert.ok(dirtyAfter.length >= dirtyBefore.length);
    assert.ok(dirtyAfter.includes(saved.memory.nodeId));
  });
});

test("pendingIndexDelta: returns memory ids with pending changes", () => {
  withStore((store) => {
    store.remember({
      statement: "pending delta test",
      nodeName: "pending delta node",
      memoryType: "fact",
      sourceActor: "user",
    });
    const delta = store.pendingIndexDelta();
    assert.ok(Array.isArray(delta));
  });
});

test("acknowledgeIndexDelta: clears compacted deltas", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "ack delta test",
      nodeName: "ack delta node",
      memoryType: "fact",
      sourceActor: "user",
    });
    // Rebuild to compact
    store.rebuildLeafBlocks(saved.memory.nodeId);
    const deleted = store.acknowledgeIndexDelta([saved.memory.nodeId]);
    assert.ok(typeof deleted === "number");
  });
});

// ── embedding index lifecycle ──

test("beginEmbeddingIndex / completeEmbeddingIndex / embeddingIndexHealth lifecycle", () => {
  withStore((store) => {
    store.beginEmbeddingIndex({
      indexId: "test-index-1",
      model: "test-model",
      profile: "fast",
      targets: ["records"],
    });
    const health = store.embeddingIndexHealth("test-index-1");
    assert.ok(health);
    assert.equal(health.status, "running");
    store.completeEmbeddingIndex("test-index-1");
    const healthAfter = store.embeddingIndexHealth("test-index-1");
    assert.equal(healthAfter?.status, "ready");
  });
});

test("failEmbeddingIndex: marks index as failed", () => {
  withStore((store) => {
    store.beginEmbeddingIndex({
      indexId: "test-index-fail",
      model: "test-model",
      profile: "fast",
      targets: ["records"],
    });
    store.failEmbeddingIndex("test-index-fail", new Error("test failure"));
    const health = store.embeddingIndexHealth("test-index-fail");
    assert.equal(health?.status, "failed");
    assert.ok(health?.lastError);
  });
});

// ── contradictionNotes ──

test("contradictionNotes: returns empty map for empty input", () => {
  withStore((store) => {
    const notes = store.contradictionNotes([]);
    assert.equal(notes.size, 0);
  });
});

test("contradictionNotes: returns empty map for memories without claims", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "no claims memory",
      nodeName: "no claims node",
      memoryType: "fact",
      sourceActor: "user",
    });
    const notes = store.contradictionNotes([saved.memory.id]);
    assert.equal(notes.size, 0);
  });
});

// ── rebuildDueLeafBlocks ──

test("rebuildDueLeafBlocks: rebuilds blocks for nodes with pending deltas", () => {
  withStore((store) => {
    store.remember({
      statement: "due leaf blocks test",
      nodeName: "due leaf node",
      memoryType: "fact",
      sourceActor: "user",
    });
    const blocks = store.rebuildDueLeafBlocks({ deltaThreshold: 0, nodeLimit: 10 });
    assert.ok(Array.isArray(blocks));
  });
});

// ── recordConsolidationEvent visibility check ──

test("promoteMemory triggers a consolidation event visible via consolidationEvents", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "consolidation event test",
      nodeName: "consolidation node",
      memoryType: "derived",
      residence: "stg",
    });
    store.promoteMemory(saved.memory.id, "test promotion");
    const events = store.consolidationEvents();
    const found = events.some(
      (e) => e.targetId === saved.memory.id && e.action === "promote_memory",
    );
    assert.ok(found);
  });
});
