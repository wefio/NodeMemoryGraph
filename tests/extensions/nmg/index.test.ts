import assert from "node:assert/strict";
import test from "node:test";

import nmgExtension from "../../../.pi/extensions/nmg/index.ts";
import {
  configuredGraphHops,
  formatSearchHeaders,
  searchMemoryContext,
} from "../../../.pi/extensions/nmg/index.ts";
import { NmgStore } from "../../../src/core/store.ts";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    "nmg_reason",
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

test("Lab reasoning state persists and is injected after reloading the extension", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-reasoning-extension-test-"));
  const previousLab = process.env.NMG_ENABLE_LAB_TOOLS;
  const previousData = process.env.NMG_DATA_DIR;
  process.env.NMG_ENABLE_LAB_TOOLS = "1";
  process.env.NMG_DATA_DIR = directory;
  const sessionManager = {
    getSessionId: () => "reasoning-session",
    getSessionFile: () => undefined,
    getBranch: () => [],
  };

  try {
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    nmgExtension({
      on() {},
      registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
    } as never);
    await tools
      .get("nmg_reason")!
      .execute(
        "call-1",
        { action: "add", kind: "goal", content: "Preserve this goal across compaction" },
        undefined,
        undefined,
        { sessionManager },
      );
    assert.equal(readdirSync(join(directory, "reasoning")).length, 1);

    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    nmgExtension({
      on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
        handlers.set(event, handler);
      },
      registerTool() {},
    } as never);
    const result = (await handlers.get("before_agent_start")!(
      { prompt: "Continue the task", systemPrompt: "base" },
      { sessionManager },
    )) as { systemPrompt: string };

    assert.match(result.systemPrompt, /<nmg_reasoning_checkpoint>/);
    assert.match(result.systemPrompt, /Preserve this goal across compaction/);
    await handlers.get("session_shutdown")!({}, { sessionManager });
  } finally {
    if (previousLab === undefined) delete process.env.NMG_ENABLE_LAB_TOOLS;
    else process.env.NMG_ENABLE_LAB_TOOLS = previousLab;
    if (previousData === undefined) delete process.env.NMG_DATA_DIR;
    else process.env.NMG_DATA_DIR = previousData;
    rmSync(directory, { recursive: true, force: true });
  }
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

test("embedding failure degrades to FTS while preserving an Active Graph", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-extension-test-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    const saved = store.remember({
      statement: "Project Atlas stores analytics in DuckDB",
      nodeName: "Project Atlas storage",
    });
    store.beginEmbeddingIndex({
      indexId: "unavailable-model@index",
      model: "unavailable-model",
      profile: "plain",
      targets: ["nodes", "leaves"],
    });
    store.completeEmbeddingIndex("unavailable-model@index");
    const context = await searchMemoryContext(
      store,
      {
        indexId: "unavailable-model@index",
        async embedQueries() {
          throw new Error("service offline");
        },
      },
      "Which project stores analytics in DuckDB?",
      { limit: 2, graphHops: 0 },
    );

    assert.equal(context.results[0]?.memory.id, saved.memory.id);
    assert.ok(context.activeGraph);
    assert.deepEqual(context.retrieval, {
      mode: "lexical",
      degraded: true,
      reason: "embedding_unavailable",
    });
    assert.match(formatSearchHeaders(context), /reason=embedding_unavailable/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unbuilt embedding index degrades without contacting the provider", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-extension-test-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  let calls = 0;
  try {
    const saved = store.remember({ statement: "Atlas uses DuckDB", nodeName: "Atlas storage" });
    const context = await searchMemoryContext(
      store,
      {
        indexId: "new-profile@index",
        async embedQueries() {
          calls += 1;
          return [[1, 0]];
        },
      },
      "Atlas DuckDB",
      { limit: 2, graphHops: 0 },
    );
    assert.equal(calls, 0);
    assert.equal(context.results[0]?.memory.id, saved.memory.id);
    assert.equal(context.retrieval?.reason, "embedding_index_not_ready");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
