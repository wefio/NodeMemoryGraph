// Backend (execution tier) selection cost model for autodiff graphs.
//
// Calibrated against tools/batch-backend-bench.ts (2026-08-10): for a training
// loop with stable structure + persistent parameters, the compiled flat tape is
// 1.3-3× faster than the interpreter across the whole measured (D, B) grid —
// there is no CPU-side size below which the interpreter wins, provided the
// one-time compile is amortized. Single-shot or non-reusable graphs must use
// the interpreter (compile cost O(V) is never amortized).
//
// The GPU tier is provisional: wired to the in-process WebGPU (Dawn) backend but
// uncalibrated (no WGSL backend exists yet). It applies the Trueno-DB-style
// "compute must dominate transfer/launch" rule and should be re-calibrated the
// day the WGSL tier lands.
//
// This module is deliberately UOp-free: callers (e.g. autodiff.ts) map their
// graph nodes to MetricNode descriptors so the cost model stays testable and
// independent of the internal IR representation.

export type ExecutionTier = "interpreter" | "compiled-tape" | "gpu-wgsl";

/** One graph node, described for the cost model. */
export interface MetricNode {
  rows: number;
  columns: number;
  isMatmul: boolean;
  /** inner dimension of a matmul (other.shape[0]); 0 for non-matmul */
  matmulInner: number;
}

export interface GraphMetrics {
  nodeCount: number;
  /** total materialized bytes (leaf data + every intermediate result) */
  totalBytes: number;
  /** 2·rows·inner·cols summed over matmul ops in the graph */
  matmulFlops: number;
}

export interface ExecutionContext {
  /** graph topology + parameter set stable across calls (a training loop) */
  reusable: boolean;
  /** expected future runs; amortizes a one-time O(V) compile */
  expectedRuns: number;
  /** is the in-process WebGPU backend available? */
  gpuAvailable?: boolean;
}

export interface TierDecision {
  tier: ExecutionTier;
  reason: string;
}

/** Minimum matmul work before GPU launch+transfer overhead can be beaten.
 *  Placeholder calibration — the largest measured CPU matmul
 *  ([1024,128]×[128,1] ≈ 0.5 MFLOP) is still CPU-faster, so the GPU bar is set
 *  an order of magnitude above that and flagged as uncalibrated. */
export const GPU_MIN_MATMUL_FLOPS = 8_000_000;

/** Compile must be amortized over at least this many runs (measured: compiled
 *  wins even for the smallest reusable loop, but a fresh compile costs O(V)). */
export const MIN_REUSE_FOR_COMPILE = 3;

export function estimateGraphMetrics(nodes: readonly MetricNode[]): GraphMetrics {
  let totalBytes = 0;
  let matmulFlops = 0;
  for (const node of nodes) {
    totalBytes += node.rows * node.columns * 4;
    if (node.isMatmul) matmulFlops += 2 * node.rows * node.matmulInner * node.columns;
  }
  return { nodeCount: nodes.length, totalBytes, matmulFlops };
}

/** Pick the fastest tier for a graph, with an auditable reason. */
export function pickTier(metrics: GraphMetrics, context: ExecutionContext): TierDecision {
  // GPU: compute must dominate transfer/launch overhead (Trueno-DB rule).
  if (context.gpuAvailable && metrics.matmulFlops >= GPU_MIN_MATMUL_FLOPS) {
    return {
      tier: "gpu-wgsl",
      reason: `matmul ${Math.round(metrics.matmulFlops / 1e6)}M flop ≥ ${GPU_MIN_MATMUL_FLOPS / 1e6}M threshold (uncalibrated; re-calibrate when WGSL backend lands)`,
    };
  }
  // Compiled: needs amortized compile + stable structure + persistent params.
  if (context.reusable && context.expectedRuns >= MIN_REUSE_FOR_COMPILE) {
    return {
      tier: "compiled-tape",
      reason: `reusable loop (${context.expectedRuns} runs) with ${metrics.nodeCount} nodes, ${Math.round(
        metrics.totalBytes / 1024,
      )}KiB, ${Math.round(metrics.matmulFlops / 1e3)}K matmul flop; measured 1.3-3× faster than interpreter across (D,B) grid`,
    };
  }
  return {
    tier: "interpreter",
    reason: context.reusable
      ? `reusable but only ${context.expectedRuns} expected run(s) < ${MIN_REUSE_FOR_COMPILE}: compile cost O(V) not amortized`
      : "single-shot / non-reusable graph: compile cost never amortized",
  };
}
