import assert from "node:assert/strict";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import { searchMemoryContext } from "../../src/integration/search.ts";
import type { MemoryContext } from "../../src/core/types.ts";

function assertSelection(store: NmgStore, context: MemoryContext, targetId: string): void {
  assert.deepEqual(
    context.results.map((result) => result.memory.id),
    [targetId],
  );
  const graph = context.activeGraph;
  assert.ok(graph);
  assert.deepEqual(graph.memoryIds, [targetId]);
  assert.deepEqual(
    graph.selections.map((selection) => selection.memoryId),
    graph.memoryIds,
  );
  const trace = store.retrievalTrace(graph.id);
  assert.deepEqual(trace?.resultMemoryIds, graph.memoryIds);
  assert.deepEqual(
    trace?.selections?.map((selection) => selection.memoryId),
    graph.memoryIds,
  );
  assert.equal(graph.usage.evidence, 1);
  assert.ok(graph.usage.estimatedTokens <= graph.budget.maxTokens);
}

for (const degraded of [false, true]) {
  test(`shared lexical entry ranks before the budget (${degraded ? "provider failure" : "no provider"})`, async () => {
    const store = new NmgStore(":memory:");
    try {
      store.remember({
        statement: "The store uses WAL",
        nodeName: "Atlas SQLite",
        importance: 1,
      });
      const target = store.remember({
        statement: "Atlas SQLite stores project data",
        nodeName: "Database choice",
        importance: 0.5,
      });
      store.beginEmbeddingIndex({
        indexId: "local-budget-fixture",
        model: "local-budget-fixture",
        profile: "test",
        targets: ["records"],
      });
      store.upsertExternalEmbeddings("local-budget-fixture", [
        { memoryId: target.memory.id, vector: [1, 0] },
      ]);
      store.completeEmbeddingIndex("local-budget-fixture");
      let embeddingCalls = 0;
      const client = degraded
        ? {
            indexId: "local-budget-fixture",
            embedQueries: async () => {
              embeddingCalls++;
              throw new Error("simulated provider unavailable");
            },
          }
        : undefined;
      const context = await searchMemoryContext(store, client, "Atlas SQLite", {
        limit: 1,
        graphHops: 0,
      });
      assertSelection(store, context, target.memory.id);
      assert.deepEqual(
        context.retrieval,
        degraded
          ? { mode: "lexical", degraded: true, reason: "embedding_unavailable" }
          : { mode: "lexical", degraded: false },
      );
      assert.equal(embeddingCalls, degraded ? 1 : 0);
    } finally {
      store.close();
    }
  });
}
