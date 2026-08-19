import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NmgStore } from "../../src/core/store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "comm-"));
  const store = new NmgStore(join(dir, "nmg.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(dir, { force: true, recursive: true });
  }
}

function node(store: NmgStore, name: string) {
  return store.remember({
    nodeName: name,
    nodeKind: "topic",
    nodeSummary: name,
    statement: `${name}内容`,
    sessionId: "s1",
    sourceActor: "user",
  });
}

test("detectCommunities finds weakly-connected components and drops isolates", () => {
  withStore((store) => {
    const a = node(store, "甲");
    const b = node(store, "乙");
    const c = node(store, "丙");
    const d = node(store, "丁");
    store.linkNodes({ sourceNodeId: a.node.id, targetNodeId: b.node.id, type: "causes" });
    store.linkNodes({ sourceNodeId: b.node.id, targetNodeId: c.node.id, type: "causes" });
    store.linkNodes({ sourceNodeId: d.node.id, targetNodeId: a.node.id, type: "causes" });
    node(store, "孤立"); // no relations → excluded
    const communities = store.detectCommunities();
    assert.equal(communities.length, 1, "one connected community");
    assert.equal(communities[0]!.length, 4, "all four related nodes grouped");
    const expected = new Set([a.node.id, b.node.id, c.node.id, d.node.id]);
    assert.ok(
      communities[0]!.every((id) => expected.has(id)),
      "community is exactly the four connected nodes",
    );
  });
});

test("analyzeCommunities profiles patterns and emits natural-supervision suggestions", () => {
  withStore((store) => {
    // Community 1: evolution + dependency.
    const b1 = store.remember({ nodeName: "预算", nodeKind: "topic", nodeSummary: "预算", statement: "预算v2023", sessionId: "s1", sourceActor: "user" });
    const b2 = store.remember({ nodeName: "预算", nodeKind: "topic", nodeSummary: "预算", statement: "预算v2024", sessionId: "s1", sourceActor: "user", supersedesId: b1.memory.id });
    const tech = node(store, "技术选型");
    const ops = node(store, "运维");
    store.linkNodes({ sourceNodeId: b2.node.id, targetNodeId: tech.node.id, type: "depends_on" });
    store.linkNodes({ sourceNodeId: tech.node.id, targetNodeId: ops.node.id, type: "depends_on" });
    // Community 2: contradiction pair.
    const va = node(store, "观点甲");
    const vb = node(store, "观点乙");
    store.linkNodes({ sourceNodeId: va.node.id, targetNodeId: vb.node.id, type: "contradicts" });
    store.linkNodes({ sourceNodeId: vb.node.id, targetNodeId: va.node.id, type: "contradicts" });

    const analysis = store.analyzeCommunities();
    assert.equal(analysis.length, 2, "two communities");
    const c0 = analysis.find((c) => c.patternCounts.EVOLUTION > 0);
    const c1 = analysis.find((c) => c.patternCounts.CONTRADICTION > 0);
    assert.ok(c0, "evolution community found");
    assert.ok(c0!.suggestions.some((s) => s.kind === "EVOLUTION_CHAIN"), "evolution suggestion");
    assert.ok(c0!.suggestions.some((s) => s.kind === "DEPENDENCY_CHAIN"), "dependency suggestion");
    assert.ok(c1, "contradiction community found");
    assert.ok(c1!.suggestions.some((s) => s.kind === "CONTRADICTION_PAIR"), "contradiction suggestion");
  });
});

test("analyzeCommunities flags a feedback loop for manual review", () => {
  withStore((store) => {
    const x = node(store, "子系统X");
    const y = node(store, "子系统Y");
    store.linkNodes({ sourceNodeId: x.node.id, targetNodeId: y.node.id, type: "causes" });
    store.linkNodes({ sourceNodeId: y.node.id, targetNodeId: x.node.id, type: "causes" });
    const analysis = store.analyzeCommunities();
    assert.equal(analysis.length, 1);
    assert.equal(analysis[0]!.patternCounts.FEEDBACK, 1);
    assert.ok(analysis[0]!.suggestions.some((s) => s.kind === "FEEDBACK_REVIEW"), "feedback review suggestion");
  });
});
