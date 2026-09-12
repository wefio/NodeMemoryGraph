import { readFileSync } from "node:fs";

import { BLOCK_COLUMNS, RELEVANCE_FEATURE_COUNT } from "../core/relevance-features.ts";
import { gradientStep, Tensor } from "./autodiff.ts";

/**
 * Learned relevance model — the strict half of the two-gate design
 * (`docs/decisions/implemented/2026-09-09-retrieval-relevance-gate.md`). A small
 * MLP over the deterministic feature vector in `src/core/relevance-features.ts`,
 * built on the same autodiff core as the differentiable controller.
 *
 * It is a *loose* gate on its own: it only has to remove what it is good at
 * removing, and the AND with the program gate supplies the strictness. Trained
 * offline from gold-labelled benchmark stores (and recall feedback); inference
 * is a plain numeric forward pass, and Platt calibration makes the output a
 * probability a fixed floor can be applied to.
 */

export interface RelevanceTrainingExample {
  features: readonly number[];
  label: 0 | 1;
}

export interface RelevanceTrainingPair {
  positiveFeatures: readonly number[];
  negativeFeatures: readonly number[];
}

export interface RelevanceTrainingResult {
  loss: number;
  examples: number;
  steps: number;
}

export type RelevanceLoss = "bce" | "focal";

export interface RelevanceModelState {
  version: 1;
  featureCount: number;
  hidden: number;
  /** Columns of the input row this head reads, in order. Absent on a legacy
   *  state, which means "all columns, wider-to-narrower". */
  columns?: number[];
  /** Feature blocks the columns come from, for provenance and for the
   *  embedder-independence test (`acceptsEmbedder`). */
  blocks?: string[];
  /** Identity of the embedder that produced the training scores (`indexId` of
   *  the embedding index, or "none" for a lexical-only head). */
  embedder?: string;
  mean: number[];
  std: number[];
  inputWeights: number[];
  inputBias: number[];
  outputWeights: number[];
  outputBias: number[];
  /** Platt calibration on the logit: p = sigmoid(scale * logit + shift). */
  calibrationScale?: number;
  calibrationShift?: number;
  trainingSteps: number;
}

interface ModelOptions {
  hidden?: number;
  /** Input width; defaults to the candidate feature count, and is overridden by a
   *  saved state. Set it when reusing the head for a different feature space
   *  (e.g. the query-level gate controller). */
  featureCount?: number;
  /** Columns of the input row to read. Takes precedence over `featureCount`;
   *  `columnsForBlocks` builds them from feature blocks. */
  columns?: number[];
  blocks?: string[];
  embedder?: string;
  mean?: ArrayLike<number>;
  std?: ArrayLike<number>;
  state?: RelevanceModelState;
}

/** Deterministic small-random initialisation (mulberry32). The autodiff
 *  `Tensor.matrix` starts at zeros; with a zero input layer the hidden units get
 *  no gradient and the model collapses to a bias-only constant classifier, so
 *  breaking the symmetry explicitly is required for this head. */
function initWeights(size: number, scale: number, seed: number): Float32Array {
  const out = new Float32Array(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[index] = ((state / 0xffffffff) * 2 - 1) * scale;
  }
  return out;
}

/** Feature standardisation from a saved state, or identity when there is none. */
function initialNormalization(
  state: RelevanceModelState | undefined,
  options: ModelOptions,
  featureCount: number,
): { mean: Float32Array; std: Float32Array } {
  const std = state?.std ?? options.std;
  return {
    mean: new Float32Array(state?.mean ?? options.mean ?? new Float32Array(featureCount)),
    std: Float32Array.from({ length: featureCount }, (_, index) => std?.[index] ?? 1),
  };
}

/** Platt calibration and the step counter restored from a saved state. */
function initialCalibration(state: RelevanceModelState | undefined): {
  scale: number;
  shift: number;
  steps: number;
} {
  return {
    scale: state?.calibrationScale ?? 1,
    shift: state?.calibrationShift ?? 0,
    steps: state?.trainingSteps ?? 0,
  };
}

const EPSILON = 1e-6;

/**
 * Columns a head reads: a saved state wins, then explicit columns, then a legacy
 * width (identity columns), otherwise every column. Validated here so a malformed
 * artifact fails at load (and the gate disables itself) instead of predicting
 * from the wrong columns.
 */
function resolveColumns(state: RelevanceModelState | undefined, options: ModelOptions): number[] {
  const width = state?.featureCount ?? options.featureCount ?? RELEVANCE_FEATURE_COUNT;
  const columns =
    state?.columns ?? options.columns ?? Array.from({ length: width }, (_, index) => index);
  if (columns.length === 0) throw new Error("a relevance head needs at least one column");
  if (new Set(columns).size !== columns.length) {
    throw new Error("relevance head columns must be unique");
  }
  for (const column of columns) {
    if (!Number.isInteger(column) || column < 0 || column >= RELEVANCE_FEATURE_COUNT) {
      throw new Error(`relevance head column out of range: ${column}`);
    }
  }
  return [...columns];
}

/**
 * Resolve the four parameter tensors from a saved state, or build fresh
 * deterministic-init tensors when there is none.
 */
function initialTensors(
  state: RelevanceModelState | undefined,
  featureCount: number,
  hidden: number,
): { inputWeights: Tensor; inputBias: Tensor; outputWeights: Tensor; outputBias: Tensor } {
  return {
    inputWeights: Tensor.matrix(
      new Float32Array(
        state?.inputWeights ??
          initWeights(hidden * featureCount, 1 / Math.sqrt(featureCount), 0x51ed2701),
      ),
      hidden,
      featureCount,
      true,
    ),
    inputBias: Tensor.vector(new Float32Array(state?.inputBias ?? new Float32Array(hidden)), true),
    outputWeights: Tensor.matrix(
      new Float32Array(
        state?.outputWeights ?? initWeights(hidden, 1 / Math.sqrt(hidden), 0x2545f491),
      ),
      1,
      hidden,
      true,
    ),
    outputBias: Tensor.vector(new Float32Array(state?.outputBias ?? new Float32Array(1)), true),
  };
}

export class RelevanceModel {
  readonly featureCount: number;
  readonly hidden: number;
  /** Columns of the input row this head reads, in order. */
  readonly columns: number[];
  /** Feature blocks the columns come from (provenance). */
  readonly blocks: string[];
  /** Embedder identity the training scores came from, or "". */
  readonly embedder: string;
  readonly #mean: Float32Array;
  readonly #std: Float32Array;
  readonly #inputWeights: Tensor;
  readonly #inputBias: Tensor;
  readonly #outputWeights: Tensor;
  readonly #outputBias: Tensor;
  #calibrationScale: number;
  #calibrationShift: number;
  #steps: number;

  constructor(options: ModelOptions = {}) {
    const state = options.state;
    this.columns = resolveColumns(state, options);
    this.featureCount = this.columns.length;
    this.hidden = state?.hidden ?? options.hidden ?? 8;
    this.blocks = [...(state?.blocks ?? options.blocks ?? [])];
    this.embedder = state?.embedder ?? options.embedder ?? "";
    const normalization = initialNormalization(state, options, this.featureCount);
    this.#mean = normalization.mean;
    this.#std = normalization.std;
    const tensors = initialTensors(state, this.featureCount, this.hidden);
    this.#inputWeights = tensors.inputWeights;
    this.#inputBias = tensors.inputBias;
    this.#outputWeights = tensors.outputWeights;
    this.#outputBias = tensors.outputBias;
    const calibration = initialCalibration(state);
    this.#calibrationScale = calibration.scale;
    this.#calibrationShift = calibration.shift;
    this.#steps = calibration.steps;
  }

  /** Project a full feature row onto this head's columns. Every input path —
   *  training, calibration and inference — goes through here, so a core-only
   *  head physically cannot read the scale-bound block. */
  #selected(features: readonly number[]): Float32Array {
    const selected = new Float32Array(this.columns.length);
    for (let index = 0; index < this.columns.length; index += 1) {
      selected[index] = features[this.columns[index]!] ?? 0;
    }
    return selected;
  }

  #parameters(): Tensor[] {
    return [this.#inputWeights, this.#inputBias, this.#outputWeights, this.#outputBias];
  }

  #normalize(features: readonly number[]): Tensor {
    const selected = this.#selected(features);
    const normalized = new Float32Array(this.featureCount);
    for (let index = 0; index < this.featureCount; index += 1) {
      const std = this.#std[index]!;
      normalized[index] = (selected[index]! - this.#mean[index]!) / (std > 0 ? std : 1);
    }
    return Tensor.vector(normalized);
  }

  #forward(normalized: Tensor): Tensor {
    const hidden = this.#inputWeights.matmul(normalized).add(this.#inputBias).sigmoid();
    return this.#outputWeights.matmul(hidden).add(this.#outputBias).sigmoid();
  }

  #logitTensor(normalized: Tensor): Tensor {
    const hidden = this.#inputWeights.matmul(normalized).add(this.#inputBias).sigmoid();
    return this.#outputWeights.matmul(hidden).add(this.#outputBias);
  }

  /** Cheap numeric forward pass — no autodiff graph, used for inference. */
  logit(features: readonly number[]): number {
    const selected = this.#selected(features);
    const x = new Float32Array(this.featureCount);
    for (let index = 0; index < this.featureCount; index += 1) {
      const std = this.#std[index]!;
      x[index] = (selected[index]! - this.#mean[index]!) / (std > 0 ? std : 1);
    }
    const weights = this.#inputWeights.data;
    const bias = this.#inputBias.data;
    const hidden = new Float32Array(this.hidden);
    for (let unit = 0; unit < this.hidden; unit += 1) {
      let sum = bias[unit]!;
      const row = unit * this.featureCount;
      for (let index = 0; index < this.featureCount; index += 1) {
        sum += weights[row + index]! * x[index]!;
      }
      hidden[unit] = 1 / (1 + Math.exp(-sum));
    }
    const outWeights = this.#outputWeights.data;
    let logit = this.#outputBias.data[0]!;
    for (let unit = 0; unit < this.hidden; unit += 1) logit += outWeights[unit]! * hidden[unit]!;
    return logit;
  }

  /** Calibrated probability in (0,1) that this candidate is relevant. */
  predict(features: readonly number[]): number {
    const value = this.#calibrationScale * this.logit(features) + this.#calibrationShift;
    return 1 / (1 + Math.exp(-value));
  }

  /** Standardise features on this example set (stored with the weights). */
  fitNormalization(examples: readonly RelevanceTrainingExample[]): void {
    if (examples.length === 0) return;
    for (let index = 0; index < this.featureCount; index += 1) {
      const column = this.columns[index]!;
      const values = examples.map((example) => example.features[column] ?? 0);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      this.#mean[index] = mean;
      this.#std[index] = Math.sqrt(variance) || 1;
    }
  }

  /**
   * True when the weights read the scale-bound block, and are therefore tied to
   * the embedder that produced the training scores. A core-only head is free of
   * that dependency and can be loaded whatever the runtime embedder is.
   */
  requiresEmbeddedScores(): boolean {
    const optional = new Set(BLOCK_COLUMNS.retrieval);
    return this.columns.some((column) => optional.has(column));
  }

  /** May this head be fed scores produced by `identity`? */
  acceptsEmbedder(identity: string): boolean {
    if (!this.requiresEmbeddedScores()) return true;
    return this.embedder !== "" && this.embedder === identity;
  }

  #clamped(probability: Tensor): Tensor {
    return probability.multiplyScalar(1 - 2 * EPSILON).add(Tensor.scalar(EPSILON));
  }

  #pointwiseLoss(example: RelevanceTrainingExample, loss: RelevanceLoss, gamma: number): Tensor {
    const probability = this.#clamped(this.#forward(this.#normalize(example.features)).at(0));
    const oneMinus = Tensor.scalar(1).subtract(probability);
    if (loss === "bce") {
      return example.label === 1
        ? probability.log().multiply(Tensor.scalar(-1))
        : oneMinus.log().multiply(Tensor.scalar(-1));
    }
    if (example.label === 1) {
      const weight = oneMinus.log().multiply(Tensor.scalar(gamma)).exp();
      return weight.multiply(probability.log().multiply(Tensor.scalar(-1)));
    }
    const weight = probability.log().multiply(Tensor.scalar(gamma)).exp();
    return weight.multiply(oneMinus.log().multiply(Tensor.scalar(-1)));
  }

  train(
    examples: readonly RelevanceTrainingExample[],
    options: {
      epochs?: number;
      learningRate?: number;
      batchSize?: number;
      fitNormalization?: boolean;
      loss?: RelevanceLoss;
      gamma?: number;
    } = {},
  ): RelevanceTrainingResult {
    if (examples.length === 0) throw new Error("relevance training requires examples");
    // Normalisation is OPT-IN and off by default: the feature vector is already
    // bounded/moderate, and standardising it magnifies narrow-range features
    // which saturates the hidden sigmoid and collapses training to the
    // bias-only base-rate solution.
    if (options.fitNormalization === true) this.fitNormalization(examples);
    const epochs = options.epochs ?? 200;
    const learningRate = options.learningRate ?? 0.1;
    const batchSize = options.batchSize ?? 64;
    const loss = options.loss ?? "bce";
    const gamma = options.gamma ?? 2;
    let last = 0;
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      for (let start = 0; start < examples.length; start += batchSize) {
        const batch = examples.slice(start, start + batchSize);
        const parameters = this.#parameters();
        parameters.forEach((parameter) => parameter.zeroGrad());
        const losses = batch.map((example) => this.#pointwiseLoss(example, loss, gamma));
        const total = losses.slice(1).reduce((sum, item) => sum.add(item), losses[0]!);
        const mean = total.multiply(Tensor.scalar(1 / batch.length));
        last = mean.scalarValue;
        mean.backward();
        gradientStep(parameters, learningRate);
        this.#steps += 1;
      }
    }
    return { loss: last, examples: examples.length, steps: this.#steps };
  }

  /** RankNet pairwise training: -log sigmoid(s_pos − s_neg) over query pairs. */
  trainPairs(
    pairs: readonly RelevanceTrainingPair[],
    options: { epochs?: number; learningRate?: number; batchSize?: number } = {},
  ): RelevanceTrainingResult {
    if (pairs.length === 0) throw new Error("pairwise training requires pairs");
    const epochs = options.epochs ?? 60;
    const learningRate = options.learningRate ?? 0.05;
    const batchSize = options.batchSize ?? 128;
    let last = 0;
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      for (let start = 0; start < pairs.length; start += batchSize) {
        const batch = pairs.slice(start, start + batchSize);
        const parameters = this.#parameters();
        parameters.forEach((parameter) => parameter.zeroGrad());
        const losses = batch.map((pair) => {
          const preferred = this.#logitTensor(this.#normalize(pair.positiveFeatures)).at(0);
          const rejected = this.#logitTensor(this.#normalize(pair.negativeFeatures)).at(0);
          const margin = preferred.add(rejected.multiply(Tensor.scalar(-1)));
          return margin.sigmoid().log().multiply(Tensor.scalar(-1));
        });
        const total = losses.slice(1).reduce((sum, item) => sum.add(item), losses[0]!);
        const mean = total.multiply(Tensor.scalar(1 / batch.length));
        last = mean.scalarValue;
        mean.backward();
        gradientStep(parameters, learningRate);
        this.#steps += 1;
      }
    }
    return { loss: last, examples: pairs.length, steps: this.#steps };
  }

  /** Platt scaling on the logit, minimising BCE on `examples` (plain gradient
   *  descent over two scalars — the model weights stay frozen). */
  fitCalibration(
    examples: readonly RelevanceTrainingExample[],
    options: { iterations?: number; learningRate?: number } = {},
  ): { scale: number; shift: number } {
    if (examples.length === 0)
      return { scale: this.#calibrationScale, shift: this.#calibrationShift };
    const logits = examples.map((example) => this.logit(example.features));
    let scale = 1;
    let shift = 0;
    const iterations = options.iterations ?? 500;
    const rate = options.learningRate ?? 0.1;
    for (let step = 0; step < iterations; step += 1) {
      let gradScale = 0;
      let gradShift = 0;
      for (let index = 0; index < examples.length; index += 1) {
        const z = scale * logits[index]! + shift;
        const p = 1 / (1 + Math.exp(-z));
        const error = p - examples[index]!.label;
        gradScale += error * logits[index]!;
        gradShift += error;
      }
      scale -= (rate * gradScale) / examples.length;
      shift -= (rate * gradShift) / examples.length;
    }
    this.#calibrationScale = scale;
    this.#calibrationShift = shift;
    return { scale, shift };
  }

  toJSON(): RelevanceModelState {
    return {
      version: 1,
      featureCount: this.featureCount,
      hidden: this.hidden,
      columns: [...this.columns],
      blocks: [...this.blocks],
      embedder: this.embedder,
      mean: [...this.#mean],
      std: [...this.#std],
      inputWeights: [...this.#inputWeights.data],
      inputBias: [...this.#inputBias.data],
      outputWeights: [...this.#outputWeights.data],
      outputBias: [...this.#outputBias.data],
      calibrationScale: this.#calibrationScale,
      calibrationShift: this.#calibrationShift,
      trainingSteps: this.#steps,
    };
  }

  static fromJSON(state: RelevanceModelState): RelevanceModel {
    return new RelevanceModel({ state });
  }
}

/** Load a trained model; null when the file is missing or malformed, so the
 *  gate stays deterministic instead of failing a recall. */
export function readRelevanceModel(path: string): RelevanceModel | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RelevanceModelState;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.mean)) return null;
    return RelevanceModel.fromJSON(parsed);
  } catch {
    return null;
  }
}
