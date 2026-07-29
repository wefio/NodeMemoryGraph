import assert from "node:assert/strict";
import test from "node:test";

import nmgExtension from "../../../.pi/extensions/nmg/index.ts";
import {
  configuredQpp1Mode,
  configuredQpp2Mode,
  configuredQpp2RetainedMass,
  configuredSearchRecommendationMode,
  configuredGraphHops,
  formatSearchRecommendation,
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

test("QPP2 folds low-necessity headers without removing Active Graph candidates", () => {
  const makeResult = (id: string, nodeId: string, name: string) => ({
    memory: {
      id,
      statement: `statement ${id}`,
      memoryType: "fact",
      tier: 1,
      createdAt: "2026-07-29T00:00:00.000Z",
      truthStatus: "asserted",
      status: "active",
      residence: "ltg",
      evidenceIds: [],
      sourceActor: "user",
      scope: {},
    },
    node: { id: nodeId, canonicalName: name, summary: `${name} summary` },
    evidence: { content: `evidence ${id}` },
  });
  const context = {
    results: [
      makeResult("memory-1", "node-1", "project"),
      makeResult("memory-2", "node-2", "archive"),
      makeResult("memory-3", "node-2", "archive"),
    ],
    relations: [],
  } as unknown as MemoryContext;

  const output = formatSearchHeaders(context, ["memory-1"]);
  assert.match(output, /memory=memory-1/);
  assert.doesNotMatch(output, /memory=memory-2/);
  assert.doesNotMatch(output, /memory=memory-3/);
  assert.match(output, /folded 2 lower-necessity candidates/);
  assert.match(output, /archive:2/);
  assert.match(output, /remain in the Active Graph/);
});

test("an explicit search may widen through the controller while automatic recall stays separate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-controller-search-test-"));
  const previousData = process.env.NMG_DATA_DIR;
  const previousControllerSearch = process.env.NMG_CONTROLLER_SEARCH;
  process.env.NMG_DATA_DIR = directory;
  process.env.NMG_CONTROLLER_SEARCH = "1";
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const sessionManager = {
    getSessionId: () => "controller-search-session",
    getSessionFile: () => undefined,
    getBranch: () => [],
  };
  try {
    nmgExtension({
      on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
        handlers.set(event, handler);
      },
      registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
    } as never);
    const context = { sessionManager };
    for (let index = 0; index < 12; index += 1) {
      await tools
        .get("nmg_remember")!
        .execute(
          `remember-${index}`,
          { statement: `Atlas project fact ${index}`, nodeName: "Atlas project" },
          undefined,
          undefined,
          context,
        );
    }
    const result = (await tools
      .get("nmg_search")!
      .execute("search", { query: "Atlas project facts" }, undefined, undefined, context)) as {
      details: MemoryContext;
    };
    assert.ok(result.details.activeGraph);
    assert.ok(result.details.activeGraph.budget.maxEvidence > 8);
    assert.ok(result.details.activeGraph.budget.maxEvidence <= 20);
    assert.ok(result.details.results.length > 8);
    await handlers.get("session_shutdown")!({}, context);
  } finally {
    if (previousData === undefined) delete process.env.NMG_DATA_DIR;
    else process.env.NMG_DATA_DIR = previousData;
    if (previousControllerSearch === undefined) delete process.env.NMG_CONTROLLER_SEARCH;
    else process.env.NMG_CONTROLLER_SEARCH = previousControllerSearch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Pi write and automatic recall close the claim contradiction loop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-extension-claims-"));
  const previousData = process.env.NMG_DATA_DIR;
  process.env.NMG_DATA_DIR = directory;
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const sessionManager = {
    getSessionId: () => "claims-session",
    getSessionFile: () => undefined,
    getBranch: () => [],
  };
  try {
    nmgExtension({
      on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
        handlers.set(event, handler);
      },
      registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
    } as never);
    const remember = tools.get("nmg_remember")!;
    const context = { sessionManager };
    await remember.execute(
      "write-positive",
      {
        statement: "The user integrated Flask-Login in the website project.",
        nodeName: "Flask experience",
        scope: { project: "website" },
        claims: [
          {
            text: "The user integrated Flask-Login.",
            polarity: "affirmative",
            predicateKey: "user_integrate_flask_login",
            confidence: 0.9,
          },
        ],
      },
      undefined,
      undefined,
      context,
    );
    await remember.execute(
      "write-negative",
      {
        statement: "The user has never integrated Flask-Login in the website project.",
        nodeName: "Flask experience",
        scope: { project: "website" },
        claims: [
          {
            text: "The user has never integrated Flask-Login.",
            polarity: "negative",
            predicateKey: "user_integrate_flask_login",
            confidence: 0.95,
          },
        ],
      },
      undefined,
      undefined,
      context,
    );

    const result = (await handlers.get("before_agent_start")!(
      {
        prompt: "Have I ever integrated Flask-Login in this project?",
        systemPrompt: "base",
      },
      context,
    )) as { systemPrompt: string };
    assert.match(result.systemPrompt, /<nmg_automatic_recall>/);
    assert.match(result.systemPrompt, /contradictory memories/);
    assert.match(result.systemPrompt, /user_integrate_flask_login/);
    assert.match(result.systemPrompt, /flag this to the user/);
    await handlers.get("session_shutdown")!({}, context);
  } finally {
    if (previousData === undefined) delete process.env.NMG_DATA_DIR;
    else process.env.NMG_DATA_DIR = previousData;
    rmSync(directory, { recursive: true, force: true });
  }
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

test("QPP stages and search recommendation are independently configurable", () => {
  const names = [
    "NMG_QPP1_MODE",
    "NMG_QPP2_MODE",
    "NMG_QPP2_RETAINED_MASS",
    "NMG_SEARCH_RECOMMENDATION",
    "NMG_CONTROLLER_SEARCH",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.equal(configuredQpp1Mode(), "shadow");
    assert.equal(configuredQpp2Mode(), "off");
    assert.equal(configuredQpp2RetainedMass(), 0.98);
    assert.equal(configuredSearchRecommendationMode(), "advisory");

    process.env.NMG_QPP1_MODE = "active";
    process.env.NMG_QPP2_MODE = "active";
    process.env.NMG_QPP2_RETAINED_MASS = "0.9";
    process.env.NMG_SEARCH_RECOMMENDATION = "off";
    assert.equal(configuredQpp1Mode(), "active");
    assert.equal(configuredQpp2Mode(), "active");
    assert.equal(configuredQpp2RetainedMass(), 0.9);
    assert.equal(configuredSearchRecommendationMode(), "off");

    delete process.env.NMG_QPP1_MODE;
    process.env.NMG_CONTROLLER_SEARCH = "1";
    assert.equal(configuredQpp1Mode(), "active");
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("search recommendation respects advisory and guardrail modes", () => {
  const context = {
    activeGraph: {
      qpp: {
        trigger: true,
        reason: "below_threshold",
        qpp: 0.2,
        threshold: 0.45,
        components: {
          top1: 0.3,
          variance: 0.1,
          intentCoverage: 0.5,
          reasonHealth: 1,
        },
      },
    },
  } as unknown as MemoryContext;

  assert.match(formatSearchRecommendation(context, "advisory"), /nmg_search/);
  assert.equal(formatSearchRecommendation(context, "guardrail"), "");
  assert.equal(formatSearchRecommendation(context, "off"), "");

  context.activeGraph!.qpp!.reason = "guardrail_low_top1";
  assert.match(formatSearchRecommendation(context, "guardrail"), /nmg_search/);
  context.activeGraph!.qpp!.trigger = false;
  assert.equal(formatSearchRecommendation(context, "advisory"), "");
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
      targets: ["records"],
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

test("a ready index without record vectors degrades without contacting the provider", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-extension-test-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  let calls = 0;
  try {
    const saved = store.remember({ statement: "Atlas uses DuckDB", nodeName: "Atlas storage" });
    store.beginEmbeddingIndex({
      indexId: "hierarchy-only@index",
      model: "hierarchy-only",
      profile: "plain",
      targets: ["nodes", "leaves"],
    });
    store.completeEmbeddingIndex("hierarchy-only@index");

    const context = await searchMemoryContext(
      store,
      {
        indexId: "hierarchy-only@index",
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
    assert.equal(context.retrieval?.reason, "embedding_index_missing_targets");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a ready record index is used by Pi's default semantic retrieval path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-extension-test-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    const lexical = store.remember({
      statement: "Project Atlas stores analytics in DuckDB",
      nodeName: "Atlas storage",
    });
    const semantic = store.remember({
      statement: "Project Borealis keeps reports in an embedded columnar database",
      nodeName: "Borealis storage",
    });
    store.upsertExternalEmbeddings("record-model@index", [
      { memoryId: lexical.memory.id, vector: [0, 1] },
      { memoryId: semantic.memory.id, vector: [1, 0] },
    ]);
    store.beginEmbeddingIndex({
      indexId: "record-model@index",
      model: "record-model",
      profile: "plain",
      targets: ["records"],
    });
    store.completeEmbeddingIndex("record-model@index");

    const context = await searchMemoryContext(
      store,
      {
        indexId: "record-model@index",
        async embedQueries() {
          return [[1, 0]];
        },
      },
      "Where does Atlas store analytics?",
      { limit: 2, graphHops: 0 },
    );

    assert.equal(context.results[0]?.memory.id, semantic.memory.id);
    assert.deepEqual(context.retrieval, { mode: "hybrid", degraded: false });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
