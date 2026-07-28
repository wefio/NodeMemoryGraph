import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControllerRuntime } from "../../src/core/controller-runtime.ts";
import { NmgStore } from "../../src/core/store.ts";

test("controller runtime learns from actual-use traces and persists exact state", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-controller-runtime-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  const statePath = join(directory, "controller.json");
  try {
    const saved = store.remember({ statement: "Project color is cobalt", nodeName: "Project" });
    const context = store.searchContext("project color", { limit: 4 });
    assert.ok(context.activeGraph);
    const runtime = new ControllerRuntime(statePath);
    const before = runtime.shadow(context);
    assert.ok(before);
    assert.equal(before.trainingSteps, 0);

    store.recordActiveGraphUse(context.activeGraph.id, { usedMemoryIds: [saved.memory.id] });
    const trace = store.retrievalTrace(context.activeGraph.id);
    assert.ok(trace);
    assert.equal(runtime.observe(context, trace), true);
    assert.equal(runtime.trainingSteps, 1);
    assert.equal(runtime.observations, 1);

    const restored = new ControllerRuntime(statePath);
    assert.equal(restored.trainingSteps, 1);
    assert.equal(restored.observations, 1);
    assert.deepEqual(restored.shadow(context), runtime.shadow(context));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("controller allocation widens an explicit recall within its operator envelope", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-controller-budget-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    store.remember({ statement: "Project color is cobalt", nodeName: "Project" });
    const context = store.searchContext("project color", { limit: 8, persistTrace: false });
    assert.ok(context.activeGraph);
    const decision = new ControllerRuntime(join(directory, "controller.json")).allocate(
      context,
      context.activeGraph.budget,
      {
        maxNodes: 16,
        maxEdges: 24,
        maxEvidence: 20,
        maxTokens: 6_000,
        maxGraphHops: 2,
        maxLocalTier: 3,
        maxLatencyMs: 800,
      },
    );
    assert.ok(decision);
    assert.ok(decision.budget.maxEvidence > context.activeGraph.budget.maxEvidence);
    assert.ok(decision.budget.maxEvidence <= 20);
    assert.ok(decision.budget.maxTokens > context.activeGraph.budget.maxTokens);
    assert.ok(decision.budget.maxTokens <= 6_000);
    assert.ok(decision.budget.maxNodes <= 16);
    assert.ok(decision.budget.maxLocalTier <= 3);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
