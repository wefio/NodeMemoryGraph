/**
 * Matched PR #190 / working tree comparison. Scratch checkout and SQLite files
 * are derived from the given ref and inputs, then deleted.
 */
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { loadDataset } from "../../../evals/retrieval/datasets.ts";
import { percentileFloor } from "../../../tools/parts/stats.ts";
import { heavyDenseWork } from "./dense-work.mjs";
import {
  runAsymmetricDiamondDag,
  runGoldenRetrieval,
  runSyncRerankMicrobench,
} from "./unified-runtime-benchmark-2026-11-25.mjs";

const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), "../../..");
const moduleUrl = fileURLToPath(new URL("./dense-work.mjs", import.meta.url));
const reportPercentiles = (samples) => ({
  p50Ms: percentileFloor(samples, 0.5),
  p95Ms: percentileFloor(samples, 0.95),
  p99Ms: percentileFloor(samples, 0.99),
});
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cpuMsSince = (start) => {
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
};

async function loadSource(source) {
  const load = (relative) => import(pathToFileURL(join(source, "src", relative)).href);
  const [graphs, runtime, rerank, storage, engine, http, vector] = await Promise.all([
    load("core/compute-graph.ts"),
    load("core/runtime/index.ts"),
    load("core/memory/piecewise-rerank.ts"),
    load("core/memory/open.ts"),
    load("core/memory/engine.ts"),
    load("integration/memory-http-service.ts"),
    load("core/vector.ts"),
  ]);
  return { ...graphs, ...runtime, ...rerank, ...storage, ...engine, ...http, ...vector };
}

async function measureProduction(lib, dir, dataset) {
  const backend = await lib.openMemoryBackend({
    kind: "sqlite", path: join(dir, "memory.sqlite"), namespace: "matched-runtime",
  });
  const workerDispatches = {};
  const restore = lib.getSharedRuntimeScheduler().domain.getWorkers().map((worker) => {
    const execute = worker.execute;
    worker.execute = function (task, signal) {
      workerDispatches[task.op] = (workerDispatches[task.op] ?? 0) + 1;
      return execute.call(worker, task, signal);
    };
    return () => { worker.execute = execute; };
  });
  try {
    const now = "2026-10-20T00:00:00.000Z";
    const engine = new lib.MemoryEngine(backend, () => now);
    const http = new lib.HttpMemoryService(engine, undefined, { preprocessMessages: false });
    const conversations = dataset.conversations.slice(0, 8);
    const queries = dataset.questions.slice(0, 32);
    let records = 0;
    const started = performance.now();
    for (const conversation of conversations) {
      const messages = conversation.messages.map((message, i) => ({
        ...message, source_message_id: String(i),
      }));
      assert.ok(messages.length > 0 && messages.length <= 128);
      const operationId = "locomo:" + conversation.conversationId;
      const out = await http.rememberBatch("locomo", conversation.conversationId, operationId, messages, operationId);
      records += out.added;
    }
    const writeMs = performance.now() - started;
    const hashing = new lib.HashingVectorEmbedder();
    const indexId = "offline-hashing";
    const pending = backend.vectorIndex.pending(indexId, 1024);
    backend.vectorIndex.save(indexId, pending, pending.map(({ text }) => [...hashing.embed(text)]));
    const hybrid = new lib.HttpMemoryService(engine, {
      indexId, model: hashing.model, profile: "fixture",
      embedQueries: async (texts) => texts.map((text) => [...hashing.embed(text)]),
    }, { preprocessMessages: false, allowBackfill: false });
    const results = {
      lexical: await measureQueries(http, queries, now),
      hybrid: await measureQueries(hybrid, queries, now),
    };
    return { conversationIds: conversations.map(({ conversationId }) => conversationId),
      queryIds: queries.map(({ id }) => id), records, writeMs, workerDispatches, results };
  } finally {
    for (const reset of restore) reset();
    await backend.close();
  }
}

async function measureQueries(service, queries, now) {
    const results = {};
    const search = (query) => service.search([query], 10, [], undefined, { now });
    for (const concurrency of [1, 8]) {
      for (const query of queries.slice(0, 4)) await search(query.query);
      const latency = [];
      const output = [];
      const cpu = process.cpuUsage();
      const start = performance.now();
      for (let i = 0; i < queries.length; i += concurrency) {
        const batch = queries.slice(i, i + concurrency);
        const pages = await Promise.all(batch.map(async ({ query }) => {
          const begin = performance.now();
          const page = await search(query);
          latency.push(performance.now() - begin);
          return page.memories.map(({ id, score }) => ({ id, score }));
        }));
        output.push(...pages);
      }
      const wallMs = performance.now() - start;
      assert.ok(output.some((page) => page.length > 0));
      results[concurrency] = {
        latency, ...reportPercentiles(latency), wallMs, cpuMs: cpuMsSince(cpu),
        requestsPerSecond: 1000 * queries.length / wallMs, digest: digest(output),
      };
    }
    return results;
}

async function measureTinyGraph(lib) {
  const registry = new lib.ComputeRegistry().register("increment", (inputs) => inputs.default + 1);
  const graph = { id: "tiny-runtime", nodes: [{ id: "n", op: "increment" }], edges: [], output: "n" };
  const sync = [], async = [];
  for (let i = 0; i < 500; i += 1) {
    lib.evaluateSyncComputeGraph(graph, registry, i, undefined);
    await lib.executeComputeGraph(graph, registry, i, undefined);
  }
  for (let batch = 0; batch < 10; batch += 1) {
    const n = 1000;
    let sum = 0;
    let start = performance.now();
    for (let i = 0; i < n; i += 1) sum += lib.evaluateSyncComputeGraph(graph, registry, i, undefined);
    sync.push((performance.now() - start) / n * 1000);
    start = performance.now();
    for (let i = 0; i < n; i += 1) sum -= await lib.executeComputeGraph(graph, registry, i, undefined);
    async.push((performance.now() - start) / n * 1000);
    assert.equal(sum, 0);
  }
  return { unit: "us per call", sync, async };
}

// Wave control uses the same nodes, dependencies and durations as the event-driven probe.
async function waveControl(lib, spec, registry, input, context) {
  const plan = lib.compileComputeGraph(spec, registry);
  const outputs = new Map([[lib.INPUT_NODE_ID, input]]);
  for (const { parallelGroups } of plan.waves) {
    for (const group of parallelGroups) {
      await Promise.all(group.map(async (node) => {
        const inputs = Object.fromEntries(node.incoming.map(({ from, port }) => [port ?? "default", outputs.get(from)]));
        outputs.set(node.id, await registry.get(node.op)(inputs, context, node.params));
      }));
    }
  }
  return outputs.get(plan.outputNodeId);
}

async function measureMixed(lib) {
  const scheduler = new lib.UnifiedRuntimeScheduler({ maxConcurrentBackground: 2 });
  const submit = (priority, index, latency) => {
    const begin = performance.now();
    return scheduler.runTask(async () => {
      if (priority === "background") heavyDenseWork(index, 160_000);
      else await sleep(2);
      latency.push(performance.now() - begin);
    }, { priority });
  };
  try {
    const foreground = [], background = [];
    const start = performance.now();
    const tasks = Array.from({length: 32}, (_, i) => submit("background", i, background));
    for (let wave = 0; wave < 8; wave += 1) {
      await sleep(3);
      for (let i = 0; i < 12; i += 1) tasks.push(submit("foreground", i, foreground));
    }
    await Promise.all(tasks);
    return { foreground, background, wallMs: performance.now() - start,
      foregroundPercentiles: reportPercentiles(foreground), backgroundPercentiles: reportPercentiles(background) };
  } finally {
    await scheduler.close();
  }
}

async function measureWorkers(lib) {
  const result = [];
  for (const workers of [0, 1, 2, 4]) {
    const pool = workers ? new lib.LocalWorkerThreadPool({ maxWorkers: workers }) : undefined;
    const submit = (seed, rounds) => pool?.execute({
      op: "dense-bench", moduleUrl, inputs: { default: { seed, rounds } }, context: {}, params: {},
    });
    try {
      await Promise.all(Array.from({ length: workers }, (_, i) => submit(i, 2000)));
      for (const rounds of [2000, 450000]) {
        const seeds = Array.from({ length: 24 }, (_, i) => i + 1);
        const cpu = process.cpuUsage();
        const start = performance.now();
        const raw = await Promise.all(seeds.map(async (seed) => {
          const begin = performance.now();
          const reply = pool ? await submit(seed, rounds) : { value: heavyDenseWork(seed, rounds) };
          return { seed, latencyMs: performance.now() - begin, ...reply };
        }));
        const wallMs = performance.now() - start;
        assert.deepEqual(raw.map(({ value }) => value), seeds.map((seed) => heavyDenseWork(seed, rounds)));
        result.push({ workers, rounds, raw, wallMs, cpuMs: cpuMsSince(cpu), tasksPerSecond: raw.length / wallMs * 1000,
          ...reportPercentiles(raw.map(({ latencyMs }) => latencyMs)) });
      }
    } finally {
      await pool?.close();
    }
  }
  return result;
}

async function measureExternalLoad(lib) {
  const governor = new lib.HostLoadGovernor({ profile: "balanced", minDwellMs: 300 });
  const scheduler = new lib.UnifiedRuntimeScheduler({ governor, maxConcurrentBackground: 4 });
  const samples = [];
  const admissions = [];
  const sample = async (phase, count) => {
    for (let i = 0; i < count; i += 1) {
      await sleep(300);
      samples.push({ phase, ms: performance.now(), ...governor.sampleHost() });
    }
    let peak = 0;
    let running = 0;
    const start = performance.now();
    await Promise.all(Array.from({ length: 12 }, () => scheduler.runTask(async () => {
      peak = Math.max(peak, ++running);
      await sleep(12);
      running -= 1;
    }, { priority: "background" })));
    admissions.push({ phase, peak, wallMs: performance.now() - start });
  };
  await sample("before", 4);
  const workerCount = Math.min(os.availableParallelism(), 32);
  const child = fork(self, ["--saturate", String(workerCount)], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exited = once(child, "exit");
  try {
    await Promise.race([
      once(child, "message"),
      exited.then(([code]) => { throw new Error("CPU load generator exited before ready: " + code); }),
    ]);
    await sample("external", 8);
  } finally {
    child.kill();
    await exited;
    await sample("recovery", 6);
    await scheduler.close();
  }
  return { workerCount, samples, admissions };
}

async function saturate(count) {
  const source = "const {parentPort}=require('node:worker_threads'); parentPort.postMessage('ready'); while(true){ Math.sqrt(Math.random()); }";
  const workers = Array.from({ length: count }, () => new Worker(source, { eval: true }));
  await Promise.all(workers.map((worker) => once(worker, "message")));
  process.send("ready");
}

async function measure(source, dir, dataset) {
  mkdirSync(dir);
  const lib = await loadSource(source);
  const golden = await runGoldenRetrieval(lib.openMemoryBackend, lib.MemoryEngine, lib.HttpMemoryService);
  return {
    golden,
    production: await measureProduction(lib, dir, dataset),
    tinyGraph: await measureTinyGraph(lib),
    syncRerank: runSyncRerankMicrobench(lib.rerankCandidatesWithGraph, lib.DEFAULT_PIECEWISE_RERANK_GRAPH),
    asymmetry: await runAsymmetricDiamondDag(lib.ComputeRegistry, lib.INPUT_NODE_ID, lib.executeComputeGraph),
    waveControl: await runAsymmetricDiamondDag(lib.ComputeRegistry, lib.INPUT_NODE_ID, (...args) => waveControl(lib, ...args)),
    mixed: await measureMixed(lib),
    workers: await measureWorkers(lib),
    hostLoad: await measureExternalLoad(lib),
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    "baseline-ref": { type: "string" }, "data-root": { type: "string" },
    rounds: { type: "string", default: "2" }, out: { type: "string" },
  } });
  assert.ok(values["baseline-ref"] && values["data-root"] && values.out,
    "usage: --baseline-ref <git ref> --data-root <OmniMemEval data directory> --out <path>");
  const dataset = loadDataset("locomo", { limit: 1 }, resolve(values["data-root"]));
  assert.ok(dataset.conversations.length >= 8 && dataset.questions.length >= 32);
  const rounds = Number(values.rounds);
  assert.ok(Number.isInteger(rounds) && rounds > 0, "--rounds must be a positive integer");
  const scratch = mkdtempSync(join(root, ".runtime-benchmark-"));
  try {
    const archive = join(scratch, "baseline.tar");
    const baselineRef = execFileSync("git", ["rev-parse", "--verify", values["baseline-ref"] + "^{commit}"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["archive", "-o", archive, baselineRef, "src", "scripts/generate-prompts.ts"], { cwd: root });
    execFileSync("tar", ["-xf", archive, "-C", scratch]);
    execFileSync(process.execPath, [join(scratch, "scripts/generate-prompts.ts")], { cwd: scratch });
    const trials = [];
    for (let round = 0; round < rounds; round += 1) {
      const order = round % 2 === 0 ? ["baseline", "post"] : ["post", "baseline"];
      const trial = { order };
      for (const key of order) {
        const source = key === "baseline" ? scratch : root;
        trial[key] = await measure(source, join(scratch, key + "-db-" + round), dataset);
      }
      assertParity(trial.baseline, trial.post);
      trials.push(trial);
    }
    const report = {
      baselineRef, measuredAt: new Date().toISOString(), node: process.version,
      platform: process.platform, arch: process.arch, cores: os.availableParallelism(),
      cpu: os.cpus()[0]?.model, physicalPowerMeasured: false,
      dataset: { name: dataset.name, sha256: dataset.sha256, sampleNote: dataset.sampleNote },
      trials,
    };
    const path = resolve(values.out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write("Wrote " + path + "\n");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function assertParity(baseline, post) {
  assert.equal(baseline.golden.digest, post.golden.digest);
  assert.equal(baseline.production.records, post.production.records);
  for (const mode of ["lexical", "hybrid"]) {
    for (const concurrency of [1, 8]) {
      assert.equal(baseline.production.results[mode][concurrency].digest, post.production.results[mode][concurrency].digest);
    }
  }
}

if (process.argv[2] === "--saturate") await saturate(Number(process.argv[3]));
else await main();
