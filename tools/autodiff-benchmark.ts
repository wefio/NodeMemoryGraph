import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { Tensor } from "../src/core/autodiff.ts";
import { DifferentiableController } from "../src/core/differentiable-controller.ts";

interface Benchmark<State> {
  name: string;
  iterations: number;
  setup(): State;
  run(state: State): number;
}

interface BenchmarkResult {
  name: string;
  iterations: number;
  rounds: number;
  medianMs: number;
  p95Ms: number;
  medianMicrosecondsPerOperation: number;
  operationsPerSecond: number;
  checksum: number;
}

const rounds = positiveInteger(process.env.NMG_AUTODIFF_BENCH_ROUNDS ?? "7");
const warmupIterations = positiveInteger(process.env.NMG_AUTODIFF_BENCH_WARMUP ?? "100");

const featureCount = 32;
const batchSize = 32;
const controllerExamples = Array.from({ length: batchSize }, (_, index) => ({
  features: Array.from(
    { length: featureCount },
    (_, feature) => ((index * 17 + feature * 13) % 101) / 100,
  ),
  target: index % 3 === 0,
}));

const matmulRows = 128;
const matmulColumns = 200;
const matmulLeft = Float32Array.from({ length: matmulRows }, (_, index) => (index % 17) / 17);
const matmulRight = Float32Array.from(
  { length: matmulRows * matmulColumns },
  (_, index) => (index % 19) / 19,
);
const expectedMatmulFirst = referenceFirstColumn(matmulLeft, matmulRight, matmulColumns);

const normalizationInput = Float32Array.from(
  { length: 128 },
  (_, index) => ((index % 23) - 11) / 11,
);
const normalizationWeights = Tensor.vector(
  Float32Array.from({ length: 128 }, (_, index) => ((index * 7) % 29) / 29),
);

const benchmarks: Benchmark<unknown>[] = [
  {
    name: "matmul_forward_1x128_128x200",
    iterations: 1_000,
    setup: () => undefined,
    run: () => {
      const value = Tensor.matrix(matmulLeft, 1, matmulRows).matmul(
        Tensor.matrix(matmulRight, matmulRows, matmulColumns),
      ).data[0]!;
      assert.ok(Math.abs(value - expectedMatmulFirst) < 1e-4);
      return value;
    },
  },
  {
    name: "l2_normalize_backward_128",
    iterations: 500,
    setup: () => undefined,
    run: () => {
      const input = Tensor.vector(normalizationInput, true);
      const loss = input.l2Normalize().dot(normalizationWeights);
      loss.backward();
      const checksum = loss.scalarValue + input.grad[0]!;
      assert.ok(Number.isFinite(checksum));
      return checksum;
    },
  },
  {
    name: "controller_train_f32_b32",
    iterations: 200,
    setup: () => new DifferentiableController(featureCount),
    run: (state) => {
      const controller = state as DifferentiableController;
      const result = controller.train(
        { nodes: controllerExamples, edges: controllerExamples },
        0.01,
      );
      assert.ok(Number.isFinite(result.loss));
      return result.loss;
    },
  },
];

const results = benchmarks.map((benchmark) => measure(benchmark));
process.stdout.write(
  `${JSON.stringify(
    {
      runtime: process.version,
      platform: `${process.platform}-${process.arch}`,
      rounds,
      warmupIterations,
      results,
    },
    null,
    2,
  )}\n`,
);

function measure<State>(benchmark: Benchmark<State>): BenchmarkResult {
  const warmupState = benchmark.setup();
  for (let index = 0; index < warmupIterations; index += 1) benchmark.run(warmupState);

  const durations: number[] = [];
  let checksum = 0;
  for (let round = 0; round < rounds; round += 1) {
    const state = benchmark.setup();
    const startedAt = performance.now();
    for (let index = 0; index < benchmark.iterations; index += 1) {
      checksum += benchmark.run(state);
    }
    durations.push(performance.now() - startedAt);
  }
  assert.ok(Number.isFinite(checksum), `${benchmark.name} produced a non-finite checksum`);
  const medianMs = percentile(durations, 0.5);
  const p95Ms = percentile(durations, 0.95);
  return {
    name: benchmark.name,
    iterations: benchmark.iterations,
    rounds,
    medianMs,
    p95Ms,
    medianMicrosecondsPerOperation: (medianMs * 1_000) / benchmark.iterations,
    operationsPerSecond: benchmark.iterations / (medianMs / 1_000),
    checksum,
  };
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1]!;
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`expected positive integer: ${value}`);
  return parsed;
}

function referenceFirstColumn(
  left: Float32Array,
  right: Float32Array,
  rightColumns: number,
): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += left[index]! * right[index * rightColumns]!;
  }
  return total;
}
