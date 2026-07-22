import assert from "node:assert/strict";
import test from "node:test";

import nmgExtension from "./index.ts";
import { configuredGraphHops, formatSearchHeaders } from "./index.ts";
import type { MemoryContext } from "../../../src/core/types.ts";

function registeredTools(lab = false): string[] {
  const previous = process.env.NMG_ENABLE_LAB_TOOLS;
  if (lab) process.env.NMG_ENABLE_LAB_TOOLS = "1";
  else delete process.env.NMG_ENABLE_LAB_TOOLS;
  const names: string[] = [];
  try {
    nmgExtension({
      on() {},
      registerTool(tool: { name: string }) {
        names.push(tool.name);
      },
    } as never);
  } finally {
    if (previous === undefined) delete process.env.NMG_ENABLE_LAB_TOOLS;
    else process.env.NMG_ENABLE_LAB_TOOLS = previous;
  }
  return names;
}

test("NMG Lite exposes only the stable three-tool surface", () => {
  assert.deepEqual(registeredTools(), ["nmg_remember", "nmg_get", "nmg_search"]);
});

test("NMG Lab tools require an explicit environment switch", () => {
  assert.deepEqual(registeredTools(true), [
    "nmg_derive",
    "nmg_link",
    "nmg_remember",
    "nmg_organize",
    "nmg_feedback",
    "nmg_rebalance",
    "nmg_consolidate",
    "nmg_get",
    "nmg_search",
  ]);
});

test("search headers disclose IDs but not source evidence", () => {
  const context = {
    results: [
      {
        memory: {
          id: "memory-1",
          statement: "A compact searchable preview",
          memoryType: "fact",
          tier: 1,
          createdAt: "2026-07-19T00:00:00.000Z",
          truthStatus: "asserted",
          status: "active",
          residence: "ltg",
        },
        node: { id: "node-1", canonicalName: "test node", summary: "Compact node header" },
        evidence: { content: "SECRET EXACT SOURCE" },
      },
    ],
    relations: [],
    activeGraph: {
      id: "ag-1",
      taskId: "task-1",
      usage: { evidence: 1, estimatedTokens: 42 },
      budget: { maxEvidence: 4, maxTokens: 500 },
    },
  } as unknown as MemoryContext;

  const output = formatSearchHeaders(context);
  assert.match(output, /memory=memory-1/);
  assert.match(output, /preview=Compact node header/);
  assert.doesNotMatch(output, /A compact searchable preview/);
  assert.doesNotMatch(output, /SECRET EXACT SOURCE/);
  assert.match(output, /nmg_get/);
  assert.match(output, /active_graph=ag-1/);
  assert.match(output, /activeGraphId/);
});

test("graph-hop environment override clamps model-requested expansion", () => {
  const previous = process.env.NMG_GRAPH_HOPS;
  try {
    process.env.NMG_GRAPH_HOPS = "0";
    assert.equal(configuredGraphHops(3), 0);
    process.env.NMG_GRAPH_HOPS = "1";
    assert.equal(configuredGraphHops(0), 1);
    delete process.env.NMG_GRAPH_HOPS;
    assert.equal(configuredGraphHops(2), 2);
  } finally {
    if (previous === undefined) delete process.env.NMG_GRAPH_HOPS;
    else process.env.NMG_GRAPH_HOPS = previous;
  }
});
