import { gradientStep, Tensor } from "./autodiff.ts";

export const CONTROLLER_BUDGET_DIMENSIONS = [
  "nodes",
  "edges",
  "evidence",
  "tokens",
  "graphHops",
  "localTier",
  "latencyMs",
] as const;

export type ControllerBudgetDimension = (typeof CONTROLLER_BUDGET_DIMENSIONS)[number];
export type ControllerAction = "expand" | "stop";

export interface BinaryRouteExample {
  features: readonly number[];
  target: boolean;
}

export interface PairwiseRouteExample {
  preferredFeatures: readonly number[];
  rejectedFeatures: readonly number[];
}

export interface ControllerTrainingExample {
  memories?: readonly BinaryRouteExample[];
  memoryPairs?: readonly PairwiseRouteExample[];
  nodes?: readonly BinaryRouteExample[];
  edges?: readonly BinaryRouteExample[];
  control?: {
    features: readonly number[];
    target: ControllerAction;
  };
  budget?: {
    features: readonly number[];
    targets: readonly number[];
  };
}

export interface ControllerTrainingResult {
  loss: number;
  observations: number;
  trainingSteps: number;
}

export interface DifferentiableControllerState {
  version: 1;
  featureCount: number;
  trainingSteps: number;
  parameters: {
    nodeWeights: number[];
    nodeBias: number[];
    memoryWeights?: number[];
    memoryBias?: number[];
    edgeWeights: number[];
    edgeBias: number[];
    controlWeights: number[];
    controlBias: number[];
    budgetWeights: number[];
    budgetBias: number[];
  };
}

interface Head {
  weights: Tensor;
  bias: Tensor;
}

const BATCH_THRESHOLD = 8;

// Power-of-2 padding only helps when feature dim is large enough for
// cache-line alignment to matter. Data shows consistent 1-7% gain at
// F=256, negligible benefit at F≤128.
const PAD_FEATURE_MIN = 192;
const PAD_RATIO_MAX = 0.125;

function nextPow2(n: number): number {
  return 1 << (32 - Math.clz32(n - 1));
}

export class DifferentiableController {
  readonly featureCount: number;
  #trainingSteps: number;
  readonly #node: Head;
  readonly #memory: Head;
  readonly #edge: Head;
  readonly #control: Head;
  readonly #budget: Head;

  constructor(featureCount: number, state?: DifferentiableControllerState) {
    if (!Number.isInteger(featureCount) || featureCount < 1) {
      throw new Error("controller feature count must be a positive integer");
    }
    if (state && (state.version !== 1 || state.featureCount !== featureCount)) {
      throw new Error("controller state is incompatible with the requested feature count");
    }
    this.featureCount = featureCount;
    this.#trainingSteps = state?.trainingSteps ?? 0;
    this.#node = this.#head(1, state?.parameters.nodeWeights, state?.parameters.nodeBias);
    this.#memory = this.#head(1, state?.parameters.memoryWeights, state?.parameters.memoryBias);
    this.#edge = this.#head(1, state?.parameters.edgeWeights, state?.parameters.edgeBias);
    this.#control = this.#head(2, state?.parameters.controlWeights, state?.parameters.controlBias);
    this.#budget = this.#head(
      CONTROLLER_BUDGET_DIMENSIONS.length,
      state?.parameters.budgetWeights,
      state?.parameters.budgetBias,
    );
  }

  get trainingSteps(): number {
    return this.#trainingSteps;
  }

  scoreNode(features: readonly number[]): number {
    return this.#binaryScore(this.#node, features);
  }

  scoreMemory(features: readonly number[]): number {
    return this.#binaryScore(this.#memory, features);
  }

  scoreEdge(features: readonly number[]): number {
    return this.#binaryScore(this.#edge, features);
  }

  chooseControl(features: readonly number[]): {
    action: ControllerAction;
    probabilities: Record<ControllerAction, number>;
  } {
    const probabilities = this.#linear(this.#control, features).softmax().data;
    const result = { stop: probabilities[0]!, expand: probabilities[1]! };
    return {
      action: result.expand > result.stop ? "expand" : "stop",
      probabilities: result,
    };
  }

  allocateBudget(features: readonly number[]): Record<ControllerBudgetDimension, number> {
    const fractions = this.#linear(this.#budget, features).sigmoid().data;
    return Object.fromEntries(
      CONTROLLER_BUDGET_DIMENSIONS.map(
        (dimension, index) => [dimension, fractions[index]!] as const,
      ),
    ) as Record<ControllerBudgetDimension, number>;
  }

  train(example: ControllerTrainingExample, learningRate = 0.05): ControllerTrainingResult {
    const losses: Tensor[] = [];
    let totalObservations = 0;

    const memoryExamples = example.memories ?? [];
    if (memoryExamples.length >= BATCH_THRESHOLD) {
      losses.push(this.#batchedBinaryLoss(this.#memory, memoryExamples));
      totalObservations += memoryExamples.length;
    } else {
      for (const item of memoryExamples) {
        losses.push(binaryCrossEntropy(this.#binary(this.#memory, item.features), item.target));
        totalObservations += 1;
      }
    }

    const memoryPairs = example.memoryPairs ?? [];
    for (const pair of memoryPairs) {
      const preferred = this.#linear(this.#memory, pair.preferredFeatures);
      const rejected = this.#linear(this.#memory, pair.rejectedFeatures);
      const margin = preferred.add(rejected.multiply(Tensor.scalar(-1)));
      losses.push(margin.sigmoid().log().multiply(Tensor.scalar(-1)));
      totalObservations += 1;
    }

    const nodeExamples = example.nodes ?? [];
    if (nodeExamples.length >= BATCH_THRESHOLD) {
      losses.push(this.#batchedBinaryLoss(this.#node, nodeExamples));
      totalObservations += nodeExamples.length;
    } else {
      for (const item of nodeExamples) {
        losses.push(binaryCrossEntropy(this.#binary(this.#node, item.features), item.target));
        totalObservations += 1;
      }
    }

    const edgeExamples = example.edges ?? [];
    if (edgeExamples.length >= BATCH_THRESHOLD) {
      losses.push(this.#batchedBinaryLoss(this.#edge, edgeExamples));
      totalObservations += edgeExamples.length;
    } else {
      for (const item of edgeExamples) {
        losses.push(binaryCrossEntropy(this.#binary(this.#edge, item.features), item.target));
        totalObservations += 1;
      }
    }

    if (example.control) {
      const probabilities = this.#linear(this.#control, example.control.features).softmax();
      const targetIndex = example.control.target === "stop" ? 0 : 1;
      losses.push(probabilities.at(targetIndex).log().multiply(Tensor.scalar(-1)));
      totalObservations += 1;
    }
    if (example.budget) {
      if (example.budget.targets.length !== CONTROLLER_BUDGET_DIMENSIONS.length) {
        throw new Error("budget target count does not match controller budget dimensions");
      }
      const prediction = this.#linear(this.#budget, example.budget.features).sigmoid();
      const target = Tensor.vector(example.budget.targets.map((value) => clamp(value, 0, 1)));
      const difference = prediction.add(target.multiply(Tensor.scalar(-1)));
      losses.push(difference.multiply(difference).mean());
      totalObservations += 1;
    }
    if (totalObservations === 0)
      throw new Error("controller training requires at least one target");

    const parameters = this.#parameters();
    parameters.forEach((parameter) => parameter.zeroGrad());
    const loss = losses
      .slice(1)
      .reduce((total, item) => total.add(item), losses[0]!)
      .multiply(Tensor.scalar(1 / totalObservations));
    const value = loss.scalarValue;
    loss.backward();
    gradientStep(parameters, learningRate);
    this.#trainingSteps += 1;
    return { loss: value, observations: totalObservations, trainingSteps: this.#trainingSteps };
  }

  toJSON(): DifferentiableControllerState {
    return {
      version: 1,
      featureCount: this.featureCount,
      trainingSteps: this.#trainingSteps,
      parameters: {
        nodeWeights: [...this.#node.weights.data],
        nodeBias: [...this.#node.bias.data],
        memoryWeights: [...this.#memory.weights.data],
        memoryBias: [...this.#memory.bias.data],
        edgeWeights: [...this.#edge.weights.data],
        edgeBias: [...this.#edge.bias.data],
        controlWeights: [...this.#control.weights.data],
        controlBias: [...this.#control.bias.data],
        budgetWeights: [...this.#budget.weights.data],
        budgetBias: [...this.#budget.bias.data],
      },
    };
  }

  static fromJSON(state: DifferentiableControllerState): DifferentiableController {
    return new DifferentiableController(state.featureCount, state);
  }

  #binaryScore(head: Head, features: readonly number[]): number {
    return this.#binary(head, features).scalarValue;
  }

  #binary(head: Head, features: readonly number[]): Tensor {
    return this.#linear(head, features).sigmoid();
  }

  #linear(head: Head, features: readonly number[]): Tensor {
    this.#validateFeatures(features);
    return head.weights.matmul(Tensor.vector(features)).add(head.bias);
  }

  #head(rows: number, weights?: readonly number[], bias?: readonly number[]): Head {
    const expectedWeights = rows * this.featureCount;
    if (weights && weights.length !== expectedWeights) {
      throw new Error("controller weight shape is invalid");
    }
    if (bias && bias.length !== rows) throw new Error("controller bias shape is invalid");
    return {
      weights: Tensor.matrix(
        weights ?? new Float32Array(expectedWeights),
        rows,
        this.featureCount,
        true,
      ),
      bias: Tensor.vector(bias ?? new Float32Array(rows), true),
    };
  }

  #batchedBinaryLoss(head: Head, examples: readonly BinaryRouteExample[]): Tensor {
    const B = examples.length;
    const F = this.featureCount;
    const padded = nextPow2(B);

    // Pad to next power of 2 only when F is large (cache alignment)
    // and the overhead is acceptable.
    if (F >= PAD_FEATURE_MIN && padded > B && (padded - B) / B < PAD_RATIO_MAX) {
      return this.#batchedBinaryLossPadded(head, examples, B, F, padded);
    }

    // Stack features into [F, B] row-major matrix: element (r,c) = feature r of example c
    const stacked = new Float32Array(F * B);
    for (let col = 0; col < B; col++) {
      const feats = examples[col]!.features;
      for (let row = 0; row < F; row++) {
        stacked[row * B + col] = feats[row]!;
      }
    }

    // W: [1, F], V: [F, B] → scores: [1, B]
    const V = Tensor.matrix(stacked, F, B);
    const scores = head.weights.matmul(V).add(head.bias);
    const probs = scores.sigmoid();

    // Target: [1, B]
    const targetData = new Float32Array(B);
    for (let i = 0; i < B; i++) targetData[i] = examples[i]!.target ? 1 : 0;
    const t = Tensor.matrix(targetData, 1, B);

    // BCE = -(t·log(p) + (1-t)·log(1-p)), sum over batch
    const term1 = t.multiply(probs.log());
    const oneMinusT = Tensor.scalar(1).add(t.multiply(Tensor.scalar(-1)));
    const oneMinusP = Tensor.scalar(1).add(probs.multiply(Tensor.scalar(-1)));
    const term2 = oneMinusT.multiply(oneMinusP.log());
    return term1.add(term2).multiply(Tensor.scalar(-1)).sum();
  }

  #batchedBinaryLossPadded(
    head: Head,
    examples: readonly BinaryRouteExample[],
    B: number,
    F: number,
    padded: number,
  ): Tensor {
    // Stack features into [F, padded] row-major, trailing cols = 0
    const stacked = new Float32Array(F * padded);
    for (let col = 0; col < B; col++) {
      const feats = examples[col]!.features;
      for (let row = 0; row < F; row++) {
        stacked[row * padded + col] = feats[row]!;
      }
    }

    // W: [1, F], V: [F, padded] → scores: [1, padded]
    const V = Tensor.matrix(stacked, F, padded);
    const scores = head.weights.matmul(V).add(head.bias);
    const probs = scores.sigmoid();

    // Target: [1, padded], trailing = 0
    const targetData = new Float32Array(padded);
    for (let i = 0; i < B; i++) targetData[i] = examples[i]!.target ? 1 : 0;
    const t = Tensor.matrix(targetData, 1, padded);

    // Mask: first B cols = 1, rest = 0
    const maskData = new Float32Array(padded);
    for (let i = 0; i < B; i++) maskData[i] = 1;
    const mask = Tensor.matrix(maskData, 1, padded);

    // BCE = -(t·log(p) + (1-t)·log(1-p)), masked for real examples only
    const term1 = t.multiply(probs.log());
    const oneMinusT = Tensor.scalar(1).add(t.multiply(Tensor.scalar(-1)));
    const oneMinusP = Tensor.scalar(1).add(probs.multiply(Tensor.scalar(-1)));
    const term2 = oneMinusT.multiply(oneMinusP.log());
    return term1.add(term2).multiply(Tensor.scalar(-1)).multiply(mask).sum();
  }

  #validateFeatures(features: readonly number[]): void {
    if (features.length !== this.featureCount) {
      throw new Error(
        `expected ${this.featureCount} controller features, received ${features.length}`,
      );
    }
    if (features.some((value) => !Number.isFinite(value))) {
      throw new Error("controller features must be finite");
    }
  }

  #parameters(): Tensor[] {
    return [
      this.#node.weights,
      this.#node.bias,
      this.#memory.weights,
      this.#memory.bias,
      this.#edge.weights,
      this.#edge.bias,
      this.#control.weights,
      this.#control.bias,
      this.#budget.weights,
      this.#budget.bias,
    ];
  }
}

function binaryCrossEntropy(probability: Tensor, target: boolean): Tensor {
  const selected = target
    ? probability
    : Tensor.scalar(1).add(probability.multiply(Tensor.scalar(-1)));
  return selected.log().multiply(Tensor.scalar(-1));
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) throw new Error("controller target must be finite");
  return Math.min(maximum, Math.max(minimum, value));
}
