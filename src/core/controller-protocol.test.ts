import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTROLLER_FEATURE_COUNT,
  CONTROLLER_FEATURE_NAMES,
  controllerSampleFromTrace,
} from "./controller-protocol.ts";
import { NmgStore } from "./store.ts";
import type { VectorEmbedder } from "./types.ts";

test("trace protocol joins STG, LTG and Active Graph into fixed bounded features", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-controller-protocol-"));
  const embedder: VectorEmbedder = {
    model: "protocol-test",
    dimensions: 2,
    embed(text) {
      return text.includes("route-alpha") ? [1, 0] : [0, 1];
    },
  };
  const store = new NmgStore(join(directory, "nmg.sqlite"), embedder);
  try {
    const entry = store.remember({
      statement: "route-alpha identifies the project",
      nodeName: "Entry",
      memoryType: "derived",
      truthStatus: "inferred",
      residence: "stg",
      tier: 0,
    });
    const answer = store.remember({
      statement: "The durable answer is cobalt",
      nodeName: "Answer",
      memoryType: "fact",
      residence: "ltg",
      tier: 2,
      importance: 0.9,
    });
    store.linkNodes({
      sourceNodeId: entry.node.id,
      targetNodeId: answer.node.id,
      type: "related_to",
    });
    const context = store.searchContext("route-alpha cobalt", {
      limit: 4,
      graphHops: 1,
      activeGraphBudget: { maxNodes: 4, maxEdges: 4, maxEvidence: 4 },
    });
    assert.ok(context.activeGraph);
    const answerResult = store.getContext([answer.memory.id]).results[0]!;
    context.results.push(answerResult);
    const answerSelection = {
      memoryId: answer.memory.id,
      nodeId: answer.node.id,
      source: "graph_expansion" as const,
      reason: "lexical_match" as const,
      rank: 2,
      tier: answer.memory.tier,
      estimatedTokens: 12,
      scores: { lexical: 0.5, vector: 0, route: 0, combined: 0.5, usefulness: 0.7 },
    };
    const traceId = store.recordRetrievalTrace({
      query: "route-alpha cobalt",
      resultMemoryIds: [entry.memory.id, answer.memory.id],
      resultNodeIds: [entry.node.id, answer.node.id],
      expandedNodeIds: [answer.node.id],
      activeGraphBudget: context.activeGraph.budget,
      activeGraphUsage: { ...context.activeGraph.usage, nodes: 2, evidence: 2, deepestTier: 2 },
      selections: [...context.activeGraph.selections, answerSelection],
      expansions: [
        {
          relationId: "test-relation",
          sourceNodeId: entry.node.id,
          targetNodeId: answer.node.id,
          hop: 1,
        },
      ],
    });
    store.recordActiveGraphUse(traceId, {
      usedMemoryIds: [answer.memory.id],
      rejectedMemoryIds: [entry.memory.id],
    });
    const trace = store.retrievalTrace(traceId);
    assert.ok(trace);

    const sample = controllerSampleFromTrace(context, trace);
    assert.equal(CONTROLLER_FEATURE_NAMES.length, CONTROLLER_FEATURE_COUNT);
    assert.equal(sample.globalFeatures.length, CONTROLLER_FEATURE_COUNT);
    assert.ok(sample.globalFeatures.every((value) => value >= 0 && value <= 1));
    assert.equal(sample.supervision.hasOutcomeFeedback, true);
    assert.deepEqual(sample.supervision.usefulMemoryIds, [answer.memory.id]);
    assert.ok(sample.training);

    const nodeLabels = [...(sample.training.nodes ?? [])].map((item) => item.target).sort();
    assert.deepEqual(nodeLabels, [false, true]);
    assert.equal(sample.training.control?.target, "expand");
    assert.equal(sample.training.budget?.targets.length, 7);
    assert.ok(sample.training.budget?.targets.every((value) => value >= 0 && value <= 1));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("trace without explicit outcome feedback is inference-only", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-controller-no-label-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    store.remember({ statement: "A remembered detail", nodeName: "Detail" });
    const context = store.searchContext("remembered detail");
    assert.ok(context.activeGraph);
    const trace = store.retrievalTrace(context.activeGraph.id);
    assert.ok(trace);
    const sample = controllerSampleFromTrace(context, trace);
    assert.equal(sample.training, null);
    assert.equal(sample.supervision.hasOutcomeFeedback, false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
