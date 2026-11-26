/**
 * Production benchmark comparing NMG backend optimization delegation & compute graph lowering
 * across SQLite pushdowns, portable JS scan fallback, LanceDB parity, and V8 sync DAG kernels.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { canonicalizeComputeValue } from "../../../src/core/canonical-value.ts";
import {
  ComputeRegistry,
  INPUT_NODE_ID,
  compileComputeGraph,
  evaluateSyncComputeGraph,
} from "../../../src/core/compute-graph.ts";
import { MemoryEngine } from "../../../src/core/memory/engine.ts";
import { openMemoryBackend } from "../../../src/core/memory/open.ts";
import {
  DEFAULT_PIECEWISE_RERANK_GRAPH,
  RERANK_COMPUTE_REGISTRY,
  rerankCandidatesWithGraph,
} from "../../../src/core/memory/piecewise-rerank.ts";
import { DEFAULT_PROJECT_GRAPH, ENGINE_VIEW_REGISTRY } from "../../../src/core/memory/view-compute-graphs.ts";
import {
  DEFAULT_HTTP_SEARCH_GRAPH,
  HTTP_SEARCH_COMPUTE_REGISTRY,
} from "../../../src/integration/http-search-graph.ts";
import { HttpMemoryService } from "../../../src/integration/memory-http-service.ts";
import {
  bindMemoryEngineConfig,
  resolveEffectiveNmgConfig,
} from "../../../src/integration/runtime-config.ts";

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function sha256(value) {
  return createHash("sha256").update(canonicalizeComputeValue(value)).digest("hex");
}

function measureCompileCosts() {
  const coldProjUs = [];
  for (let i = 0; i < 40; i += 1) {
    const freshSpec = { ...DEFAULT_PROJECT_GRAPH, id: `cold-proj-${i}` };
    const t0 = performance.now();
    compileComputeGraph(freshSpec, ENGINE_VIEW_REGISTRY, { backendTarget: "sqlite" });
    coldProjUs.push((performance.now() - t0) * 1000);
  }
  const warmSpec = { ...DEFAULT_PROJECT_GRAPH, id: "warm-proj" };
  compileComputeGraph(warmSpec, ENGINE_VIEW_REGISTRY, { backendTarget: "sqlite" });
  const tWarm0 = performance.now();
  for (let i = 0; i < 5000; i += 1) {
    compileComputeGraph(warmSpec, ENGINE_VIEW_REGISTRY, { backendTarget: "sqlite" });
  }
  const warmHitUs = ((performance.now() - tWarm0) / 5000) * 1000;
  coldProjUs.sort((a, b) => a - b);
  return {
    coldProjectCompileMedianUs: round3(quantile(coldProjUs, 0.5)),
    warmPlanCacheHitUs: round3(warmHitUs),
  };
}

function measureJsV8SyncKernels() {
  const candidates = Array.from({ length: 80 }, (_, idx) => ({
    id: `cand-${idx}`,
    statement: `PostgreSQL WAL migration note_${idx} query index tuning_${idx % 6}`,
    combinedScore: 10 - idx * 0.05,
    eventTime: `2026-10-${String(1 + (idx % 20)).padStart(2, "0")}T10:00:00.000Z`,
    sessionId: `sess-${idx % 4}`,
    nodeId: `node-${idx % 7}`,
    turnOrdinal: idx,
    stateKey: idx % 4 === 0 ? `state.${idx % 3}` : null,
  }));
  const baseScores = candidates.map((c) => ({ id: c.id, score: c.combinedScore }));
  const ctx = { queryText: "PostgreSQL query index tuning", candidates };

  const graphBaseline = { ...DEFAULT_PIECEWISE_RERANK_GRAPH, id: "rerank-interp" };
  const graphKernel = { ...DEFAULT_PIECEWISE_RERANK_GRAPH, id: "rerank-kernel" };
  for (let i = 0; i < 30; i += 1) {
    evaluateSyncComputeGraph(graphBaseline, RERANK_COMPUTE_REGISTRY, baseScores, ctx, undefined, {
      enableSyncKernel: false,
      enableLinearFusion: false,
    });
    rerankCandidatesWithGraph(candidates, ctx.queryText, graphKernel);
  }

  const rerankRuns = 250;
  const runTimed = (fn) => {
    const latencies = [];
    const memBefore = process.memoryUsage().heapUsed;
    const cpuBefore = process.cpuUsage();
    const tAll = performance.now();
    for (let i = 0; i < rerankRuns; i += 1) {
      const t0 = performance.now();
      fn();
      latencies.push(performance.now() - t0);
    }
    const wallMs = performance.now() - tAll;
    const cpuDelta = process.cpuUsage(cpuBefore);
    const heapDeltaMb = (process.memoryUsage().heapUsed - memBefore) / (1024 * 1024);
    latencies.sort((a, b) => a - b);
    return {
      runs: rerankRuns,
      wallMs: round3(wallMs),
      p50Ms: round3(quantile(latencies, 0.5)),
      p95Ms: round3(quantile(latencies, 0.95)),
      opsPerSec: round3((rerankRuns / wallMs) * 1000),
      cpuMs: round3((cpuDelta.user + cpuDelta.system) / 1000),
      heapDeltaMb: round3(heapDeltaMb),
    };
  };

  const rerankBaseline = runTimed(() =>
    evaluateSyncComputeGraph(graphBaseline, RERANK_COMPUTE_REGISTRY, baseScores, ctx, undefined, {
      enableSyncKernel: false,
      enableLinearFusion: false,
    }),
  );
  const rerankKernel = runTimed(() =>
    rerankCandidatesWithGraph(candidates, ctx.queryText, graphKernel),
  );

  const batches = [
    {
      clauseIndex: 0,
      appendOnly: false,
      results: Array.from({ length: 16 }, (_, idx) => ({
        memory: { id: `m-${idx}`, statement: `item-${idx}`, markers: [] },
        node: { id: "n1", canonicalName: "N", summary: "" },
        evidence: {
          id: `e-${idx}`,
          content: "c",
          role: "user",
          sessionId: "s",
          sourceMessageId: String(idx),
          sourceRef: null,
          createdAt: "",
        },
        evidenceRecords: [],
        lexicalScore: 0.5,
        vectorScore: 0.5,
        routeScore: 0,
        combinedScore: 1 - idx * 0.04,
        recallReason: "hybrid_match",
      })),
    },
  ];
  const httpCtx = { limit: 8, clauseCount: 1 };
  const httpBaseGraph = { ...DEFAULT_HTTP_SEARCH_GRAPH, id: "http-interp" };
  const httpKernelGraph = { ...DEFAULT_HTTP_SEARCH_GRAPH, id: "http-kernel" };
  for (let i = 0; i < 100; i += 1) {
    evaluateSyncComputeGraph(httpBaseGraph, HTTP_SEARCH_COMPUTE_REGISTRY, batches, httpCtx, undefined, {
      enableSyncKernel: false,
      enableLinearFusion: false,
    });
    evaluateSyncComputeGraph(httpKernelGraph, HTTP_SEARCH_COMPUTE_REGISTRY, batches, httpCtx, undefined, {
      enableSyncKernel: true,
      enableLinearFusion: true,
    });
  }
  const httpRuns = 3000;
  const runHttp = (useKernel, spec) => {
    const t0 = performance.now();
    for (let i = 0; i < httpRuns; i += 1) {
      evaluateSyncComputeGraph(spec, HTTP_SEARCH_COMPUTE_REGISTRY, batches, httpCtx, undefined, {
        enableSyncKernel: useKernel,
        enableLinearFusion: useKernel,
      });
    }
    const wallMs = performance.now() - t0;
    return { runs: httpRuns, wallMs: round3(wallMs), opsPerSec: round3((httpRuns / wallMs) * 1000) };
  };
  const httpBaseline = runHttp(false, httpBaseGraph);
  const httpKernel = runHttp(true, httpKernelGraph);

  const opqReg = new ComputeRegistry().register("tiny_opaque", (i) => Number(i.default) + 1);
  const opqSpec = {
    id: "tiny-opaque-g",
    nodes: [{ id: "o", op: "tiny_opaque" }],
    edges: [{ from: INPUT_NODE_ID, to: "o" }],
    output: "o",
  };
  for (let i = 0; i < 200; i += 1) evaluateSyncComputeGraph(opqSpec, opqReg, i, {});
  const tOpq0 = performance.now();
  for (let i = 0; i < 5000; i += 1) evaluateSyncComputeGraph(opqSpec, opqReg, i, {});
  const opaqueFallback5kMs = round3(performance.now() - tOpq0);

  return {
    piecewiseRerank: {
      baseline: rerankBaseline,
      syncKernel: rerankKernel,
      speedupRatio: round3(rerankBaseline.wallMs / Math.max(0.001, rerankKernel.wallMs)),
    },
    httpDiamond: {
      baseline: httpBaseline,
      syncKernel: httpKernel,
      speedupRatio: round3(httpBaseline.wallMs / Math.max(0.001, httpKernel.wallMs)),
    },
    opaqueFallback5kMs,
  };
}

async function seedCorpus(engine, count) {
  const inputs = Array.from({ length: count }, (_, idx) => {
    const isProfile = idx % 20 === 0;
    return {
      statement: isProfile
        ? `User prefers verification matrix format_${idx}`
        : `Telemetry checkpoint_${idx} verified SQLite pushdown index latency_${idx % 7}`,
      nodeName: `Component_${idx % Math.max(8, Math.floor(count / 15))}`,
      memoryType: isProfile ? "preference" : "fact",
      sourceActor: "user",
      scope: isProfile ? { profile: "user" } : {},
      recallTriggers: isProfile ? ["verification matrix", `format_${idx}`] : undefined,
      markers: isProfile
        ? [{ kind: "persona_preference", attributes: { summary: `format_${idx}` } }]
        : undefined,
      eventTime: `2026-10-${String(1 + (idx % 28)).padStart(2, "0")}T${String(idx % 24).padStart(2, "0")}:00:00.000Z`,
    };
  });
  const ids = [];
  for (let offset = 0; offset < inputs.length; offset += 100) {
    const res = await engine.rememberMany(inputs.slice(offset, offset + 100), `bench-seed-${offset}`);
    if (offset === 0 && res.length >= 2) {
      await engine.linkNodes(
        { sourceNodeId: res[0].node.id, targetNodeId: res[1].node.id, type: "depends_on" },
        "bench-edge-0",
      );
    }
    for (const item of res) ids.push(item.memory.id);
  }
  return ids;
}

async function measureWorkloadOp(iterations, fn) {
  for (let i = 0; i < 3; i += 1) await fn();
  const latencies = [];
  const memBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const tAll = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    await fn();
    latencies.push(performance.now() - t0);
  }
  const wallMs = performance.now() - tAll;
  const cpuDelta = process.cpuUsage(cpuBefore);
  const heapDeltaMb = (process.memoryUsage().heapUsed - memBefore) / (1024 * 1024);
  latencies.sort((a, b) => a - b);
  return {
    iterations,
    wallMs: round3(wallMs),
    p50Ms: round3(quantile(latencies, 0.5)),
    p95Ms: round3(quantile(latencies, 0.95)),
    opsPerSec: round3((iterations / wallMs) * 1000),
    cpuMs: round3((cpuDelta.user + cpuDelta.system) / 1000),
    heapDeltaMb: round3(heapDeltaMb),
  };
}

async function countSqlAndScans(backend, run) {
  let prepareCount = 0;
  let scannedEntities = 0;
  const origPrepare = DatabaseSync.prototype.prepare;
  const origScan = backend.scan;
  DatabaseSync.prototype.prepare = function patchedPrepare(sql) {
    prepareCount += 1;
    return origPrepare.call(this, sql);
  };
  backend.scan = async function patchedScan(...args) {
    const out = await origScan.apply(this, args);
    scannedEntities += out.length;
    return out;
  };
  try {
    await run();
  } finally {
    DatabaseSync.prototype.prepare = origPrepare;
    backend.scan = origScan;
  }
  return { prepareCount, scannedEntities };
}

async function benchmarkScale(count) {
  const dir = mkdtempSync(join(os.tmpdir(), `nmg-lower-scale-${count}-`));
  const now = "2026-11-26T12:00:00.000Z";
  const sqliteBackend = await openMemoryBackend({
    kind: "sqlite",
    path: join(dir, "memory.sqlite"),
    namespace: "bench",
  });
  try {
    const loweredEngine = new MemoryEngine(sqliteBackend, () => now, {
      optimization: {
        backend: "sqlite",
        enableRegionLowering: true,
        enableLinearFusion: true,
        enableSyncKernel: true,
        costRatioThreshold: 1.0,
      },
    });
    const portableEngine = new MemoryEngine(sqliteBackend, () => now, {
      optimization: {
        backend: "portable",
        enableRegionLowering: false,
        enableLinearFusion: false,
        enableSyncKernel: false,
        costRatioThreshold: 1.0,
      },
    });
    const ids = await seedCorpus(loweredEngine, count);
    const sampleGetIds = ids.slice(0, 5);
    const iters = count >= 1000 ? 15 : 25;

    const runProj = (eng) =>
      eng.projectGraph({ dimensions: ["node", "memoryType", "time"], limit: 150 });
    const runProfile = (eng) => eng.userProfile("verification matrix", { limit: 10 });
    const runSearch = (eng) => eng.search("SQLite pushdown latency", { limit: 10 });
    const runGet = (eng) => eng.get(sampleGetIds, { includeProfileEvidence: true });

    const digestsMatch =
      sha256(await runProj(loweredEngine)) === sha256(await runProj(portableEngine)) &&
      sha256(await runProfile(loweredEngine)) === sha256(await runProfile(portableEngine)) &&
      sha256(await runSearch(loweredEngine)) === sha256(await runSearch(portableEngine)) &&
      sha256(await runGet(loweredEngine)) === sha256(await runGet(portableEngine));
    if (!digestsMatch) throw new Error(`Parity digest mismatch at scale N=${count}`);

    const projectGraphLowered = await measureWorkloadOp(iters, () => runProj(loweredEngine));
    const projectGraphPortable = await measureWorkloadOp(iters, () => runProj(portableEngine));
    const userProfileLowered = await measureWorkloadOp(iters, () => runProfile(loweredEngine));
    const userProfilePortable = await measureWorkloadOp(iters, () => runProfile(portableEngine));
    const searchLowered = await measureWorkloadOp(iters, () => runSearch(loweredEngine));
    const searchPortable = await measureWorkloadOp(iters, () => runSearch(portableEngine));
    const getLowered = await measureWorkloadOp(iters, () => runGet(loweredEngine));
    const getPortable = await measureWorkloadOp(iters, () => runGet(portableEngine));

    const counts = {
      projectGraph: {
        lowered: await countSqlAndScans(sqliteBackend, () => runProj(loweredEngine)),
        portable: await countSqlAndScans(sqliteBackend, () => runProj(portableEngine)),
      },
      userProfile: {
        lowered: await countSqlAndScans(sqliteBackend, () => runProfile(loweredEngine)),
        portable: await countSqlAndScans(sqliteBackend, () => runProfile(portableEngine)),
      },
      lexicalSearch: {
        lowered: await countSqlAndScans(sqliteBackend, () => runSearch(loweredEngine)),
        portable: await countSqlAndScans(sqliteBackend, () => runSearch(portableEngine)),
      },
      getWithProfileLinks: {
        lowered: await countSqlAndScans(sqliteBackend, () => runGet(loweredEngine)),
        portable: await countSqlAndScans(sqliteBackend, () => runGet(portableEngine)),
      },
    };

    const cfg = resolveEffectiveNmgConfig({ environment: {} });
    const httpSvc = new HttpMemoryService(
      new MemoryEngine(sqliteBackend, () => now, bindMemoryEngineConfig(cfg)),
      undefined,
      { preprocessMessages: true, capabilities: cfg },
    );
    const httpSummary = await httpSvc.searchSingleClause("SQLite pushdown", 10);

    return {
      corpusCount: count,
      parityVerified: digestsMatch,
      httpReturned: httpSummary.page.results.length,
      latencies: {
        projectGraph: { lowered: projectGraphLowered, portable: projectGraphPortable },
        userProfile: { lowered: userProfileLowered, portable: userProfilePortable },
        lexicalSearch: { lowered: searchLowered, portable: searchPortable },
        getWithProfileLinks: { lowered: getLowered, portable: getPortable },
      },
      counts,
    };
  } finally {
    await sqliteBackend.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  if (!values.out) throw new Error("usage: --out <report.json>");

  const compile = measureCompileCosts();
  const jsV8 = measureJsV8SyncKernels();
  const scales = [];
  for (const n of [50, 250, 1000, 2500]) {
    scales.push(await benchmarkScale(n));
  }

  const report = {
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      powerTelemetryAvailable: false,
    },
    compile,
    jsV8,
    scales,
  };

  const outPath = resolve(values.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote backend lowering benchmark report to ${outPath}\n`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
