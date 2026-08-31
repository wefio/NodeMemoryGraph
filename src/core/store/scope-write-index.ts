import type { MemoryStatus, Polarity } from "../types.ts";
import { searchTerms } from "./search-ranking.ts";

export interface ScopeWriteIndexRow {
  id: string;
  nodeId: string;
  statement: string;
  normalizedStatement: string;
  tokens: string[];
  eventTime: string | null;
  polarity: Polarity | null;
  status: MemoryStatus;
  createdAt: string;
}

/**
 * Disposable, process-local acceleration for write-time duplicate and
 * supersession candidate discovery. SQLite remains authoritative: a cold index
 * is rebuilt from one scope and any uncertain mutation can invalidate it.
 */
export class ScopeWriteIndex {
  readonly #rows = new Map<string, ScopeWriteIndexRow>();
  readonly #statements = new Map<string, Set<string>>();
  readonly #tokens = new Map<string, Set<string>>();
  readonly #insertionOrder: string[] = [];

  constructor(rows: readonly ScopeWriteIndexRow[]) {
    for (const row of rows) this.add(row);
  }

  add(row: ScopeWriteIndexRow): void {
    if (this.#rows.has(row.id)) this.remove(row.id);
    this.#rows.set(row.id, row);
    this.#insertionOrder.push(row.id);
    addToBucket(this.#statements, row.statement, row.id);
    for (const token of row.tokens) addToBucket(this.#tokens, token, row.id);
  }

  remove(memoryId: string): void {
    const row = this.#rows.get(memoryId);
    if (!row) return;
    this.#rows.delete(memoryId);
    removeFromBucket(this.#statements, row.statement, memoryId);
    for (const token of row.tokens) {
      removeFromBucket(this.#tokens, token, memoryId);
    }
  }

  setStatus(memoryId: string, status: MemoryStatus): void {
    const row = this.#rows.get(memoryId);
    if (!row) return;
    this.#rows.set(memoryId, { ...row, status });
  }

  exact(statement: string): ScopeWriteIndexRow | undefined {
    return this.#newest(
      [...(this.#statements.get(statement) ?? [])].filter(
        (id) => this.#rows.get(id)?.status === "active",
      ),
    );
  }

  recentActive(limit: number): ScopeWriteIndexRow[] {
    const rows: ScopeWriteIndexRow[] = [];
    for (let index = this.#insertionOrder.length - 1; index >= 0 && rows.length < limit; index--) {
      const row = this.#rows.get(this.#insertionOrder[index]!);
      if (row?.status === "active") rows.push(row);
    }
    return rows;
  }

  matchingTokens(tokens: readonly string[]): ScopeWriteIndexRow[] {
    const ids = new Set<string>();
    for (const token of tokens) {
      for (const id of this.#tokens.get(token) ?? []) ids.add(id);
    }
    return [...ids]
      .map((id) => this.#rows.get(id))
      .filter(
        (row): row is ScopeWriteIndexRow =>
          row !== undefined && (row.status === "active" || row.status === "disputed"),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  #newest(ids: readonly string[]): ScopeWriteIndexRow | undefined {
    let newest: ScopeWriteIndexRow | undefined;
    for (const id of ids) {
      const row = this.#rows.get(id);
      if (row && (!newest || row.createdAt > newest.createdAt)) newest = row;
    }
    return newest;
  }
}

export function writeTokens(statement: string): string[] {
  return [
    ...new Set(
      searchTerms(statement)
        .map((token) => token.toLowerCase().replace(/[^a-z0-9]/g, ""))
        .filter((token) => token.length >= 2),
    ),
  ];
}

function addToBucket(index: Map<string, Set<string>>, key: string, memoryId: string): void {
  const bucket = index.get(key) ?? new Set<string>();
  bucket.add(memoryId);
  index.set(key, bucket);
}

function removeFromBucket(index: Map<string, Set<string>>, key: string, memoryId: string): void {
  const bucket = index.get(key);
  if (!bucket) return;
  bucket.delete(memoryId);
  if (bucket.size === 0) index.delete(key);
}
