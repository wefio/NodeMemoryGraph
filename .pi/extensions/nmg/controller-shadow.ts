import { join } from "node:path";

import type { MemoryContext } from "../../../src/core/types.ts";

type ShadowOrigin = "automatic" | "tool";

interface ShadowDependencies {
  runtime: import("../../../src/lab/controller-runtime.ts").ControllerRuntime;
  log: import("../../../src/lab/shadow-evaluation.ts").ShadowEvaluationLog;
}

interface PendingContext {
  context: MemoryContext;
  retrievedAt: number;
  useRecorded: boolean;
  outcomeRecorded: boolean;
  feedbackRecorded: boolean;
  feedbackNudgeShown: boolean;
}

export interface PendingShadowFeedback {
  activeGraphId: string;
  semanticTaskId: string;
}

/**
 * Optional, lazy Pi bridge for the experimental differentiable controller.
 * It records and learns from explicit get use but never changes retrieval.
 */
export class ControllerShadowBridge {
  readonly enabled: boolean;
  readonly #dataDirectory: string;
  readonly #contexts = new Map<string, PendingContext>();
  readonly #maxContexts: number;
  #dependenciesPromise: Promise<ShadowDependencies> | undefined;

  constructor(dataDirectory: string, enabled = shadowEnabled(), maxContexts = 128) {
    this.#dataDirectory = dataDirectory;
    this.enabled = enabled;
    this.#maxContexts = Math.max(1, maxContexts);
  }

  async retrieval(
    context: MemoryContext,
    sessionId: string,
    origin: ShadowOrigin,
    injectedText = "",
  ): Promise<void> {
    if (!this.enabled || !context.activeGraph) return;
    try {
      const dependencies = await this.#dependencies();
      const startedAt = performance.now();
      const decision = dependencies.runtime.shadow(context);
      const controllerLatencyMs = performance.now() - startedAt;
      if (!decision) return;
      this.#rememberContext(context.activeGraph.id, context);
      dependencies.log.retrieval({
        graphId: context.activeGraph.id,
        sessionId,
        origin,
        query: context.activeGraph.query,
        queryTaskId: context.activeGraph.taskId,
        candidateMemoryIds: context.activeGraph.memoryIds,
        candidateNodeIds: context.activeGraph.nodeIds,
        selections: context.activeGraph.selections,
        qpp: context.activeGraph.qpp,
        decision,
        budget: context.activeGraph.budget,
        usage: context.activeGraph.usage,
        controllerLatencyMs,
        injectedText,
      });
    } catch {
      // Shadow telemetry and learning must never break memory retrieval.
    }
  }

  async feedback(
    activeGraphId: string,
    sessionId: string,
    labels: {
      taskSuccess?: boolean;
      userCorrection?: boolean;
      evidenceSufficient?: boolean;
      expansionUseful?: boolean;
      excessiveNoise?: boolean;
      noMemoryNeeded?: boolean;
      note?: string;
      semanticTaskId?: string;
    },
  ): Promise<boolean> {
    if (!this.enabled) return false;
    const pending = this.#contexts.get(activeGraphId);
    if (pending?.context.activeGraph?.sessionId !== sessionId) return false;
    try {
      const dependencies = await this.#dependencies();
      const recorded = dependencies.log.feedback({
        graphId: activeGraphId,
        sessionId,
        ...labels,
        semanticTaskId: labels.semanticTaskId ?? pending.context.activeGraph?.taskId,
      });
      if (recorded) pending.feedbackRecorded = true;
      return recorded;
    } catch {
      return false;
    }
  }

  async use(
    activeGraphId: string | undefined,
    sessionId: string,
    requestedMemoryIds: readonly string[],
    usedMemoryIds: readonly string[],
  ): Promise<void> {
    if (!this.enabled || !activeGraphId) return;
    const pending = this.#contexts.get(activeGraphId);
    const context = pending?.context;
    if (!pending || !context?.activeGraph || context.activeGraph.sessionId !== sessionId) return;
    try {
      const dependencies = await this.#dependencies();
      dependencies.log.use({
        graphId: activeGraphId,
        sessionId,
        requestedMemoryIds,
        usedMemoryIds,
      });
      if (usedMemoryIds.length > 0) pending.useRecorded = true;
      dependencies.runtime.observeUse(context, usedMemoryIds);
    } catch {
      // Best-effort shadow learning; the daemon already owns canonical use attribution.
    }
  }

  async searchSuppressed(sessionId: string, query: string): Promise<void> {
    if (!this.enabled) return;
    const graphId = [...this.#contexts.entries()]
      .reverse()
      .find(([, entry]) => entry.context.activeGraph?.sessionId === sessionId)?.[0];
    if (!graphId) return;
    try {
      const dependencies = await this.#dependencies();
      dependencies.log.toolFlow({
        graphId,
        sessionId,
        action: "search_suppressed",
        reason: "evidence_progression_required",
        query,
      });
    } catch {
      // Tool-flow telemetry is observational and must not affect Pi completion.
    }
  }

  async feedbackNudgeShown(
    sessionId: string,
    pendingFeedback: PendingShadowFeedback,
  ): Promise<void> {
    if (!this.enabled) return;
    const pending = this.#contexts.get(pendingFeedback.activeGraphId);
    if (pending?.context.activeGraph?.sessionId !== sessionId) return;
    try {
      const dependencies = await this.#dependencies();
      dependencies.log.toolFlow({
        graphId: pendingFeedback.activeGraphId,
        sessionId,
        action: "feedback_nudge_shown",
        reason: "next_user_turn_review",
      });
    } catch {
      // Reminder telemetry is observational and must not affect the reminder.
    }
  }

  async outcome(sessionId: string, messages: readonly unknown[]): Promise<void> {
    if (!this.enabled) return;
    const pending = [...this.#contexts.entries()].filter(
      ([, entry]) => !entry.outcomeRecorded && entry.context.activeGraph?.sessionId === sessionId,
    );
    if (pending.length === 0) return;
    try {
      const dependencies = await this.#dependencies();
      const usage = summarizeMessages(messages);
      for (const [graphId, entry] of pending) {
        dependencies.log.outcome({
          graphId,
          sessionId,
          messageCount: messages.length,
          toolRounds: usage.toolRounds,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          endToEndLatencyMs: Math.max(0, performance.now() - entry.retrievedAt),
        });
        entry.outcomeRecorded = true;
      }
    } catch {
      // Outcome telemetry is observational and must not affect Pi completion.
    }
  }

  /**
   * Return one completed, still-unlabelled retrieval for next-turn review.
   * Showing the reminder is one-shot; lack of feedback remains unknown rather
   * than becoming an implicit negative or positive label.
   */
  pendingFeedback(sessionId: string): PendingShadowFeedback | null {
    if (!this.enabled) return null;
    const pending = [...this.#contexts.entries()]
      .reverse()
      .find(
        ([, entry]) =>
          entry.context.activeGraph?.sessionId === sessionId &&
          entry.useRecorded &&
          entry.outcomeRecorded &&
          !entry.feedbackRecorded &&
          !entry.feedbackNudgeShown,
      );
    if (!pending) return null;
    const [activeGraphId, entry] = pending;
    entry.feedbackNudgeShown = true;
    return {
      activeGraphId,
      semanticTaskId: entry.context.activeGraph!.taskId,
    };
  }

  clear(sessionId: string): void {
    for (const [graphId, entry] of this.#contexts) {
      if (entry.context.activeGraph?.sessionId === sessionId) this.#contexts.delete(graphId);
    }
  }

  async #dependencies(): Promise<ShadowDependencies> {
    return (this.#dependenciesPromise ??= Promise.all([
      import("../../../src/lab/controller-runtime.ts"),
      import("../../../src/lab/shadow-evaluation.ts"),
    ]).then(([runtimeModule, logModule]) => ({
      runtime: new runtimeModule.ControllerRuntime(
        join(this.#dataDirectory, "controller-shadow-state.json"),
      ),
      log: new logModule.ShadowEvaluationLog(
        join(this.#dataDirectory, "controller-shadow-events.jsonl"),
      ),
    })));
  }

  #rememberContext(graphId: string, context: MemoryContext): void {
    this.#contexts.delete(graphId);
    this.#contexts.set(graphId, {
      context,
      retrievedAt: performance.now(),
      useRecorded: false,
      outcomeRecorded: false,
      feedbackRecorded: false,
      feedbackNudgeShown: false,
    });
    while (this.#contexts.size > this.#maxContexts) {
      this.#contexts.delete(this.#contexts.keys().next().value!);
    }
  }
}

function summarizeMessages(messages: readonly unknown[]): {
  inputTokens: number;
  outputTokens: number;
  toolRounds: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let toolRounds = 0;
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as { role?: unknown; usage?: { input?: unknown; output?: unknown } };
    if (message.role === "toolResult") toolRounds += 1;
    if (message.role !== "assistant" || !message.usage) continue;
    if (typeof message.usage.input === "number" && Number.isFinite(message.usage.input)) {
      inputTokens += message.usage.input;
    }
    if (typeof message.usage.output === "number" && Number.isFinite(message.usage.output)) {
      outputTokens += message.usage.output;
    }
  }
  return { inputTokens, outputTokens, toolRounds };
}

export function shadowEnabled(value = process.env.NMG_CONTROLLER_SHADOW): boolean {
  return /^(?:1|true|yes|on)$/iu.test(value?.trim() ?? "");
}
