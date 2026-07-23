import { Tensor, gradientStep } from "./autodiff.ts";

/**
 * Phase A: g₁-only hierarchical activation.
 *
 * Replaces pure cosine similarity with query-conditioned cross-attention
 * over the candidate pool, producing a global context vector g₁ and
 * attention-weighted node scores.
 */

export interface NodeActivationInput {
  nodeId: string;
  vector: Float32Array; // L2-normalized [d]
}

export interface HierarchicalActivationOutput {
  g1Context: Float32Array; // aggregated context [d]
  attentionWeights: Float32Array; // softmax weights [n]
  nodeScores: Float32Array; // g₁-boosted scores [n]
}

export interface ActivationTrainingSample {
  queryVector: Float32Array;
  candidates: NodeActivationInput[];
  usedNodeIds: Set<string>;
}

export interface ActivationTrainingResult {
  loss: number;
  trainingSteps: number;
}

export interface HierarchicalActivationState {
  version: 1;
  dimensions: number;
  trainingSteps: number;
  g1Temperature: number;
}

export class HierarchicalActivation {
  readonly dimensions: number;
  #trainingSteps: number;
  readonly #g1Temperature: Tensor; // scalar — attention softmax temperature

  constructor(dimensions: number, state?: HierarchicalActivationState) {
    this.dimensions = dimensions;
    this.#trainingSteps = state?.trainingSteps ?? 0;
    this.#g1Temperature = Tensor.scalar(
      state?.g1Temperature ?? 1 / Math.sqrt(dimensions),
      true,
    );
  }

  get trainingSteps(): number {
    return this.#trainingSteps;
  }

  /**
   * Phase A forward pass: query → cross-attention over candidates → g₁ + scores.
   */
  propagate(
    queryVector: Float32Array,
    candidates: NodeActivationInput[],
  ): HierarchicalActivationOutput {
    const n = candidates.length;
    if (n === 0) {
      return {
        g1Context: new Float32Array(this.dimensions),
        attentionWeights: new Float32Array(0),
        nodeScores: new Float32Array(0),
      };
    }

    // Stack candidate vectors into [d, n] row-major matrix
    const stacked = new Float32Array(this.dimensions * n);
    for (let col = 0; col < n; col++) {
      const vec = candidates[col]!.vector;
      for (let row = 0; row < this.dimensions; row++) {
        stacked[row * n + col] = vec[row]!;
      }
    }

    const q = Tensor.vector(queryVector); // [d, 1]
    const C = Tensor.matrix(stacked, this.dimensions, n); // [d, n]

    // Cross-attention: scores = softmax(q^T @ C * temperature)
    // q^T: [1, d], C: [d, n] → [1, n]
    const rawScores = q.transpose().matmul(C).multiply(this.#g1Temperature); // [1, n]
    const attention = rawScores.softmax(); // [1, n]

    // g₁ = C @ attention^T: [d, n] × [n, 1] → [d, 1]
    const g1 = C.matmul(attention.transpose()); // [d, 1]

    // Boosted scores: cosine similarity + attention-weighted bonus
    const cosineSim = rawScores.multiply(
      Tensor.scalar(1 / this.#g1Temperature.scalarValue),
    ).data; // undo temperature scaling to get pure dot-product similarities

    const attnData = attention.data;
    const nodeScores = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Score = cosine similarity + attention boost
      nodeScores[i] = cosineSim[i]! + attnData[i]! * 0.5;
    }

    return {
      g1Context: Float32Array.from(g1.data),
      attentionWeights: Float32Array.from(attnData),
      nodeScores,
    };
  }

  /**
   * Train g₁ temperature to sharpen attention toward used nodes.
   */
  train(
    sample: ActivationTrainingSample,
    learningRate = 0.05,
  ): ActivationTrainingResult {
    const n = sample.candidates.length;
    if (n === 0) throw new Error("activation training requires at least one candidate");

    // Stack candidates
    const stacked = new Float32Array(this.dimensions * n);
    for (let col = 0; col < n; col++) {
      const vec = sample.candidates[col]!.vector;
      for (let row = 0; row < this.dimensions; row++) {
        stacked[row * n + col] = vec[row]!;
      }
    }

    const q = Tensor.vector(sample.queryVector);
    const C = Tensor.matrix(stacked, this.dimensions, n);

    // Forward
    const rawScores = q.transpose().matmul(C).multiply(this.#g1Temperature);
    const attention = rawScores.softmax();

    // Loss: negative log-likelihood of attention on used nodes
    // L = -log(mean_{i in used} attention[i])
    let usedLoss: Tensor | null = null;
    for (let i = 0; i < n; i++) {
      if (sample.usedNodeIds.has(sample.candidates[i]!.nodeId)) {
        const term = attention.at(i);
        usedLoss = usedLoss ? usedLoss.add(term) : term;
      }
    }
    if (!usedLoss) throw new Error("activation training requires at least one used node");
    const meanUsed = usedLoss.multiply(
      Tensor.scalar(1 / sample.usedNodeIds.size),
    );
    const loss = meanUsed.log().multiply(Tensor.scalar(-1));

    // Backward
    this.#g1Temperature.zeroGrad();
    const lossValue = loss.scalarValue;
    loss.backward();
    gradientStep([this.#g1Temperature], learningRate);
    this.#trainingSteps += 1;

    return { loss: lossValue, trainingSteps: this.#trainingSteps };
  }

  toJSON(): HierarchicalActivationState {
    return {
      version: 1,
      dimensions: this.dimensions,
      trainingSteps: this.#trainingSteps,
      g1Temperature: this.#g1Temperature.scalarValue,
    };
  }

  static fromJSON(state: HierarchicalActivationState): HierarchicalActivation {
    return new HierarchicalActivation(state.dimensions, state);
  }
}
