import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NmgStore } from "../../src/core/store.ts";
import { propagateEdgeActivation } from "../../src/core/edge-activation.ts";

function withStore(run: (store: NmgStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mhp-"));
  const store = new NmgStore(join(dir, "nmg.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
  }
}

test("propagateEdgeActivation traces the best-activation path per node", () => {
  const rel = (id: string, s: string, t: string, type: string) => ({
    id,
    sourceNodeId: s,
    targetNodeId: t,
    type,
    strength: 0.8,
    activationRule: "conductive",
    direction: "source->target",
    fanBudget: false,
    status: "consolidated",
  } as const);
  const result = propagateEdgeActivation(
    new Map([["A", 1.0]]),
    [rel("r1", "A", "B", "causes"), rel("r2", "B", "C", "causes")],
    { maxHops: 3 },
  );
  assert.deepEqual(result.paths.get("A"), []);
  const b = result.paths.get("B") ?? [];
  assert.equal(b.length, 1);
  assert.equal(b[0]!.sourceNodeId, "A");
  assert.equal(b[0]!.targetNodeId, "B");
  assert.equal(b[0]!.hop, 1);
  const c = result.paths.get("C") ?? [];
  assert.equal(c.length, 2);
  assert.equal(c[0]!.sourceNodeId, "A");
  assert.equal(c[1]!.sourceNodeId, "B");
  assert.equal(c[1]!.targetNodeId, "C");
  assert.equal(c[1]!.hop, 2);
});

test("searchContext graph expansion returns results with multi-hop path", () => {
  withStore((store) => {
    const ma = store.remember({
      nodeName: "资金",
      nodeKind: "topic",
      nodeSummary: "资金流",
      statement: "A公司向B公司转账",
      sessionId: "s1",
      sourceActor: "user",
    });
    const mb = store.remember({
      nodeName: "关联",
      nodeKind: "topic",
      nodeSummary: "关联",
      statement: "Brightway控股Nebula股份",
      sessionId: "s1",
      sourceActor: "user",
    });
    const mc = store.remember({
      nodeName: "风险",
      nodeKind: "topic",
      nodeSummary: "风险",
      statement: "Nebula近期财报异常波动",
      sessionId: "s1",
      sourceActor: "user",
    });
    store.linkNodes({ sourceNodeId: ma.node.id, targetNodeId: mb.node.id, type: "causes" });
    store.linkNodes({ sourceNodeId: mb.node.id, targetNodeId: mc.node.id, type: "causes" });

    const ctx = store.searchContext("A公司转账", {
      limit: 10,
      sessionId: "s1",
      graphHops: 2,
    });
    const byStmt = new Map(ctx.results.map((r) => [r.memory.statement, r]));
    const a = byStmt.get("A公司向B公司转账");
    const b = byStmt.get("Brightway控股Nebula股份");
    const c = byStmt.get("Nebula近期财报异常波动");
    assert.ok(a, "seed hit present");
    assert.ok(!a!.path || a!.path.length === 0, "seed carries no path");
    assert.ok(b && b.path && b.path.length === 1, "1-hop node carries A->B");
    assert.equal(b!.path![0]!.relationType, "causes");
    assert.ok(c && c.path && c.path.length === 2, "2-hop node carries A->B->C");
    assert.equal(c!.path![1]!.hop, 2);
    // Graph-reached nodes are labelled with the learned_route recall reason.
    assert.ok(
      c!.recallReason === "learned_route" || b!.recallReason === "learned_route",
      "graph-reached node flagged learned_route",
    );
  });
});

test("graphHops=0 produces no paths", () => {
  withStore((store) => {
    const ma = store.remember({
      nodeName: "资金",
      nodeKind: "topic",
      nodeSummary: "资金流",
      statement: "A公司向B公司转账",
      sessionId: "s1",
      sourceActor: "user",
    });
    const mb = store.remember({
      nodeName: "关联",
      nodeKind: "topic",
      nodeSummary: "关联",
      statement: "Brightway控股Nebula股份",
      sessionId: "s1",
      sourceActor: "user",
    });
    store.linkNodes({ sourceNodeId: ma.node.id, targetNodeId: mb.node.id, type: "causes" });
    const ctx = store.searchContext("A公司转账", {
      limit: 10,
      sessionId: "s1",
      graphHops: 0,
    });
    for (const result of ctx.results) {
      assert.ok(!result.path || result.path.length === 0, "no path without graph hops");
    }
  });
});
