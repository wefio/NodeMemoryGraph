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

export interface ControllerTrainingExample {
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

export class DifferentiableController {
  readonly featureCount: number;
  #trainingSteps: number;
  readonly #node: Head;
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
    for (const item of example.nodes ?? []) {
      losses.push(binaryCrossEntropy(this.#binary(this.#node, item.features), item.target));
    }
    for (const item of example.edges ?? []) {
      losses.push(binaryCrossEntropy(this.#binary(this.#edge, item.features), item.target));
    }
    if (example.control) {
      const probabilities = this.#linear(this.#control, example.control.features).softmax();
      const targetIndex = example.control.target === "stop" ? 0 : 1;
      losses.push(probabilities.at(targetIndex).log().multiply(Tensor.scalar(-1)));
    }
    if (example.budget) {
      if (example.budget.targets.length !== CONTROLLER_BUDGET_DIMENSIONS.length) {
        throw new Error("budget target count does not match controller budget dimensions");
      }
      const prediction = this.#linear(this.#budget, example.budget.features).sigmoid();
      const target = Tensor.vector(example.budget.targets.map((value) => clamp(value, 0, 1)));
      const difference = prediction.add(target.multiply(Tensor.scalar(-1)));
      losses.push(difference.multiply(difference).mean());
    }
    if (losses.length === 0) throw new Error("controller training requires at least one target");

    const parameters = this.#parameters();
    parameters.forEach((parameter) => parameter.zeroGrad());
    const loss = losses
      .slice(1)
      .reduce((total, item) => total.add(item), losses[0]!)
      .multiply(Tensor.scalar(1 / losses.length));
    const value = loss.scalarValue;
    loss.backward();
    gradientStep(parameters, learningRate);
    this.#trainingSteps += 1;
    return { loss: value, observations: losses.length, trainingSteps: this.#trainingSteps };
  }

  toJSON(): DifferentiableControllerState {
    return {
      version: 1,
      featureCount: this.featureCount,
      trainingSteps: this.#trainingSteps,
      parameters: {
        nodeWeights: [...this.#node.weights.data],
        nodeBias: [...this.#node.bias.data],
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
