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
  disclosureRecorded: boolean;
  outcomeRecorded: boolean;
  feedbackRecorded: boolean;
  feedbackNudgeShown: boolean;
  verifiedClaimOutcomeRecorded: boolean;
  claimOutcomeNudgeShown: boolean;
  verifiedSupportedMemoryIds: Set<string>;
}

export interface PendingShadowFeedback {
  activeGraphId: string;
  semanticTaskId: string;
}

export interface PendingClaimOutcome {
  activeGraphId: string;
  semanticTaskId: string;
}

/**
 * Optional, lazy Pi bridge for the experimental differentiable controller.
 * It records disclosure separately from answer attribution and never changes retrieval.
 */
export class ControllerShadowBridge {
  readonly enabled: boolean;
  readonly #dataDirectory: string;
  readonly #contexts = new Map<string, PendingContext>();
  readonly #maxContexts: number;
  readonly #collectionOrigin: "controlled" | "natural";
  #dependenciesPromise: Promise<ShadowDependencies> | undefined;

  constructor(
    dataDirectory: string,
    enabled = shadowEnabled(),
    maxContexts = 128,
    collectionOrigin = shadowCollectionOrigin(),
  ) {
    this.#dataDirectory = dataDirectory;
    this.enabled = enabled;
    this.#maxContexts = Math.max(1, maxContexts);
    this.#collectionOrigin = collectionOrigin;
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
      if (injectedText.trim()) {
        const pending = this.#contexts.get(context.activeGraph.id);
        if (pending) pending.disclosureRecorded = true;
      }
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

  /**
   * Produce an active budget only after the controller has learned from at
   * least one verified evidence outcome. A zero-step controller is an uninformative
   * 0.5 prior and must never change product retrieval merely because active
   * mode was selected.
   */
  async allocate(
    context: MemoryContext,
    minimum: import("../../../src/core/types.ts").ActiveGraphBudget,
    normalMaximum: import("../../../src/core/types.ts").ActiveGraphBudget,
    expandedMaximum: import("../../../src/core/types.ts").ActiveGraphBudget,
  ): Promise<import("../../../src/lab/controller-runtime.ts").ControllerBudgetDecision | null> {
    if (!this.enabled) return null;
    try {
      const { runtime } = await this.#dependencies();
      return runtime.trainingSteps > 0
        ? runtime.allocate(context, minimum, normalMaximum, expandedMaximum)
        : null;
    } catch {
      return null;
    }
  }

  /** Learned listwise fold; like allocation, it is inert before supervision. */
  async fold(
    context: MemoryContext,
    retainedMass: number,
  ): Promise<import("../../../src/lab/controller-runtime.ts").ControllerMemoryFold | null> {
    if (!this.enabled) return null;
    try {
      const { runtime } = await this.#dependencies();
      return runtime.trainingSteps > 0 ? runtime.foldMemories(context, retainedMass) : null;
    } catch {
      return null;
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
        collectionOrigin: this.#collectionOrigin,
        ...labels,
        semanticTaskId: labels.semanticTaskId ?? pending.context.activeGraph?.taskId,
      });
      if (recorded) pending.feedbackRecorded = true;
      return recorded;
    } catch {
      return false;
    }
  }

  /** Resolve an omitted feedback ID only inside the caller's Pi session. */
  latestActiveGraphId(sessionId: string): string | null {
    if (!this.enabled) return null;
    return (
      [...this.#contexts.entries()]
        .reverse()
        .find(([, entry]) => entry.context.activeGraph?.sessionId === sessionId)?.[0] ?? null
    );
  }

  /** Resolve the newest graph in this Pi session that actually exposed a memory. */
  latestActiveGraphIdForMemory(sessionId: string, memoryId: string): string | null {
    if (!this.enabled) return null;
    return (
      [...this.#contexts.entries()]
        .reverse()
        .find(
          ([, entry]) =>
            entry.context.activeGraph?.sessionId === sessionId &&
            entry.context.activeGraph.memoryIds.includes(memoryId),
        )?.[0] ?? null
    );
  }

  async disclosure(
    activeGraphId: string | undefined,
    sessionId: string,
    requestedMemoryIds: readonly string[],
    disclosedMemoryIds: readonly string[],
  ): Promise<void> {
    if (!this.enabled || !activeGraphId) return;
    const pending = this.#contexts.get(activeGraphId);
    const context = pending?.context;
    if (!pending || !context?.activeGraph || context.activeGraph.sessionId !== sessionId) return;
    try {
      const dependencies = await this.#dependencies();
      const recorded = dependencies.log.disclosure({
        graphId: activeGraphId,
        sessionId,
        requestedMemoryIds,
        disclosedMemoryIds,
      });
      if (recorded && disclosedMemoryIds.length > 0) pending.disclosureRecorded = true;
    } catch {
      // Best-effort disclosure telemetry; the daemon owns the canonical trace.
    }
  }

  async attribution(
    activeGraphId: string | undefined,
    sessionId: string,
    candidateMemoryIds: readonly string[],
    attributedMemoryIds: readonly string[],
  ): Promise<void> {
    if (!this.enabled || !activeGraphId) return;
    const pending = this.#contexts.get(activeGraphId);
    const context = pending?.context;
    if (!pending || !context?.activeGraph || context.activeGraph.sessionId !== sessionId) return;
    try {
      const dependencies = await this.#dependencies();
      dependencies.log.attribution({
        graphId: activeGraphId,
        sessionId,
        candidateMemoryIds,
        attributedMemoryIds,
        method: "answer_overlap",
      });
    } catch {
      // Best-effort diagnostic attribution; never break agent completion.
    }
  }

  /**
   * Persist a cumulative evidence target only after the daemon accepted an
   * attributable user/tool claim outcome. Contradiction is an explicit negative,
   * so it removes the memory from the supported set while still emitting an
   * attribution event. The latest event therefore remains a complete target for
   * the graph instead of losing earlier supported memories.
   */
  async verifiedClaimOutcome(
    activeGraphId: string | undefined,
    sessionId: string,
    memoryId: string,
    outcome: "supported" | "contradicted",
  ): Promise<boolean> {
    if (!this.enabled || !activeGraphId) return false;
    const pending = this.#contexts.get(activeGraphId);
    const graph = pending?.context.activeGraph;
    if (!pending || !graph || graph.sessionId !== sessionId || !graph.memoryIds.includes(memoryId)) {
      return false;
    }
    if (outcome === "supported") pending.verifiedSupportedMemoryIds.add(memoryId);
    else pending.verifiedSupportedMemoryIds.delete(memoryId);
    // The caller invokes this only after the canonical daemon accepted the
    // attributable outcome. Suppress the reminder even if best-effort shadow
    // logging fails; otherwise a telemetry failure could prompt a duplicate vote.
    pending.verifiedClaimOutcomeRecorded = true;
    try {
      const dependencies = await this.#dependencies();
      const recorded = dependencies.log.attribution({
        graphId: activeGraphId,
        sessionId,
        candidateMemoryIds: graph.memoryIds,
        attributedMemoryIds: [...pending.verifiedSupportedMemoryIds],
        method: "verified_claim_support",
      });
      return recorded;
    } catch {
      // Canonical claim evidence is already in SQLite; shadow export is best-effort.
      return false;
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

  async claimOutcomeNudgeShown(
    sessionId: string,
    pendingClaimOutcome: PendingClaimOutcome,
  ): Promise<void> {
    if (!this.enabled) return;
    const pending = this.#contexts.get(pendingClaimOutcome.activeGraphId);
    if (pending?.context.activeGraph?.sessionId !== sessionId) return;
    try {
      const dependencies = await this.#dependencies();
      dependencies.log.toolFlow({
        graphId: pendingClaimOutcome.activeGraphId,
        sessionId,
        action: "claim_outcome_nudge_shown",
        reason: "next_user_turn_claim_review",
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
          entry.disclosureRecorded &&
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

  /**
   * Return one completed disclosure that still lacks independently attributable
   * claim evidence. The reminder is deliberately advisory: the next user turn
   * may contain no eligible evidence, which remains unknown rather than a label.
   */
  pendingClaimOutcome(sessionId: string): PendingClaimOutcome | null {
    if (!this.enabled) return null;
    const pending = [...this.#contexts.entries()]
      .reverse()
      .find(
        ([, entry]) =>
          entry.context.activeGraph?.sessionId === sessionId &&
          entry.disclosureRecorded &&
          entry.outcomeRecorded &&
          !entry.verifiedClaimOutcomeRecorded &&
          !entry.claimOutcomeNudgeShown,
      );
    if (!pending) return null;
    const [activeGraphId, entry] = pending;
    entry.claimOutcomeNudgeShown = true;
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
      disclosureRecorded: false,
      outcomeRecorded: false,
      feedbackRecorded: false,
      feedbackNudgeShown: false,
      verifiedClaimOutcomeRecorded: false,
      claimOutcomeNudgeShown: false,
      verifiedSupportedMemoryIds: new Set(),
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

export function shadowCollectionOrigin(
  value = process.env.NMG_SHADOW_COLLECTION_ORIGIN,
): "controlled" | "natural" {
  return value?.trim().toLowerCase() === "controlled" ? "controlled" : "natural";
}
