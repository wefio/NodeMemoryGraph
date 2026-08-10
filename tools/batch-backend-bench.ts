import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { Tensor, gradientStep } from "../src/lab/autodiff.ts";

// ── Batch training backend sweep ─────────────────────────────────────────────
// Measures one training step (forward + backward + gradientStep) for two batch
// representations across a (D, B) grid, under whichever execution tier is
// active in this process (interpreter by default, flat-tape compiled when
// NMG_AUTODIFF_COMPILE=1). Run once per tier, merge the two JSON streams.
//
//   stacked: samples stacked into [B,D]; matmul/arrays grow, graph stays ~const
//   loop:    B per-sample subgraphs summed; graph grows O(B), arrays stay tiny
//
// Parameters persist across steps (a real training loop — like the controller's
// constructor-held weights). Only leaf constant data may change per step; that
// is the exact shape the compiled tape is built to amortize.

interface Row {
  form: "stacked" | "loop";
  d: number;
  b: number;
  us: number;
  checksum: number;
}

const rounds = 7;
const warmup = 50;

const D_GRID = [16, 128];
const B_GRID = [1, 4, 16, 64, 256, 1024];

interface StepState {
  run: () => number;
}

function stackedState(d: number, b: number): StepState {
  const w = Float32Array.from({ length: d }, (_, i) => ((i * 11 + 1) % 97) / 100);
  const W = Tensor.matrix(w, d, 1, true);
  const bias = Tensor.scalar(0.1, true);
  const x = Float32Array.from({ length: b * d }, (_, i) => ((i * 7 + 3) % 101) / 100);
  const X = Tensor.matrix(x, b, d);
  const targets = Float32Array.from({ length: b }, (_, i) => (i % 2 === 0 ? 1 : 0));
  const T = Tensor.matrix(targets, b, 1);
  return {
    run: () => {
      const pred = X.matmul(W).add(bias).sigmoid();
      const diff = pred.add(T.multiply(Tensor.scalar(-1)));
      const loss = diff.multiply(diff).mean();
      const value = loss.scalarValue;
      loss.backward();
      gradientStep([W, bias], 0.01);
      return value + W.grad[0]! + bias.grad[0]!;
    },
  };
}

function loopState(d: number, b: number): StepState {
  const w = Float32Array.from({ length: d }, (_, i) => ((i * 11 + 1) % 97) / 100);
  const W = Tensor.matrix(w, d, 1, true);
  const bias = Tensor.scalar(0.1, true);
  const features: Float32Array[] = [];
  const targets: number[] = [];
  for (let i = 0; i < b; i += 1) {
    features.push(Float32Array.from({ length: d }, (_, j) => ((i * 13 + j * 7 + 3) % 101) / 100));
    targets.push(i % 2 === 0 ? 1 : 0);
  }
  return {
    run: () => {
      const losses: Tensor[] = [];
      for (let i = 0; i < b; i += 1) {
        const pred = Tensor.vector(features[i]!).dot(W).add(bias).sigmoid();
        const target = Tensor.scalar(targets[i]!);
        const diff = pred.add(target.multiply(Tensor.scalar(-1)));
        losses.push(diff.multiply(diff));
      }
      const loss = losses
        .slice(1)
        .reduce((a, c) => a.add(c), losses[0]!)
        .multiply(Tensor.scalar(1 / b));
      const value = loss.scalarValue;
      loss.backward();
      gradientStep([W, bias], 0.01);
      return value + W.grad[0]! + bias.grad[0]!;
    },
  };
}

function medianUs(run: () => number, iterations: number): number {
  for (let i = 0; i < warmup; i += 1) run();
  const durations: number[] = [];
  let checksum = 0;
  for (let r = 0; r < rounds; r += 1) {
    const startedAt = performance.now();
    for (let i = 0; i < iterations; i += 1) checksum += run();
    durations.push(performance.now() - startedAt);
  }
  assert.ok(Number.isFinite(checksum));
  durations.sort((a, b) => a - b);
  return (durations[Math.ceil(0.5 * durations.length) - 1]! * 1000) / iterations;
}

function iterationsFor(b: number): number {
  // tiny graphs can be measured cheaply; large graphs need fewer iterations
  return b <= 4 ? 400 : b <= 64 ? 200 : 100;
}

function main(): void {
  const rows: Row[] = [];
  for (const d of D_GRID) {
    for (const b of B_GRID) {
      const iterations = iterationsFor(b);
      // Build the state once and reuse it across iterations — parameters must
      // persist (a real training loop) or the compiled tape's param-identity
      // guard correctly refuses to engage and the tier is not exercised.
      const stacked = medianUs(stackedState(d, b).run, iterations);
      rows.push({ form: "stacked", d, b, us: stacked, checksum: stacked });
      const loop = medianUs(loopState(d, b).run, iterations);
      rows.push({ form: "loop", d, b, us: loop, checksum: loop });
    }
  }
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

main();
