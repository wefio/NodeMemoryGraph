import { decideMemoryLoad } from "../core/gate.ts";
import type { MemoryTier } from "../core/types.ts";
import { excerpt } from "./tool-observation.ts";

interface SessionTaskState {
  anchors: string[];
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

  prepare(sessionId: string, prompt: string): SessionRecallRequest | null {
    const normalized = normalizeTaskPrompt(prompt);
    if (!normalized) return null;
    const state = this.#state(sessionId);
    const gate = decideMemoryLoad(normalized);
    const substantive = isSubstantiveTaskPrompt(normalized);
    const continuation = isTaskContinuation(normalized);
    const prior = state.anchors.join("\n");
    const continuePriorTask = continuation && prior.length > 0;
    const usePriorContext = prior.length > 0 && (gate.mode === "retrieve" || continuePriorTask);

    if (substantive) {
      const anchor = excerpt(normalized, this.maxAnchorCharacters);
      if (state.anchors.at(-1) !== anchor) state.anchors.push(anchor);
      while (state.anchors.length > this.maxAnchors) state.anchors.shift();
    }
    if (gate.mode === "none" && !continuePriorTask) return null;
    return {
      query: [normalized, usePriorContext ? `Recent task context:\n${prior}` : ""]
        .filter(Boolean)
        .join("\n"),
      mode: gate.mode === "none" ? "cue" : gate.mode,
      reason: gate.mode === "none" ? "task_continuation" : gate.reason,
      maxTier: (gate.mode === "none" ? 1 : gate.maxTier) as MemoryTier,
      limit: gate.mode === "none" ? 5 : gate.limit,
      graphHops: gate.mode === "none" ? 0 : gate.graphHops,
    };
  }

  clear(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  #state(sessionId: string): SessionTaskState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = { anchors: [] };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }
}

function normalizeTaskPrompt(prompt: string): string {
  return prompt.replace(/\s+/gu, " ").trim();
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
