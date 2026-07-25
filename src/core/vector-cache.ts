import { cosineSimilarity } from "./vector.ts";

export interface VectorCacheEntry {
  id: string;
  vector: readonly number[];
}

export class Float32VectorCache {
  readonly dimensions: number;
  #capacity: number;
  #length = 0;
  #ids: string[];
  #indices = new Map<string, number>();
  #matrix: Float32Array;

  constructor(dimensions: number, initialCapacity = 16) {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error("vector cache dimensions must be a positive integer");
    }
    this.dimensions = dimensions;
    this.#capacity = Math.max(1, initialCapacity);
    this.#ids = new Array(this.#capacity);
    this.#matrix = new Float32Array(this.#capacity * dimensions);
  }

  get size(): number {
    return this.#length;
  }

  get byteLength(): number {
    return this.#matrix.byteLength;
  }

  upsert(id: string, vector: readonly number[]): void {
    if (vector.length !== this.dimensions) throw new Error("vector dimension mismatch");
    let index = this.#indices.get(id);
    if (index === undefined) {
      this.#ensureCapacity(this.#length + 1);
      index = this.#length++;
      this.#indices.set(id, index);
      this.#ids[index] = id;
    }
    this.#matrix.set(vector, index * this.dimensions);
  }

  has(id: string): boolean {
    return this.#indices.has(id);
  }

  vector(id: string): Float32Array | undefined {
    const index = this.#indices.get(id);
    if (index === undefined) return undefined;
    const start = index * this.dimensions;
    return this.#matrix.subarray(start, start + this.dimensions);
  }

  /**
   * Remove a single entry from the cache without invalidating the whole kind.
   *
   * Because the matrix is a contiguous Float32Array, a non-terminal removal
   * shifts the last entry into the freed slot so the matrix stays dense.
   * Idempotent: does nothing when the id is not present.
   */
  remove(id: string): void {
    const index = this.#indices.get(id);
    if (index === undefined) return;
    const last = this.#length - 1;
    if (index < last) {
      // Move the last entry into the freed slot.
      const lastId = this.#ids[last]!;
      this.#indices.set(lastId, index);
      this.#ids[index] = lastId;
      this.#matrix.copyWithin(
        index * this.dimensions,
        last * this.dimensions,
        this.#length * this.dimensions,
      );
    }
    this.#indices.delete(id);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    this.#ids[last] = undefined as unknown as string;
    this.#length = last;
  }

  score(
    query: readonly number[],
    candidateIds?: ReadonlySet<string>,
  ): Array<{
    id: string;
    score: number;
  }> {
    if (query.length !== this.dimensions) return [];
    const results: Array<{ id: string; score: number }> = [];
    for (let index = 0; index < this.#length; index += 1) {
      const id = this.#ids[index]!;
      if (candidateIds && !candidateIds.has(id)) continue;
      const start = index * this.dimensions;
      const score = cosineSimilarity(query, this.#matrix.subarray(start, start + this.dimensions));
      if (score > 0) results.push({ id, score });
    }
    return results.sort((left, right) => right.score - left.score);
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#capacity) return;
    while (this.#capacity < required) this.#capacity *= 2;
    const expanded = new Float32Array(this.#capacity * this.dimensions);
    expanded.set(this.#matrix.subarray(0, this.#length * this.dimensions));
    this.#matrix = expanded;
    this.#ids.length = this.#capacity;
  }
}
