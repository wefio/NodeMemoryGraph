import type { VectorEmbedder } from "./types.ts";

export class HashingVectorEmbedder implements VectorEmbedder {
  readonly dimensions: number;
  readonly model = "nmg-hashing-v1";

  constructor(dimensions = 256) {
    if (!Number.isInteger(dimensions) || dimensions < 16) {
      throw new Error("vector dimensions must be an integer >= 16");
    }
    this.dimensions = dimensions;
  }

  embed(text: string): readonly number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const feature of features(text)) {
      const hash = fnv1a(feature);
      const index = hash % this.dimensions;
      vector[index] += (hash & 1) === 0 ? 1 : -1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm === 0 ? vector : vector.map((value) => value / norm);
  }
}

export function cosineSimilarity(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): number {
  if (left.length !== right.length) return 0;
  let score = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    score += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftNorm * rightNorm);
  return denominator === 0 ? 0 : Math.max(-1, Math.min(1, score / denominator));
}

function features(value: string): string[] {
  const normalized = value.trim().toLocaleLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}_+.#-]+/gu) ?? [];
  const result = [...tokens];
  for (const token of tokens) {
    const compact = token.replace(/\s+/g, "");
    const width = /\p{Script=Han}/u.test(compact) ? 2 : 3;
    for (let index = 0; index <= compact.length - width; index += 1) {
      result.push(compact.slice(index, index + width));
    }
  }
  return result;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
