import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

import type {
  ControllerShadowDecision,
  ControllerShadowFeatureSnapshot,
} from "./controller-runtime.ts";
import type {
  ActiveGraphBudget,
  ActiveGraphBudgetUsage,
  ActiveGraphSelection,
  QppTriggerDecision,
} from "../core/types.ts";

export type ShadowRetrievalOrigin = "automatic" | "tool";

interface ShadowEventBase {
  version: 1 | 2;
  graphId: string;
  sessionId: string;
  recordedAt: string;
}

export interface ShadowRetrievalEvent extends ShadowEventBase {
  type: "retrieval";
  origin: ShadowRetrievalOrigin;
  query: string;
  queryTaskId: string;
  candidateMemoryIds: string[];
  candidateNodeIds: string[];
  selections: ActiveGraphSelection[];
  qpp: QppTriggerDecision | null;
  baselineNodeIds: string[];
  learnedNodeIds: string[];
  changed: boolean;
  controllerTrainingSteps: number;
  /** Missing only on legacy events written before replayable feature capture. */
  controllerFeatures?: ControllerShadowFeatureSnapshot;
  /** Hard envelope active when the decision was observed; absent on legacy events. */
  budget?: ActiveGraphBudget;
  costs: {
    retrievalLatencyMs: number;
    controllerLatencyMs: number;
    injectedCharacters: number;
    injectedEstimatedTokens: number;
    recordsRead: number;
    estimatedTokens: number;
    nodesRead: number;
    edgesRead: number;
    /** Missing only on legacy events written before budget replay support. */
    graphHops?: number;
    deepestTier: number;
  };
}

/** Legacy ambiguous event. It may represent disclosure or answer overlap and is audit-only. */
export interface ShadowUseEvent extends ShadowEventBase {
  type: "use";
  requestedMemoryIds: string[];
  usedMemoryIds: string[];
}

export interface ShadowDisclosureEvent extends ShadowEventBase {
  version: 2;
  type: "disclosure";
  requestedMemoryIds: string[];
  disclosedMemoryIds: string[];
}

export type ShadowAttributionMethod = "answer_overlap" | "verified_claim_support";

export interface ShadowAttributionEvent extends ShadowEventBase {
  version: 2;
  type: "attribution";
  candidateMemoryIds: string[];
  attributedMemoryIds: string[];
  method: ShadowAttributionMethod;
}

export interface ShadowOutcomeEvent extends ShadowEventBase {
  type: "outcome";
  runCompleted: boolean;
  messageCount: number;
  toolRounds: number;
  inputTokens: number | null;
  outputTokens: number | null;
  endToEndLatencyMs: number | null;
}

export interface ShadowFeedbackEvent extends ShadowEventBase {
  type: "feedback";
  collectionOrigin: "controlled" | "natural";
  semanticTaskId: string | null;
  taskSuccess: boolean | null;
  userCorrection: boolean | null;
  evidenceSufficient: boolean | null;
  expansionUseful: boolean | null;
  excessiveNoise: boolean | null;
  noMemoryNeeded: boolean | null;
  note?: string;
}

export interface ShadowToolFlowEvent extends ShadowEventBase {
  type: "tool_flow";
  action: "search_suppressed" | "feedback_nudge_shown" | "claim_outcome_nudge_shown";
  reason: "evidence_progression_required" | "next_user_turn_review" | "next_user_turn_claim_review";
  query?: string;
}

export interface ShadowActuationEvent extends ShadowEventBase {
  version: 2;
  type: "actuation";
  action: "allocate" | "fold" | "rerank";
  changed: boolean;
  controllerTrainingSteps: number;
  controllerMode?: "controlled" | "active";
  candidateSha256?: string;
  featureProtocolVersion?: number;
  beforeMemoryIds?: string[];
  afterMemoryIds?: string[];
  beforeBudget?: ActiveGraphBudget;
  afterBudget?: ActiveGraphBudget;
}

export type ShadowEvaluationEvent =
  | ShadowRetrievalEvent
  | ShadowUseEvent
  | ShadowDisclosureEvent
  | ShadowAttributionEvent
  | ShadowOutcomeEvent
  | ShadowFeedbackEvent
  | ShadowToolFlowEvent
  | ShadowActuationEvent;

export interface ShadowEvaluationLogOptions {
  maxBytes?: number;
  retainedFiles?: number;
  now?: () => Date;
}

/**
 * Bounded local JSONL event log for matched baseline/controller evaluation.
 * Logging is best-effort: evaluation telemetry must never break Pi retrieval.
 */
export class ShadowEvaluationLog {
  readonly #path: string;
  readonly #maxBytes: number;
  readonly #retainedFiles: number;
  readonly #now: () => Date;

  constructor(path: string, options: ShadowEvaluationLogOptions = {}) {
    this.#path = path;
    this.#maxBytes = Math.max(1_024, options.maxBytes ?? 8 * 1_024 * 1_024);
    this.#retainedFiles = Math.max(1, options.retainedFiles ?? 4);
    this.#now = options.now ?? (() => new Date());
  }

  retrieval(input: {
    graphId: string;
    sessionId: string;
    origin: ShadowRetrievalOrigin;
    query: string;
    queryTaskId: string;
    candidateMemoryIds: readonly string[];
    candidateNodeIds: readonly string[];
    selections: readonly ActiveGraphSelection[];
    qpp?: QppTriggerDecision;
    decision: ControllerShadowDecision;
    budget: ActiveGraphBudget;
    usage: ActiveGraphBudgetUsage;
    controllerLatencyMs: number;
    injectedText?: string;
  }): boolean {
    return this.#append({
      version: 1,
      type: "retrieval",
      graphId: input.graphId,
      sessionId: input.sessionId,
      recordedAt: this.#now().toISOString(),
      origin: input.origin,
      query: input.query,
      queryTaskId: input.queryTaskId,
      candidateMemoryIds: [...input.candidateMemoryIds],
      candidateNodeIds: [...input.candidateNodeIds],
      selections: input.selections.map((selection) => ({
        ...selection,
        scores: { ...selection.scores },
      })),
      qpp: input.qpp
        ? {
            ...input.qpp,
            components: { ...input.qpp.components },
            expansion: input.qpp.expansion
              ? {
                  ...input.qpp.expansion,
                  stages: input.qpp.expansion.stages.map((stage) => ({ ...stage })),
                }
              : undefined,
          }
        : null,
      baselineNodeIds: input.decision.baselineNodeIds,
      learnedNodeIds: input.decision.learnedNodeIds,
      changed: input.decision.changed,
      controllerTrainingSteps: input.decision.trainingSteps,
      controllerFeatures: cloneControllerFeatures(input.decision.features),
      budget: { ...input.budget },
      costs: {
        retrievalLatencyMs: input.usage.latencyMs,
        controllerLatencyMs: input.controllerLatencyMs,
        injectedCharacters: input.injectedText?.length ?? 0,
        injectedEstimatedTokens: Math.ceil((input.injectedText?.length ?? 0) / 4),
        recordsRead: input.usage.evidence,
        estimatedTokens: input.usage.estimatedTokens,
        nodesRead: input.usage.nodes,
        edgesRead: input.usage.edges,
        graphHops: input.usage.graphHops,
        deepestTier: input.usage.deepestTier,
      },
    });
  }

  disclosure(input: {
    graphId: string;
    sessionId: string;
    requestedMemoryIds: readonly string[];
    disclosedMemoryIds: readonly string[];
  }): boolean {
    return this.#append({
      version: 2,
      type: "disclosure",
      graphId: input.graphId,
      sessionId: input.sessionId,
      recordedAt: this.#now().toISOString(),
      requestedMemoryIds: [...input.requestedMemoryIds],
      disclosedMemoryIds: [...input.disclosedMemoryIds],
    });
  }

  attribution(input: {
    graphId: string;
    sessionId: string;
    candidateMemoryIds: readonly string[];
    attributedMemoryIds: readonly string[];
    method: ShadowAttributionMethod;
  }): boolean {
    return this.#append({
      version: 2,
      type: "attribution",
      graphId: input.graphId,
      sessionId: input.sessionId,
      recordedAt: this.#now().toISOString(),
      candidateMemoryIds: [...input.candidateMemoryIds],
      attributedMemoryIds: [...input.attributedMemoryIds],
      method: input.method,
    });
  }

  outcome(input: {
    graphId: string;
    sessionId: string;
    messageCount: number;
    toolRounds?: number;
    inputTokens?: number;
    outputTokens?: number;
    endToEndLatencyMs?: number;
  }): boolean {
    return this.#append({
      version: 1,
      type: "outcome",
      graphId: input.graphId,
      sessionId: input.sessionId,
      recordedAt: this.#now().toISOString(),
      runCompleted: true,
      messageCount: input.messageCount,
      toolRounds: Math.max(0, Math.floor(input.toolRounds ?? 0)),
      inputTokens: finiteOrNull(input.inputTokens),
      outputTokens: finiteOrNull(input.outputTokens),
      endToEndLatencyMs: finiteOrNull(input.endToEndLatencyMs),
    });
  }

  feedback(input: {
    graphId: string;
    sessionId: string;
    taskSuccess?: boolean | null;
    userCorrection?: boolean | null;
    evidenceSufficient?: boolean | null;
    expansionUseful?: boolean | null;
    excessiveNoise?: boolean | null;
    noMemoryNeeded?: boolean | null;
    note?: string;
    semanticTaskId?: string;
    collectionOrigin?: ShadowFeedbackEvent["collectionOrigin"];
  }): boolean {
    return this.#append({
      version: 1,
      type: "feedback",
      graphId: input.graphId,
      sessionId: input.sessionId,
      recordedAt: this.#now().toISOString(),
      collectionOrigin: input.collectionOrigin ?? "natural",
      semanticTaskId: input.semanticTaskId?.trim() || null,
      taskSuccess: input.taskSuccess ?? null,
      userCorrection: input.userCorrection ?? null,
      evidenceSufficient: input.evidenceSufficient ?? null,
      expansionUseful: input.expansionUseful ?? null,
      excessiveNoise: input.excessiveNoise ?? null,
      noMemoryNeeded: input.noMemoryNeeded ?? null,
      note: input.note?.trim() || undefined,
    });
  }

  toolFlow(input: {
    graphId: string;
    sessionId: string;
    action: ShadowToolFlowEvent["action"];
    reason: ShadowToolFlowEvent["reason"];
    query?: string;
  }): boolean {
    return this.#append({
      version: 1,
      type: "tool_flow",
      graphId: input.graphId,
      sessionId: input.sessionId,
      recordedAt: this.#now().toISOString(),
      action: input.action,
      reason: input.reason,
      query: input.query,
    });
  }

  actuation(input: {
    graphId: string;
    sessionId: string;
    action: ShadowActuationEvent["action"];
    changed: boolean;
    controllerTrainingSteps: number;
    controllerMode?: "controlled" | "active";
    candidateSha256?: string;
    featureProtocolVersion?: number;
    beforeMemoryIds?: readonly string[];
    afterMemoryIds?: readonly string[];
    beforeBudget?: ActiveGraphBudget;
    afterBudget?: ActiveGraphBudget;
  }): boolean {
    return this.#append({
      version: 2,
      type: "actuation",
      graphId: input.graphId,
      sessionId: input.sessionId,
      recordedAt: this.#now().toISOString(),
      action: input.action,
      changed: input.changed,
      controllerTrainingSteps: input.controllerTrainingSteps,
      controllerMode: input.controllerMode,
      candidateSha256: input.candidateSha256,
      featureProtocolVersion: input.featureProtocolVersion,
      beforeMemoryIds: input.beforeMemoryIds ? [...input.beforeMemoryIds] : undefined,
      afterMemoryIds: input.afterMemoryIds ? [...input.afterMemoryIds] : undefined,
      beforeBudget: input.beforeBudget ? { ...input.beforeBudget } : undefined,
      afterBudget: input.afterBudget ? { ...input.afterBudget } : undefined,
    });
  }

  #append(event: ShadowEvaluationEvent): boolean {
    const lockPath = `${this.#path}.lock`;
    let lock: number | null = null;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      lock = acquireFileLock(lockPath);
      const line = `${JSON.stringify(event)}\n`;
      if (
        existsSync(this.#path) &&
        statSync(this.#path).size + Buffer.byteLength(line) > this.#maxBytes
      )
        this.#rotate();
      appendFileSync(this.#path, line, "utf8");
      return true;
    } catch {
      return false;
    } finally {
      if (lock !== null) {
        try {
          closeSync(lock);
        } finally {
          try {
            unlinkSync(lockPath);
          } catch {
            // Another cleanup path may already have removed a stale lock.
          }
        }
      }
    }
  }

  #rotate(): void {
    const oldest = `${this.#path}.${this.#retainedFiles}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let index = this.#retainedFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? this.#path : `${this.#path}.${index - 1}`;
      const target = `${this.#path}.${index}`;
      if (existsSync(source)) renameSync(source, target);
    }
  }
}

const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function acquireFileLock(path: string, timeoutMs = 5_000): number {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return openSync(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 30_000) unlinkSync(path);
      } catch {
        // The owner may have released the lock between exists/stat/unlink.
      }
      if (Date.now() >= deadline) {
        throw new Error(`shadow evaluation log lock timed out: ${path}`, { cause: error });
      }
      Atomics.wait(LOCK_WAIT, 0, 0, 10);
    }
  }
}

function cloneControllerFeatures(
  features: ControllerShadowFeatureSnapshot,
): ControllerShadowFeatureSnapshot {
  const cloneMap = (values: Record<string, number[]>): Record<string, number[]> =>
    Object.fromEntries(Object.entries(values).map(([id, vector]) => [id, [...vector]]));
  return {
    protocolVersion: features.protocolVersion,
    global: [...features.global],
    memories: cloneMap(features.memories),
    nodes: cloneMap(features.nodes),
    edges: cloneMap(features.edges),
  };
}

function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}
