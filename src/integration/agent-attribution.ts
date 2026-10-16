import type { MemoryContext, MemorySearchResult } from "../core/types.ts";
import { messageText } from "./tool-observation.ts";

/**
 * Agent-end diagnostic-attribution cache. Independent of the SkillOpt shadow
 * bridge, it records which active graphs a session retrieved so agent_end can
 * derive answer overlap and persist attributed_memory_ids. The signal is useful
 * for coverage and feedback targeting but cannot train QPP or the controller.
 * Normal close() already checkpoints, so there is no per-turn cost beyond the
 * bounded in-memory list.
 */
export class AgentAttributionFlow {
  readonly #traces = new Map<string, Array<{ traceId: string; results: MemorySearchResult[] }>>();
  readonly maxPerSession: number;

  constructor(maxPerSession = 8) {
    this.maxPerSession = Math.max(1, maxPerSession);
  }

  note(sessionId: string, context: MemoryContext): void {
    if (!context.activeGraph) return;
    let list = this.#traces.get(sessionId);
    if (!list) {
      list = [];
      this.#traces.set(sessionId, list);
    }
    const existing = list.find((entry) => entry.traceId === context.activeGraph!.id);
    if (existing) {
      existing.results = context.results;
      return;
    }
    list.push({ traceId: context.activeGraph.id, results: context.results });
    if (list.length > this.maxPerSession) list.shift();
  }

  latestActiveGraphIdForMemories(sessionId: string, memoryIds: readonly string[]): string | null {
    if (memoryIds.length === 0) return null;
    const requested = new Set(memoryIds);
    const traces = this.#traces.get(sessionId) ?? [];
    for (let index = traces.length - 1; index >= 0; index -= 1) {
      const trace = traces[index]!;
      const available = new Set(trace.results.map((result) => result.memory.id));
      if ([...requested].every((memoryId) => available.has(memoryId))) return trace.traceId;
    }
    return null;
  }

  /** All retrieved graphs for this session, cleared afterwards (one-shot). */
  consume(sessionId: string): Array<{ traceId: string; results: MemorySearchResult[] }> {
    const pending = this.#traces.get(sessionId) ?? [];
    this.#traces.delete(sessionId);
    return pending;
  }

  clear(sessionId: string): void {
    this.#traces.delete(sessionId);
  }
}

/** Concatenate assistant message content from an agent_end message list. */
export function extractAnswerText(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") continue;
    const text = messageText(message.content).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n").trim();
}

export function extractPromptText(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as { role?: unknown; content?: unknown };
    if (message.role !== "user") continue;
    const text = messageText(message.content).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n").trim();
}
