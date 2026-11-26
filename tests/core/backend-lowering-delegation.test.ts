import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveLayeredConfig } from "../../src/core/capability-config.ts";
import { adaptExternalAlgorithm } from "../../src/core/compute-contracts.ts";
import {
  ComputeBackendRegistry,
  ComputeMemoCache,
  ComputeRegistry,
  DEFAULT_BACKEND_REGISTRY,
  INPUT_NODE_ID,
  compileComputeGraph,
  evaluateSyncComputeGraph,
  explainComputePlan,
  isLegalConvexRegion,
  type ComputeBackendAdapter,
  type ComputeGraphSpec,
} from "../../src/core/compute-graph.ts";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { openMemoryBackend } from "../../src/core/memory/open.ts";
import {
  DEFAULT_GET_CONTEXT_GRAPH,
  DEFAULT_PROJECT_GRAPH,
  DEFAULT_USER_PROFILE_GRAPH,
  ENGINE_VIEW_REGISTRY,
} from "../../src/core/memory/view-compute-graphs.ts";
import {
  DEFAULT_ENGINE_SEARCH_GRAPH,
  ENGINE_SEARCH_REGISTRY,
} from "../../src/core/memory/search-compute-graph.ts";
import {
  resolveEffectiveNmgConfig,
  bindMemoryEngineConfig,
} from "../../src/integration/runtime-config.ts";
import { HttpMemoryService } from "../../src/integration/memory-http-service.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

test("Calcite-style backend capabilities, convex region legality, and cost thresholds", () => {
  // 1. SQLite adapter collapses projection+topology and user-profile regions; portable keeps separate nodes
  const sqlProj = explainComputePlan(
    compileComputeGraph(DEFAULT_PROJECT_GRAPH, ENGINE_VIEW_REGISTRY, { backendTarget: "sqlite" }),
  );
  assert.equal(sqlProj.loweredNodes.select_memories, "sqlite_pushdown");
  assert.equal(sqlProj.loweredNodes.topology, "sqlite_pushdown");
  assert.equal(
    sqlProj.steps.some((s) => s.id === "select_memories"),
    false,
  );
  const topoStep = sqlProj.steps.find((s) => s.id === "topology");
  assert.deepEqual(topoStep?.loweredRegionNodeIds, ["select_memories", "topology"]);

  const noRegionProj = explainComputePlan(
    compileComputeGraph(DEFAULT_PROJECT_GRAPH, ENGINE_VIEW_REGISTRY, {
      backendTarget: "sqlite",
      enableRegionLowering: false,
    }),
  );
  assert.equal(
    noRegionProj.steps.some((s) => s.id === "select_memories"),
    true,
  );
  assert.equal(noRegionProj.loweredNodes.select_memories, "sqlite_pushdown");
  assert.equal(noRegionProj.loweredNodes.topology, undefined);

  const portProj = explainComputePlan(
    compileComputeGraph(DEFAULT_PROJECT_GRAPH, ENGINE_VIEW_REGISTRY, { backendTarget: "portable" }),
  );
  assert.equal(portProj.loweredNodes.select_memories, "portable_scan");
  assert.equal(
    portProj.steps.some((s) => s.id === "select_memories"),
    true,
  );

  const sqlProfile = explainComputePlan(
    compileComputeGraph(DEFAULT_USER_PROFILE_GRAPH, ENGINE_VIEW_REGISTRY, {
      backendTarget: "sqlite",
    }),
  );
  assert.equal(sqlProfile.steps.length, 1);
  assert.equal(sqlProfile.loweredNodes.candidates, "sqlite_pushdown");
  assert.equal(sqlProfile.loweredNodes.assemble, "sqlite_pushdown");

  const sqlSearch = explainComputePlan(
    compileComputeGraph(DEFAULT_ENGINE_SEARCH_GRAPH, ENGINE_SEARCH_REGISTRY, {
      backendTarget: "sqlite",
    }),
  );
  assert.equal(sqlSearch.loweredNodes.recall, "sqlite_pushdown");
  assert.equal(sqlSearch.loweredNodes.temporal, "sqlite_pushdown");

  const sqlGet = explainComputePlan(
    compileComputeGraph(DEFAULT_GET_CONTEXT_GRAPH, ENGINE_VIEW_REGISTRY, {
      backendTarget: "sqlite",
    }),
  );
  assert.equal(sqlGet.loweredNodes.scan, "sqlite_pushdown");

  // 2. Cost threshold gating safely rejects pushdown when ratio is stricter than savings
  const strictCostProj = explainComputePlan(
    compileComputeGraph(DEFAULT_PROJECT_GRAPH, ENGINE_VIEW_REGISTRY, {
      backendTarget: "sqlite",
      costRatioThreshold: 0.1,
    }),
  );
  assert.deepEqual(strictCostProj.loweredNodes, {});

  // 3. Convexity check rejects regions where path exits and re-enters via external intermediate node
  const diamondNodes = [
    { id: "a", op: "p" },
    { id: "ext_mid", op: "p" },
    { id: "c", op: "p" },
  ];
  const diamondEdges = [
    { from: INPUT_NODE_ID, to: "a" },
    { from: "a", to: "ext_mid" },
    { from: "ext_mid", to: "c" },
  ];
  const nodeById = new Map(diamondNodes.map((n) => [n.id, n]));
  const reg = new ComputeRegistry().register("p", (i) => i.default, { effect: "pure" });
  const incoming = new Map([
    ["a", [{ from: INPUT_NODE_ID, to: "a" }]],
    ["ext_mid", [{ from: "a", to: "ext_mid" }]],
    ["c", [{ from: "ext_mid", to: "c" }]],
  ]);
  const outgoing = new Map([
    ["a", ["ext_mid"]],
    ["ext_mid", ["c"]],
    ["c", [] as string[]],
  ]);
  assert.equal(
    isLegalConvexRegion(["a", "c"], "c", {
      specId: "non-convex",
      nodes: diamondNodes,
      edges: diamondEdges,
      output: "c",
      nodeById,
      incoming,
      outgoing,
      enableRegionLowering: true,
      resolveOp: (n) => n.op,
      resolveCaps: (_n, op) => reg.getCapabilities(op),
    }),
    false,
  );

  // 4. Opaque & external black-box nodes never lower into SQLite regions and fall back safely
  const extMod = adaptExternalAlgorithm({
    op: "blackbox",
    invoke: (x: number) => x * 10,
  });
  const extReg = new ComputeRegistry()
    .register("pure_add", (i) => Number(i.default) + 1, { effect: "pure" })
    .registerModule(extMod);
  const mixedSpec: ComputeGraphSpec = {
    id: "mixed-opaque",
    nodes: [
      { id: "add", op: "pure_add" },
      { id: "bb", op: "blackbox" },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "add" },
      { from: "add", to: "bb" },
    ],
    output: "bb",
  };
  assert.equal(evaluateSyncComputeGraph(mixedSpec, extReg, 3, {}), 40);

  // 5. Custom backend adapter versions participate in PLAN_CACHE & ComputeMemoCache keys
  const adapterV1: ComputeBackendAdapter = {
    id: "custom-numeric",
    version: "1.0.0",
    priority: 120,
    capabilities: {
      backendKind: "numeric",
      supportedExprKinds: ["relational_query"],
      supportedOperations: ["ordered_get_page"],
      supportsRegionFusion: false,
      boundaryConversionCostMs: 0.01,
    },
    rules: [
      {
        id: "num.ordered_get",
        description: "Test custom adapter version sensitivity",
        match: (ctx) =>
          ctx.nodes
            .filter(
              (n) =>
                n.expression?.kind === "relational_query" &&
                n.expression.operation === "ordered_get_page",
            )
            .map((n) => ({
              adapterId: "custom-numeric",
              ruleId: "num.ordered_get",
              regionNodeIds: [n.id],
              exitNodeId: n.id,
              loweredTarget: "portable_scan",
              expression: n.expression,
              estimatedLoweredMs: 0.05,
              estimatedBaselineMs: 0.5,
            })),
      },
    ],
  };
  const customRegA = new ComputeBackendRegistry([...DEFAULT_BACKEND_REGISTRY.list(), adapterV1]);
  const customRegB = new ComputeBackendRegistry([
    ...DEFAULT_BACKEND_REGISTRY.list(),
    { ...adapterV1, version: "2.0.0" },
  ]);
  assert.notEqual(customRegA.versionSignature, customRegB.versionSignature);
  const pA = compileComputeGraph(DEFAULT_GET_CONTEXT_GRAPH, ENGINE_VIEW_REGISTRY, {
    backendRegistry: customRegA,
  });
  const pB = compileComputeGraph(DEFAULT_GET_CONTEXT_GRAPH, ENGINE_VIEW_REGISTRY, {
    backendRegistry: customRegB,
  });
  assert.notEqual(pA.backendVersionSignature, pB.backendVersionSignature);
  assert.equal(pA.loweredNodes.get("scan"), "portable_scan");
});

test("L0/L1/L2 optimization configuration separates physical policy from resultIdentityHash", () => {
  const baseCfg = resolveEffectiveNmgConfig({ environment: {} });
  const portableCfg = resolveEffectiveNmgConfig({
    environment: { NMG_OPTIMIZATION_BACKEND: "portable" },
    l2: { optimization: { enableRegionLowering: false, costRatioThreshold: 0.5 } },
  });
  assert.equal(baseCfg.optimization.backend, "auto");
  assert.equal(portableCfg.optimization.backend, "portable");
  assert.equal(portableCfg.optimization.enableRegionLowering, false);
  assert.equal(portableCfg.optimization.costRatioThreshold, 0.5);
  assert.equal(baseCfg.resultIdentityHash, portableCfg.resultIdentityHash);
  assert.equal(portableCfg.provenance.get("optimization.backend")?.layer, "L1");
  assert.equal(portableCfg.provenance.get("optimization.enableRegionLowering")?.layer, "L2");

  const layeredOnly = resolveLayeredConfig({});
  assert.equal(
    (layeredOnly.values.optimization as { enableSyncKernel: boolean }).enableSyncKernel,
    true,
  );
});

test("SQLite lowered paths match portable_scan and LanceMemoryBackend across search, projectGraph, userProfile, get, and timezone edges", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-lowering-parity-"));
  const now = "2026-11-26T12:00:00.000Z";
  const sqliteBackend = await openMemoryBackend({
    kind: "sqlite",
    path: join(dir, "memory.sqlite"),
    namespace: "parity-ns",
  });
  const lanceBackend = await openMemoryBackend({
    kind: "lancedb",
    uri: join(dir, "lance-store"),
    namespace: "parity-ns",
  });
  t.after(async () => {
    await sqliteBackend.close();
    await lanceBackend.close();
    removeTempDirectory(dir);
  });

  const sqlOptEngine = new MemoryEngine(sqliteBackend, () => now, {
    optimization: {
      backend: "sqlite",
      enableRegionLowering: true,
      enableLinearFusion: true,
      enableSyncKernel: true,
      costRatioThreshold: 1.0,
    },
  });
  const portableOptEngine = new MemoryEngine(sqliteBackend, () => now, {
    optimization: {
      backend: "portable",
      enableRegionLowering: false,
      enableLinearFusion: false,
      enableSyncKernel: false,
      costRatioThreshold: 1.0,
    },
  });
  const lanceEngine = new MemoryEngine(lanceBackend, () => now);

  const seedInputs = [
    {
      statement: "Primary storage engine uses SQLite WAL for atomic durable snapshots",
      nodeName: "StorageEngine",
      nodeKind: "entity" as const,
      memoryType: "state" as const,
      stateKey: "storage.engine",
      eventTime: "2026-11-20T09:00:00.000Z",
    },
    {
      statement: "Query optimizer delegates relational projections to native storage indexes",
      nodeName: "Optimizer",
      nodeKind: "concept" as const,
      memoryType: "fact" as const,
      predicateKey: "delegation_mode",
      polarity: "affirmative" as const,
      eventTime: "2026-11-21T10:30:00.000Z",
    },
    {
      statement: "User prefers concise verification tables in dark terminal mode",
      nodeName: "UserStyle",
      memoryType: "preference" as const,
      sourceActor: "user" as const,
      scope: { profile: "user" },
      recallTriggers: ["verification tables", "terminal mode"],
      markers: [
        { kind: "persona_preference", attributes: { summary: "concise verification tables" } },
      ],
      eventTime: "2026-11-18T14:00:00+08:00",
    },
    {
      statement: "Sensitive secret note should stay hidden from userProfile",
      nodeName: "UserStyle",
      memoryType: "constraint" as const,
      sourceActor: "user" as const,
      scope: { profile: "user" },
      recallTriggers: ["verification tables"],
      markers: [{ kind: "sensitive" }],
    },
    {
      statement:
        "Timezone validUntil +08:00 window active at 12:00Z (21:00+08:00 is 13:00Z > 12:00Z)",
      nodeName: "Optimizer",
      validFrom: "2026-11-26T10:00:00+08:00",
      validUntil: "2026-11-26T21:00:00+08:00",
      expiresAt: "2026-11-27T00:00:00Z",
    },
    {
      statement: "Timezone validUntil +08:00 expired at 12:00Z (19:00+08:00 is 11:00Z <= 12:00Z)",
      nodeName: "Optimizer",
      validFrom: "2026-11-26T08:00:00+08:00",
      validUntil: "2026-11-26T19:00:00+08:00",
    },
  ];

  const rSql = await sqlOptEngine.rememberMany(seedInputs, "seed-parity-op");
  const rLance = await lanceEngine.rememberMany(seedInputs, "seed-parity-op");
  await sqlOptEngine.linkNodes(
    {
      sourceNodeId: rSql[0]!.node.id,
      targetNodeId: rSql[1]!.node.id,
      type: "depends_on",
    },
    "link-nodes-op",
  );
  await lanceEngine.linkNodes(
    {
      sourceNodeId: rLance[0]!.node.id,
      targetNodeId: rLance[1]!.node.id,
      type: "depends_on",
    },
    "link-nodes-op",
  );
  await sqlOptEngine.linkMemories(
    {
      sourceMemoryId: rSql[0]!.memory.id,
      targetMemoryId: rSql[1]!.memory.id,
      type: "related_to",
    },
    "link-mems-op",
  );
  await lanceEngine.linkMemories(
    {
      sourceMemoryId: rLance[0]!.memory.id,
      targetMemoryId: rLance[1]!.memory.id,
      type: "related_to",
    },
    "link-mems-op",
  );

  // 1. projectGraph lowered vs portable vs LanceDB
  const projSql = await sqlOptEngine.projectGraph({
    dimensions: ["node", "memoryType", "time"],
    limit: 50,
  });
  const projPort = await portableOptEngine.projectGraph({
    dimensions: ["node", "memoryType", "time"],
    limit: 50,
  });
  assert.deepEqual(projSql, projPort);
  // Active records (all except the expired 19:00+08:00 entry)
  assert.equal(projSql.memoryCount, 5);
  assert.ok(
    projSql.edges.some(
      (e) => e.kind === "explicit" && e.relationType === "depends_on" && e.weight === 2,
    ),
  );

  // Paginated projectGraph (limit < total active memories) must match sort_time DESC ordering across backends
  const projPagedSql = await sqlOptEngine.projectGraph({
    dimensions: ["node", "memoryType", "time"],
    limit: 2,
  });
  const projPagedPort = await portableOptEngine.projectGraph({
    dimensions: ["node", "memoryType", "time"],
    limit: 2,
  });
  const projPagedLance = await lanceEngine.projectGraph({
    dimensions: ["node", "memoryType", "time"],
    limit: 2,
  });
  assert.deepEqual(projPagedSql, projPagedPort);
  assert.equal(projPagedSql.memoryCount, 2);
  assert.equal(projPagedSql.page?.hasMore, true);
  assert.deepEqual(
    projPagedSql.bindings.map((b) => b.memoryId),
    projPagedLance.bindings.map((b) => b.memoryId),
  );

  // 2. userProfile (* list & trigger match) lowered vs portable vs LanceDB
  const profListSql = await sqlOptEngine.userProfile("*", { limit: 10 });
  const profListPort = await portableOptEngine.userProfile("*", { limit: 10 });
  const profListLance = await lanceEngine.userProfile("*", { limit: 10 });
  assert.deepEqual(profListSql, profListPort);
  assert.equal(profListSql.results.length, 1);
  assert.equal(profListLance.results.length, 1);
  assert.equal(profListSql.userProfile?.[0]?.memoryId, profListLance.userProfile?.[0]?.memoryId);

  const profQuerySql = await sqlOptEngine.userProfile("Need verification tables now", { limit: 5 });
  const profQueryPort = await portableOptEngine.userProfile("Need verification tables now", {
    limit: 5,
  });
  assert.deepEqual(profQuerySql, profQueryPort);
  assert.equal(profQuerySql.results.length, 1);

  // 3. lexical search + timezone parity + nodeName filter
  const searchSql = await sqlOptEngine.search("Timezone", { limit: 10, nodeName: "Optimizer" });
  const searchPort = await portableOptEngine.search("Timezone", {
    limit: 10,
    nodeName: "Optimizer",
  });
  const searchLance = await lanceEngine.search("Timezone", { limit: 10, nodeName: "Optimizer" });
  assert.deepEqual(searchSql, searchPort);
  assert.equal(searchSql.results.length, 1); // excludes 19:00+08:00 expired row, keeps 21:00+08:00 active row
  assert.equal(searchSql.results[0]?.memory.id, rSql[4]!.memory.id);
  assert.deepEqual(
    searchSql.results.map((r) => r.memory.id),
    searchLance.results.map((r) => r.memory.id),
  );

  // Exact RegExp search safely falls back on SQLite without error
  const exactSql = await sqlOptEngine.searchExactAnchor(
    { text: "Timezone", pattern: /\+08:00 window active/ },
    { limit: 5 },
  );
  const exactPort = await portableOptEngine.searchExactAnchor(
    { text: "Timezone", pattern: /\+08:00 window active/ },
    { limit: 5 },
  );
  assert.deepEqual(exactSql, exactPort);
  assert.equal(exactSql.results.length, 1);

  // 4. ordered get + includeProfileEvidence semi-join parity + caller order preservation
  const orderedIds = [rSql[2]!.memory.id, rSql[0]!.memory.id, rSql[4]!.memory.id];
  const getSql = await sqlOptEngine.get(orderedIds, { includeProfileEvidence: true });
  const getPort = await portableOptEngine.get(orderedIds, { includeProfileEvidence: true });
  const getLance = await lanceEngine.get(orderedIds, { includeProfileEvidence: true });
  assert.deepEqual(getSql, getPort);
  assert.deepEqual(
    getSql.results.map((r) => r.memory.id),
    orderedIds,
  );
  assert.deepEqual(
    getSql.results.map((r) => r.memory.id),
    getLance.results.map((r) => r.memory.id),
  );
  assert.ok(getSql.results[0]?.profileEvidence?.length);

  // 5. readProfileCandidates & HttpMemoryService.profileSummary via single-query pushdown
  const candSql = await sqlOptEngine.readProfileCandidates({
    sourceActor: "user",
    memoryTypes: ["constraint", "preference"],
  });
  const candPort = await portableOptEngine.readProfileCandidates({
    sourceActor: "user",
    memoryTypes: ["constraint", "preference"],
  });
  assert.deepEqual(candSql, candPort);

  const cfgBound = resolveEffectiveNmgConfig({ environment: {} });
  const httpSvc = new HttpMemoryService(
    new MemoryEngine(sqliteBackend, () => now, bindMemoryEngineConfig(cfgBound)),
    undefined,
    { preprocessMessages: true, capabilities: cfgBound },
  );
  const profileText = await httpSvc.profileSummary("verification tables");
  assert.ok(profileText.includes("dark terminal mode"));

  // 6. Snapshot view isolation across concurrent commit
  const pinnedView = await sqliteBackend.openRead();
  try {
    await sqlOptEngine.remember(
      { statement: "Post-snapshot write for Optimizer visibility check", nodeName: "Optimizer" },
      "concurrent-write-op",
    );
    const snapshotRows = sqliteBackend.lexicalSearchPage!(pinnedView, {
      text: "Optimizer",
      baseQuery: { kind: "memory", limit: 10 },
      limit: 10,
      now,
    });
    assert.equal(snapshotRows.length, 1);
  } finally {
    await sqliteBackend.closeRead(pinnedView);
  }
  const freshRows = await sqlOptEngine.search("Optimizer", { limit: 10 });
  assert.equal(freshRows.results.length, 2);

  // 7. MemoCache tracks registry / sync kernel async guard
  const memo = new ComputeMemoCache();
  const regSyncErr = new ComputeRegistry().register("async_step", async (i) => i.default, {
    effect: "pure",
  });
  const syncErrSpec: ComputeGraphSpec = {
    id: "sync-kernel-async-guard",
    nodes: [{ id: "a", op: "async_step" }],
    edges: [{ from: INPUT_NODE_ID, to: "a" }],
    output: "a",
  };
  assert.throws(
    () => evaluateSyncComputeGraph(syncErrSpec, regSyncErr, 1, {}, memo),
    /async node/i,
  );
});
