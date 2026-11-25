/**
 * Controlled baseline/post benchmark for NMG unified runtime convergence.
 * Measures: fixed-recipe golden retrieval parity, sync rerank microbenchmark,
 * asymmetric async diamond critical-path execution, foreground vs background
 * concurrency, worker-pool scaling (0/1/2/4 in post mode), and host load modes.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function heavyDenseWork(seed, rounds) {
  let acc = seed * 0.137 + 1.0;
  for (let i = 0; i < rounds; i += 1) {
    acc = Math.sin(acc * 1.00013 + i * 0.001) + Math.cos(acc * 0.9997);
  }
  return acc;
}

async function runGoldenRetrieval(openMemoryBackend, MemoryEngine, HttpMemoryService) {
  const dir = mkdtempSync(join(os.tmpdir(), "nmg-runtime-bench-"));
  const backend = await openMemoryBackend({
    kind: "sqlite",
    path: join(dir, "memory.sqlite"),
    namespace: "runtime-bench",
  });
  try {
    let seq = 0;
    const engine = new MemoryEngine(backend, () => {
      seq += 1;
      return `2026-10-${String(1 + Math.floor(seq / 60)).padStart(2, "0")}T00:${String(seq % 60).padStart(2, "0")}:00.000Z`;
    });
    const docs = [
      {
        statement: "Primary database migrated from PostgreSQL to SQLite WAL for local durability",
        nodeName: "Database Architecture",
        memoryType: "state",
        stateKey: "storage.engine",
        eventTime: "2026-10-02T09:00:00.000Z",
      },
      {
        statement: "Benchmark verified SQLite WAL write throughput at 14k ops per second",
        nodeName: "Database Architecture",
        eventTime: "2026-10-05T11:30:00.000Z",
      },
      {
        statement: "Team decided GraphRAG community cache stays in memory only",
        nodeName: "Cache Strategy",
        eventTime: "2026-10-06T14:00:00.000Z",
      },
      ...Array.from({ length: 57 }, (_, idx) => ({
        statement: `Sprint telemetry record ${idx} monitoring latency and memory budget`,
        nodeName: `Telemetry ${idx % 6}`,
        eventTime: `2026-10-01T${String(idx % 24).padStart(2, "0")}:00:00.000Z`,
      })),
    ];
    await engine.rememberMany(docs, "golden-batch-001");
    const pending = backend.vectorIndex.pending("bench-vec", 128);
    backend.vectorIndex.save(
      "bench-vec",
      pending,
      pending.map((item) => {
        const lower = item.text.toLowerCase();
        if (lower.includes("sqlite") || lower.includes("database")) return [1, 0];
        if (lower.includes("cache")) return [0.7, 0.7];
        return [0.2, 0.9];
      }),
    );

    const engineRes = await engine.search(
      "SQLite database throughput durability",
      { limit: 10 },
      { indexId: "bench-vec", vector: [1, 0], mode: "hybrid" },
    );
    const fakeEmbedder = {
      indexId: "bench-vec",
      model: "bench-2d",
      profile: "plain",
      embed: async (inputs) => inputs.map(() => [1, 0]),
      embedDocuments: async (inputs) => inputs.map(() => [1, 0]),
      embedQueries: async (inputs) => inputs.map(() => [1, 0]),
    };
    const httpService = new HttpMemoryService(engine, fakeEmbedder, {
      allowBackfill: false,
      preprocessMessages: false,
    });
    const httpRes = await httpService.search(["SQLite database durability"], 10);

    const engineSummary = engineRes.results.map((r) => ({
      id: r.memory.id,
      score: round4(r.combinedScore),
    }));
    const httpSummary = httpRes.memories.map((m) => ({
      id: m.id,
      score: round4(m.score),
    }));
    const digest = createHash("sha256")
      .update(JSON.stringify({ engineSummary, httpSummary }))
      .digest("hex");
    if (!engineSummary.length || !httpSummary.length) {
      throw new Error("Golden retrieval returned empty results");
    }
    return {
      queryCount: 2,
      engineCount: engineSummary.length,
      httpCount: httpSummary.length,
      digest,
      topEngineIds: engineSummary.slice(0, 5).map((e) => e.id),
    };
  } finally {
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function runSyncRerankMicrobench(rerankCandidatesWithGraph, DEFAULT_PIECEWISE_RERANK_GRAPH) {
  const candidates = Array.from({ length: 60 }, (_, idx) => ({
    id: `cand-${idx}`,
    statement: `database optimization step_${idx} query latency reduction note_${idx % 5}`,
    combinedScore: 10 - idx * 0.1,
    eventTime: `2026-10-${String(1 + (idx % 12)).padStart(2, "0")}T10:00:00.000Z`,
    sessionId: `sess-${idx % 4}`,
    nodeId: `node-${idx % 7}`,
    stateKey: idx % 3 === 0 ? `state.${idx % 5}` : null,
  }));
  // Warmup
  for (let i = 0; i < 10; i += 1) {
    rerankCandidatesWithGraph(candidates, "database optimization latency", DEFAULT_PIECEWISE_RERANK_GRAPH);
  }
  const latencies = [];
  const memBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const t0 = performance.now();
  const iterations = 200;
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    const out = rerankCandidatesWithGraph(
      candidates,
      "database optimization latency",
      DEFAULT_PIECEWISE_RERANK_GRAPH,
    );
    if (out.length !== candidates.length) throw new Error("Unexpected rerank count");
    latencies.push(performance.now() - start);
  }
  const wallMs = performance.now() - t0;
  const cpuDelta = process.cpuUsage(cpuBefore);
  const memAfter = process.memoryUsage();
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    iterations,
    wallMs: round3(wallMs),
    p50Ms: round3(quantile(sorted, 0.5)),
    p95Ms: round3(quantile(sorted, 0.95)),
    opsPerSec: round3((iterations / wallMs) * 1000),
    userCpuMs: round3(cpuDelta.user / 1000),
    systemCpuMs: round3(cpuDelta.system / 1000),
    heapDeltaMb: round3((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)),
    rssMb: round3(memAfter.rss / (1024 * 1024)),
  };
}

async function runAsymmetricDiamondDag(ComputeRegistry, INPUT_NODE_ID, executeComputeGraph) {
  const reg = new ComputeRegistry();
  const readMeta = {
    version: "1.0.0",
    effect: "read",
    cacheable: false,
    parallelSafe: true,
    resources: { execution: "async_io" },
  };
  reg.register("slow_a", async () => { await sleep(60); return "A"; }, readMeta);
  reg.register("fast_b", async () => { await sleep(5); return 1; }, readMeta);
  reg.register("mid_c", async (i) => { await sleep(28); return Number(i.default) + 1; }, readMeta);
  reg.register("mid_d", async (i) => { await sleep(22); return Number(i.default) + 1; }, readMeta);
  reg.register(
    "join",
    (inputs) => ({ slow: inputs.slow, fast: inputs.fast }),
    { version: "1.0.0", effect: "pure", cacheable: true, parallelSafe: true },
  );
  const spec = {
    id: "asymmetric-diamond-bench",
    nodes: [
      { id: "slowA", op: "slow_a" },
      { id: "fastB", op: "fast_b" },
      { id: "midC", op: "mid_c" },
      { id: "midD", op: "mid_d" },
      { id: "join", op: "join" },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "slowA" },
      { from: INPUT_NODE_ID, to: "fastB" },
      { from: "fastB", to: "midC" },
      { from: "midC", to: "midD" },
      { from: "slowA", to: "join", port: "slow" },
      { from: "midD", to: "join", port: "fast" },
    ],
    output: "join",
  };
  // Warmup once
  await executeComputeGraph(spec, reg, 0, {});
  const wallTimes = [];
  const cpuBefore = process.cpuUsage();
  for (let i = 0; i < 3; i += 1) {
    const start = performance.now();
    const out = await executeComputeGraph(spec, reg, i, {});
    const elapsed = performance.now() - start;
    if (out.slow !== "A" || out.fast !== 3) throw new Error("Invalid diamond DAG output");
    wallTimes.push(elapsed);
  }
  const cpuDelta = process.cpuUsage(cpuBefore);
  wallTimes.sort((a, b) => a - b);
  return {
    runs: wallTimes.length,
    medianWallMs: round3(quantile(wallTimes, 0.5)),
    minWallMs: round3(wallTimes[0]),
    maxWallMs: round3(wallTimes[wallTimes.length - 1]),
    cpuMs: round3((cpuDelta.user + cpuDelta.system) / 1000),
  };
}

async function runForegroundVsBackground(mode, runtimeMod) {
  const fgLatencies = [];
  const bgLatencies = [];
  const startAll = performance.now();

  const runFgItem = async (idx) => {
    const t0 = performance.now();
    await sleep(2);
    heavyDenseWork(idx, 500);
    fgLatencies.push(performance.now() - t0);
  };
  const runBgItem = async (idx) => {
    const t0 = performance.now();
    await sleep(4);
    heavyDenseWork(idx + 100, 30_000);
    await sleep(4);
    bgLatencies.push(performance.now() - t0);
  };

  if (mode === "baseline" || !runtimeMod) {
    const bgTasks = Array.from({ length: 12 }, (_, idx) => runBgItem(idx));
    const fgTasks = Array.from({ length: 20 }, (_, idx) => runFgItem(idx));
    await Promise.all([...bgTasks, ...fgTasks]);
  } else {
    const { UnifiedRuntimeScheduler } = runtimeMod;
    const scheduler = new UnifiedRuntimeScheduler({ maxConcurrentBackground: 2 });
    const bgTasks = Array.from({ length: 12 }, (_, idx) =>
      scheduler.runTask(() => runBgItem(idx), { priority: "background", label: `bg-${idx}` }),
    );
    const fgTasks = Array.from({ length: 20 }, (_, idx) =>
      scheduler.runTask(() => runFgItem(idx), { priority: "foreground", label: `fg-${idx}` }),
    );
    await Promise.all([...bgTasks, ...fgTasks]);
    await scheduler.close();
  }

  const totalWallMs = performance.now() - startAll;
  fgLatencies.sort((a, b) => a - b);
  bgLatencies.sort((a, b) => a - b);
  return {
    fgCount: fgLatencies.length,
    bgCount: bgLatencies.length,
    totalWallMs: round3(totalWallMs),
    fgP50Ms: round3(quantile(fgLatencies, 0.5)),
    fgP95Ms: round3(quantile(fgLatencies, 0.95)),
    bgMedianMs: round3(quantile(bgLatencies, 0.5)),
  };
}

async function runWorkerScaling(mode, runtimeMod) {
  const tasks = 16;
  const workRounds = 450_000;
  if (mode === "baseline" || !runtimeMod) {
    const cpuBefore = process.cpuUsage();
    const start = performance.now();
    let checksum = 0;
    for (let i = 0; i < tasks; i += 1) checksum += heavyDenseWork(i + 1, workRounds);
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuBefore);
    if (!Number.isFinite(checksum)) throw new Error("Non-finite checksum");
    return {
      inline0: {
        workers: 0,
        wallMs: round3(wallMs),
        userCpuMs: round3(cpu.user / 1000),
        throughputTasksPerSec: round3((tasks / wallMs) * 1000),
      },
    };
  }

  const results = {};
  const { LocalWorkerThreadPool } = runtimeMod;
  for (const workers of [0, 1, 2, 4]) {
    if (workers === 0) {
      const cpuBefore = process.cpuUsage();
      const start = performance.now();
      let checksum = 0;
      for (let i = 0; i < tasks; i += 1) checksum += heavyDenseWork(i + 1, workRounds);
      const wallMs = performance.now() - start;
      const cpu = process.cpuUsage(cpuBefore);
      if (!Number.isFinite(checksum)) throw new Error("Non-finite checksum");
      results.inline0 = {
        workers: 0,
        wallMs: round3(wallMs),
        userCpuMs: round3(cpu.user / 1000),
        throughputTasksPerSec: round3((tasks / wallMs) * 1000),
      };
      continue;
    }
    const pool = new LocalWorkerThreadPool({ maxWorkers: workers, id: `bench-pool-${workers}` });
    try {
      // Warm workers before timed loop to measure steady-state execution vs communication overhead
      await Promise.all(
        Array.from({ length: workers }, (_, w) =>
          pool.execute({
            op: "__builtin_dense_bench",
            inputs: { default: { seed: w + 1, rounds: 1000 } },
            context: {},
            params: {},
          }),
        ),
      );
      const start = performance.now();
      const outs = await Promise.all(
        Array.from({ length: tasks }, (_, i) =>
          pool.execute({
            op: "__builtin_dense_bench",
            inputs: { default: { seed: i + 1, rounds: workRounds } },
            context: {},
            params: {},
          }),
        ),
      );
      const wallMs = performance.now() - start;
      if (outs.length !== tasks || !outs.every((v) => Number.isFinite(v.value))) {
        throw new Error("Invalid worker output");
      }
      const avgIpcUs =
        outs.reduce((acc, item) => acc + item.ipcMs, 0) / Math.max(1, outs.length) * 1000;
      results[`workers${workers}`] = {
        workers,
        wallMs: round3(wallMs),
        avgIpcUs: round3(avgIpcUs),
        throughputTasksPerSec: round3((tasks / wallMs) * 1000),
      };
    } finally {
      await pool.close();
    }
  }
  return results;
}

async function runAdaptiveLoadCheck(runtimeMod) {
  if (!runtimeMod?.HostLoadGovernor) return null;
  const { HostLoadGovernor } = runtimeMod;
  const governor = new HostLoadGovernor({ profile: "balanced", minDwellMs: 0 });
  const states = ["idle", "light", "heavy"];
  const matrix = {};
  for (const state of states) {
    const elu = state === "idle" ? 0.05 : state === "light" ? 0.45 : 0.92;
    const budget = governor.evaluateSample({
      eventLoopUtilization: elu,
      p99DelayMs: state === "heavy" ? 85 : 5,
      onBattery: false,
      nowMs: 10_000 + states.indexOf(state) * 1000,
    });
    matrix[state] = {
      loadState: budget.loadState,
      maxBackgroundConcurrency: budget.maxBackgroundConcurrency,
      backgroundCpuBudgetMs: budget.backgroundCpuBudgetMs,
      preferWorkerOffload: budget.preferWorkerOffload,
    };
  }
  const ecoBattery = new HostLoadGovernor({ profile: "eco", minDwellMs: 0 }).evaluateSample({
    eventLoopUtilization: 0.45,
    p99DelayMs: 10,
    onBattery: true,
    nowMs: 5000,
  });
  return {
    ...matrix,
    ecoBattery: {
      loadState: ecoBattery.loadState,
      maxBackgroundConcurrency: ecoBattery.maxBackgroundConcurrency,
      backgroundCpuBudgetMs: ecoBattery.backgroundCpuBudgetMs,
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string" },
      out: { type: "string" },
      baseline: { type: "string" },
    },
  });
  if ((values.mode !== "baseline" && values.mode !== "post") || !values.out) {
    throw new Error("usage: --mode <baseline|post> --out <json-path> [--baseline <baseline.json>]");
  }

  const imp = (rel) => import(pathToFileURL(resolve(REPO_ROOT, rel)).href);
  const { openMemoryBackend } = await imp("src/core/memory/open.ts");
  const { MemoryEngine } = await imp("src/core/memory/engine.ts");
  const { HttpMemoryService } = await imp("src/integration/memory-http-service.ts");
  const { rerankCandidatesWithGraph, DEFAULT_PIECEWISE_RERANK_GRAPH } = await imp(
    "src/core/memory/piecewise-rerank.ts",
  );
  const { ComputeRegistry, INPUT_NODE_ID, executeComputeGraph } = await imp(
    "src/core/compute-graph.ts",
  );
  const runtimeMod =
    values.mode === "post" ? await imp("src/core/runtime/index.ts").catch(() => null) : null;

  const golden = await runGoldenRetrieval(openMemoryBackend, MemoryEngine, HttpMemoryService);
  if (values.baseline) {
    const base = JSON.parse(readFileSync(resolve(values.baseline), "utf8"));
    if (base.golden.digest !== golden.digest) {
      throw new Error(
        `Golden retrieval digest mismatch! baseline=${base.golden.digest} post=${golden.digest}`,
      );
    }
  }
  const syncRerank = runSyncRerankMicrobench(
    rerankCandidatesWithGraph,
    DEFAULT_PIECEWISE_RERANK_GRAPH,
  );
  const diamondDag = await runAsymmetricDiamondDag(
    ComputeRegistry,
    INPUT_NODE_ID,
    executeComputeGraph,
  );
  const fgVsBg = await runForegroundVsBackground(values.mode, runtimeMod);
  const workerScaling = await runWorkerScaling(values.mode, runtimeMod);
  const adaptiveLoad = await runAdaptiveLoadCheck(runtimeMod);

  const report = {
    mode: values.mode,
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      powerTelemetryAvailable: false,
    },
    golden,
    syncRerank,
    diamondDag,
    fgVsBg,
    workerScaling,
    ...(adaptiveLoad ? { adaptiveLoad } : {}),
  };

  const outPath = resolve(values.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${values.mode} benchmark report to ${outPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
