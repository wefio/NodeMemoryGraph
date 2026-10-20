import { recallTermDecision } from "../core/gate.ts";
import { RecallPool } from "../core/recall-pool.ts";
import type { MemoryTier, MemoryGateDecision } from "../core/types.ts";
import { excerpt } from "./tool-observation.ts";

interface SessionTaskState {
  anchors: string[];
  pool: RecallPool;
  turn: number;
}

export interface SessionRecallRequest {
  query: string;
  mode: "retrieve" | "cue";
  reason: string;
  maxTier: MemoryTier;
  limit: number;
  graphHops: number;
}

/**
 * Bounded query-side task context for automatic recall. It does not inject
 * transcript text into the model and does not attempt semantic summarisation;
 * it only carries two recent substantive user task anchors across terse
 * continuation turns such as "reload 了，你试试".
 */
export class SessionTaskWindow {
  readonly #sessions = new Map<string, SessionTaskState>();
  readonly maxAnchors: number;
  readonly maxAnchorCharacters: number;

  constructor(maxAnchors = 2, maxAnchorCharacters = 480) {
    this.maxAnchors = Math.max(1, maxAnchors);
    this.maxAnchorCharacters = Math.max(80, maxAnchorCharacters);
  }

  prepare(
    sessionId: string,
    prompt: string,
    retainedDecision?: MemoryGateDecision,
  ): SessionRecallRequest | null {
    const normalized = normalizeTaskPrompt(prompt);
    if (!normalized) return null;
    const state = this.#state(sessionId);
    // A daemon decision, including `none`, is authoritative: never resurrect an evicted seed.
    const gate =
      retainedDecision ?? recallTermDecision(state.pool.observe(prompt, ++state.turn)?.mode);
    const prior = state.anchors.join("\n");
    rememberAnchor(state, normalized, this.maxAnchors, this.maxAnchorCharacters);
    const continued = isTaskContinuation(normalized) && prior.length > 0;
    if (gate.mode === "none" && !continued) return null;
    const withPrior = prior.length > 0 && (gate.mode === "retrieve" || continued);
    return {
      query: [normalized, withPrior ? `Recent task context:\n${prior}` : ""]
        .filter(Boolean)
        .join("\n"),
      ...gateBudget(gate),
    };
  }

  clear(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  #state(sessionId: string): SessionTaskState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = { anchors: [], pool: new RecallPool(), turn: 0 };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }
}

function normalizeTaskPrompt(prompt: string): string {
  return prompt.replace(/\s+/gu, " ").trim();
}

function rememberAnchor(
  state: SessionTaskState,
  normalized: string,
  maxAnchors: number,
  maxCharacters: number,
): void {
  if (!isSubstantiveTaskPrompt(normalized)) return;
  const anchor = excerpt(normalized, maxCharacters);
  if (state.anchors.at(-1) === anchor) return;
  state.anchors.push(anchor);
  while (state.anchors.length > maxAnchors) state.anchors.shift();
}

/** A terse continuation keeps its shallow budget so task context is not an unbounded search. */
function gateBudget(
  gate: MemoryGateDecision,
): Pick<SessionRecallRequest, "mode" | "reason" | "maxTier" | "limit" | "graphHops"> {
  if (gate.mode === "none")
    return {
      mode: "cue",
      reason: "task_continuation",
      maxTier: 1 as MemoryTier,
      limit: 5,
      graphHops: 0,
    };
  return {
    mode: gate.mode,
    reason: gate.reason,
    maxTier: gate.maxTier as MemoryTier,
    limit: gate.limit,
    graphHops: gate.graphHops,
  };
}

function isSubstantiveTaskPrompt(prompt: string): boolean {
  if (prompt.length >= 40) return true;
  return /(?:[A-Za-z][\w.-]{2,}[-_/][\w./-]+|\b(?:fix|implement|debug|test|build|refactor|install|configure)\b|(?:修复|实现|测试|构建|重构|安装|配置|设计))/iu.test(
    prompt,
  );
}

function isTaskContinuation(prompt: string): boolean {
  if (prompt.length > 100) return false;
  return /(?:\b(?:continue|again|retry|reload|try|proceed|go on|fix it|test it)\b|(?:继续|再试|重试|试试|开始吧|接着|改吧|修一下|好了|可以了|然后呢))/iu.test(
    prompt,
  );
}
