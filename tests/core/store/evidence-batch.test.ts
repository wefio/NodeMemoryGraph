import assert from "node:assert/strict";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";
import type { MemorySearchResult } from "../../../src/core/types.ts";

class EvidenceStore extends NmgStore {
  hydrate(results: MemorySearchResult[]): MemorySearchResult[] {
    return this.hydrateEvidence(results);
  }
  nodeResults(nodeId: string): MemorySearchResult[] {
    return this.resultsForNode(nodeId, 3, 20);
  }
  link(memoryId: string, historyId: string): void {
    this.db
      .prepare("INSERT INTO memory_evidence_links(memory_id, history_id) VALUES (?, ?)")
      .run(memoryId, historyId);
  }
  linkMissingHistory(memoryId: string): void {
    // Simulate an imported dangling link: keep the ID, omit its absent history.
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.link(memoryId, "missing-history");
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

test("direct and node retrieval retain sorted shared provenance without sharing mutable history objects", () => {
  const store = new EvidenceStore(":memory:");
  try {
    const first = store.remember({
      statement: "Batch provenance first",
      nodeName: "batch provenance",
      evidence: "First exact source",
    });
    const second = store.remember({
      statement: "Batch provenance second",
      nodeName: "batch provenance",
      evidence: "Second exact source",
    });
    store.link(first.memory.id, second.history.id);
    const expected = [first.history, second.history].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const results of [
      store.search("batch provenance", { maxTier: 3 }),
      store.nodeResults(first.node.id),
    ]) {
      const a = results.find((r) => r.memory.id === first.memory.id)!;
      const b = results.find((r) => r.memory.id === second.memory.id)!;
      assert.ok(a && b);
      assert.deepEqual(
        a.memory.evidenceIds,
        expected.map((h) => h.id),
      );
      assert.deepEqual(a.evidenceRecords, expected);
      assert.deepEqual(b.evidenceRecords, [second.history]);
      assert.notEqual(
        a.evidenceRecords.find((h) => h.id === second.history.id),
        b.evidenceRecords[0],
      );
      assert.equal(a.evidence.id, first.history.id);
    }
  } finally {
    store.close();
  }
});

test("batched hydration retains caller order, repeated records, absent histories and empty links across chunks", () => {
  const store = new EvidenceStore(":memory:");
  try {
    const memory = store.remember({
      statement: "Batch evidence",
      nodeName: "batch",
      evidence: "Exact source",
    });
    const original = store.nodeResults(memory.node.id)[0]!;
    store.linkMissingHistory(memory.memory.id);
    const empty = Array.from({ length: 400 }, (_, i) => ({
      ...structuredClone(original),
      memory: { ...original.memory, id: `absent-${i}` },
    }));
    const inputs = [...empty, structuredClone(original), structuredClone(original)];
    const results = store.hydrate(inputs);
    assert.equal(results, inputs);
    assert.equal(results.length, 402);
    assert.deepEqual(
      results.map((r) => r.memory.id),
      [...empty.map((r) => r.memory.id), memory.memory.id, memory.memory.id],
    );
    for (const result of results.slice(0, 400)) {
      assert.deepEqual(result.memory.evidenceIds, []);
      assert.deepEqual(result.evidenceRecords, []);
    }
    for (const result of results.slice(400)) {
      assert.deepEqual(result.memory.evidenceIds, [memory.history.id, "missing-history"].sort());
      assert.deepEqual(result.evidenceRecords, [memory.history]);
    }
    assert.notEqual(results[400]!.evidenceRecords[0], results[401]!.evidenceRecords[0]);
    assert.deepEqual(store.hydrate([]), []);
  } finally {
    store.close();
  }
});
