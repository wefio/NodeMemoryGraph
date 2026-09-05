import { Tensor, gradientStep } from "./autodiff.ts";

export const CONTEXT_ACTIONS = ["none", "cue", "resurface", "retrieve"] as const;
export type ContextAction = (typeof CONTEXT_ACTIONS)[number];
const FEATURE_COUNT = 32;
const ACTION_COUNT = CONTEXT_ACTIONS.length;

function validateSelection(
  allowed: readonly ContextAction[],
  costs: readonly number[],
  epsilon: number,
): void {
  if (!allowed.length || allowed.some((action) => !CONTEXT_ACTIONS.includes(action))) {
    throw new Error("at least one valid allowed action is required");
  }
  if (costs.length !== ACTION_COUNT || costs.some((x) => !Number.isFinite(x) || x < 0)) {
    throw new Error("four finite nonnegative costs are required");
  }
  if (!Number.isFinite(epsilon) || epsilon < 0 || epsilon > 1) {
    throw new Error("epsilon must be in [0, 1]");
  }
}

/** Experimental action-value head, not an executor or an authorization policy.
 * Callers own normalized pre-action features, attributable outcome admission,
 * task/version isolation, and the permitted action set. No default activation,
 * implicit learning, neural experts, memory writes, or model calls occur here.
 */
export class ContextRouter {
  readonly #weights: Tensor;
  readonly #bias: Tensor;

  constructor(parameters: readonly number[] = new Array(132).fill(0)) {
    if (parameters.length !== 132 || parameters.some((x) => !Number.isFinite(Math.fround(x)))) {
      throw new Error("router requires 132 finite Float32 parameters");
    }
    this.#weights = Tensor.matrix(parameters.slice(0, 128), ACTION_COUNT, FEATURE_COUNT, true);
    this.#bias = Tensor.vector(parameters.slice(128), true);
  }

  parameters(): number[] {
    return [...this.#weights.data, ...this.#bias.data];
  }

  values(features: readonly number[]): number[] {
    const values = [...this.#forward(features).data];
    if (values.some((x) => !Number.isFinite(x))) throw new Error("non-finite router prediction");
    return values;
  }

  /** Costs are already converted by the caller to reward units (lambda * K).
   * Ties follow CONTEXT_ACTIONS order, preferring none when it is permitted.
   * Exploration is a real sample, not a shadow counterfactual observation.
   */
  select(
    features: readonly number[],
    allowed: readonly ContextAction[],
    costs: readonly number[] = [0, 0, 0, 0],
    epsilon = 0,
    random: () => number = Math.random,
  ): { action: ContextAction; probability: number } {
    validateSelection(allowed, costs, epsilon);
    const values = this.values(features);
    const indices = CONTEXT_ACTIONS.map((_, i) => i).filter((i) =>
      allowed.includes(CONTEXT_ACTIONS[i]!),
    );
    const greedy = indices.reduce((best, i) =>
      values[i]! - costs[i]! > values[best]! - costs[best]! ? i : best,
    );
    const draw = random();
    if (!Number.isFinite(draw) || draw < 0 || draw >= 1)
      throw new Error("random must be in [0, 1)");
    let cumulative = 0;
    for (const i of indices) {
      const probability = epsilon / indices.length + (i === greedy ? 1 - epsilon : 0);
      cumulative += probability;
      if (draw < cumulative || i === indices.at(-1)) {
        return { action: CONTEXT_ACTIONS[i]!, probability };
      }
    }
    throw new Error("no allowed action");
  }

  /** Supervised regression for ONE actually executed, outcome-labelled action.
   * This is not a causal estimator or off-policy evaluation. Never feed shadow
   * choices, unverified completion claims, or unexecuted actions as labels.
   */
  update(
    features: readonly number[],
    action: ContextAction,
    reward: number,
    learningRate: number,
  ): number {
    const index = CONTEXT_ACTIONS.indexOf(action);
    if (index < 0) throw new Error("unknown context action");
    if (!Number.isFinite(reward) || Math.abs(reward) > 1)
      throw new Error("reward must be in [-1, 1]");
    if (!Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 1) {
      throw new Error("learning rate must be in (0, 1]");
    }
    const prediction = this.#forward(features);
    // A fixed-shape mask avoids varying Index op arguments in the compiled tape.
    const mask = Tensor.vector(CONTEXT_ACTIONS.map((_, i) => (i === index ? 1 : 0)));
    const target = Tensor.vector(CONTEXT_ACTIONS.map(() => reward));
    const error = prediction.subtract(target);
    const loss = error.multiply(error).multiply(mask).sum().multiplyScalar(0.5);
    const value = loss.scalarValue;
    if (!Number.isFinite(value)) throw new Error("non-finite router loss");
    loss.backward();
    const parameters = [this.#weights, this.#bias];
    for (const parameter of parameters) {
      if (
        parameter.grad.some(
          (g, i) => !Number.isFinite(Math.fround(parameter.data[i]! - learningRate * g)),
        )
      ) {
        throw new Error("non-finite router update");
      }
    }
    gradientStep(parameters, learningRate);
    return value;
  }

  #forward(features: readonly number[]): Tensor {
    if (
      features.length !== FEATURE_COUNT ||
      features.some((x) => !Number.isFinite(x) || Math.abs(x) > 1)
    ) {
      throw new Error("router requires 32 finite features normalized to [-1, 1]");
    }
    return this.#weights.matmul(Tensor.vector(features)).add(this.#bias);
  }
}
