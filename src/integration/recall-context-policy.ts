import type { MemorySearchResult } from "../core/types.ts";
import { isTaskContinuation } from "./session-task-window.ts";

export type RecallDisplayMode = "compact" | "full";
interface RecallContextState {
  project: string;
  prompts: string[];
}
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const stopWords = new Set(
  "the a an is are was were this that it and or to of in for with can you i we please 继续 开始 可以 好的 什么 怎么 如何 我 你 的 了 是 在 和 与".split(
    " ",
  ),
);

function terms(text: string): Set<string> {
  const clean = text
    .slice(0, 4_000)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/\b[0-9a-f]{8,}\b/gu, " ");
  return new Set(
    [...segmenter.segment(clean)]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment)
      .filter((term) => !stopWords.has(term) && !/^\d+$/u.test(term)),
  );
}
function overlap(query: Set<string>, text: Set<string>): number {
  if (!query.size) return 0;
  return [...query].filter((term) => text.has(term)).length / query.size;
}

/** Bounded user-only context. Ranking preserves every candidate and its retrieval scores. */
export class RecallContextPolicy {
  readonly #sessions = new Map<string, RecallContextState>();
  readonly #modes = new Map<string, RecallDisplayMode>();

  #state(sessionId: string): RecallContextState {
    let state = this.#sessions.get(sessionId);
    if (!state) state = { project: "", prompts: [] };
    this.#sessions.delete(sessionId);
    this.#sessions.set(sessionId, state);
    if (this.#sessions.size > 32) this.#sessions.delete(this.#sessions.keys().next().value!);
    return state;
  }

  observe(sessionId: string, prompt: string, project: string): void {
    const state = this.#state(sessionId);
    if (state.project !== project) state.prompts = [];
    state.project = project;
    const bounded = Array.from(prompt.replace(/\s+/gu, " ").trim()).slice(0, 480).join("");
    if (bounded && state.prompts.at(-1) !== bounded) state.prompts.push(bounded);
    state.prompts = state.prompts.slice(-3);
  }

  mode(sessionId: string): RecallDisplayMode {
    return this.#modes.get(sessionId) ?? "compact";
  }
  setMode(sessionId: string, mode: RecallDisplayMode): void {
    if (mode === "compact") this.#modes.delete(sessionId);
    else this.#modes.set(sessionId, mode);
  }
  clear(sessionId: string): void {
    this.#sessions.delete(sessionId);
    this.#modes.delete(sessionId);
  }

  rank(
    sessionId: string,
    project: string,
    query: string,
    results: readonly MemorySearchResult[],
  ): MemorySearchResult[] {
    const current = query.split("\nRecent task context:")[0]!.trim();
    const currentTerms = terms(current);
    const state = this.#sessions.get(sessionId);
    const prompts = state?.project === project ? state.prompts : [];
    const recent = prompts.filter((prompt) => prompt !== current && !isTaskContinuation(prompt));
    // Only the latest distinct topic can supplement a continuation. A current
    // substantive request must overlap that topic before history can affect rank.
    const previous = terms(recent.at(-1) ?? "");
    const history =
      isTaskContinuation(current) || overlap(currentTerms, previous) > 0
        ? previous
        : new Set<string>();
    if (!currentTerms.size && !history.size) return [...results];
    return results
      .map((result, index) => {
        const candidate = terms(`${result.node.canonicalName} ${result.memory.statement}`);
        return {
          result,
          index,
          score:
            2 * overlap(currentTerms, candidate) +
            0.35 * overlap(history, candidate) +
            0.15 / (index + 1),
        };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(({ result }) => result);
  }
}
