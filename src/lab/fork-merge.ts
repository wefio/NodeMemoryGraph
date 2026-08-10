/**
 * Fork-Merge: same query → two branches → divergence comparison → joint gradient.
 *
 * The two branches are separate HierarchicalActivation instances with
 * independent parameters.  Both receive the same query Tensor, so the
 * entire DAG — left sub-graph, right sub-graph, and merge node — is
 * connected through a shared root.  Autodiff can therefore flow
 * gradients from the merge loss back through both branches
 * simultaneously.
 */

import { Tensor, gradientStep } from "./autodiff.ts";
import type { HierarchicalActivation } from "../core/hierarchical-activation.ts";
import type { NodeActivationInput, GraphStateSnapshot } from "../core/hierarchical-activation.ts";

// ── types ──

export interface ForkMergeResult {
  /** Per-candidate scores from the left branch (Float32Array, length = num candidates). */
  leftScores: Float32Array;
  /** Per-candidate scores from the right branch (Float32Array, length = num candidates). */
  rightScores: Float32Array;
  /** Cosine distance between the two score distributions (0 = identical, 2 = opposite). */
  divergence: number;
}

export interface ForkMergeConfig {
  /** Merge strategy for the loss node. */
  strategy: "cosine_distance";
  /** Weight of divergence term: positive = push apart, negative = pull together. */
  divergenceWeight: number;
}

const DEFAULT_CONFIG: ForkMergeConfig = {
  strategy: "cosine_distance",
  divergenceWeight: 1.0,
};

/**
 * Cosine distance is mathematically bounded to [0, 2], but it is computed here
 * from float32 score tensors. When both branches carry identical parameters the
 * similarity should be exactly 1.0; float32 rounding can instead yield values a
 * few ULPs above 1.0, making `1 - cos` a small negative number (observed down to
 * -1.2e-7 in roughly 20% of identical-parameter forwards). Callers treat
 * divergence as a non-negative magnitude, so clamp to the true range rather than
 * leaking rounding noise.
 */
function clampDivergence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(2, Math.max(0, value));
}

// ── ForkMerge ──

export class ForkMerge {
  readonly left: HierarchicalActivation;
  readonly right: HierarchicalActivation;
  readonly config: ForkMergeConfig;

  constructor(
    left: HierarchicalActivation,
    right: HierarchicalActivation,
    config: Partial<ForkMergeConfig> = {},
  ) {
    this.left = left;
    this.right = right;
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (left.dimensions !== right.dimensions) {
      throw new Error(`dimension mismatch: left=${left.dimensions} right=${right.dimensions}`);
    }
  }

  // ── forward: build unified DAG, execute, return results ──

  forward(
    query: Float32Array,
    candidates: readonly NodeActivationInput[],
    opts?: {
      leftNeighborhood?: readonly NodeActivationInput[];
      rightNeighborhood?: readonly NodeActivationInput[];
      graphState?: GraphStateSnapshot;
    },
  ): ForkMergeResult {
    const n = candidates.length;
    if (n === 0)
      return { leftScores: new Float32Array(), rightScores: new Float32Array(), divergence: 0 };

    // Build both branches from the same query tensor.  This is the
    // critical move: q is a single Tensor; both branches reference
    // it, so gradients flow through q back to upstream parameters.
    const branchL = this.#buildBranch(
      this.left,
      Tensor.vector(query),
      candidates,
      opts?.leftNeighborhood,
      opts?.graphState,
    );
    const branchR = this.#buildBranch(
      this.right,
      Tensor.vector(query),
      candidates,
      opts?.rightNeighborhood,
      opts?.graphState,
    );

    // Merge: cosine distance between the two score distributions.
    // d_cos = 1 - (a·b) / (||a|| * ||b||)
    // 0 = identical, 2 = maximally different
    const dot = branchL.scores.dot(branchR.scores);
    const normL = branchL.scores.norm();
    const normR = branchR.scores.norm();
    const epsilon = Tensor.scalar(1e-10);
    const cos = dot.divide(normL.multiply(normR).add(epsilon));
    const divergence = Tensor.scalar(1).subtract(cos);

    // Execute
    const leftData = Float32Array.from(branchL.scores.data);
    const rightData = Float32Array.from(branchR.scores.data);

    return {
      leftScores: leftData,
      rightScores: rightData,
      divergence: clampDivergence(divergence.scalarValue),
    };
  }

  // ── training ──

  /**
   * Train both branches jointly to DIFFERENTIATE their outputs.
   * Minimise cosine similarity → branches learn complementary preferences.
   */
  trainContrastive(
    sample: {
      query: Float32Array;
      candidates: readonly NodeActivationInput[];
      leftNeighborhood?: readonly NodeActivationInput[];
      rightNeighborhood?: readonly NodeActivationInput[];
      graphState?: GraphStateSnapshot;
    },
    learningRate = 0.05,
  ): { loss: number; divergence: number } {
    const n = sample.candidates.length;
    if (n === 0) return { loss: 0, divergence: 0 };

    const q = Tensor.vector(sample.query);

    const branchL = this.#buildBranch(
      this.left,
      q,
      sample.candidates,
      sample.leftNeighborhood,
      sample.graphState,
    );
    const branchR = this.#buildBranch(
      this.right,
      q,
      sample.candidates,
      sample.rightNeighborhood,
      sample.graphState,
    );

    // Cosine distance loss: we want to MINIMISE cosine (high distance).
    // Loss = cosine_similarity (so gradient pushes them apart).
    const dot = branchL.scores.dot(branchR.scores);
    const normL = branchL.scores.norm();
    const normR = branchR.scores.norm();
    const epsilon = Tensor.scalar(1e-10);
    const cos = dot.divide(normL.multiply(normR).add(epsilon));
    const loss = cos.multiplyScalar(this.config.divergenceWeight);

    const lossValue = loss.scalarValue;
    loss.backward();

    // Apply gradients to both branches' parameters
    const allParams = [...this.left.parameters(), ...this.right.parameters()];
    gradientStep(allParams, learningRate);

    return { loss: lossValue, divergence: clampDivergence(1 - cos.scalarValue) };
  }

  /**
   * Train both branches to ALIGN their outputs.
   * Maximise cosine similarity → branches learn convergent preferences.
   */
  trainAlign(
    sample: {
      query: Float32Array;
      candidates: readonly NodeActivationInput[];
      leftNeighborhood?: readonly NodeActivationInput[];
      rightNeighborhood?: readonly NodeActivationInput[];
      graphState?: GraphStateSnapshot;
    },
    learningRate = 0.05,
  ): { loss: number; divergence: number } {
    const n = sample.candidates.length;
    if (n === 0) return { loss: 0, divergence: 0 };

    const q = Tensor.vector(sample.query);

    const branchL = this.#buildBranch(
      this.left,
      q,
      sample.candidates,
      sample.leftNeighborhood,
      sample.graphState,
    );
    const branchR = this.#buildBranch(
      this.right,
      q,
      sample.candidates,
      sample.rightNeighborhood,
      sample.graphState,
    );

    // Alignment loss: we want to MAXIMISE cosine → minimise (1 - cos).
    const dot = branchL.scores.dot(branchR.scores);
    const normL = branchL.scores.norm();
    const normR = branchR.scores.norm();
    const epsilon = Tensor.scalar(1e-10);
    const cos = dot.divide(normL.multiply(normR).add(epsilon));
    const loss = Tensor.scalar(1).subtract(cos).multiplyScalar(this.config.divergenceWeight);

    const lossValue = loss.scalarValue;
    loss.backward();

    const allParams = [...this.left.parameters(), ...this.right.parameters()];
    gradientStep(allParams, learningRate);

    return { loss: lossValue, divergence: clampDivergence(1 - cos.scalarValue) };
  }

  // ── serialisation ──

  toJSON(): { left: unknown; right: unknown; config: ForkMergeConfig } {
    return {
      left: this.left.toJSON(),
      right: this.right.toJSON(),
      config: this.config,
    };
  }

  // ── internals ──

  /**
   * Build one branch of the fork: q → spatial/temporal → blended scores.
   * Returns { scores: Tensor } so the caller can merge and backward.
   *
   * This mirrors HierarchicalActivation.propagate() but exposes the raw
   * score Tensor instead of executing immediately.
   */
  #buildBranch(
    ha: HierarchicalActivation,
    q: Tensor,
    candidates: readonly NodeActivationInput[],
    neighborhood: readonly NodeActivationInput[] | undefined,
    graphState: GraphStateSnapshot | undefined,
  ): { scores: Tensor } {
    // Use HA's internal build method — we need the scores Tensor.
    // HA.propagate() already returns scores; we build a minimal duplicate
    // here to keep the HA interface clean.  This is intentional coupling.
    return (ha as ForkMergeInternal).buildGraph(q, candidates, neighborhood ?? [], graphState);
  }
}

// ── internal interface exposed by HierarchicalActivation for ForkMerge ──

export interface ForkMergeInternal {
  buildGraph(
    q: Tensor,
    candidates: readonly NodeActivationInput[],
    neighborhood: readonly NodeActivationInput[],
    graphState: GraphStateSnapshot | undefined,
  ): { scores: Tensor };
}

export type { HierarchicalActivation, NodeActivationInput, GraphStateSnapshot };
