import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ComputeRegistry,
  INPUT_NODE_ID,
  evaluateSyncComputeGraph,
  findParetoOptimalGraphs,
  replaceGraphNode,
  runGraphExperiments,
  type ComputeGraphSpec,
} from "../../src/core/compute-graph.ts";
import type { EmbeddingClient } from "../../src/core/embedding-provider.ts";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { openMemoryBackend } from "../../src/core/memory/open.ts";
import {
  DEFAULT_PIECEWISE_RERANK_GRAPH,
  RERANK_COMPUTE_REGISTRY,
  type RerankCandidate,
  type RerankContext,
  type ScoredCandidateId,
} from "../../src/core/memory/piecewise-rerank.ts";
import { DEFAULT_HTTP_SEARCH_GRAPH } from "../../src/integration/http-search-graph.ts";
import { sourceHttpMessageId } from "../../src/integration/memory-http-protocol.ts";
import { HttpMemoryService } from "../../src/integration/memory-http-service.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

function createDeterministicEmbedder(): EmbeddingClient {
  const vectorFor = (text: string): number[] => {
    const lower = text.toLowerCase();
    if (lower.includes("espresso") || lower.includes("grinder") || lower.includes("roast")) {
      return [0.95, 0.25, 0];
    }
    if (lower.includes("telescope") || lower.includes("nebula")) {
      return [0.1, 0.95, 0.2];
    }
    return [0.6, 0.5, 0.6];
  };
  return {
    indexId: "e2e-stub-v1",
    model: "e2e-stub",
    profile: "default",
    async embed(inputs) {
      return inputs.map(vectorFor);
    },
    async embedDocuments(inputs) {
      return inputs.map(vectorFor);
    },
    async embedQueries(inputs) {
      return inputs.map(vectorFor);
    },
  };
}

test("end-to-end retrieval pipeline combines dates FTS5, optional nodes, HTTP service, and hierarchical graph experiments", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-compute-graph-e2e-"));
  const path = join(directory, "memory.sqlite");
  const backend = await openMemoryBackend({ kind: "sqlite", path, namespace: "e2e:user-1" });
  const views: Awaited<ReturnType<typeof backend.openRead>>[] = [];
  t.after(async () => {
    for (const v of views) await backend.closeRead(v);
    await backend.close();
    removeTempDirectory(directory);
  });

  const engine = new MemoryEngine(backend, () => "2023-07-01T00:00:00.000Z");
  const embedder = createDeterministicEmbedder();
  const http = new HttpMemoryService(engine, embedder, { backfillLimit: 32 });

  // 1) Progressive node-less ingestion via engine + HTTP conversation ingestion with timestamps.
  const espressoOld = await engine.remember({
    statement: "Calibrated conical burr grinder for espresso extraction.",
    eventTime: "2023-03-14T08:00:00Z",
    sessionId: null,
  });
  await engine.remember({
    statement: "Bought a brass tamper for the coffee bar.",
    eventTime: "2023-05-08T09:00:00Z",
    sessionId: null,
  });

  await http.rememberBatch("user-1", "sess-roast", "req-1", [
    {
      role: "user",
      content: "Sampled washed Ethiopian light roast coffee beans this morning.",
      chat_time: "2023-06-20T09:00:00Z",
      source_message_id: sourceHttpMessageId("e2e-1", 0),
    },
    {
      role: "assistant",
      content: "Light roast coffee beans taste best with a 1:2.2 espresso ratio.",
      chat_time: "2023-06-20T09:01:00Z",
      source_message_id: sourceHttpMessageId("e2e-1", 1),
    },
  ]);

  // 2) Hybrid HTTP search triggers backfill and surfaces undated content matching May 2023 date query.
  const dateSearch = await http.search(["May 2023 brass tamper"], 5);
  assert.match(String(dateSearch.memories[0]?.content ?? ""), /brass tamper/i);

  // 3) Hybrid MemoryEngine search supports default piecewise rerank graph, swapped recipe, and bypass.
  const semantic = {
    mode: "hybrid" as const,
    indexId: embedder.indexId,
    vector: await embedder.embedQueries(["espresso coffee grinder"]),
  };
  const defaultRes = await engine.search(
    "espresso coffee grinder",
    { limit: 10 },
    {
      ...semantic,
      vector: semantic.vector[0]!,
    },
  );
  assert.ok(defaultRes.results.some((item) => item.memory.id === espressoOld.memory.id));

  const bypassedRes = await engine.search(
    "espresso coffee grinder",
    { limit: 10, rerankGraph: false },
    { ...semantic, vector: semantic.vector[0]! },
  );
  assert.equal(bypassedRes.results.length, defaultRes.results.length);

  // 4) Wrap SQLite hybrid retrieval + rerank subgraph into an end-to-end experiment ComputeGraph
  //    to compare recipes with shared upstream prefix caching and extract the Pareto frontier.
  const view = await backend.openRead();
  views.push(view);

  let recallExecutions = 0;
  const e2eRegistry = new ComputeRegistry<{ query: string }>()
    .register(
      "sqlite_hybrid_candidates",
      () => {
        recallExecutions += 1;
        const hybrid = backend.hybridCandidates!(
          view,
          { kind: "memory", text: "coffee espresso roast", limit: 50 },
          { mode: "hybrid", indexId: embedder.indexId, vector: semantic.vector[0]! },
        );
        return hybrid.candidates.map(({ entity, recordScore, bm25 }): RerankCandidate => ({
          id: entity.value.id,
          statement: entity.value.statement,
          combinedScore: recordScore * 0.75 + bm25 * 0.25,
          eventTime: entity.value.eventTime,
          createdAt: entity.value.createdAt,
          sessionId: entity.value.sessionId,
          nodeId: entity.value.nodeId,
        }));
      },
      { effect: "pure", cacheable: true },
    )
    .register(
      "rerank_subgraph",
      (inputs, ctx, params) => {
        const candidates = inputs.default as readonly RerankCandidate[];
        const rerankSpec = params.spec as ComputeGraphSpec;
        const baseInput: readonly ScoredCandidateId[] = candidates
          .map((c) => ({ id: c.id, score: c.combinedScore }))
          .sort((left, right) => right.score - left.score);
        return evaluateSyncComputeGraph<readonly ScoredCandidateId[], string[], RerankContext>(
          rerankSpec,
          RERANK_COMPUTE_REGISTRY,
          baseInput,
          { queryText: ctx.query, candidates },
        );
      },
      { effect: "pure" },
    );

  const baseRecipe: ComputeGraphSpec = {
    id: "recipe-default",
    nodes: [
      { id: "recall", op: "sqlite_hybrid_candidates" },
      { id: "rerank", op: "rerank_subgraph", params: { spec: DEFAULT_PIECEWISE_RERANK_GRAPH } },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "recall" },
      { from: "recall", to: "rerank" },
    ],
    output: "rerank",
  };
  const altRecipe = replaceGraphNode(
    baseRecipe,
    "rerank",
    {
      op: "rerank_subgraph",
      params: {
        spec: replaceGraphNode(DEFAULT_PIECEWISE_RERANK_GRAPH, "head_r3", {
          op: "identity_rank",
        }),
      },
    },
    "recipe-no-r3",
  );

  const experimentOutcome = await runGraphExperiments<string, string[], { query: string }>(
    [baseRecipe, altRecipe],
    e2eRegistry,
    "coffee espresso roast",
    { query: "When did I calibrate the espresso grinder?" },
  );
  assert.equal(recallExecutions, 1);
  assert.equal(experimentOutcome.cacheHits, 1);
  assert.ok((experimentOutcome.results.get("recipe-default")?.length ?? 0) >= 3);

  const pareto = findParetoOptimalGraphs(
    [
      { id: "recipe-default", score: 0.9, latencyMs: 0.6 },
      { id: "recipe-no-r3", score: 0.85, latencyMs: 0.5 },
      { id: "recipe-slow-worse", score: 0.85, latencyMs: 2.0 },
    ],
    [(x) => x.score, (x) => -x.latencyMs],
  );
  assert.deepEqual(
    pareto.map((x) => x.id),
    ["recipe-default", "recipe-no-r3"],
  );

  // 5) HttpMemoryService supports swappable HTTP fusion ComputeGraph and on-demand engine.projectGraph.
  const noTailSearchGraph = replaceGraphNode(
    DEFAULT_HTTP_SEARCH_GRAPH,
    "tail",
    { op: "select_supplemental_tail", params: { maxDue: 0, maxNeighbors: 0, maxTotal: 0 } },
    "http-no-tail",
  );
  const httpWithCustomGraph = new HttpMemoryService(engine, embedder, {
    searchGraph: noTailSearchGraph,
  });
  const fused = await httpWithCustomGraph.search(
    ["coffee beans espresso ratio", "brass tamper"],
    4,
  );
  assert.equal(fused.clauses.length, 2);
  assert.ok(fused.memories.length >= 2);

  const projection = await engine.projectGraph({ dimensions: ["session", "memoryType"] });
  assert.ok(projection.nodes.some((n) => n.dimension === "session" && n.key === "sess-roast"));
  assert.ok(projection.nodes.some((n) => n.dimension === "memoryType" && n.key === "event"));
  assert.ok(projection.edges.some((e) => e.kind === "co_occurrence"));
});
