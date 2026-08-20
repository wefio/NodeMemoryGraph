import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateControllerGate } from "../../src/lab/controller-gate.ts";
import { CONTROLLER_FEATURE_PROTOCOL_VERSION } from "../../src/lab/controller-protocol.ts";
import {
  CONTROLLER_BUDGET_DIMENSIONS,
  DifferentiableController,
  type ControllerTrainingExample,
} from "../../src/lab/differentiable-controller.ts";
import type { ActiveGraphSelection } from "../../src/core/types.ts";
import { buildShadowDataset, type ShadowDatasetRow } from "./dataset.ts";
import { readShadowEvents, resolveShadowEventPath } from "./report.ts";

export interface ShadowCalibrationOptions {
  epochs?: number;
  learningRate?: number;
  residualWeight?: number;
  topNodes?: number;
}

export function summarizeShadowCalibration(
  calibration: ReturnType<typeof calibrateShadowController>,
) {
  return {
    rows: calibration.rows,
    evidenceDiversity: calibration.evidenceDiversity,
    dataWindow: calibration.dataWindow,
    validation: calibration.validation,
    gate: calibration.gate,
    eligibleForShadow: calibration.eligibleForShadow,
    eligibleForActivation: calibration.eligibleForActivation,
  };
}

/**
 * Train and evaluate only from chronologically split, fully labelled real-use rows.
 * This creates a candidate artifact; it never activates or overwrites runtime policy.
 */
export function calibrateShadowController(
  rows: readonly ShadowDatasetRow[],
  options: ShadowCalibrationOptions = {},
) {
  const epochs = positiveInteger(options.epochs ?? 40, "epochs");
  const learningRate = bounded(options.learningRate ?? 0.03, 0.0001, 1);
  const residualWeight = bounded(options.residualWeight ?? 0.1, 0, 1);
  const topNodes = positiveInteger(options.topNodes ?? 3, "topNodes");
  const train = rows.filter((row) => row.split === "train");
  const validation = rows.filter((row) => row.split === "validation");
  if (train.length === 0 || validation.length === 0) {
    throw new Error("shadow calibration requires non-empty chronological train and validation rows");
  }

  const controller = new DifferentiableController(
    train[0]!.retrieval.controllerFeatures!.global.length,
  );
  const losses: number[] = [];
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (const row of rotate(train, epoch)) {
      const example = trainingExample(row);
      if (!example) continue;
      losses.push(controller.train(example, learningRate).loss);
    }
  }

  const evaluated = validation.map((row) => evaluateRow(row, controller, residualWeight, topNodes));
  const baseline = classificationMetrics(evaluated.map((row) => row.baseline));
  const learned = classificationMetrics(evaluated.map((row) => row.learned));
  const candidateRecall = average(evaluated.map((row) => row.candidateRecall));
  const controlAccuracy = average(evaluated.map((row) => Number(row.controlCorrect)));
  const trainingPrimaryTargets = primaryEvidenceTargets(train);
  const validationPrimaryTargets = primaryEvidenceTargets(validation);
  const trainingExactTargets = exactUseEvidenceTargets(train);
  const validationExactTargets = exactUseEvidenceTargets(validation);
  const overlappingExactTargets = new Set(
    [...validationExactTargets].filter((target) => trainingExactTargets.has(target)),
  );
  const gate = evaluateControllerGate({
    trainingCases: train.length,
    trainingEvidenceTargets: trainingPrimaryTargets.size,
    validationEvidenceTargets: validationPrimaryTargets.size,
    overlappingEvidenceTargets: overlappingExactTargets.size,
    candidateRecall,
    baselineRecall: baseline.recall,
    learnedRecall: learned.recall,
    baselinePrecision: baseline.precision,
    learnedPrecision: learned.precision,
    baselineInferenceMs: average(evaluated.map((row) => row.baselineInferenceMs)),
    learnedInferenceMs: average(evaluated.map((row) => row.inferenceMs)),
  });

  return {
    config: { epochs, learningRate, residualWeight, topNodes },
    featureProtocolVersion: CONTROLLER_FEATURE_PROTOCOL_VERSION,
    rows: { train: train.length, validation: validation.length },
    evidenceDiversity: {
      primaryTrainingTargets: trainingPrimaryTargets.size,
      primaryValidationTargets: validationPrimaryTargets.size,
      exactTrainingTargets: trainingExactTargets.size,
      exactValidationTargets: validationExactTargets.size,
      overlappingExactTargets: overlappingExactTargets.size,
    },
    dataWindow: {
      from: rows.map((row) => row.recordedAt).sort()[0]!,
      to: rows.map((row) => row.recordedAt).sort().at(-1)!,
    },
    training: {
      steps: controller.trainingSteps,
      finalLoss: losses.at(-1) ?? null,
      observations: losses.length,
    },
    validation: {
      candidateRecall,
      baseline,
      learned,
      controlAccuracy,
      baselineMeanInferenceMs: average(evaluated.map((row) => row.baselineInferenceMs)),
      meanInferenceMs: average(evaluated.map((row) => row.inferenceMs)),
      costs: summarizeCosts(validation),
    },
    gate,
    eligibleForShadow: gate.eligibility.shadow,
    eligibleForActivation: false,
    controller: controller.toJSON(),
  };
}

function primaryEvidenceTargets(rows: readonly ShadowDatasetRow[]): Set<string> {
  const targets = new Set<string>();
  for (const row of rows) {
    const used = new Set(row.use?.usedMemoryIds ?? []);
    const primary = [...row.retrieval.selections]
      .sort((left, right) => left.rank - right.rank)
      .find((selection) => used.has(selection.memoryId));
    if (primary) targets.add(primary.memoryId);
  }
  return targets;
}

function exactUseEvidenceTargets(rows: readonly ShadowDatasetRow[]): Set<string> {
  return new Set(rows.flatMap((row) => row.use?.usedMemoryIds ?? []));
}

function trainingExample(row: ShadowDatasetRow): ControllerTrainingExample | null {
  const features = row.retrieval.controllerFeatures!;
  const used = new Set(row.use?.usedMemoryIds ?? []);
  const selections = row.retrieval.selections;
  const usedSelections = selections.filter((selection) => used.has(selection.memoryId));
  const usefulNodes = new Set(usedSelections.map((selection) => selection.nodeId));
  const memoryPairs = pairwise(features.memories, used);
  const nodes = binaryExamples(features.nodes, usefulNodes);
  const controlTarget = controlTargetFor(row);
  const budgetTargets = budgetTargetsFor(row, usedSelections, usefulNodes);
  if (memoryPairs.length === 0 && nodes.length === 0 && !controlTarget && !budgetTargets) return null;
  return {
    memoryPairs,
    nodes,
    control: controlTarget ? { features: features.global, target: controlTarget } : undefined,
    budget: budgetTargets ? { features: features.global, targets: budgetTargets } : undefined,
  };
}

function controlTargetFor(row: ShadowDatasetRow): "expand" | "stop" | null {
  if (row.feedback.expansionUseful === true) return "expand";
  if (row.feedback.evidenceSufficient === true || row.feedback.noMemoryNeeded === true) return "stop";
  // Insufficient evidence with an unhelpful local expansion may require a new
  // search route. Do not collapse that future action into the generic stop head.
  return null;
}

function budgetTargetsFor(
  row: ShadowDatasetRow,
  selections: readonly ActiveGraphSelection[],
  usefulNodes: ReadonlySet<string>,
): number[] | null {
  if (selections.length === 0) return null;
  const budget = row.retrieval.budget!;
  const tokens = selections.reduce((sum, selection) => sum + selection.estimatedTokens, 0);
  const deepestTier = Math.max(...selections.map((selection) => selection.tier));
  const deepestRank = Math.max(...selections.map((selection) => selection.rank));
  const values = [
    ratio(usefulNodes.size, budget.maxNodes),
    ratio(row.retrieval.costs.edgesRead, budget.maxEdges),
    ratio(deepestRank, budget.maxEvidence),
    ratio(tokens, budget.maxTokens),
    ratio(row.retrieval.costs.graphHops ?? 0, budget.maxGraphHops),
    ratio(deepestTier, budget.maxLocalTier),
    ratio(row.retrieval.costs.retrievalLatencyMs, budget.maxLatencyMs),
  ];
  if (values.length !== CONTROLLER_BUDGET_DIMENSIONS.length) {
    throw new Error("shadow budget target shape is invalid");
  }
  return values;
}

function evaluateRow(
  row: ShadowDatasetRow,
  controller: DifferentiableController,
  residualWeight: number,
  topNodes: number,
) {
  const features = row.retrieval.controllerFeatures!;
  const useful = new Set(
    row.retrieval.selections
      .filter((selection) => row.use?.usedMemoryIds.includes(selection.memoryId))
      .map((selection) => selection.nodeId),
  );
  const baselineStarted = performance.now();
  const baselineScores = new Map<string, number>();
  for (const selection of row.retrieval.selections) {
    baselineScores.set(
      selection.nodeId,
      Math.max(baselineScores.get(selection.nodeId) ?? 0, selection.scores.usefulness),
    );
  }
  const baselineIds = rank(
    Object.keys(features.nodes),
    (id) => baselineScores.get(id) ?? 0,
  ).slice(0, topNodes);
  const baselineInferenceMs = performance.now() - baselineStarted;
  const learnedStarted = performance.now();
  const learnedIds = rank(
    Object.keys(features.nodes),
    (id) =>
      (baselineScores.get(id) ?? 0) + residualWeight * (controller.scoreNode(features.nodes[id]!) - 0.5),
  ).slice(0, topNodes);
  const target = controlTargetFor(row);
  const controlCorrect = target ? controller.chooseControl(features.global).action === target : true;
  const inferenceMs = performance.now() - learnedStarted;
  return {
    candidateRecall: useful.size === 0 ? 1 : intersection(Object.keys(features.nodes), useful) / useful.size,
    baseline: counts(baselineIds, useful),
    learned: counts(learnedIds, useful),
    controlCorrect,
    baselineInferenceMs,
    inferenceMs,
  };
}

function pairwise(
  features: Record<string, number[]>,
  useful: ReadonlySet<string>,
): Array<{ preferredFeatures: number[]; rejectedFeatures: number[] }> {
  const positives = Object.entries(features).filter(([id]) => useful.has(id));
  const negatives = Object.entries(features).filter(([id]) => !useful.has(id));
  if (positives.length === 0 || negatives.length === 0) return [];
  return positives.flatMap(([, preferredFeatures]) =>
    negatives.slice(0, Math.max(4, positives.length * 4)).map(([, rejectedFeatures]) => ({
      preferredFeatures,
      rejectedFeatures,
    })),
  );
}

function binaryExamples(features: Record<string, number[]>, useful: ReadonlySet<string>) {
  if (useful.size === 0) return [];
  return Object.entries(features).map(([id, vector]) => ({ features: vector, target: useful.has(id) }));
}

function summarizeCosts(rows: readonly ShadowDatasetRow[]) {
  return {
    retrievalLatencyMs: average(rows.map((row) => row.retrieval.costs.retrievalLatencyMs)),
    controllerLatencyMs: average(rows.map((row) => row.retrieval.costs.controllerLatencyMs)),
    endToEndLatencyMs: average(
      rows.map((row) => row.outcome?.endToEndLatencyMs ?? 0).filter((value) => value > 0),
    ),
    toolRounds: average(rows.map((row) => row.outcome?.toolRounds ?? 0)),
    injectedTokens: average(rows.map((row) => row.retrieval.costs.injectedEstimatedTokens)),
    retrievedTokens: average(rows.map((row) => row.retrieval.costs.estimatedTokens)),
  };
}

function classificationMetrics(values: Array<{ tp: number; fp: number; fn: number }>) {
  const tp = values.reduce((sum, value) => sum + value.tp, 0);
  const fp = values.reduce((sum, value) => sum + value.fp, 0);
  const fn = values.reduce((sum, value) => sum + value.fn, 0);
  return { precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) };
}

function counts(ids: readonly string[], useful: ReadonlySet<string>) {
  const tp = ids.filter((id) => useful.has(id)).length;
  return { tp, fp: ids.length - tp, fn: Math.max(0, useful.size - tp) };
}

function rank(ids: readonly string[], score: (id: string) => number): string[] {
  return [...ids].sort((left, right) => score(right) - score(left) || left.localeCompare(right));
}

function intersection(ids: readonly string[], expected: ReadonlySet<string>): number {
  return ids.filter((id) => expected.has(id)).length;
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  if (values.length === 0) return [];
  const pivot = offset % values.length;
  return [...values.slice(pivot), ...values.slice(0, pivot)];
}

function ratio(value: number, maximum: number): number {
  return maximum <= 0 ? 0 : bounded(value / maximum, 0, 1);
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) throw new Error("controller calibration value must be finite");
  return Math.min(maximum, Math.max(minimum, value));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fileFingerprint(path: string): string | null {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const eventPath = resolveShadowEventPath(process.argv[2]);
  const dataset = buildShadowDataset(readShadowEvents(eventPath));
  const resultPath = resolve(
    process.argv[3] ??
      `evals/controller-shadow/results/${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  if (dataset.blockers.length > 0) {
    const blocked = { status: "blocked", eventPath, dataset };
    process.stdout.write(`${JSON.stringify(blocked, null, 2)}\n`);
    process.exitCode = 2;
  } else {
    const rollbackPath = resolve(
      process.env.NMG_CONTROLLER_STATE ??
        resolve(dirname(eventPath), "controller-shadow-state.json"),
    );
    const calibration = calibrateShadowController(dataset.rows, {
      epochs: Number(process.env.NMG_CONTROLLER_CALIBRATION_EPOCHS ?? 40),
      learningRate: Number(process.env.NMG_CONTROLLER_CALIBRATION_LR ?? 0.03),
      residualWeight: Number(process.env.NMG_CONTROLLER_RESIDUAL_WEIGHT ?? 0.1),
      topNodes: Number(process.env.NMG_CONTROLLER_TOP_NODES ?? 3),
    });
    const artifact = {
      status: "candidate",
      createdAt: new Date().toISOString(),
      eventPath,
      eventFingerprint: fileFingerprint(eventPath),
      rollbackTarget: { path: rollbackPath, fingerprint: fileFingerprint(rollbackPath) },
      dataset: { tasks: dataset.tasks, excludedGraphs: dataset.excludedGraphs },
      calibration,
    };
    writeAtomic(resultPath, artifact);
    // Keep complete learned parameters in the artifact. Console output is an
    // operator-facing readiness summary; dumping every weight obscures the gate.
    process.stdout.write(
      `${JSON.stringify(
        {
          resultPath,
          status: artifact.status,
          dataset: artifact.dataset,
          calibration: summarizeShadowCalibration(calibration),
        },
        null,
        2,
      )}\n`,
    );
  }
}
