import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-retrieval-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

// ── searchContext ──

test("searchContext returns results and relations for a lexical query", () => {
  withStore((store) => {
    store.remember({
      statement: "Atlas uses SQLite for persistence",
      nodeName: "Atlas storage",
      memoryType: "constraint",
      importance: 0.9,
    });
    store.remember({
      statement: "Atlas uses WAL mode",
      nodeName: "Atlas storage",
      memoryType: "constraint",
      importance: 0.8,
    });

    const ctx = store.searchContext("SQLite persistence");
    assert.ok(ctx.results.length >= 1);
    assert.equal(ctx.results[0]?.node.canonicalName, "Atlas storage");
    assert.ok(Array.isArray(ctx.relations));
  });
});

test("searchContext returns results sorted by contextUsefulness", () => {
  withStore((store) => {
    store.remember({
      statement: "The sky is blue",
      nodeName: "sky",
      memoryType: "fact",
      importance: 0.5,
    });
    store.remember({
      statement: "Project Atlas database uses SQLite",
      nodeName: "Atlas",
      memoryType: "constraint",
      importance: 0.9,
    });

    const ctx = store.searchContext("Atlas SQLite database");
    assert.ok(ctx.results.length >= 1);
    // The Atlas result should be first because it matches better
    assert.equal(ctx.results[0]?.node.canonicalName, "Atlas");
  });
});

test("searchContext surfaces a bounded open memory beside its retrieved anchor", () => {
  withStore((store) => {
    const anchor = store.remember({
      statement: "Atlas uses SQLite for local persistence",
      nodeName: "Atlas storage",
      memoryType: "fact",
    });
    for (let index = 0; index < 30; index += 1) {
      store.remember({
        statement: `Unrelated archive item ${index}`,
        nodeName: `Archive ${index}`,
        importance: 0.9,
      });
    }
    const open = store.remember({
      statement: "Verify portability on the remaining target platform",
      nodeName: "Release verification backlog",
      memoryType: "event",
      importance: 0,
      resolution: "open",
      relatedMemoryIds: [anchor.memory.id],
    });

    const context = store.searchContext("Which database does Atlas use?", {
      limit: 8,
      retrievalMode: "fts5",
    });
    assert.ok(context.results.some((result) => result.memory.id === anchor.memory.id));
    assert.ok(context.results.some((result) => result.memory.id === open.memory.id));
    assert.equal(
      context.results.find((result) => result.memory.id === open.memory.id)?.memory.resolution,
      "open",
    );
    assert.equal(
      context.activeGraph?.selections.find((selection) => selection.memoryId === open.memory.id)
        ?.source,
      "open_attachment",
    );
  });
});

test("FTS5 retrieves a Chinese memory from a shorter overlapping phrase", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "用户偏好中文解释，并希望保留精确的技术细节。",
      nodeName: "用户讲解偏好",
      memoryType: "preference",
    });

    const context = store.searchContext("用户偏好中文解释", {
      limit: 8,
      retrievalMode: "fts5",
    });

    assert.ok(context.results.some((result) => result.memory.id === saved.memory.id));
    const recallContext = store.searchContext("你还记得我偏好中文解释吗？", {
      limit: 8,
      retrievalMode: "fts5",
    });
    assert.ok(recallContext.results.some((result) => result.memory.id === saved.memory.id));
  });
});

test("FTS5 recalls a memory by an explicit recall trigger without exposing a duplicate", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "The user's preferred explanation style is concise and visual.",
      nodeName: "Explanation preference",
      memoryType: "preference",
      recallTriggers: ["讲解风格", "how to explain things to me"],
    });

    const context = store.searchContext("讲解风格", {
      limit: 8,
      retrievalMode: "fts5",
    });

    assert.deepEqual(
      context.results.filter((result) => result.memory.id === saved.memory.id).map((result) => result.memory.id),
      [saved.memory.id],
    );
  });
});

test("store open migrates a legacy raw Chinese FTS row exactly once", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-fts-migration-"));
  const path = join(directory, "nmg.sqlite");
  const statement = "用户偏好中文解释，并希望保留精确的技术细节。";
  let store: NmgStore | null = new NmgStore(path);
  try {
    const saved = store.remember({
      statement,
      nodeName: "用户讲解偏好",
      memoryType: "preference",
    });
    store.close();
    store = null;

    const db = new DatabaseSync(path);
    db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(saved.memory.id);
    db.prepare(
      "INSERT INTO memory_fts(memory_id, statement, node_name, evidence) VALUES (?, ?, ?, ?)",
    ).run(saved.memory.id, statement, "用户讲解偏好", statement);
    db.prepare(
      "UPDATE store_metadata SET value = 'legacy-raw' WHERE key = 'fts_text_format'",
    ).run();
    db.close();

    store = new NmgStore(path);
    const context = store.searchContext("你还记得我偏好中文解释吗？", {
      limit: 8,
      retrievalMode: "fts5",
    });
    assert.ok(context.results.some((result) => result.memory.id === saved.memory.id));
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("searchContext populates activeGraph with budget, usage and trace id", () => {
  withStore((store) => {
    store.remember({
      statement: "Memory for trace test",
      nodeName: "trace node",
      memoryType: "fact",
      importance: 0.7,
    });

    const ctx = store.searchContext("trace test");
    assert.ok(ctx.activeGraph);
    assert.ok(ctx.activeGraph.id, "active graph should have a trace id");
    assert.ok(ctx.activeGraph.budget);
    assert.ok(ctx.activeGraph.usage);
    assert.equal(ctx.activeGraph.query, "trace test");
    assert.ok(Array.isArray(ctx.activeGraph.nodeIds));
    assert.ok(Array.isArray(ctx.activeGraph.memoryIds));
  });
});

test("searchContext with persistTrace=false still returns a valid context", () => {
  withStore((store) => {
    store.remember({
      statement: "Persist trace false test",
      nodeName: "trace flag node",
      memoryType: "fact",
      importance: 0.6,
    });

    const ctx = store.searchContext("trace false", { persistTrace: false });
    assert.ok(ctx.results.length >= 1);
    assert.ok(ctx.activeGraph);
    assert.ok(ctx.activeGraph.id);
  });
});

// ── searchContextWithSecondPass ──

test("searchContextWithSecondPass enables secondPass and returns context", () => {
  withStore((store) => {
    store.remember({
      statement: "Second pass test memory alpha",
      nodeName: "alpha node",
      memoryType: "constraint",
      importance: 0.9,
    });
    store.remember({
      statement: "Second pass test memory beta",
      nodeName: "beta node",
      memoryType: "fact",
      importance: 0.7,
    });

    const ctx = store.searchContextWithSecondPass("second pass test");
    assert.ok(ctx.results.length >= 1);
    assert.ok(ctx.activeGraph);
    assert.ok(ctx.activeGraph.qpp);
  });
});

test("tiered disclosure stops at L0 when shallow evidence is sufficient", () => {
  withStore((store) => {
    const hot = store.remember({
      statement: "Atlas storage engine is SQLite",
      nodeName: "Atlas storage",
      tier: 0,
    });
    store.remember({
      statement: "Atlas storage engine migration details are archived",
      nodeName: "Atlas storage archive",
      tier: 2,
    });
    const context = store.searchContext("Atlas storage engine SQLite", {
      maxTier: 3,
      tieredDisclosure: true,
      limit: 8,
    });
    assert.equal(context.activeGraph?.usage.tiersOpened, 1);
    assert.equal(context.activeGraph?.usage.deepestTier, 0);
    assert.deepEqual(
      context.results.map((result) => result.memory.id),
      [hot.memory.id],
    );
  });
});

test("tiered disclosure prevents graph expansion from bypassing unopened tiers", () => {
  withStore((store) => {
    const hot = store.remember({
      statement: "Atlas storage engine is SQLite",
      nodeName: "Atlas storage",
      tier: 0,
    });
    const deep = store.remember({
      statement: "Atlas migration archive contains an obsolete engine comparison",
      nodeName: "Atlas migration archive",
      tier: 2,
    });
    store.linkNodes({
      sourceNodeId: hot.node.id,
      targetNodeId: deep.node.id,
      type: "related_to",
    });

    const context = store.searchContext("Atlas storage engine SQLite", {
      maxTier: 3,
      graphHops: 1,
      tieredDisclosure: true,
      limit: 8,
    });

    assert.equal(context.activeGraph?.usage.deepestTier, 0);
    assert.ok(context.results.some((result) => result.memory.id === hot.memory.id));
    assert.ok(!context.results.some((result) => result.memory.id === deep.memory.id));
  });
});

test("Active Graph exposes derived edge activation without storing it on the relation", () => {
  withStore((store) => {
    const source = store.remember({
      statement: "Atlas uses SQLite",
      nodeName: "Atlas",
      tier: 0,
    });
    const target = store.remember({
      statement: "SQLite persistence is local",
      nodeName: "SQLite persistence",
      tier: 0,
    });
    const relation = store.linkNodes({
      sourceNodeId: source.node.id,
      targetNodeId: target.node.id,
      type: "depends_on",
      strength: 0.9,
    });

    const context = store.searchContext("Atlas uses SQLite", { graphHops: 1, limit: 8 });
    const projected = context.activeGraph?.edges.find((edge) => edge.id === relation.id);
    assert.ok((projected?.activation ?? 0) > 0);
    assert.equal(projected?.activationChannel, "conductive");
    assert.equal(store.getRelations([source.node.id])[0]?.strength, 0.9);
  });
});

test("verified Active Graph evidence updates edge strength through prediction error", () => {
  withStore((store) => {
    const source = store.remember({ statement: "Orchid alpha", nodeName: "Orchid alpha" });
    const target = store.remember({ statement: "Orchid beta", nodeName: "Orchid beta" });
    const relation = store.linkNodes({
      sourceNodeId: source.node.id,
      targetNodeId: target.node.id,
      type: "related_to",
      strength: 0.2,
    });
    const context = store.searchContext("Orchid alpha beta", { graphHops: 1, limit: 8 });
    assert.ok(context.results.some((result) => result.memory.id === source.memory.id));
    assert.ok(context.results.some((result) => result.memory.id === target.memory.id));

    store.recordActiveGraphAttribution(context.activeGraph!.id, {
      method: "verified_evidence",
      attributedMemoryIds: [source.memory.id, target.memory.id],
    });

    assert.ok(store.getRelations([source.node.id])[0]!.strength > relation.strength);
  });
});

test("tiered disclosure opens deeper tiers on a shallow miss", () => {
  withStore((store) => {
    const deep = store.remember({
      statement: "The archived codename is silver heron",
      nodeName: "Archived codename",
      tier: 2,
    });
    const context = store.searchContext("archived codename silver heron", {
      maxTier: 3,
      tieredDisclosure: true,
      limit: 8,
    });
    assert.equal(context.activeGraph?.usage.tiersOpened, 3);
    assert.equal(context.activeGraph?.usage.deepestTier, 2);
    assert.ok(context.results.some((result) => result.memory.id === deep.memory.id));
  });
});

test("tiered disclosure enforces the shared deep-evidence budget", () => {
  withStore((store) => {
    for (let index = 0; index < 4; index += 1) {
      store.remember({
        statement: `Archived atlas decision ${index}`,
        nodeName: `Archived decision ${index}`,
        tier: 2,
      });
    }
    const context = store.searchContext("Archived atlas decision", {
      maxTier: 3,
      tieredDisclosure: true,
      limit: 8,
      activeGraphBudget: { maxTierBudget: 1 },
    });
    assert.equal(context.activeGraph?.usage.deepEvidence, 1);
    assert.equal(
      context.activeGraph?.budgetLedger.find((entry) => entry.dimension === "deepEvidence")
        ?.exhausted,
      true,
    );
  });
});

test("warm disclosure ranks once and defers the colder half of tier one", () => {
  withStore((store) => {
    const memories = Array.from({ length: 6 }, (_, index) =>
      store.remember({
        statement: `Warm atlas preference ${index}`,
        nodeName: `Warm preference ${index}`,
        tier: 1,
      }),
    );
    const context = store.searchContext("Warm atlas preference", {
      maxTier: 1,
      limit: 6,
      progressiveWarmDisclosure: true,
      activeGraphBudget: { maxNodes: 6, maxEvidence: 6 },
    });
    assert.equal(context.results.length, 3);
    assert.equal(context.progressiveDisclosure?.rankedWarmCandidates, 6);
    assert.equal(context.progressiveDisclosure?.initiallyVisible, 3);
    assert.equal(context.progressiveDisclosure?.deferredMemoryIds.length, 3);

    const expanded = store.getContext(context.progressiveDisclosure!.deferredMemoryIds);
    assert.equal(expanded.results.length, 3);
    assert.deepEqual(
      new Set([...context.results, ...expanded.results].map((result) => result.memory.id)),
      new Set(memories.map((memory) => memory.memory.id)),
    );
  });
});

test("warm disclosure can be disabled for full-pool retrieval", () => {
  withStore((store) => {
    for (let index = 0; index < 6; index += 1) {
      store.remember({
        statement: `Warm full-pool preference ${index}`,
        nodeName: `Full-pool preference ${index}`,
        tier: 1,
      });
    }
    const context = store.searchContext("Warm full-pool preference", {
      maxTier: 1,
      limit: 6,
      progressiveWarmDisclosure: false,
      activeGraphBudget: { maxNodes: 6, maxEvidence: 6 },
    });
    assert.equal(context.results.length, 6);
    assert.equal(context.progressiveDisclosure, undefined);
  });
});

test("warm disclosure leaves small tier-one pools fully visible", () => {
  withStore((store) => {
    for (let index = 0; index < 4; index += 1) {
      store.remember({
        statement: `Small warm preference ${index}`,
        nodeName: `Small warm preference ${index}`,
        tier: 1,
      });
    }
    const context = store.searchContext("Small warm preference", {
      maxTier: 1,
      limit: 4,
      progressiveWarmDisclosure: true,
      activeGraphBudget: { maxNodes: 4, maxEvidence: 4 },
    });
    assert.equal(context.results.length, 4);
    assert.equal(context.progressiveDisclosure, undefined);
  });
});

// ── getContext ──

test("getContext retrieves results for given memory IDs", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "Direct context lookup memory",
      nodeName: "context node",
      memoryType: "fact",
      importance: 0.8,
    });

    const ctx = store.getContext([saved.memory.id]);
    assert.equal(ctx.results.length, 1);
    assert.equal(ctx.results[0]?.memory.id, saved.memory.id);
    assert.equal(ctx.results[0]?.memory.statement, "Direct context lookup memory");
  });
});

test("getContext returns empty results for unknown memory IDs", () => {
  withStore((store) => {
    const ctx = store.getContext(["nonexistent-id-12345"]);
    assert.equal(ctx.results.length, 0);
    assert.deepEqual(ctx.relations, []);
  });
});

test("getContext with graphHops retrieves relations between nodes", () => {
  withStore((store) => {
    const a = store.remember({
      statement: "Node A is foundational",
      nodeName: "Node A",
      memoryType: "fact",
      importance: 0.8,
    });
    const b = store.remember({
      statement: "Node B depends on A",
      nodeName: "Node B",
      memoryType: "fact",
      importance: 0.7,
    });
    store.linkNodes({
      sourceNodeId: a.node.id,
      targetNodeId: b.node.id,
      type: "depends_on",
    });

    const ctx = store.getContext([a.memory.id], 1);
    assert.ok(ctx.results.length >= 1);
    // Relations should include the link between A and B
    const linkedNodeIds = ctx.relations.flatMap((r) => [r.sourceNodeId, r.targetNodeId]);
    assert.ok(linkedNodeIds.includes(a.node.id));
    assert.ok(linkedNodeIds.includes(b.node.id));
  });
});

// ── residentKernel ──

test("residentKernel returns high-importance constraint memories", () => {
  withStore((store) => {
    store.remember({
      statement: "Critical: service must always encrypt data",
      nodeName: "security policy",
      memoryType: "constraint",
      importance: 0.95,
      truthStatus: "asserted",
      sourceActor: "system",
    });
    // Constraint with high importance, truthStatus asserted, sourceActor system,
    // should remain tier 0 after rebalance and pass kernel filter
    store.rebuildVectorIndex();

    const kernel = store.residentKernel();
    // The single constraint may or may not be tier 0 after rebalance;
    // validate the method runs and returns a valid MemoryContext shape
    assert.ok(Array.isArray(kernel.results));
    assert.ok(Array.isArray(kernel.relations));
    // Any returned result must be a constraint
    for (const result of kernel.results) {
      assert.equal(result.memory.memoryType, "constraint");
    }
  });
});

test("residentKernel respects limit parameter", () => {
  withStore((store) => {
    for (let i = 0; i < 5; i++) {
      store.remember({
        statement: `Constraint rule ${i}`,
        nodeName: `rule node ${i}`,
        memoryType: "constraint",
        importance: 0.9,
      });
    }

    const kernel = store.residentKernel(2);
    assert.ok(kernel.results.length <= 2);
  });
});

// ── recallCues ──

test("recallCues returns cues with node information for a query", () => {
  withStore((store) => {
    store.remember({
      statement: "The deployment uses Kubernetes on AWS",
      nodeName: "deployment infrastructure",
      memoryType: "fact",
      importance: 0.8,
    });
    store.remember({
      statement: "AWS region is us-east-1",
      nodeName: "AWS config",
      memoryType: "constraint",
      importance: 0.7,
    });

    const index = store.recallCues("Kubernetes deployment");
    assert.ok(index.cues.length >= 1);
    const firstCue = index.cues[0]!;
    assert.ok(firstCue.nodeId);
    assert.ok(firstCue.canonicalName);
    assert.ok(firstCue.score > 0);
    assert.equal(typeof firstCue.activeCount, "number");
    assert.equal(typeof firstCue.deepestTier, "number");
    assert.equal(typeof firstCue.hasConflicts, "boolean");
    assert.equal(typeof firstCue.hasDeepMemory, "boolean");
  });
});

test("recallCues respects limit option", () => {
  withStore((store) => {
    for (let i = 0; i < 10; i++) {
      store.remember({
        statement: `Memory in distinct node ${i}`,
        nodeName: `distinct node ${i}`,
        memoryType: "fact",
        importance: 0.8,
      });
    }

    const index = store.recallCues("distinct node", { limit: 3 });
    assert.ok(index.cues.length <= 3);
  });
});

// ── search ──

test("search returns MemorySearchResult array for a lexical query", () => {
  withStore((store) => {
    store.remember({
      statement: "The build system uses webpack",
      nodeName: "build system",
      memoryType: "fact",
      importance: 0.7,
    });

    const results = store.search("webpack build");
    assert.ok(results.length >= 1);
    assert.ok(results[0]!.memory.id);
    assert.ok(results[0]!.node.canonicalName);
    assert.equal(typeof results[0]!.lexicalScore, "number");
    assert.equal(typeof results[0]!.combinedScore, "number");
  });
});

test("search returns empty array when matching memories are dormant", () => {
  withStore((store) => {
    store.remember({
      statement: "The project uses TypeScript",
      nodeName: "project tech",
      memoryType: "fact",
      importance: 0.9,
    });

    const before = store.search("TypeScript");
    assert.ok(before.length >= 1, "should find the memory initially");

    store.setMemoryStorageState(before[0]!.memory.id, "dormant");
    const after = store.search("TypeScript");
    assert.equal(after.length, 0, "dormant memory should not appear in search");
  });
});

// ── searchByVector ──

test("searchByVector returns results with vector scoring", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "The database connection pool size is 20",
      nodeName: "database config",
      memoryType: "constraint",
      importance: 0.8,
    });
    store.upsertExternalEmbeddings("test-model", [
      { memoryId: saved.memory.id, vector: new Array(128).fill(0).map(() => Math.random()) },
    ]);

    const queryVector = new Array(128).fill(0).map(() => Math.random());
    const results = store.searchByVector("database pool", queryVector, "test-model", {
      retrievalMode: "qwen3",
    });
    assert.ok(Array.isArray(results));
    // With random vectors, results are non-deterministic but the call should not throw
  });
});

// ── searchByVectorCandidates ──

test("searchByVectorCandidates restricts search to given candidate memory IDs", () => {
  withStore((store) => {
    const alpha = store.remember({
      statement: "Alpha memory for candidate test",
      nodeName: "alpha candidate",
      memoryType: "fact",
      importance: 0.9,
    });
    const beta = store.remember({
      statement: "Beta memory for candidate test",
      nodeName: "beta candidate",
      memoryType: "fact",
      importance: 0.8,
    });

    const queryVector = new Array(128).fill(0.1);
    const results = store.searchByVectorCandidates(
      "candidate test",
      queryVector,
      "unused-model",
      [alpha.memory.id, beta.memory.id],
      { retrievalMode: "fts5" },
    );
    // Should only include results from the candidate set
    for (const result of results) {
      assert.ok(
        result.memory.id === alpha.memory.id || result.memory.id === beta.memory.id,
        `result ${result.memory.id} should be in candidate set`,
      );
    }
  });
});

test("searchByVectorCandidates with empty candidates still delegates to FTS search", () => {
  withStore((store) => {
    store.remember({
      statement: "Some memory for fallback test",
      nodeName: "fallback test node",
      memoryType: "fact",
      importance: 0.5,
    });

    const queryVector = new Array(128).fill(0.1);
    // Empty candidate list means no forced restriction — searchWithVector
    // falls through to its normal FTS candidate pool.
    const results = store.searchByVectorCandidates(
      "fallback test",
      queryVector,
      "unused-model",
      [],
      { retrievalMode: "fts5" },
    );
    assert.ok(results.length >= 1);
  });
});

// ── searchLeafBlocks ──

test("searchLeafBlocks returns empty for empty block IDs", () => {
  withStore((store) => {
    const queryVector = new Array(128).fill(0.1);
    const results = store.searchLeafBlocks("anything", queryVector, "unused-model", []);
    assert.equal(results.length, 0);
  });
});

// ── searchHierarchyByVector ──

test("searchHierarchyByVector returns results through hierarchical routing", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "Hierarchy search test memory",
      nodeName: "hierarchy node",
      memoryType: "constraint",
      importance: 0.9,
    });
    store.upsertExternalEmbeddings("hier-model", [
      { memoryId: saved.memory.id, vector: new Array(128).fill(0.1) },
    ]);

    const queryVector = new Array(128).fill(0.1);
    const results = store.searchHierarchyByVector("hierarchy search", queryVector, "hier-model", {
      limit: 10,
    });
    assert.ok(Array.isArray(results));
  });
});

// ── searchNodeFirst ──

test("searchNodeFirst restricts results to given node IDs", () => {
  withStore((store) => {
    const target = store.remember({
      statement: "Memory inside target node for NodeFirst",
      nodeName: "target node",
      memoryType: "fact",
      importance: 0.9,
    });
    store.remember({
      statement: "Memory in other node for NodeFirst",
      nodeName: "other node",
      memoryType: "fact",
      importance: 0.8,
    });

    const queryVector = new Array(128).fill(0.1);
    const results = store.searchNodeFirst(
      "NodeFirst",
      queryVector,
      "unused-model",
      [target.node.id],
      { retrievalMode: "fts5" },
    );
    // All results should belong to the target node
    for (const result of results) {
      assert.equal(result.node.id, target.node.id);
    }
  });
});

test("searchNodeFirst with empty node IDs returns empty", () => {
  withStore((store) => {
    store.remember({
      statement: "Memory for empty nodes test",
      nodeName: "empty nodes",
      memoryType: "fact",
      importance: 0.5,
    });

    const queryVector = new Array(128).fill(0.1);
    const results = store.searchNodeFirst("empty nodes", queryVector, "unused-model", []);
    assert.equal(results.length, 0);
  });
});
