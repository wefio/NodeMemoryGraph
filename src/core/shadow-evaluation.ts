import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

import type { ControllerShadowDecision } from "./controller-runtime.ts";
import type { ActiveGraphBudgetUsage } from "./types.ts";

export type ShadowRetrievalOrigin = "automatic" | "tool";

interface ShadowEventBase {
  version: 1;
  graphId: string;
  sessionId: string;
  recordedAt: string;
}

export interface ShadowRetrievalEvent extends ShadowEventBase {
  type: "retrieval";
  origin: ShadowRetrievalOrigin;
  query: string;
  candidateMemoryIds: string[];
  candidateNodeIds: string[];
  baselineNodeIds: string[];
  learnedNodeIds: string[];
  changed: boolean;
  controllerTrainingSteps: number;
  costs: {
    retrievalLatencyMs: number;
    controllerLatencyMs: number;
    recordsRead: number;
    estimatedTokens: number;
    nodesRead: number;
    edgesRead: number;
    deepestTier: number;
  };
}

export interface ShadowUseEvent extends ShadowEventBase {
  type: "use";
  requestedMemoryIds: string[];
  usedMemoryIds: string[];
}

export interface ShadowOutcomeEvent extends ShadowEventBase {
  type: "outcome";
  runCompleted: boolean;
  messageCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ShadowFeedbackEvent extends ShadowEventBase {
  type: "feedback";
  taskSuccess: boolean | null;
  userCorrection: boolean | null;
  note?: string;
}

export type ShadowEvaluationEvent =
  ShadowRetrievalEvent | ShadowUseEvent | ShadowOutcomeEvent | ShadowFeedbackEvent;

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
    candidateMemoryIds: readonly string[];
    candidateNodeIds: readonly string[];
    decision: ControllerShadowDecision;
    usage: ActiveGraphBudgetUsage;
    controllerLatencyMs: number;
  }): boolean {
    return this.#append({
      version: 1,
      type: "retrieval",
      graphId: input.graphId,
      sessionId: input.sessionId,
      recordedAt: this.#now().toISOString(),
      origin: input.origin,
      query: input.query,
      candidateMemoryIds: [...input.candidateMemoryIds],
      candidateNodeIds: [...input.candidateNodeIds],
      baselineNodeIds: input.decision.baselineNodeIds,
      learnedNodeIds: input.decision.learnedNodeIds,
      changed: input.decision.changed,
      controllerTrainingSteps: input.decision.trainingSteps,
      costs: {
        retrievalLatencyMs: input.usage.latencyMs,
        controllerLatencyMs: input.controllerLatencyMs,
        recordsRead: input.usage.evidence,
        estimatedTokens: input.usage.estimatedTokens,
        nodesRead: input.usage.nodes,
        edgesRead: input.usage.edges,
        deepestTier: input.usage.deepestTier,
      },
    });
  }

  use(input: {
    graphId: string;
    sessionId: string;
    requestedMemoryIds: readonly string[];
    usedMemoryIds: readonly string[];
  }): boolean {
    return this.#append({
      version: 1,
      type: "use",
      graphId: input.graphId,
      sessionId: input.sessionId,
      recordedAt: this.#now().toISOString(),
      requestedMemoryIds: [...input.requestedMemoryIds],
      usedMemoryIds: [...input.usedMemoryIds],
    });
  }

  outcome(input: {
    graphId: string;
    sessionId: string;
    messageCount: number;
    inputTokens?: number;
    outputTokens?: number;
  }): boolean {
    return this.#append({
      version: 1,
      type: "outcome",
      graphId: input.graphId,
      sessionId: input.sessionId,
      recordedAt: this.#now().toISOString(),
      runCompleted: true,
      messageCount: input.messageCount,
      inputTokens: finiteOrNull(input.inputTokens),
      outputTokens: finiteOrNull(input.outputTokens),
    });
  }

  feedback(input: {
    graphId: string;
    sessionId: string;
    taskSuccess?: boolean | null;
    userCorrection?: boolean | null;
    note?: string;
  }): boolean {
    return this.#append({
      version: 1,
      type: "feedback",
      graphId: input.graphId,
      sessionId: input.sessionId,
      recordedAt: this.#now().toISOString(),
      taskSuccess: input.taskSuccess ?? null,
      userCorrection: input.userCorrection ?? null,
      note: input.note?.trim() || undefined,
    });
  }

  #append(event: ShadowEvaluationEvent): boolean {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
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

function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}
