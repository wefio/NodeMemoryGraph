/**
 * Matched probe for the cost-model wait dimension and the asynchronous dispatch floor.
 *
 * Run against two checkouts to compare a change with its baseline, for example:
 *
 *   git worktree add --detach .temp/baseline <ref>
 *   node docs/experiments/runtime/io-wait-probe.mjs --root . --out .temp/current.json
 *   node docs/experiments/runtime/io-wait-probe.mjs --root .temp/baseline --out .temp/baseline.json
 *
 * The `--root` checkout only needs `src/` and `docs/experiments/runtime/`; no installed
 * dependencies are imported by the measured modules.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const DEFAULT_ITERATIONS = 1000;
const DEFAULT_BATCHES = 10;
const FAN_WIDTH = 4;
const FAN_LATENCY_MS = 20;

const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function loadModules(root) {
  const load = (relative) => import(new URL(relative, root).href);
  const [graphs, runtime] = await Promise.all([
    load("src/core/compute-graph.ts"),
    load("src/core/runtime/index.ts"),
  ]);
  return { ...graphs, ...runtime };
}

async function perCallMicros(run, iterations, batches) {
  for (let i = 0; i < 300; i += 1) await run(i);
  const samples = [];
  for (let batch = 0; batch < batches; batch += 1) {
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) await run(i);
    samples.push(((performance.now() - start) / iterations) * 1000);
  }
  return { medianUs: round(median(samples)), samples: samples.map((value) => round(value)) };
}

function fanGraph(lib, delayMs) {
  const registry = new lib.ComputeRegistry();
  const nodes = [];
  const edges = [];
  for (let i = 0; i < FAN_WIDTH; i += 1) {
    registry.register(
      `fan_${i}`,
      async () => {
        await lib.sleep(delayMs);
        return i;
      },
      { effect: "read", parallelSafe: true, resources: { execution: "async_io" } },
    );
    nodes.push({ id: `n${i}`, op: `fan_${i}` });
    edges.push({ from: lib.INPUT_NODE_ID, to: `n${i}` });
  }
  registry.register("join", (inputs) => Object.values(inputs).reduce((a, b) => a + b, 0), {
    effect: "pure",
  });
  nodes.push({ id: "join", op: "join" });
  for (let i = 0; i < FAN_WIDTH; i += 1) edges.push({ from: `n${i}`, to: "join" });
  return { registry, spec: { id: "fan-out", nodes, edges, output: "join" } };
}

async function rankProbe(lib) {
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const registry = new lib.ComputeRegistry()
    .register("fast_read", async () => wait(5), {
      effect: "read",
      parallelSafe: true,
      resources: { execution: "async_io" },
    })
    .register("slow_read", async () => wait(FAN_LATENCY_MS), {
      effect: "read",
      parallelSafe: true,
      resources: { execution: "async_io" },
    })
    .register("join", (inputs) => inputs, { effect: "pure" });
  const single = (op) => ({
    id: `observe-${op}`,
    nodes: [{ id: "out", op }],
    edges: [],
    output: "out",
  });
  const scheduler = new lib.UnifiedRuntimeScheduler();
  for (const op of ["fast_read", "slow_read"]) {
    await lib.withRuntimePolicy(
      undefined,
      () => lib.executeComputeGraph(single(op), registry, null, undefined),
      scheduler,
    );
  }
  const plan = lib.compileComputeGraph(
    {
      id: "rank",
      nodes: [
        { id: "fast", op: "fast_read" },
        { id: "slow", op: "slow_read" },
        { id: "join", op: "join" },
      ],
      edges: [
        { from: lib.INPUT_NODE_ID, to: "fast" },
        { from: lib.INPUT_NODE_ID, to: "slow" },
        { from: "fast", to: "join", port: "fast" },
        { from: "slow", to: "join", port: "slow" },
      ],
      output: "join",
    },
    registry,
  );
  const ranks = lib.computeUpwardRanks(plan, scheduler.costModel, 1);
  const estimates = Object.fromEntries(
    ["fast_read", "slow_read"].map((op) => {
      const estimate = scheduler.costModel.estimate(op, undefined, 1);
      return [op, { cpuMs: round(estimate.cpuMs), waitMs: round(estimate.waitMs) }];
    }),
  );
  await scheduler.close();
  return {
    estimates,
    ranks: { fast: round(ranks.get("fast") ?? 0), slow: round(ranks.get("slow") ?? 0) },
    slowRanksAhead: (ranks.get("slow") ?? 0) > (ranks.get("fast") ?? 0),
  };
}

async function main() {
  const rootArg = readFlag("--root") ?? ".";
  const outArg = readFlag("--out");
  const root = pathToFileURL(resolve(rootArg) + "/");
  const lib = await loadModules(root);
  Object.assign(lib, {
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  });

  const tinyRegistry = new lib.ComputeRegistry().register(
    "increment",
    (inputs) => inputs.default + 1,
  );
  const tinySpec = { id: "tiny", nodes: [{ id: "n", op: "increment" }], edges: [], output: "n" };
  const sync = await perCallMicros(
    (i) => lib.evaluateSyncComputeGraph(tinySpec, tinyRegistry, i, undefined),
    DEFAULT_ITERATIONS,
    DEFAULT_BATCHES,
  );
  const asyncCalls = await perCallMicros(
    (i) => lib.executeComputeGraph(tinySpec, tinyRegistry, i, undefined),
    DEFAULT_ITERATIONS,
    DEFAULT_BATCHES,
  );

  const fan = fanGraph(lib, FAN_LATENCY_MS);
  const scheduler = new lib.UnifiedRuntimeScheduler();
  const runFan = () =>
    lib.withRuntimePolicy(
      undefined,
      () => lib.executeComputeGraph(fan.spec, fan.registry, 0, undefined),
      scheduler,
    );
  await runFan();
  const fanSamples = [];
  for (let i = 0; i < 5; i += 1) {
    const start = performance.now();
    await runFan();
    fanSamples.push(performance.now() - start);
  }
  const fanEstimate = scheduler.costModel.estimate("fan_0", undefined, 1);
  await scheduler.close();

  const result = {
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      root: resolve(rootArg),
      measuredAt: new Date().toISOString(),
    },
    synchronousGraphPerCall: sync,
    asynchronousGraphPerCall: asyncCalls,
    fanOut: {
      width: FAN_WIDTH,
      leafLatencyMs: FAN_LATENCY_MS,
      samples: fanSamples.map((value) => round(value)),
      medianMs: round(median(fanSamples)),
      observedWaitMs: round(fanEstimate.waitMs),
      cpuEstimateMs: round(fanEstimate.cpuMs),
    },
    criticalPath: await rankProbe(lib),
  };
  const text = JSON.stringify(result, null, 2) + "\n";
  if (outArg) {
    mkdirSync(dirname(resolve(outArg)), { recursive: true });
    writeFileSync(resolve(outArg), text);
  }
  process.stdout.write(text);
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

await main();
