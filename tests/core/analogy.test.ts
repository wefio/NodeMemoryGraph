import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NmgStore } from "../../src/core/store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "anlg-"));
  const store = new NmgStore(join(dir, "nmg.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
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

test("abstractSubgraph extracts EVOLUTION from a supersede chain", () => {
  withStore((store) => {
    const v2022 = store.remember({ nodeName: "预算", nodeKind: "topic", nodeSummary: "预算", statement: "2022预算5000万", sessionId: "s1", sourceActor: "user", eventTime: "2022-01-01" });
    const v2023 = store.remember({ nodeName: "预算", nodeKind: "topic", nodeSummary: "预算", statement: "2023预算6500万", sessionId: "s1", sourceActor: "user", eventTime: "2023-01-01" });
    store.applySupersession({ newMemoryId: v2023.memory.id, supersededMemoryId: v2022.memory.id });
    const sig = store.abstractSubgraph([v2022.node.id, v2023.node.id]);
    assert.ok(sig.patternTypes.includes("EVOLUTION"));
    assert.equal(sig.patternCounts.EVOLUTION, 1);
  });
});

test("abstractSubgraph extracts all other pattern shapes from a mixed cluster", () => {
  withStore((store) => {
    const [t, a, b, c, d, p1, p2] = ["主题", "甲", "乙", "丙", "丁", "容器", "零件"].map((x) => node(store, x));
    store.linkNodes({ sourceNodeId: a.node.id, targetNodeId: b.node.id, type: "contradicts" });
    store.linkNodes({ sourceNodeId: b.node.id, targetNodeId: a.node.id, type: "contradicts" });
    store.linkNodes({ sourceNodeId: a.node.id, targetNodeId: b.node.id, type: "depends_on" });
    store.linkNodes({ sourceNodeId: b.node.id, targetNodeId: c.node.id, type: "depends_on" });
    store.linkNodes({ sourceNodeId: p1.node.id, targetNodeId: p2.node.id, type: "part_of" });
    store.linkNodes({ sourceNodeId: c.node.id, targetNodeId: d.node.id, type: "causes" });
    store.linkNodes({ sourceNodeId: d.node.id, targetNodeId: c.node.id, type: "causes" });
    const sig = store.abstractSubgraph([t.node.id, a.node.id, b.node.id, c.node.id, d.node.id, p1.node.id, p2.node.id]);
    // Bidirectional contradiction is one CONTRADICTION; the causes cycle is one FEEDBACK.
    assert.equal(sig.patternCounts.CONTRADICTION, 1);
    assert.equal(sig.patternCounts.DEPENDENCY, 4);
    assert.equal(sig.patternCounts.AGGREGATION, 1);
    assert.equal(sig.patternCounts.FEEDBACK, 1);
  });
});

test("findStructuralAnalogies matches same-structure, semantically different domains", () => {
  withStore((store) => {
    // Domain A: budget evolution.
    const b2022 = store.remember({ nodeName: "预算", nodeKind: "topic", nodeSummary: "预算", statement: "2022预算5000万", sessionId: "s1", sourceActor: "user" });
    const b2023 = store.remember({ nodeName: "预算", nodeKind: "topic", nodeSummary: "预算", statement: "2023预算6500万", sessionId: "s1", sourceActor: "user" });
    store.applySupersession({ newMemoryId: b2023.memory.id, supersededMemoryId: b2022.memory.id });
    // Domain B: tech-stack evolution (unrelated semantics, same structure).
    const s1 = store.remember({ nodeName: "技术选型", nodeKind: "topic", nodeSummary: "选型", statement: "选型v1用Postgres", sessionId: "s1", sourceActor: "user" });
    const s2 = store.remember({ nodeName: "技术选型", nodeKind: "topic", nodeSummary: "选型", statement: "选型v2迁TiDB", sessionId: "s1", sourceActor: "user" });
    store.applySupersession({ newMemoryId: s2.memory.id, supersededMemoryId: s1.memory.id });
    // Domain C: plain memory, no structure — must not match.
    store.remember({ nodeName: "产品", nodeKind: "topic", nodeSummary: "产品", statement: "产品有3个功能", sessionId: "s1", sourceActor: "user" });

    const analogies = store.findStructuralAnalogies([b2022.node.id, b2023.node.id], { maxCandidates: 5 });
    const hitTech = analogies.find((a) => a.targetNodeName === "技术选型");
    assert.ok(hitTech, "tech-stack matched as budget's analogy");
    assert.equal(hitTech!.score, 1);
    assert.ok(hitTech!.sharedPatterns.includes("EVOLUTION"));
    assert.ok(!analogies.some((a) => a.targetNodeName === "产品"), "no-structure domain excluded");

    // Symmetric: tech-stack finds budget.
    const back = store.findStructuralAnalogies([s1.node.id, s2.node.id], { maxCandidates: 5 });
    assert.ok(back.some((a) => a.targetNodeName === "预算"), "reverse analogy works");
  });
});

test("findStructuralAnalogies excludes nodes directly related to the query cluster", () => {
  withStore((store) => {
    const budget = node(store, "预算");
    const finance = node(store, "财务");
    store.linkNodes({ sourceNodeId: budget.node.id, targetNodeId: finance.node.id, type: "related_to" });
    // Same-domain node directly related to budget must not surface as an analogy.
    const analogies = store.findStructuralAnalogies([budget.node.id], { maxCandidates: 5 });
    assert.ok(!analogies.some((a) => a.targetNodeId === finance.node.id), "adjacent same-domain node excluded");
  });
});
