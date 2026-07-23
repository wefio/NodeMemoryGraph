import { Tensor, gradientStep } from "./autodiff.ts";

/**
 * Phase D: full hierarchical activation — g₁/g₂/g₃ + h₁/h₂/h₃.
 *
 * Spatial:  g₁ (candidate pool) → g₂ (neighborhood) → g₃ (full graph)
 * Temporal: h₁ (short-term EMA of g₁) → h₂ (medium) → h₃ (long-term)
 * Scoring:  weighted blend of all spatial + temporal similarities
 */

export interface NodeActivationInput {
  nodeId: string;
  vector: Float32Array; // L2-normalized [d]
}

export interface GraphStateSnapshot {
  /** Medium-term stable node vectors (e.g., recently consolidated STG) */
  mediumTermVectors: Float32Array[];
  /** Long-term stable node vectors (e.g., LTG anchors) */
  longTermVectors: Float32Array[];
}

export interface HierarchicalActivationOutput {
  g1Context: Float32Array;
  g1AttentionWeights: Float32Array;
  g2Context: Float32Array;
  g2AttentionWeights: Float32Array;
  g3Context: Float32Array;
  h1State: Float32Array;
  h2State: Float32Array;
  h3State: Float32Array;
  nodeScores: Float32Array;
}

export interface ActivationTrainingSample {
  queryVector: Float32Array;
  candidates: NodeActivationInput[];
  neighborhood?: NodeActivationInput[];
  graphState?: GraphStateSnapshot;
  usedNodeIds: Set<string>;
}

export interface ActivationTrainingResult {
  loss: number;
  trainingSteps: number;
}

export interface HierarchicalActivationState {
  version: 3;
  dimensions: number;
  trainingSteps: number;
  temperature: number;
  scoreWeights: number[]; // [w_sim, w_g1, w_g2, w_g3, w_h1, w_h2, w_h3]
  temporalAlpha: number; // h₁ update rate
  h1State: number[] | null;
}

const SCORE_WEIGHT_COUNT = 7; // w_sim, w_g1, w_g2, w_g3, w_h1, w_h2, w_h3

export class HierarchicalActivation {
  readonly dimensions: number;
  #trainingSteps: number;
  readonly #temperature: Tensor;
  readonly #scoreWeights: Tensor; // [7]
  readonly #temporalAlpha: Tensor; // scalar, h₁ EMA rate
  #h1State: Float32Array | null;

  constructor(dimensions: number, state?: HierarchicalActivationState) {
    this.dimensions = dimensions;
    this.#trainingSteps = state?.trainingSteps ?? 0;
    this.#temperature = Tensor.scalar(
      state?.temperature ?? 1 / Math.sqrt(dimensions),
      true,
    );
    const weights = state?.scoreWeights ?? Array<number>(SCORE_WEIGHT_COUNT).fill(1);
    this.#scoreWeights = Tensor.vector(weights, true);
    this.#temporalAlpha = Tensor.scalar(state?.temporalAlpha ?? 0.3, true);
    this.#h1State = state?.h1State
      ? new Float32Array(state.h1State)
      : null;
  }

  get trainingSteps(): number {
    return this.#trainingSteps;
  }

  // ── forward ──

  propagate(
    queryVector: Float32Array,
    candidates: NodeActivationInput[],
    neighborhood: NodeActivationInput[] = [],
    graphState?: GraphStateSnapshot,
  ): HierarchicalActivationOutput {
    const n = candidates.length;
    const zeroOut = {
      g1Context: new Float32Array(this.dimensions),
      g1AttentionWeights: new Float32Array(0),
      g2Context: new Float32Array(this.dimensions),
      g2AttentionWeights: new Float32Array(0),
      g3Context: new Float32Array(this.dimensions),
      h1State: this.#h1State ?? new Float32Array(this.dimensions),
      h2State: new Float32Array(this.dimensions),
      h3State: new Float32Array(this.dimensions),
      nodeScores: new Float32Array(0),
    };
    if (n === 0) return zeroOut;

    const q = Tensor.vector(queryVector);
    const C = this.#stack(candidates, n);

    // ── g₁: query → candidates cross-attention ──
    const simQ = q.transpose().matmul(C);
    const attnG1 = simQ.multiply(this.#temperature).softmax();
    const g1 = C.matmul(attnG1.transpose());

    // ── g₂: g₁ → neighborhood cross-attention ──
    const m = neighborhood.length;
    let g2: Tensor;
    let attnG2Data: Float32Array;
    if (m > 0) {
      const N = this.#stack(neighborhood, m);
      const simG2 = g1.transpose().matmul(N).multiply(this.#temperature);
      const attnG2 = simG2.softmax();
      g2 = N.matmul(attnG2.transpose());
      attnG2Data = Float32Array.from(attnG2.data);
    } else {
      g2 = g1;
      attnG2Data = new Float32Array(0);
    }

    // ── Temporal projections ──
    const g1Data = Float32Array.from(g1.data);
    const g2Data = Float32Array.from(g2.data);

    // h₁: EMA of g₁
    const alpha = this.#temporalAlpha.scalarValue;
    const h1 = new Float32Array(this.dimensions);
    const prevH1 = this.#h1State ?? new Float32Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) {
      h1[i] = alpha * g1Data[i]! + (1 - alpha) * prevH1[i]!;
    }
    this.#h1State = h1;

    // h₂: mean of medium-term stable vectors
    const h2 = this.#meanVector(graphState?.mediumTermVectors);

    // h₃: mean of long-term stable vectors
    const h3 = this.#meanVector(graphState?.longTermVectors);

    // ── g₃: fusion g₁ + g₂ + h₁ + h₂ + h₃ ──
    const h1T = Tensor.vector(h1);
    const h2T = Tensor.vector(h2);
    const h3T = Tensor.vector(h3);
    const g3 = g1.add(g2).add(h1T).add(h2T).add(h3T).l2Normalize();

    // ── Blended scores ──
    const sw = this.#scoreWeights.softmax();
    const simG1 = g1.transpose().matmul(C);
    const simG2 = g2.transpose().matmul(C);
    const simG3 = g3.transpose().matmul(C);
    const simH1 = h1T.transpose().matmul(C);
    const simH2 = h2T.transpose().matmul(C);
    const simH3 = h3T.transpose().matmul(C);

    const blended = simQ.multiply(sw.at(0))
      .add(simG1.multiply(sw.at(1)))
      .add(simG2.multiply(sw.at(2)))
      .add(simG3.multiply(sw.at(3)))
      .add(simH1.multiply(sw.at(4)))
      .add(simH2.multiply(sw.at(5)))
      .add(simH3.multiply(sw.at(6)));

    return {
      g1Context: g1Data,
      g1AttentionWeights: Float32Array.from(attnG1.data),
      g2Context: g2Data,
      g2AttentionWeights: attnG2Data,
      g3Context: Float32Array.from(g3.data),
      h1State: h1,
      h2State: h2,
      h3State: h3,
      nodeScores: Float32Array.from(blended.data),
    };
  }

  // ── training ──

  train(
    sample: ActivationTrainingSample,
    learningRate = 0.05,
  ): ActivationTrainingResult {
    const n = sample.candidates.length;
    if (n === 0) throw new Error("activation training requires at least one candidate");

    // Build forward DAG
    const q = Tensor.vector(sample.queryVector);
    const C = this.#stack(sample.candidates, n);

    const simQ = q.transpose().matmul(C);
    const attnG1 = simQ.multiply(this.#temperature).softmax();
    const g1 = C.matmul(attnG1.transpose());

    const neighborhood = sample.neighborhood ?? [];
    const m = neighborhood.length;
    let g2: Tensor;
    if (m > 0) {
      const N = this.#stack(neighborhood, m);
      const simG2 = g1.transpose().matmul(N).multiply(this.#temperature);
      g2 = N.matmul(simG2.softmax().transpose());
    } else {
      g2 = g1;
    }

    // Temporal (detached from current graph for training stability — uses stored state)
    const h1 = Tensor.vector(this.#h1State ?? new Float32Array(this.dimensions));
    const h2 = Tensor.vector(
      this.#meanVector(sample.graphState?.mediumTermVectors),
    );
    const h3 = Tensor.vector(
      this.#meanVector(sample.graphState?.longTermVectors),
    );

    const g3 = g1.add(g2).add(h1).add(h2).add(h3).l2Normalize();

    // Blended scores (reuse simQ from g₁ step)
    const sw = this.#scoreWeights.softmax();
    const blended = simQ.multiply(sw.at(0))
      .add(g1.transpose().matmul(C).multiply(sw.at(1)))
      .add(g2.transpose().matmul(C).multiply(sw.at(2)))
      .add(g3.transpose().matmul(C).multiply(sw.at(3)))
      .add(h1.transpose().matmul(C).multiply(sw.at(4)))
      .add(h2.transpose().matmul(C).multiply(sw.at(5)))
      .add(h3.transpose().matmul(C).multiply(sw.at(6)));

    const probs = blended.softmax();

    // NLL loss on used nodes
    let usedLoss: Tensor | null = null;
    const usedIds = sample.usedNodeIds;
    const usedCount = sample.candidates.filter(
      (c) => usedIds.has(c.nodeId),
    ).length;
    if (usedCount === 0) throw new Error("activation training requires at least one used node");

    for (let i = 0; i < n; i++) {
      if (usedIds.has(sample.candidates[i]!.nodeId)) {
        const term = probs.at(i);
        usedLoss = usedLoss ? usedLoss.add(term) : term;
      }
    }
    const loss = usedLoss!
      .multiply(Tensor.scalar(1 / usedCount))
      .log()
      .multiply(Tensor.scalar(-1));

    // Backward
    const params = this.#parameters();
    params.forEach((p) => p.zeroGrad());
    const lossValue = loss.scalarValue;
    loss.backward();
    gradientStep(params, learningRate);
    this.#trainingSteps += 1;

    return { loss: lossValue, trainingSteps: this.#trainingSteps };
  }

  // ── persistence ──

  toJSON(): HierarchicalActivationState {
    const weights = this.#scoreWeights.softmax().data;
    return {
      version: 3,
      dimensions: this.dimensions,
      trainingSteps: this.#trainingSteps,
      temperature: this.#temperature.scalarValue,
      scoreWeights: Array.from(weights),
      temporalAlpha: this.#temporalAlpha.scalarValue,
      h1State: this.#h1State ? Array.from(this.#h1State) : null,
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

  #meanVector(vectors: Float32Array[] | undefined): Float32Array {
    const result = new Float32Array(this.dimensions);
    if (!vectors || vectors.length === 0) return result;
    const invN = 1 / vectors.length;
    for (const v of vectors) {
      for (let i = 0; i < this.dimensions; i++) {
        result[i] += v[i]! * invN;
      }
    }
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) norm += result[i]! ** 2;
    if (norm > 0) {
      const invNorm = 1 / Math.sqrt(norm);
      for (let i = 0; i < this.dimensions; i++) result[i]! *= invNorm;
    }
    return result;
  }

  #parameters(): Tensor[] {
    return [this.#temperature, this.#scoreWeights, this.#temporalAlpha];
  }
}
