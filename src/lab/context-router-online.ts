import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ContextRouter, type ContextAction } from "./context-router.ts";
import {
  encodeContextFeatures,
  type ContextFeatureState,
} from "./context-features.ts";
import {
  contextOutcomeFromFeedback,
  contextUseReward,
  type ContextFeedbackLabels,
} from "./context-reward.ts";
import type { MemoryContext, MemorySearchResult } from "../core/types.ts";

/**
 * Shared online learner over the real auto-recall loop.
 *
 * Shared layer home for the context-use feedback loop (RSCB-style): a decision
 * (features + the action auto-recall actually took) is staged per retrieval
 * graph, then its later natural feedback maps to one observed-action regression
 * and the weights persist. Both host packages (pi extension, dsh/dsh-nmg) call
 * this same module — the learner never lives in one host.
 */

/** Online learning gate. ON by default (it never changes auto-recall behaviour
 *  and only runs a tiny observed-action update when feedback arrives). Set
 *  NMG_CONTEXT_ONLINE_LEARNING=0 to disable. */
export function contextOnlineLearningEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NMG_CONTEXT_ONLINE_LEARNING !== "0";
}

export function onlineRouterStatePath(dataDir: string): string {
  return join(dataDir, "context-router-online.json");
}

export function loadOnlineRouter(path: string): ContextRouter {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { params?: number[] };
    if (Array.isArray(parsed.params) && parsed.params.length === 132) {
      return new ContextRouter(parsed.params);
    }
  } catch {
    // Corrupt/absent state: start from a zero router rather than crashing recall.
  }
  return new ContextRouter();
}

export function saveOnlineRouter(router: ContextRouter, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, params: router.parameters() }), "utf8");
}

/** Best-effort 32-dim decision features from the real MemoryContext. Only reads
 *  fields actually present; anything not derivable here is left null so
 *  context-features encodes it as a missing indicator (never fabricated). Score
 *  values are batch-relative (top/max, gap/max) so no external envelope guess is
 *  needed. Callers may overlay extras (budget ratios) via `extras`.
 */
export function contextFeaturesFromMemory(
  ctx: Pick<MemoryContext, "results" | "activeGraph">,
  extras: ContextFeatureState = {},
): number[] {
  const scores = (ctx.results ?? [])
    .map((r: MemorySearchResult) => r.combinedScore)
    .filter((x: number) => Number.isFinite(x) && x >= 0);
  scores.sort((a, b) => b - a);
  const max = scores[0] ?? 0;
  const top = scores[0];
  const second = scores[1];
  const denom = Math.max(1e-6, max);
  const topCandidateScore = top !== undefined ? top / denom : undefined;
  const candidateScoreGap =
    top !== undefined && second !== undefined ? (top - second) / denom : undefined;
  const budgetTokens = ctx.activeGraph?.budget?.maxTokens;
  const state: ContextFeatureState = {
    ...extras,
    contextOccupancy: undefined,
    candidateCount: (ctx.results ?? []).length,
    topCandidateScore: topCandidateScore !== undefined ? Math.min(1, topCandidateScore) : undefined,
    candidateScoreGap: candidateScoreGap !== undefined ? Math.min(1, candidateScoreGap) : undefined,
    remainingTokenRatio:
      budgetTokens && Number.isFinite(budgetTokens)
        ? Math.min(1, budgetTokens / 50_000)
        : undefined,
    remainingToolRatio: undefined,
    candidateRedundancy: undefined,
    candidateFreshness: undefined,
    stepsSinceVerification: undefined,
    consecutiveFailures: undefined,
    returnedFromInterruption: undefined,
    previousNone: undefined,
    previousCue: undefined,
    previousResurface: undefined,
    previousRetrieve: undefined,
    previousReward: undefined,
  };
  return encodeContextFeatures(state);
}

interface StagedDecision {
  sessionId: string;
  features: number[];
  action: ContextAction;
}

/** Upper bound on staged decisions awaiting feedback (oldest evicted). */
const MAX_PENDING = 512;

/** Minimal online learner over the real auto-recall loop. One staged decision
 *  per retrieval graph is matched to its later feedback by graphId, then a
 *  single observed-action regression runs immediately and weights persist.
 *  Exploration is deliberately absent in v1: the executed action is always the
 *  one auto-recall actually took, so no behaviour changes while enabled.
 */
export class ContextRouterOnlineLearner {
  readonly #router: ContextRouter;
  readonly #statePath: string;
  readonly #pending = new Map<string, StagedDecision>();
  #dirty = false;

  constructor(statePath: string, router?: ContextRouter) {
    this.#statePath = statePath;
    this.#router = router ?? loadOnlineRouter(statePath);
  }

  parameters(): number[] {
    return this.#router.parameters();
  }

  /** Called right after an auto-recall staged/injected a retrieval graph. */
  stage(graphId: string, sessionId: string, features: number[], action: ContextAction): void {
    if (this.#pending.size >= MAX_PENDING) {
      // Evict the oldest staged decision so an always-unrated stream cannot grow
      // this map without bound.
      const oldest = this.#pending.keys().next().value;
      if (oldest !== undefined) this.#pending.delete(oldest);
    }
    this.#pending.set(graphId, { sessionId, features, action });
  }

  /** Newest staged decision in this session (feedback binding fallback when the
   *  controller shadow is disabled and cannot resolve the graph itself). */
  latestStagedGraph(sessionId: string): string | null {
    for (const graphId of [...this.#pending.keys()].reverse()) {
      if (this.#pending.get(graphId)?.sessionId === sessionId) return graphId;
    }
    return null;
  }

  /** Called when feedback for graphId arrives. Returns false when there is no
   *  staged decision, no usable label, or the graph is foreign. */
  consumeFeedback(
    graphId: string,
    labels: ContextFeedbackLabels,
    learningRate = 0.05,
  ): { trained: boolean; reward?: number; loss?: number } {
    const staged = this.#pending.get(graphId);
    this.#pending.delete(graphId);
    if (!staged) return { trained: false };
    const outcome = contextOutcomeFromFeedback(labels);
    if (!outcome) return { trained: false };
    const reward = contextUseReward(outcome, staged.action);
    const loss = this.#router.update(staged.features, staged.action, reward, learningRate);
    this.#dirty = true;
    return { trained: true, reward, loss };
  }

  /** Persist weights when any update happened (cheap; called after consume). */
  persistIfDirty(): void {
    if (!this.#dirty) return;
    saveOnlineRouter(this.#router, this.#statePath);
    this.#dirty = false;
  }
}
