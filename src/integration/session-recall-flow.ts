/**
 * Per-turn tool-flow guard. It does not cap retrieval depth or result count;
 * it prevents repeated paraphrased searches when the model has not consumed
 * any returned evidence. A successful get opens the search phase again.
 */
export class SessionRecallFlow {
  readonly #states = new Map<
    string,
    {
      turnKey: string;
      searchesSinceGet: number;
      searchCalls: number;
      recallCalls: number;
      consecutiveNoGain: number;
      candidateIds: Set<string>;
      loadedIds: Set<string>;
    }
  >();
  readonly maxSearchesBeforeGet: number;
  readonly maxSearchCalls: number;
  readonly maxRecallCalls: number;
  readonly maxConsecutiveNoGain: number;

  constructor(
    maxSearchesBeforeGet = 2,
    maxSearchCalls = 3,
    maxRecallCalls = 5,
    maxConsecutiveNoGain = 2,
  ) {
    this.maxSearchesBeforeGet = Math.max(1, maxSearchesBeforeGet);
    this.maxSearchCalls = Math.max(this.maxSearchesBeforeGet, maxSearchCalls);
    this.maxRecallCalls = Math.max(this.maxSearchCalls, maxRecallCalls);
    this.maxConsecutiveNoGain = Math.max(1, maxConsecutiveNoGain);
  }

  beginTurn(sessionId: string, turnKey: string): boolean {
    const current = this.#states.get(sessionId);
    if (current?.turnKey === turnKey) return false;
    this.#states.set(sessionId, this.#newState(turnKey));
    return true;
  }

  allowSearch(sessionId: string): boolean {
    const current = this.#state(sessionId);
    if (this.searchBlockReason(sessionId) !== null) return false;
    current.searchesSinceGet += 1;
    current.searchCalls += 1;
    current.recallCalls += 1;
    return true;
  }

  searchBlockReason(sessionId: string): string | null {
    const current = this.#state(sessionId);
    if (current.recallCalls >= this.maxRecallCalls) return "recall_tool_budget_exhausted";
    if (current.searchCalls >= this.maxSearchCalls) return "search_budget_exhausted";
    if (current.consecutiveNoGain >= this.maxConsecutiveNoGain) return "no_new_evidence";
    if (current.searchesSinceGet >= this.maxSearchesBeforeGet) {
      return "evidence_progression_required";
    }
    return null;
  }

  recordSearch(sessionId: string, memoryIds: readonly string[]): void {
    const current = this.#state(sessionId);
    const newIds = memoryIds.filter((memoryId) => !current.candidateIds.has(memoryId));
    for (const memoryId of memoryIds) current.candidateIds.add(memoryId);
    current.consecutiveNoGain = newIds.length > 0 ? 0 : current.consecutiveNoGain + 1;
  }

  allowGet(sessionId: string): boolean {
    const current = this.#state(sessionId);
    if (current.recallCalls >= this.maxRecallCalls) return false;
    current.recallCalls += 1;
    return true;
  }

  recordGet(sessionId: string, memoryIds: readonly string[]): void {
    const current = this.#state(sessionId);
    const newIds = memoryIds.filter((memoryId) => !current.loadedIds.has(memoryId));
    for (const memoryId of memoryIds) current.loadedIds.add(memoryId);
    if (newIds.length > 0) {
      current.searchesSinceGet = 0;
      current.consecutiveNoGain = 0;
    }
  }

  clear(sessionId: string): void {
    this.#states.delete(sessionId);
  }

  #state(sessionId: string) {
    let current = this.#states.get(sessionId);
    if (!current) {
      current = this.#newState("");
      this.#states.set(sessionId, current);
    }
    return current;
  }

  #newState(turnKey: string) {
    return {
      turnKey,
      searchesSinceGet: 0,
      searchCalls: 0,
      recallCalls: 0,
      consecutiveNoGain: 0,
      candidateIds: new Set<string>(),
      loadedIds: new Set<string>(),
    };
  }
}
