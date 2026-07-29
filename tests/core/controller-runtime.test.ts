import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControllerRuntime } from "../../src/core/controller-runtime.ts";
import {
  CONTROLLER_FEATURE_COUNT,
  CONTROLLER_FEATURE_PROTOCOL_VERSION,
} from "../../src/core/controller-protocol.ts";
import { DifferentiableController } from "../../src/core/differentiable-controller.ts";
import { fibonacciEvidenceBudgets } from "../../src/core/store/active-graph.ts";
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
    assert.ok(fibonacciEvidenceBudgets(20).includes(decision.budget.maxEvidence));
    assert.ok(decision.budget.maxTokens > context.activeGraph.budget.maxTokens);
    assert.ok(decision.budget.maxTokens <= 6_000);
    assert.ok(decision.budget.maxNodes <= 16);
    assert.ok(decision.budget.maxLocalTier <= 3);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("QPP2 folds candidates but preserves a deterministic safe prefix", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-controller-fold-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    for (let index = 0; index < 25; index += 1) {
      store.remember({
        statement: `Atlas project detail ${index}`,
        nodeName: `Atlas topic ${index % 3}`,
      });
    }
    const context = store.searchContext("Atlas project detail", { limit: 25 });
    const fold = new ControllerRuntime(join(directory, "controller.json")).foldMemories(
      context,
      20,
      15,
    );
    assert.ok(fold);
    assert.equal(fold.visibleMemoryIds.length, 20);
    assert.equal(fold.foldedMemoryIds.length, 5);
    assert.deepEqual(
      fold.visibleMemoryIds.slice(0, 15),
      context.results.slice(0, 15).map((result) => result.memory.id),
    );
    assert.deepEqual(
      new Set([...fold.visibleMemoryIds, ...fold.foldedMemoryIds]),
      new Set(context.results.map((result) => result.memory.id)),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("controller runtime zero-pads a version-1 feature state", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-controller-migrate-"));
  const statePath = join(directory, "controller.json");
  try {
    const legacy = new DifferentiableController(32);
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        featureProtocolVersion: 1,
        controller: legacy.toJSON(),
        observations: 3,
        updatedAt: new Date(0).toISOString(),
      }),
    );
    const runtime = new ControllerRuntime(statePath);
    runtime.save();
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as {
      featureProtocolVersion: number;
      controller: { featureCount: number };
    };
    assert.equal(saved.featureProtocolVersion, CONTROLLER_FEATURE_PROTOCOL_VERSION);
    assert.equal(saved.controller.featureCount, CONTROLLER_FEATURE_COUNT);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an expansion-trained controller can enter the larger Active Graph tier", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-controller-expanded-budget-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    const primary = store.remember({ statement: "Project color is cobalt", nodeName: "Project" });
    const context = store.searchContext("cobalt", { limit: 8 });
    assert.ok(context.activeGraph);
    const trace = store.retrievalTrace(context.activeGraph.id);
    assert.ok(trace);
    // This is the exact supervision shape emitted when a later graph expansion
    // supplied the memory that was ultimately used. The budget test is about
    // controller policy, not the separate graph-routing implementation.
    const expansionTrace = {
      ...trace,
      usefulMemoryIds: [primary.memory.id],
      selections: trace.selections.map((selection) => ({
        ...selection,
        source: "graph_expansion" as const,
      })),
    };
    const runtime = new ControllerRuntime(join(directory, "controller.json"));
    for (let step = 0; step < 64; step += 1) runtime.observe(context, expansionTrace, 0.2);
    const decision = runtime.allocate(
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
      {
        maxNodes: 50,
        maxEdges: 100,
        maxEvidence: 50,
        maxTokens: 10_000,
        maxGraphHops: 3,
        maxLocalTier: 3,
        maxLatencyMs: 1_500,
      },
    );
    assert.ok(decision);
    assert.equal(decision.action, "expand");
    assert.ok(decision.budget.maxEvidence > 20);
    assert.ok(decision.budget.maxEvidence <= 50);
    assert.ok(decision.budget.maxTokens > 6_000);
    assert.ok(decision.budget.maxTokens <= 10_000);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
