import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  CONTROLLER_FEATURE_COUNT,
  CONTROLLER_FEATURE_PROTOCOL_VERSION,
  controllerSampleFromTrace,
} from "./controller-protocol.ts";
import {
  CONTROLLER_BUDGET_DIMENSIONS,
  DifferentiableController,
  type ControllerAction,
  type ControllerBudgetDimension,
  type DifferentiableControllerState,
} from "./differentiable-controller.ts";
import type { ActiveGraphBudget, MemoryContext, RetrievalTrace } from "./types.ts";
import { fibonacciEvidenceBudgets } from "./store/active-graph.ts";

export interface ControllerRuntimeState {
  version: 1;
  featureProtocolVersion: typeof CONTROLLER_FEATURE_PROTOCOL_VERSION;
  controller: DifferentiableControllerState;
  observations: number;
  updatedAt: string;
}

export interface ControllerShadowDecision {
  baselineNodeIds: string[];
  learnedNodeIds: string[];
  changed: boolean;
  trainingSteps: number;
}

/** A real, bounded budget decision derived from a disposable candidate graph. */
export interface ControllerBudgetDecision {
  action: ControllerAction;
  fractions: Record<ControllerBudgetDimension, number>;
  budget: ActiveGraphBudget;
  trainingSteps: number;
}

export interface ControllerMemoryFold {
  visibleMemoryIds: string[];
  foldedMemoryIds: string[];
  trainingSteps: number;
}

/**
 * Persistent Pi-side controller adapter. It learns from completed retrieval traces but
 * deliberately exposes shadow decisions only; activation is an external evaluated gate.
 */
export class ControllerRuntime {
  readonly #path: string;
  readonly #controller: DifferentiableController;
  #observations: number;

  constructor(path: string) {
    this.#path = path;
    const state = loadState(path);
    this.#controller = state
      ? DifferentiableController.fromJSON(state.controller)
      : new DifferentiableController(CONTROLLER_FEATURE_COUNT);
    this.#observations = state?.observations ?? 0;
  }

  get trainingSteps(): number {
    return this.#controller.trainingSteps;
  }

  get observations(): number {
    return this.#observations;
  }

  shadow(context: MemoryContext, residualWeight = 0.1): ControllerShadowDecision | null {
    const graph = context.activeGraph;
    if (!graph) return null;
    const trace = traceFromActiveGraph(context);
    const sample = controllerSampleFromTrace(context, trace);
    const baselineScores = new Map<string, number>();
    for (const selection of graph.selections) {
      baselineScores.set(
        selection.nodeId,
        Math.max(baselineScores.get(selection.nodeId) ?? 0, selection.scores.usefulness),
      );
    }
    const baselineNodeIds = rank(
      Object.keys(sample.nodeFeatures).map((nodeId) => ({
        nodeId,
        score: baselineScores.get(nodeId) ?? 0,
      })),
    );
    const boundedWeight = Math.max(0, Math.min(residualWeight, 1));
    const learnedNodeIds = rank(
      Object.entries(sample.nodeFeatures).map(([nodeId, features]) => ({
        nodeId,
        score:
          (baselineScores.get(nodeId) ?? 0) +
          boundedWeight * (this.#controller.scoreNode(features) - 0.5),
      })),
    );
    return {
      baselineNodeIds,
      learnedNodeIds,
      changed: baselineNodeIds.some((nodeId, index) => learnedNodeIds[index] !== nodeId),
      trainingSteps: this.#controller.trainingSteps,
    };
  }

  /**
   * Retain a configurable share of the learned listwise probability mass.
   * Top-1 is the only fixed safety anchor. A flat score distribution therefore
   * stays wide, while a steep distribution permits aggressive folding.
   */
  foldMemories(context: MemoryContext, retainedMass = 0.98): ControllerMemoryFold | null {
    if (!context.activeGraph || context.results.length <= 1) return null;
    const trace = traceFromActiveGraph(context);
    const sample = controllerSampleFromTrace(context, trace);
    const scores = context.results.map((result) =>
      this.#controller.scoreMemory(sample.memoryFeatures[result.memory.id]!),
    );
    const visibleIndices = retainedMassIndices(scores, retainedMass);
    const visibleIds = new Set(visibleIndices.map((index) => context.results[index]!.memory.id));
    if (visibleIds.size === context.results.length) return null;
    return {
      visibleMemoryIds: context.results
        .map((result) => result.memory.id)
        .filter((id) => visibleIds.has(id)),
      foldedMemoryIds: context.results
        .map((result) => result.memory.id)
        .filter((id) => !visibleIds.has(id)),
      trainingSteps: this.#controller.trainingSteps,
    };
  }

  /**
   * Convert the controller's continuous allocation head into a concrete Active
   * Graph budget. `minimum`, `normalMaximum`, and `expandedMaximum` are hard
   * operator policy bounds. The control head chooses whether this search may
   * enter the larger AG tier; the learned model cannot exceed either envelope.
   */
  allocate(
    context: MemoryContext,
    minimum: ActiveGraphBudget,
    normalMaximum: ActiveGraphBudget,
    expandedMaximum: ActiveGraphBudget = normalMaximum,
  ): ControllerBudgetDecision | null {
    if (!context.activeGraph) return null;
    const trace = traceFromActiveGraph(context);
    const sample = controllerSampleFromTrace(context, trace);
    const fractions = this.#controller.allocateBudget(sample.globalFeatures);
    const control = this.#controller.chooseControl(sample.globalFeatures);
    const expanded = control.action === "expand";
    const maximum = expanded ? expandedMaximum : normalMaximum;
    const fraction = (dimension: ControllerBudgetDimension): number =>
      Math.max(fractions[dimension], expanded ? 0.75 : 0);
    return {
      action: control.action,
      fractions,
      budget: {
        maxNodes: project(minimum.maxNodes, maximum.maxNodes, fraction("nodes")),
        maxEdges: project(minimum.maxEdges, maximum.maxEdges, fraction("edges")),
        maxEvidence: projectFibonacci(
          minimum.maxEvidence,
          maximum.maxEvidence,
          fraction("evidence"),
        ),
        maxTokens: project(minimum.maxTokens, maximum.maxTokens, fraction("tokens")),
        maxGraphHops: project(minimum.maxGraphHops, maximum.maxGraphHops, fraction("graphHops")),
        maxLocalTier: project(
          minimum.maxLocalTier,
          maximum.maxLocalTier,
          fraction("localTier"),
        ) as ActiveGraphBudget["maxLocalTier"],
        maxLatencyMs: project(minimum.maxLatencyMs, maximum.maxLatencyMs, fraction("latencyMs")),
      },
      trainingSteps: this.#controller.trainingSteps,
    };
  }

  observe(context: MemoryContext, trace: RetrievalTrace, learningRate = 0.03): boolean {
    const sample = controllerSampleFromTrace(context, trace);
    if (!sample.training) return false;
    this.#controller.train(sample.training, learningRate);
    this.#observations += 1;
    this.save();
    return true;
  }

  save(): void {
    const state: ControllerRuntimeState = {
      version: 1,
      featureProtocolVersion: CONTROLLER_FEATURE_PROTOCOL_VERSION,
      controller: this.#controller.toJSON(),
      observations: this.#observations,
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, this.#path);
  }
}

export function retainedMassIndices(scores: readonly number[], retainedMass = 0.98): number[] {
  if (scores.length === 0) return [];
  const target = Math.max(0, Math.min(retainedMass, 1));
  const logits = scores.map((score) => {
    const probability = Math.max(1e-6, Math.min(Number.isFinite(score) ? score : 0.5, 1 - 1e-6));
    return Math.log(probability / (1 - probability));
  });
  const maximum = Math.max(...logits);
  const masses = logits.map((logit) => Math.exp(logit - maximum));
  const total = masses.reduce((sum, mass) => sum + mass, 0);
  const selected = new Set<number>([0]);
  let accumulated = masses[0]!;
  const ranked = masses
    .map((mass, index) => ({ index, mass }))
    .filter(({ index }) => index !== 0)
    .sort((left, right) => right.mass - left.mass || left.index - right.index);
  for (const candidate of ranked) {
    if (accumulated / Math.max(total, Number.EPSILON) >= target) break;
    selected.add(candidate.index);
    accumulated += candidate.mass;
  }
  return [...selected].sort((left, right) => left - right);
}

function loadState(path: string): ControllerRuntimeState | null {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as ControllerRuntimeState;
    if (
      state.version !== 1 ||
      ![1, CONTROLLER_FEATURE_PROTOCOL_VERSION].includes(state.featureProtocolVersion)
    ) {
      throw new Error("controller runtime state is incompatible with the feature protocol");
    }
    return {
      ...state,
      featureProtocolVersion: CONTROLLER_FEATURE_PROTOCOL_VERSION,
      controller: resizeControllerState(state.controller, CONTROLLER_FEATURE_COUNT),
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function traceFromActiveGraph(context: MemoryContext): RetrievalTrace {
  const graph = context.activeGraph!;
  return {
    id: graph.id,
    query: graph.query,
    taskId: graph.taskId,
    resultMemoryIds: graph.memoryIds,
    resultNodeIds: graph.nodeIds,
    expandedNodeIds: graph.expansions.map((expansion) => expansion.targetNodeId),
    relationIds: graph.expansions.map((expansion) => expansion.relationId),
    usefulMemoryIds: [],
    contradictedMemoryIds: [],
    rejectedMemoryIds: [],
    ambiguity: 0,
    fallbackUsed: false,
    conflictObserved: false,
    activeGraphBudget: graph.budget,
    activeGraphUsage: graph.usage,
    selections: graph.selections,
    expansions: graph.expansions,
    budgetLedger: graph.budgetLedger,
    qpp: graph.qpp,
    createdAt: graph.createdAt,
  };
}

function rank(values: Array<{ nodeId: string; score: number }>): string[] {
  return values
    .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId))
    .map((value) => value.nodeId);
}

function project(minimum: number, maximum: number, fraction: number): number {
  const lower = Math.min(minimum, maximum);
  const upper = Math.max(minimum, maximum);
  return Math.round(lower + (upper - lower) * Math.max(0, Math.min(1, fraction)));
}

function projectFibonacci(minimum: number, maximum: number, fraction: number): number {
  const projected = project(minimum, maximum, fraction);
  const tiers = fibonacciEvidenceBudgets(maximum).filter((tier) => tier >= minimum);
  return tiers.find((tier) => tier >= projected) ?? maximum;
}

function resizeControllerState(
  state: DifferentiableControllerState,
  featureCount: number,
): DifferentiableControllerState {
  if (state.featureCount === featureCount) return state;
  if (state.featureCount > featureCount) {
    throw new Error("controller state has more features than the current protocol");
  }
  const resize = (values: number[], rows: number): number[] => {
    const resized = new Array<number>(rows * featureCount).fill(0);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < state.featureCount; column += 1) {
        resized[row * featureCount + column] = values[row * state.featureCount + column] ?? 0;
      }
    }
    return resized;
  };
  return {
    ...state,
    featureCount,
    parameters: {
      ...state.parameters,
      nodeWeights: resize(state.parameters.nodeWeights, 1),
      memoryWeights: resize(
        state.parameters.memoryWeights ?? new Array(state.featureCount).fill(0),
        1,
      ),
      memoryBias: state.parameters.memoryBias ?? [0],
      edgeWeights: resize(state.parameters.edgeWeights, 1),
      controlWeights: resize(state.parameters.controlWeights, 2),
      budgetWeights: resize(state.parameters.budgetWeights, CONTROLLER_BUDGET_DIMENSIONS.length),
    },
  };
}
