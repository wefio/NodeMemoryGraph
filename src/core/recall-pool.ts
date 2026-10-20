import { matchesRecallTerm, normalizeRecallPhrase, recallInput } from "./recall-matcher.ts";
import {
  RECALL_VOCABULARY,
  RECALL_POOL_CAPACITY,
  RECALL_POOL_PROTECTED_CAPACITY,
  type RecallTerm,
} from "./recall-vocabulary.ts";

export interface RecallPoolEntry extends RecallTerm {
  origin: "seed" | "learned";
  protected: boolean;
  hits: number;
  lastTurn?: number;
  touched: number;
}

/** Segmented LRU: seed origin confers no priority. Only observed user turns count as use. */
export class RecallPool {
  readonly #entries: RecallPoolEntry[] = [];
  #clock = 0;
  readonly capacity: number;
  readonly protectedCapacity: number;

  constructor(
    seeds: readonly RecallTerm[] = RECALL_VOCABULARY,
    capacity = RECALL_POOL_CAPACITY,
    protectedCapacity = RECALL_POOL_PROTECTED_CAPACITY,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || seeds.length > capacity)
      throw new Error("Recall pool capacity must fit its seed vocabulary");
    if (!Number.isSafeInteger(protectedCapacity) || protectedCapacity < 0)
      throw new Error("Invalid protected capacity");
    this.capacity = capacity;
    this.protectedCapacity = Math.min(protectedCapacity, capacity - 1);
    for (const term of seeds) this.#entries.push(this.#entry(term, "seed"));
  }

  #entry(term: RecallTerm, origin: RecallPoolEntry["origin"]): RecallPoolEntry {
    return {
      ...structuredClone(term),
      phrase: normalizeRecallPhrase(term.phrase),
      origin,
      protected: false,
      hits: 0,
      touched: ++this.#clock,
    };
  }

  entries(): RecallPoolEntry[] {
    return this.#entries.map((entry) => structuredClone(entry));
  }

  add(term: RecallTerm, sourceTurn?: number): RecallPoolEntry[] {
    this.remove(term.phrase);
    const entry = this.#entry(term, "learned");
    if (sourceTurn !== undefined) {
      entry.lastTurn = sourceTurn;
      entry.hits = 1;
    }
    this.#entries.push(entry);
    const retired: RecallPoolEntry[] = [];
    while (this.#entries.length > this.capacity) {
      const candidates = this.#entries.filter((entry) => !entry.protected);
      const oldest = candidates.reduce((a, b) => (a.touched < b.touched ? a : b));
      this.#entries.splice(this.#entries.indexOf(oldest), 1);
      retired.push(structuredClone(oldest));
    }
    return retired;
  }

  remove(phrase: string): boolean {
    const normalized = normalizeRecallPhrase(phrase);
    let removed = false;
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (this.#entries[i]!.phrase !== normalized) continue;
      this.#entries.splice(i, 1);
      removed = true;
    }
    return removed;
  }

  observe(prompt: string, turn: number): RecallPoolEntry | undefined {
    const text = recallInput(prompt);
    const matches = this.#entries.filter((entry) => matchesRecallTerm(text, entry));
    for (const entry of matches) {
      if (entry.lastTurn === turn) continue;
      entry.lastTurn = turn;
      entry.hits = Math.min(2, entry.hits + 1);
      entry.touched = ++this.#clock;
      entry.protected = entry.hits >= 2;
    }
    this.#rebalance();
    const selected = matches.find((entry) => entry.mode === "retrieve") ?? matches[0];
    return selected ? structuredClone(selected) : undefined;
  }

  #rebalance(): void {
    const protectedEntries = this.#entries
      .filter((entry) => entry.protected)
      .sort((a, b) => a.touched - b.touched);
    while (protectedEntries.length > this.protectedCapacity)
      protectedEntries.shift()!.protected = false;
  }
}
