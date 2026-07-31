import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-graph-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

// ── linkNodes ──

test("linkNodes creates new relation and is idempotent on re-link", () => {
  withStore((store) => {
    const a = store.remember({
      statement: "Atlas uses SQLite",
      nodeName: "Atlas storage",
      memoryType: "constraint",
    });
    const b = store.remember({
      statement: "NMG indexes memory",
      nodeName: "NMG engine",
      memoryType: "fact",
    });
    const rel = store.linkNodes({
      sourceNodeId: a.node.id,
      targetNodeId: b.node.id,
      type: "depends_on",
    });
    assert.equal(rel.sourceNodeId, a.node.id);
    assert.equal(rel.targetNodeId, b.node.id);
    assert.equal(rel.type, "depends_on");
    assert.equal(rel.status, "consolidated");
    assert.ok(rel.evidenceIds.length >= 0);

    // Idempotent: same call returns the same relation id.
    const rel2 = store.linkNodes({
      sourceNodeId: a.node.id,
      targetNodeId: b.node.id,
      type: "depends_on",
    });
    assert.equal(rel2.id, rel.id);
  });
});

test("linkNodes merges evidenceIds on existing relation", () => {
  withStore((store) => {
    const a = store.remember({
      statement: "A is true",
      nodeName: "node A",
      memoryType: "fact",
    });
    const b = store.remember({
      statement: "B is true",
      nodeName: "node B",
      memoryType: "fact",
    });
    const rel1 = store.linkNodes({
      sourceNodeId: a.node.id,
      targetNodeId: b.node.id,
      type: "related_to",
      evidenceIds: ["ev-1"],
    });
    const rel2 = store.linkNodes({
      sourceNodeId: a.node.id,
      targetNodeId: b.node.id,
      type: "related_to",
      evidenceIds: ["ev-2"],
    });
    assert.equal(rel1.id, rel2.id);
    assert.deepEqual([...rel2.evidenceIds].sort(), ["ev-1", "ev-2"]);
  });
});

// ── getRelations ──

test("getRelations finds relations for given node ids", () => {
  withStore((store) => {
    const a = store.remember({
      statement: "alpha",
      nodeName: "alpha node",
      memoryType: "fact",
    });
    const b = store.remember({
      statement: "beta",
      nodeName: "beta node",
      memoryType: "fact",
    });
    store.linkNodes({
      sourceNodeId: a.node.id,
      targetNodeId: b.node.id,
      type: "related_to",
    });
    const rels = store.getRelations([a.node.id]);
    assert.equal(rels.length, 1);
    assert.equal(rels[0]!.sourceNodeId, a.node.id);
    assert.equal(rels[0]!.targetNodeId, b.node.id);
  });
});

test("getRelations with maxHops=2 traverses two-hop neighbourhood", () => {
  withStore((store) => {
    const a = store.remember({
      statement: "a",
      nodeName: "A",
      memoryType: "fact",
    });
    const b = store.remember({
      statement: "b",
      nodeName: "B",
      memoryType: "fact",
    });
    const c = store.remember({
      statement: "c",
      nodeName: "C",
      memoryType: "fact",
    });
    store.linkNodes({ sourceNodeId: a.node.id, targetNodeId: b.node.id, type: "related_to" });
    store.linkNodes({ sourceNodeId: b.node.id, targetNodeId: c.node.id, type: "related_to" });
    const rels = store.getRelations([a.node.id], 2);
    assert.equal(rels.length, 2);
    const ids = new Set(rels.flatMap((r) => [r.sourceNodeId, r.targetNodeId]));
    assert.ok(ids.has(a.node.id));
    assert.ok(ids.has(b.node.id));
    assert.ok(ids.has(c.node.id));
  });
});

// ── mergeNodes ──

test("mergeNodes merges two nodes and moves memories to target", () => {
  withStore((store) => {
    const src1 = store.remember({
      statement: "src1 memory",
      nodeName: "source one",
      memoryType: "fact",
    });
    const src2 = store.remember({
      statement: "src2 memory",
      nodeName: "source two",
      memoryType: "fact",
    });
    const transform = store.mergeNodes({
      sourceNodeIds: [src1.node.id, src2.node.id],
      targetName: "merged target",
    });
    assert.equal(transform.type, "merge");
    assert.deepEqual([...transform.sourceNodeIds].sort(), [src1.node.id, src2.node.id].sort());
    assert.equal(transform.movedMemoryIds.length, 2);

    // Verify memories now belong to the target node.
    const ctx = store.getContext([src1.memory.id, src2.memory.id]);
    for (const result of ctx.results) {
      assert.equal(result.node.id, transform.targetNodeIds[0]!);
    }
  });
});

test("mergeNodes throws when given fewer than two source nodes", () => {
  withStore((store) => {
    const src = store.remember({
      statement: "only one",
      nodeName: "solo node",
      memoryType: "fact",
    });
    assert.throws(
      () =>
        store.mergeNodes({
          sourceNodeIds: [src.node.id],
          targetName: "should fail",
        }),
      /merge requires at least two nodes/,
    );
  });
});

// ── splitNode ──

test("splitNode partitions source memories into distinct target nodes", () => {
  withStore((store) => {
    const src = store.remember({
      statement: "memory one in source",
      nodeName: "source node",
      memoryType: "fact",
    });
    const src2 = store.remember({
      statement: "memory two in source",
      nodeName: "source node", // same node name, same node
      memoryType: "fact",
    });
    const transform = store.splitNode({
      sourceNodeId: src.node.id,
      partitions: [
        { nodeName: "target A", memoryIds: [src.memory.id] },
        { nodeName: "target B", memoryIds: [src2.memory.id] },
      ],
    });
    assert.equal(transform.type, "split");
    assert.equal(transform.targetNodeIds.length, 2);
    assert.deepEqual([...transform.movedMemoryIds].sort(), [src.memory.id, src2.memory.id].sort());

    // Source node should now be marked 'split'.
    const ctx = store.getContext([src.memory.id]);
    assert.equal(ctx.results[0]!.node.status, "active"); // memory now belongs to a new active node
  });
});

test("splitNode throws when source node does not exist", () => {
  withStore((store) => {
    assert.throws(
      () =>
        store.splitNode({
          sourceNodeId: "nonexistent-node-id",
          partitions: [
            { nodeName: "A", memoryIds: ["fake-memory"] },
            { nodeName: "B", memoryIds: ["fake-memory-2"] },
          ],
        }),
      /node .* does not exist/,
    );
  });
});

// ── getNodeTransform ──

test("getNodeTransform returns null for unknown id and the transform for known id", () => {
  withStore((store) => {
    assert.equal(store.getNodeTransform("nonexistent"), null);

    const a = store.remember({
      statement: "a fact",
      nodeName: "node A",
      memoryType: "fact",
    });
    const b = store.remember({
      statement: "b fact",
      nodeName: "node B",
      memoryType: "fact",
    });
    const transform = store.mergeNodes({
      sourceNodeIds: [a.node.id, b.node.id],
      targetName: "merged AB",
    });
    const fetched = store.getNodeTransform(transform.id);
    assert.ok(fetched);
    assert.equal(fetched!.type, "merge");
    assert.equal(fetched!.id, transform.id);
  });
});

// ── routeNodes ──

test("routeNodes returns scored routes for active nodes", () => {
  withStore((store) => {
    store.remember({
      statement: "Atlas uses SQLite",
      nodeName: "Atlas storage",
      memoryType: "constraint",
    });
    const routes = store.routeNodes("Atlas storage");
    assert.ok(routes.length > 0);
    for (const route of routes) {
      assert.ok(route.score > 0);
      assert.equal(route.node.status, "active");
    }
  });
});

// ── routeNodesByVector ──

test("routeNodesByVector throws when model is empty", () => {
  withStore((store) => {
    assert.throws(() => store.routeNodesByVector([0.1, 0.2], "  "), /embedding model is required/);
  });
});

test("routeNodesByVector throws when query vector is empty", () => {
  withStore((store) => {
    assert.throws(() => store.routeNodesByVector([], "test-model"), /query vector is required/);
  });
});

test("routeNodesByVector returns empty when no node embeddings exist for the model", () => {
  withStore((store) => {
    store.remember({
      statement: "Atlas uses SQLite",
      nodeName: "Atlas storage",
      memoryType: "constraint",
    });
    const routes = store.routeNodesByVector([0.1, 0.2, 0.3], "unused-model");
    assert.equal(routes.length, 0);
  });
});

// ── trainRouter ──

test("trainRouter updates router weights for useful nodes", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "Atlas uses SQLite",
      nodeName: "Atlas storage",
      memoryType: "constraint",
    });
    // Should not throw.
    store.trainRouter("Atlas storage", [saved.node.id], 0.2);
  });
});

// ── edgeStability ──

test("edgeStability returns zero score when no task observations exist", () => {
  withStore((store) => {
    const stability = store.edgeStability("node-x", "node-y");
    assert.equal(stability.independentTasks, 0);
    assert.equal(stability.usefulTasks, 0);
    assert.equal(stability.contradictedTasks, 0);
    assert.equal(stability.score, 0);
    // left/right are sorted
    assert.ok(stability.leftNodeId <= stability.rightNodeId);
  });
});

// ── nodeActivation / relationActivation ──

test("nodeActivation returns zero score when the node has no signal row", () => {
  withStore((store) => {
    const signal = store.nodeActivation("nonexistent-node");
    assert.equal(signal.selectedCount, 0);
    assert.equal(signal.score, 0);
  });
});

test("relationActivation returns zero score when the relation has no signal row", () => {
  withStore((store) => {
    const signal = store.relationActivation("nonexistent-relation");
    assert.equal(signal.selectedCount, 0);
    assert.equal(signal.score, 0);
  });
});

// ── consolidate ──

test("reconcileConsolidation returns empty results when no edge observations exist", () => {
  withStore((store) => {
    const result = store.reconcileConsolidation();
    assert.deepEqual(result.consolidatedRelations, []);
    assert.deepEqual(result.demotedRelations, []);
    assert.deepEqual(result.events, []);
  });
});

test("consolidationEvents returns empty list on a fresh store", () => {
  withStore((store) => {
    const events = store.consolidationEvents();
    assert.deepEqual(events, []);
  });
});

// ── topology proposals ──

test("proposeTopologyChanges returns empty list when no signals exist", () => {
  withStore((store) => {
    const proposals = store.proposeTopologyChanges();
    assert.deepEqual(proposals, []);
  });
});

test("topologyProposals returns empty list on a fresh store", () => {
  withStore((store) => {
    const proposals = store.topologyProposals();
    assert.deepEqual(proposals, []);
  });
});

test("reviewTopologyProposal throws for nonexistent proposal", () => {
  withStore((store) => {
    assert.throws(
      () => store.reviewTopologyProposal("nonexistent-id", "accept"),
      /topology proposal .* does not exist/,
    );
  });
});
