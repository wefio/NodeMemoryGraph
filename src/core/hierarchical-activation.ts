import { Tensor, gradientStep } from "./autodiff.ts";

/**
 * Phase B: g₁ + g₂ hierarchical activation with learnable scoring weights.
 *
 * g₁: query-conditioned cross-attention over the candidate pool
 * g₂: g₁-conditioned cross-attention over neighborhood
 * Scores: w_sim·sim(q,node) + w_g1·sim(g₁,node) + w_g2·sim(g₂,node)
 */

export interface NodeActivationInput {
  nodeId: string;
  vector: Float32Array; // L2-normalized [d]
}

export interface HierarchicalActivationOutput {
  g1Context: Float32Array; // [d] candidate-pool context
  g1AttentionWeights: Float32Array; // [n_candidates]
  g2Context: Float32Array; // [d] neighborhood context
  g2AttentionWeights: Float32Array; // [n_neighborhood]
  nodeScores: Float32Array; // [n_candidates] blended scores
}

export interface ActivationTrainingSample {
  queryVector: Float32Array;
  candidates: NodeActivationInput[];
  neighborhood?: NodeActivationInput[];
  usedNodeIds: Set<string>;
}

export interface ActivationTrainingResult {
  loss: number;
  trainingSteps: number;
}

export interface HierarchicalActivationState {
  version: 2;
  dimensions: number;
  trainingSteps: number;
  g1Temperature: number;
  scoreWeights: [number, number, number]; // w_sim, w_g1, w_g2
}

export class HierarchicalActivation {
  readonly dimensions: number;
  #trainingSteps: number;
  readonly #temperature: Tensor; // shared attention temperature
  readonly #scoreWeights: Tensor; // [3] scoring weights (will be softmax-normalized)

  constructor(dimensions: number, state?: HierarchicalActivationState) {
    this.dimensions = dimensions;
    this.#trainingSteps = state?.trainingSteps ?? 0;
    this.#temperature = Tensor.scalar(
      state?.g1Temperature ?? 1 / Math.sqrt(dimensions),
      true,
    );
    const [w0, w1, w2] = state?.scoreWeights ?? [1, 1, 1];
    this.#scoreWeights = Tensor.vector([w0, w1, w2], true);
  }

  get trainingSteps(): number {
    return this.#trainingSteps;
  }

  /**
   * Phase B forward: query → g₁ → g₂ → blended scores.
   */
  propagate(
    queryVector: Float32Array,
    candidates: NodeActivationInput[],
    neighborhood: NodeActivationInput[] = [],
  ): HierarchicalActivationOutput {
    const n = candidates.length;
    if (n === 0) {
      return {
        g1Context: new Float32Array(this.dimensions),
        g1AttentionWeights: new Float32Array(0),
        g2Context: new Float32Array(this.dimensions),
        g2AttentionWeights: new Float32Array(0),
        nodeScores: new Float32Array(0),
      };
    }

    // ── Stack candidates into [d, n] ──
    const C = this.#stack(candidates, n);

    // ── g₁: query → cross-attention over candidates ──
    const q = Tensor.vector(queryVector);
    const simQ = q.transpose().matmul(C); // [1, n] raw similarities
    const attnG1 = simQ.multiply(this.#temperature).softmax(); // [1, n]
    const g1 = C.matmul(attnG1.transpose()); // [d, 1]

    // ── g₂: g₁ → cross-attention over neighborhood ──
    let g2: Tensor;
    let attnG2: Tensor;
    if (neighborhood.length > 0) {
      const m = neighborhood.length;
      const N = this.#stack(neighborhood, m);
      const simG2 = g1.transpose().matmul(N).multiply(this.#temperature); // [1, m]
      attnG2 = simG2.softmax();
      g2 = N.matmul(attnG2.transpose()); // [d, 1]
    } else {
      // No neighborhood: g₂ = g₁, uniform attention
      g2 = g1;
      attnG2 = Tensor.vector(new Float32Array(0));
    }

    // ── Blended scores ──
    const scoreWeights = this.#scoreWeights.softmax(); // [3] normalized
    const wSim = scoreWeights.at(0); // scalar
    const wG1 = scoreWeights.at(1);
    const wG2 = scoreWeights.at(2);

    // sim(g₁, candidates): g1^T @ C → [1, n]
    const simG1 = g1.transpose().matmul(C);
    // sim(g₂, candidates): g2^T @ C → [1, n]
    const simG2 = g2.transpose().matmul(C);

    // blended = w_sim * simQ + w_g1 * simG1 + w_g2 * simG2
    const blended = simQ.multiply(wSim)
      .add(simG1.multiply(wG1))
      .add(simG2.multiply(wG2));

    const nodeScores = Float32Array.from(blended.data);

    return {
      g1Context: Float32Array.from(g1.data),
      g1AttentionWeights: Float32Array.from(attnG1.data),
      g2Context: Float32Array.from(g2.data),
      g2AttentionWeights: Float32Array.from(attnG2.data),
      nodeScores,
    };
  }

  /**
   * Train temperature and scoring weights via NLL on softmax(blended scores).
   */
  train(
    sample: ActivationTrainingSample,
    learningRate = 0.05,
  ): ActivationTrainingResult {
    const n = sample.candidates.length;
    if (n === 0) throw new Error("activation training requires at least one candidate");

    // ── Build DAG ──
    const C = this.#stack(sample.candidates, n);

    const q = Tensor.vector(sample.queryVector);
    const simQ = q.transpose().matmul(C);
    const attnG1 = simQ.multiply(this.#temperature).softmax();
    const g1 = C.matmul(attnG1.transpose());

    const neighborhood = sample.neighborhood ?? [];
    let g2: Tensor;
    if (neighborhood.length > 0) {
      const N = this.#stack(neighborhood, neighborhood.length);
      const simG2 = g1.transpose().matmul(N).multiply(this.#temperature);
      const attnG2 = simG2.softmax();
      g2 = N.matmul(attnG2.transpose());
    } else {
      g2 = g1;
    }

    const scoreWeights = this.#scoreWeights.softmax();
    const wSim = scoreWeights.at(0);
    const wG1 = scoreWeights.at(1);
    const wG2 = scoreWeights.at(2);

    const simG1 = g1.transpose().matmul(C);
    const simG2 = g2.transpose().matmul(C);
    const blended = simQ.multiply(wSim)
      .add(simG1.multiply(wG1))
      .add(simG2.multiply(wG2));

    const probs = blended.softmax(); // [1, n]

    // ── NLL loss ──
    let usedLoss: Tensor | null = null;
    for (let i = 0; i < n; i++) {
      if (sample.usedNodeIds.has(sample.candidates[i]!.nodeId)) {
        const term = probs.at(i);
        usedLoss = usedLoss ? usedLoss.add(term) : term;
      }
    }
    if (!usedLoss) throw new Error("activation training requires at least one used node");
    const loss = usedLoss
      .multiply(Tensor.scalar(1 / sample.usedNodeIds.size))
      .log()
      .multiply(Tensor.scalar(-1));

    // ── Backward ──
    const params = this.#parameters();
    params.forEach((p) => p.zeroGrad());
    const lossValue = loss.scalarValue;
    loss.backward();
    gradientStep(params, learningRate);
    this.#trainingSteps += 1;

    return { loss: lossValue, trainingSteps: this.#trainingSteps };
  }

  toJSON(): HierarchicalActivationState {
    const weights = this.#scoreWeights.softmax().data;
    return {
      version: 2,
      dimensions: this.dimensions,
      trainingSteps: this.#trainingSteps,
      g1Temperature: this.#temperature.scalarValue,
      scoreWeights: [weights[0]!, weights[1]!, weights[2]!],
    };
  }

  static fromJSON(state: HierarchicalActivationState): HierarchicalActivation {
    return new HierarchicalActivation(state.dimensions, state);
  }

  // ── helpers ──

  #stack(vectors: NodeActivationInput[], count: number): Tensor {
    const data = new Float32Array(this.dimensions * count);
    for (let col = 0; col < count; col++) {
      const vec = vectors[col]!.vector;
      for (let row = 0; row < this.dimensions; row++) {
        data[row * count + col] = vec[row]!;
      }
    }
    return Tensor.matrix(data, this.dimensions, count);
  }

  #parameters(): Tensor[] {
    return [this.#temperature, this.#scoreWeights];
  }
}
