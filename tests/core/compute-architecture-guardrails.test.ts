import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_COMPUTE_CONTRACTS,
  adaptExternalAlgorithm,
} from "../../src/core/compute-contracts.ts";
import {
  ComputeMemoCache,
  ComputeRegistry,
  INPUT_NODE_ID,
  attachStateStamp,
  compileComputeGraph,
  evaluateSyncComputeGraph,
  executeComputeGraph,
  explainComputePlan,
  findParetoOptimalGraphs,
  graphAsOperator,
  replaceGraphNode,
  resolveCapabilities,
  runGraphExperiments,
  withCacheToken,
  type ComputeExecutionDiagnostics,
  type ComputeGraphSpec,
} from "../../src/core/compute-graph.ts";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import type { MemorySnapshotPort } from "../../src/core/memory/hydration.ts";
import { openMemoryBackend } from "../../src/core/memory/open.ts";
import { RERANK_COMPUTE_REGISTRY } from "../../src/core/memory/piecewise-rerank.ts";
import { RETRIEVAL_COMPUTE_REGISTRY } from "../../src/core/memory/retrieval-graph.ts";
import {
  DEFAULT_ENGINE_SEARCH_GRAPH,
  ENGINE_SEARCH_REGISTRY,
} from "../../src/core/memory/search-compute-graph.ts";
import {
  DEFAULT_PROJECT_GRAPH,
  ENGINE_VIEW_REGISTRY,
} from "../../src/core/memory/view-compute-graphs.ts";
import { ENGINE_WRITE_REGISTRY } from "../../src/core/memory/write-compute-graphs.ts";
import { HTTP_PROFILE_COMPUTE_REGISTRY } from "../../src/integration/http-profile-view.ts";
import { HTTP_SEARCH_COMPUTE_REGISTRY } from "../../src/integration/http-search-graph.ts";
import { HTTP_WRITE_PREPROCESS_REGISTRY } from "../../src/integration/http-write-preprocess.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

function checkRegistryOps(
  name: string,
  reg: Pick<ComputeRegistry<unknown>, "getCapabilities">,
  ops: readonly string[],
) {
  for (const op of ops) {
    const caps = reg.getCapabilities(op);
    assert.ok(caps.version.length > 0, `${name}.${op} must declare version`);
    assert.notEqual(caps.effect, "opaque", `${name}.${op} must not remain unannotated opaque`);
    assert.ok(caps.contracts.length > 0, `${name}.${op} must bind at least one logical contract`);
    for (const contractId of caps.contracts) {
      assert.ok(
        DEFAULT_COMPUTE_CONTRACTS.has(contractId),
        `${name}.${op} references unknown contract '${contractId}'`,
      );
    }
  }
}

test("Static architecture guardrails: layer boundaries, declared operator contracts, and retired rank-fusion", () => {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const memoryDir = join(repoRoot, "src", "core", "memory");
  const computeFiles = [
    join(repoRoot, "src", "core", "canonical-value.ts"),
    join(repoRoot, "src", "core", "capability-config.ts"),
    join(repoRoot, "src", "core", "compute-contracts.ts"),
    join(repoRoot, "src", "core", "compute-planner.ts"),
    join(repoRoot, "src", "core", "compute-graph.ts"),
    join(repoRoot, "src", "core", "resource-locks.ts"),
    join(repoRoot, "src", "core", "runtime", "cost-model.ts"),
    join(repoRoot, "src", "core", "runtime", "load-governor.ts"),
    join(repoRoot, "src", "core", "runtime", "worker-pool.ts"),
    join(repoRoot, "src", "core", "runtime", "worker-entry.ts"),
    join(repoRoot, "src", "core", "runtime", "scheduler.ts"),
    join(memoryDir, "page-stitch-operators.ts"),
    join(memoryDir, "piecewise-rerank.ts"),
    join(memoryDir, "bm25f-neighborhoods.ts"),
    join(memoryDir, "incremental-bm25.ts"),
    join(memoryDir, "graph-projection.ts"),
    join(memoryDir, "retrieval-graph.ts"),
  ];
  for (const file of computeFiles) {
    const text = readFileSync(file, "utf8");
    for (const forbidden of ["sqlite-", "lance-backend", "engine.ts", "node:sqlite"]) {
      assert.equal(text.includes(forbidden), false, `${file} must not import '${forbidden}'`);
    }
  }

  for (const domainFile of [
    "hydration.ts",
    "search-compute-graph.ts",
    "view-compute-graphs.ts",
    "write-compute-graphs.ts",
  ]) {
    const text = readFileSync(join(memoryDir, domainFile), "utf8");
    for (const forbidden of ["sqlite-", "lance-backend", "engine.ts", "node:sqlite"]) {
      assert.equal(text.includes(forbidden), false, `${domainFile} must not import '${forbidden}'`);
    }
  }

  for (const file of readdirSync(memoryDir)) {
    if (!file.startsWith("sqlite-") && file !== "lance-backend.ts" && file !== "entity-rows.ts") {
      continue;
    }
    const text = readFileSync(join(memoryDir, file), "utf8");
    for (const forbidden of [
      "compute-contracts",
      "compute-planner",
      "compute-graph",
      "search-compute-graph",
      "view-compute-graphs",
      "write-compute-graphs",
      "hydration",
    ]) {
      assert.equal(text.includes(forbidden), false, `${file} must not import '${forbidden}'`);
    }
  }

  checkRegistryOps("ENGINE_SEARCH", ENGINE_SEARCH_REGISTRY, [
    "analyze_search_query",
    "recall_primary_candidates",
    "recall_temporal_window",
    "expand_search_neighbors",
    "assemble_search_context",
  ]);
  checkRegistryOps("ENGINE_VIEW", ENGINE_VIEW_REGISTRY, [
    "scan_ordered_get",
    "assemble_get_context",
    "resolve_and_expand_neighborhood",
    "relational_memory_query",
    "load_projection_topology",
    "build_pivot_projection",
    "scan_user_profile_candidates",
    "assemble_user_profile_context",
  ]);
  checkRegistryOps("ENGINE_WRITE", ENGINE_WRITE_REGISTRY, [
    "prefetch_remember_batch",
    "plan_remember_slots",
    "plan_lifecycle_mutation",
  ]);
  checkRegistryOps("RERANK", RERANK_COMPUTE_REGISTRY, [
    "identity_rank",
    "r3_intent_boost",
    "r5_recency_boost",
    "r1_incremental_dedup",
    "w_session_pivot",
    "causal_band_stitch",
    "bm25f_field_score",
    "incremental_bm25_score",
    "w_temporal_pivot",
    "w_concept_pivot",
    "w_lineage_pivot",
    "w_turn_pivot",
    "w_chrono_seq_pivot",
  ]);
  checkRegistryOps("RETRIEVAL", RETRIEVAL_COMPUTE_REGISTRY, [
    "lexical_recall",
    "vector_recall",
    "log_odds_fusion",
    "piecewise_rerank",
    "pivot_graph_projection",
  ]);
  checkRegistryOps("HTTP_SEARCH", HTTP_SEARCH_COMPUTE_REGISTRY, [
    "fuse_clause_hits",
    "select_supplemental_tail",
    "stitch_http_page",
  ]);
  checkRegistryOps("HTTP_PREPROCESS", HTTP_WRITE_PREPROCESS_REGISTRY, [
    "extract_forget_directive",
    "extract_preference_signals",
    "classify_turn_type",
  ]);
  checkRegistryOps("HTTP_PROFILE", HTTP_PROFILE_COMPUTE_REGISTRY, [
    "resolve_profile_head",
    "rank_profile_sections",
    "render_profile_supplement",
  ]);

  assert.equal(existsSync(join(memoryDir, "rank-fusion.ts")), false);
  assert.equal(existsSync(join(repoRoot, "src", "lab", "rank-fusion.ts")), false);
  assert.equal(existsSync(join(repoRoot, "tests", "core", "rank-fusion.test.ts")), false);
});

test("Runtime safety 1-3: mutable output clone isolation, closure tokens, and state-stamp invalidation", () => {
  // 1. Mutable cached output cannot be polluted by callers
  const memo = new ComputeMemoCache();
  let pureCalls = 0;
  const reg = new ComputeRegistry<{ scaler: (x: number) => number; val?: number }>()
    .register(
      "make_list",
      (inputs) => {
        pureCalls += 1;
        return { list: [Number(inputs.default), Number(inputs.default) + 1] };
      },
      { effect: "pure" },
    )
    .register(
      "apply_closure",
      (inputs, ctx) => {
        pureCalls += 1;
        return ctx.scaler(Number(inputs.default));
      },
      { effect: "pure" },
    )
    .register(
      "stamped_read",
      (inputs, ctx) => {
        pureCalls += 1;
        return `${String(inputs.default)}:${ctx.val ?? 0}`;
      },
      {
        effect: "read",
        cacheable: true,
        externalDeps: ["storage_snapshot", "vector_index"],
      },
    );

  const listSpec: ComputeGraphSpec = {
    id: "list-g",
    nodes: [{ id: "m", op: "make_list" }],
    edges: [{ from: INPUT_NODE_ID, to: "m" }],
    output: "m",
  };
  const idFn = (x: number) => x;
  const first = evaluateSyncComputeGraph<
    number,
    { list: number[] },
    { scaler: (x: number) => number }
  >(listSpec, reg, 5, { scaler: idFn }, memo);
  first.list.push(999);
  const second = evaluateSyncComputeGraph<
    number,
    { list: number[] },
    { scaler: (x: number) => number }
  >(listSpec, reg, 5, { scaler: idFn }, memo);
  assert.deepEqual(second.list, [5, 6]);
  assert.equal(pureCalls, 1);

  // 2. Closure instances with identical source never collide; withCacheToken allows intentional match
  const makeScaler = (k: number) => (x: number) => x * k;
  const closureSpec: ComputeGraphSpec = {
    id: "closure-g",
    nodes: [{ id: "c", op: "apply_closure" }],
    edges: [{ from: INPUT_NODE_ID, to: "c" }],
    output: "c",
  };
  assert.equal(evaluateSyncComputeGraph(closureSpec, reg, 3, { scaler: makeScaler(2) }, memo), 6);
  assert.equal(evaluateSyncComputeGraph(closureSpec, reg, 3, { scaler: makeScaler(10) }, memo), 30);
  const sA = withCacheToken((x: number) => x + 7, "add-7");
  const sB = withCacheToken((x: number) => x + 7, "add-7");
  const hitsBefore = memo.hits;
  assert.equal(evaluateSyncComputeGraph(closureSpec, reg, 3, { scaler: sA }, memo), 10);
  assert.equal(evaluateSyncComputeGraph(closureSpec, reg, 3, { scaler: sB }, memo), 10);
  assert.equal(memo.hits, hitsBefore + 1);

  // 3. Stamped read invalidates on revision/modelVersion and skips caching without required stamps
  const readSpec: ComputeGraphSpec = {
    id: "read-g",
    nodes: [{ id: "r", op: "stamped_read" }],
    edges: [{ from: INPUT_NODE_ID, to: "r" }],
    output: "r",
  };
  const ctxNoStamp = { scaler: sA, val: 1 };
  const diagMissing: ComputeExecutionDiagnostics = {
    peakLiveOutputs: 0,
    cacheHits: 0,
    executedNodes: 0,
    cacheSkips: 0,
  };
  assert.equal(
    evaluateSyncComputeGraph(readSpec, reg, "q", ctxNoStamp, memo, undefined, diagMissing),
    "q:1",
  );
  assert.equal(diagMissing.cacheSkips, 1);

  const ctxRev1 = attachStateStamp(
    { scaler: sA, val: 1 },
    { namespace: "ns1", revision: 1, modelVersion: "m1" },
  );
  const ctxRev2 = attachStateStamp(
    { scaler: sA, val: 2 },
    { namespace: "ns1", revision: 2, modelVersion: "m1" },
  );
  assert.equal(evaluateSyncComputeGraph(readSpec, reg, "q", ctxRev1, memo), "q:1");
  const hitsRev1 = memo.hits;
  assert.equal(evaluateSyncComputeGraph(readSpec, reg, "q", ctxRev1, memo), "q:1");
  assert.equal(memo.hits, hitsRev1 + 1);
  assert.equal(evaluateSyncComputeGraph(readSpec, reg, "q", ctxRev2, memo), "q:2");
});

test("Runtime safety 4-9: graphAsOperator dynamic invalidation, taint, resource locks, LRU/refcount, zero-hash", async () => {
  // 4 & 5. graphAsOperator re-registration + conservative opaque/write defaults
  const defaultCaps = resolveCapabilities(undefined);
  assert.equal(defaultCaps.effect, "opaque");
  assert.equal(defaultCaps.cacheable, false);
  assert.equal(defaultCaps.parallelSafe, false);
  assert.equal(defaultCaps.eliminable, false);

  let runs = 0;
  const reg = new ComputeRegistry()
    .register(
      "leaf",
      (inputs) => {
        runs += 1;
        return `${String(inputs.default)}:v1`;
      },
      { effect: "pure" },
    )
    .register("opaque_op", (inputs) => {
      runs += 1;
      return `${String(inputs.default)}:opaque`;
    })
    .register(
      "downstream",
      (inputs) => {
        runs += 1;
        return `down(${String(inputs.default)})`;
      },
      { effect: "pure" },
    );

  const child: ComputeGraphSpec = {
    id: "child-dyn",
    nodes: [{ id: "l", op: "leaf" }],
    edges: [{ from: INPUT_NODE_ID, to: "l" }],
    output: "l",
  };
  reg.register("comp", graphAsOperator(child, reg));
  assert.equal(reg.getCapabilities("comp").effect, "pure");

  const outer: ComputeGraphSpec = {
    id: "outer-dyn",
    nodes: [{ id: "c", op: "comp" }],
    edges: [{ from: INPUT_NODE_ID, to: "c" }],
    output: "c",
  };
  const memo = new ComputeMemoCache({ maxEntries: 2 });
  assert.equal(await executeComputeGraph(outer, reg, "x", {}, memo), "x:v1");
  // Re-registering inner leaf updates outer composite capability and invalidates outer cache
  reg.register(
    "leaf",
    (inputs) => {
      runs += 1;
      return `${String(inputs.default)}:v2-fx`;
    },
    { effect: "write" },
  );
  assert.equal(reg.getCapabilities("comp").effect, "write");
  assert.equal(await executeComputeGraph(outer, reg, "x", {}, memo), "x:v2-fx");

  // Unannotated opaque node taints downstream node
  const opaqueChain: ComputeGraphSpec = {
    id: "opaque-chain",
    nodes: [
      { id: "o", op: "opaque_op" },
      { id: "d", op: "downstream" },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "o" },
      { from: "o", to: "d" },
    ],
    output: "d",
  };
  const runsBefore = runs;
  evaluateSyncComputeGraph(opaqueChain, reg, "k", {}, memo);
  evaluateSyncComputeGraph(opaqueChain, reg, "k", {}, memo);
  assert.equal(runs - runsBefore, 4);

  // 7. Resource-lock serialization vs conflict-free parallel execution
  let active = 0;
  let maxConcurrent = 0;
  const asyncWait = async () => {
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    await new Promise((r) => setTimeout(r, 15));
    active -= 1;
  };
  const lockReg = new ComputeRegistry()
    .register(
      "w_idx",
      async () => {
        await asyncWait();
        return 1;
      },
      { effect: "read", parallelSafe: true, resources: { execution: "async_io", writes: ["idx"] } },
    )
    .register(
      "r_idx",
      async () => {
        await asyncWait();
        return 2;
      },
      { effect: "read", parallelSafe: true, resources: { execution: "async_io", reads: ["idx"] } },
    )
    .register(
      "r_other",
      async () => {
        await asyncWait();
        return 3;
      },
      {
        effect: "read",
        parallelSafe: true,
        resources: { execution: "async_io", reads: ["other"] },
      },
    )
    .register("sum3", (i) => Number(i.a) + Number(i.b) + Number(i.c), { effect: "pure" });

  const lockSpec: ComputeGraphSpec = {
    id: "resource-locks",
    nodes: [
      { id: "a", op: "w_idx" },
      { id: "b", op: "r_idx" },
      { id: "c", op: "r_other" },
      { id: "s", op: "sum3" },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "a" },
      { from: INPUT_NODE_ID, to: "b" },
      { from: INPUT_NODE_ID, to: "c" },
      { from: "a", to: "s", port: "a" },
      { from: "b", to: "s", port: "b" },
      { from: "c", to: "s", port: "c" },
    ],
    output: "s",
  };
  // w_idx and r_other run in parallel group 1 (max 2 concurrent), r_idx runs after conflict check
  assert.equal(await executeComputeGraph(lockSpec, lockReg, 0, {}), 6);
  assert.equal(maxConcurrent, 2);

  // 8. LRU eviction & ref-counted output release
  const lru = new ComputeMemoCache({ maxEntries: 2 });
  lru.set("k1", 1);
  lru.set("k2", 2);
  lru.get("k1");
  lru.set("k3", 3);
  assert.equal(lru.evictions, 1);
  assert.equal(lru.get("k2").found, false);
  assert.equal(lru.get("k1").found, true);

  const chainReg = new ComputeRegistry().register("inc", (i) => Number(i.default) + 1, {
    effect: "pure",
  });
  const chainSpec: ComputeGraphSpec = {
    id: "chain-6",
    nodes: [
      { id: "n1", op: "inc" },
      { id: "n2", op: "inc" },
      { id: "n3", op: "inc" },
      { id: "n4", op: "inc" },
      { id: "n5", op: "inc" },
      { id: "n6", op: "inc" },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "n1" },
      { from: "n1", to: "n2" },
      { from: "n2", to: "n3" },
      { from: "n3", to: "n4" },
      { from: "n4", to: "n5" },
      { from: "n5", to: "n6" },
    ],
    output: "n6",
  };
  const chainDiag: ComputeExecutionDiagnostics = {
    peakLiveOutputs: 0,
    cacheHits: 0,
    executedNodes: 0,
    cacheSkips: 0,
  };
  assert.equal(
    evaluateSyncComputeGraph(chainSpec, chainReg, 0, {}, undefined, undefined, chainDiag),
    6,
  );
  assert.ok(
    chainDiag.peakLiveOutputs <= 3,
    `Expected bounded live slots, got ${chainDiag.peakLiveOutputs}`,
  );

  // 9. Zero-hash uncached path accepts BigInt + cyclic objects without canonicalization errors
  const cyclic: { tag: string; self?: unknown; big: bigint } = { tag: "c", big: 42n };
  cyclic.self = cyclic;
  const zeroHashReg = new ComputeRegistry().register(
    "read_big",
    (inputs) => (inputs.default as typeof cyclic).big + 8n,
    { effect: "pure" },
  );
  const zeroSpec: ComputeGraphSpec = {
    id: "zero-hash",
    nodes: [{ id: "z", op: "read_big" }],
    edges: [{ from: INPUT_NODE_ID, to: "z" }],
    output: "z",
  };
  assert.equal(evaluateSyncComputeGraph(zeroSpec, zeroHashReg, cyclic, {}), 50n);
});

test("Planner passes & 7 architecture validation scenarios on live SQLite backend", async (t) => {
  // Planner: DCE + CSE + Linear Fusion + SQL lowering inspection
  const reg = new ComputeRegistry()
    .register("add1", (i) => Number(i.default) + 1, { effect: "pure" })
    .register("mul2", (i) => Number(i.default) * 2, { effect: "pure" })
    .register("sum", (i) => Number(i.a) + Number(i.b), { effect: "pure" })
    .register("dead_fx", () => "kept-fx", { effect: "write" });

  const optSpec: ComputeGraphSpec = {
    id: "opt-test",
    nodes: [
      { id: "a", op: "add1" },
      { id: "a_dup", op: "add1" },
      { id: "dead_pure", op: "mul2" },
      { id: "dead_w", op: "dead_fx" },
      { id: "join", op: "sum" },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "a" },
      { from: INPUT_NODE_ID, to: "a_dup" },
      { from: INPUT_NODE_ID, to: "dead_pure" },
      { from: "a", to: "join", port: "a" },
      { from: "a_dup", to: "join", port: "b" },
    ],
    output: "join",
  };
  const unoptPlan = compileComputeGraph(optSpec, reg, { enableCse: false, enableDce: false });
  const optPlan = compileComputeGraph(optSpec, reg, { enableCse: true, enableDce: true });
  const explained = explainComputePlan(optPlan);
  assert.deepEqual(explained.eliminatedNodeIds, ["dead_pure"]);
  assert.equal(explained.cseMergedNodeIds.a_dup, "a");
  assert.ok(optPlan.order.length < unoptPlan.order.length);
  assert.equal(
    evaluateSyncComputeGraph(optSpec, reg, 4, {}, undefined, {
      enableCse: false,
      enableDce: false,
    }),
    evaluateSyncComputeGraph(optSpec, reg, 4, {}, undefined, { enableCse: true, enableDce: true }),
  );

  // Lowered projectGraph plan inspection
  const sqlProjPlan = explainComputePlan(
    compileComputeGraph(DEFAULT_PROJECT_GRAPH, ENGINE_VIEW_REGISTRY, { backendTarget: "sqlite" }),
  );
  const portableProjPlan = explainComputePlan(
    compileComputeGraph(DEFAULT_PROJECT_GRAPH, ENGINE_VIEW_REGISTRY, { backendTarget: "portable" }),
  );
  assert.equal(sqlProjPlan.loweredNodes.select_memories, "sqlite_pushdown");
  assert.equal(portableProjPlan.loweredNodes.select_memories, "portable_scan");

  // Scenarios 1-7 against a real SQLite backend without modifying engine or DB schema
  const dir = mkdtempSync(join(tmpdir(), "nmg-arch-val-"));
  const dbPath = join(dir, "memory.sqlite");
  t.after(() => removeTempDirectory(dir));
  const backend = await openMemoryBackend({ kind: "sqlite", path: dbPath, namespace: "arch" });
  try {
    const engine = new MemoryEngine(backend, () => "2026-11-24T10:00:00.000Z");
    const m1 = await engine.remember({ statement: "Primary compute node handles SQLite queries" });
    const m2 = await engine.remember({
      statement: "Secondary fallback node handles pure JS filters",
    });

    // Scenario 1: plug in a new standalone retrieval module & Scenario 4: 3rd-party black-box adapter
    class ThirdPartyRanker {
      scoreText(text: string): number {
        return text.includes("Secondary") ? 10 : 1;
      }
    }
    const ext = new ThirdPartyRanker();
    const extOp = adaptExternalAlgorithm({
      op: "third_party_rerank",
      mapInput: (inputs) =>
        inputs.candidates as {
          results: Array<{ memory: { statement: string }; combinedScore: number }>;
        },
      invoke: (state) => ({
        ...state,
        results: [...state.results].sort(
          (a, b) => ext.scoreText(b.memory.statement) - ext.scoreText(a.memory.statement),
        ),
      }),
    });
    assert.equal(extOp.meta.effect, "opaque");

    const customReg = new ComputeRegistry<MemorySnapshotPort>().registerModule(extOp);
    for (const op of [
      "analyze_search_query",
      "recall_primary_candidates",
      "recall_temporal_window",
      "expand_search_neighbors",
      "assemble_search_context",
    ]) {
      customReg.register(
        op,
        ENGINE_SEARCH_REGISTRY.get(op),
        ENGINE_SEARCH_REGISTRY.getCapabilities(op),
      );
    }

    // Scenario 2 & 3: replace recall node with nested subgraph or swap full search graph
    const swappedSearchGraph = replaceGraphNode(DEFAULT_ENGINE_SEARCH_GRAPH, "temporal", {
      op: "third_party_rerank",
    });

    const beforeView = await backend.openRead();
    const revBefore = beforeView.revision;
    await backend.closeRead(beforeView);

    // Scenario 6: switch compute plans without touching authoritative DB storage
    const defaultOut = await engine.search("handles");
    const customEngine = new MemoryEngine(backend, () => "2026-11-24T10:00:00.000Z", {
      searchGraph: swappedSearchGraph,
      searchRegistry: customReg,
    });
    const customOut = await customEngine.search("handles");
    assert.equal(defaultOut.results.length, 2);
    assert.equal(customOut.results[0]?.memory.id, m2.memory.id);

    const afterView = await backend.openRead();
    assert.equal(afterView.revision, revBefore);
    const counts = await backend.counts?.(afterView);
    assert.equal(counts?.memories, 2);
    await backend.closeRead(afterView);
    assert.ok(m1.memory.id !== m2.memory.id);

    // Scenario 7: run unified multi-recipe experiment + Pareto selection
    const expReg = new ComputeRegistry()
      .register("recall", (i) => `${String(i.default)}:hits`, { effect: "pure" })
      .register(
        "score",
        (i, _c, p) => ({ acc: Number(p.acc), lat: Number(p.lat), tag: String(i.default) }),
        {
          effect: "pure",
        },
      );
    const rBase: ComputeGraphSpec = {
      id: "r-base",
      nodes: [
        { id: "rec", op: "recall" },
        { id: "sc", op: "score", params: { acc: 0.78, lat: 2.5 } },
      ],
      edges: [
        { from: INPUT_NODE_ID, to: "rec" },
        { from: "rec", to: "sc" },
      ],
      output: "sc",
    };
    const rFast = replaceGraphNode(
      rBase,
      "sc",
      { op: "score", params: { acc: 0.77, lat: 0.9 } },
      "r-fast",
    );
    const rDominated = replaceGraphNode(
      rBase,
      "sc",
      { op: "score", params: { acc: 0.75, lat: 3.1 } },
      "r-dom",
    );
    const exp = await runGraphExperiments<string, { acc: number; lat: number }, unknown>(
      [rBase, rFast, rDominated],
      expReg,
      "q",
      {},
    );
    assert.equal(exp.cacheHits, 2);
    const pareto = findParetoOptimalGraphs(
      [...exp.results.entries()].map(([id, v]) => ({ id, ...v })),
      [(x) => x.acc, (x) => -x.lat],
    );
    assert.deepEqual(
      pareto.map((x) => x.id),
      ["r-base", "r-fast"],
    );
  } finally {
    await backend.close();
  }
});

test("Planner & cache correctness 1-4: registry isolation, recursive subgraph DCE, fused step params, container freeze", async () => {
  // 1. Distinct ComputeRegistry instances with identical generation never share wrong PhysicalExecutionPlan
  const graph: ComputeGraphSpec = {
    id: "contract-bound",
    nodes: [{ id: "step", op: "$contract", contract: "memory.candidate_rerank" }],
    edges: [{ from: INPUT_NODE_ID, to: "step" }],
    output: "step",
  };
  const regA = new ComputeRegistry().register("op_a", (i) => `${String(i.default)}:A`, {
    effect: "pure",
    contract: "memory.candidate_rerank",
  });
  const regB = new ComputeRegistry().register("op_b", (i) => `${String(i.default)}:B`, {
    effect: "pure",
    contract: "memory.candidate_rerank",
  });
  assert.equal(evaluateSyncComputeGraph(graph, regA, "x", {}), "x:A");
  assert.equal(evaluateSyncComputeGraph(graph, regB, "x", {}), "x:B");

  // 2. DCE retains unreachable nested subgraphs that contain side-effecting writes
  let nestedSideEffectRuns = 0;
  const sideReg = new ComputeRegistry()
    .register("pure_id", (i) => i.default, { effect: "pure" })
    .register(
      "record_audit",
      (i) => {
        nestedSideEffectRuns += 1;
        return i.default;
      },
      { effect: "write" },
    );
  const sideSubgraph: ComputeGraphSpec = {
    id: "side-sub",
    nodes: [{ id: "w", op: "record_audit" }],
    edges: [{ from: INPUT_NODE_ID, to: "w" }],
    output: "w",
  };
  const outer: ComputeGraphSpec = {
    id: "outer-dce",
    nodes: [
      { id: "kept", op: "pure_id" },
      { id: "dead_side", op: "subgraph", subgraph: sideSubgraph },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "kept" },
      { from: INPUT_NODE_ID, to: "dead_side" },
    ],
    output: "kept",
  };
  const outerPlan = compileComputeGraph(outer, sideReg);
  assert.equal(outerPlan.eliminatedNodeIds.includes("dead_side"), false);
  evaluateSyncComputeGraph(outer, sideReg, 42, {});
  assert.equal(nestedSideEffectRuns, 1);

  // 3. Fused linear pure chain signatures distinguish differing internal step params
  const chainReg = new ComputeRegistry().register(
    "add_k",
    (i, _c, p) => Number(i.default) + Number(p.k ?? 0),
    { effect: "pure" },
  );
  const chainBase: ComputeGraphSpec = {
    id: "fused-chain-sig",
    nodes: [
      { id: "s1", op: "add_k", params: { k: 1 } },
      { id: "s2", op: "add_k", params: { k: 10 } },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "s1" },
      { from: "s1", to: "s2" },
    ],
    output: "s2",
  };
  const chainModified = replaceGraphNode(
    chainBase,
    "s1",
    { op: "add_k", params: { k: 100 } },
    "fused-chain-sig",
  );
  const chainMemo = new ComputeMemoCache();
  assert.equal(
    evaluateSyncComputeGraph(chainBase, chainReg, 5, {}, chainMemo, { enableLinearFusion: true }),
    16,
  );
  assert.equal(
    evaluateSyncComputeGraph(chainModified, chainReg, 5, {}, chainMemo, {
      enableLinearFusion: true,
    }),
    115,
  );

  // 4. Object.freeze(Map / Set / Date / Uint8Array) never bypasses cache cloning or collides hashes
  const mapReg = new ComputeRegistry()
    .register(
      "make_frozen_map",
      (i) => Object.freeze(new Map<string, number>([["val", Number(i.default)]])),
      { effect: "pure" },
    )
    .register("echo_frozen_map", (i) => i.default, { effect: "pure" });
  const mapSpec: ComputeGraphSpec = {
    id: "frozen-map-g",
    nodes: [{ id: "m", op: "make_frozen_map" }],
    edges: [{ from: INPUT_NODE_ID, to: "m" }],
    output: "m",
  };
  const mapMemo = new ComputeMemoCache();
  const mFirst = evaluateSyncComputeGraph<number, Map<string, number>, unknown>(
    mapSpec,
    mapReg,
    1,
    {},
    mapMemo,
  );
  mFirst.set("val", 999);
  const mSecond = evaluateSyncComputeGraph<number, Map<string, number>, unknown>(
    mapSpec,
    mapReg,
    1,
    {},
    mapMemo,
  );
  assert.equal(mSecond.get("val"), 1);

  const echoSpec: ComputeGraphSpec = {
    id: "echo-map-g",
    nodes: [{ id: "e", op: "echo_frozen_map" }],
    edges: [{ from: INPUT_NODE_ID, to: "e" }],
    output: "e",
  };
  const rA = evaluateSyncComputeGraph<Map<string, number>, Map<string, number>, unknown>(
    echoSpec,
    mapReg,
    Object.freeze(new Map([["k", 1]])),
    {},
    mapMemo,
  );
  const rB = evaluateSyncComputeGraph<Map<string, number>, Map<string, number>, unknown>(
    echoSpec,
    mapReg,
    Object.freeze(new Map([["k", 2]])),
    {},
    mapMemo,
  );
  assert.equal(rA.get("k"), 1);
  assert.equal(rB.get("k"), 2);
});

test("Adapter & convergence guardrails: thin adapters share config and wake/stitch primitives", () => {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const workbuddy = readFileSync(join(repoRoot, "workbuddy-plugin", "nmg-hook.ts"), "utf8");
  const dshMjs = readFileSync(join(repoRoot, "dsh", "nmg-plugin.mjs"), "utf8");
  const dshTs = readFileSync(join(repoRoot, "dsh", "dsh-nmg", "src", "plugin", "index.ts"), "utf8");
  assert.equal(workbuddy.includes("resolveNmgDataDir"), true);
  assert.equal(workbuddy.includes("configuredAutoRecallLimit"), true);
  assert.equal(workbuddy.includes("WAKE_KINDS"), false);
  assert.equal(dshMjs.includes("compactSearchContext"), true);
  assert.equal(dshMjs.includes("function searchPreviewOf"), false);
  assert.equal(dshTs.includes("configuredAutoRecallLimit"), true);
  assert.equal(dshTs.includes("readWakeConfig"), true);
});
