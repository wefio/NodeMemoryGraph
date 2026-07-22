import type { VectorEmbedder } from "./types.ts";
import { cosineSimilarity } from "./vector.ts";

export class OnlineNodeRouter {
  readonly #embedder: VectorEmbedder;

  constructor(embedder: VectorEmbedder) {
    this.#embedder = embedder;
  }

  score(query: string, weights: readonly number[]): number {
    return cosineSimilarity(this.#embedder.embed(query), weights);
  }

  update(query: string, weights: readonly number[] | undefined, learningRate = 0.2): number[] {
    const queryVector = this.#embedder.embed(query);
    const current = weights ?? new Array<number>(this.#embedder.dimensions).fill(0);
    return current.map(
      (value, index) => value * (1 - learningRate) + (queryVector[index] ?? 0) * learningRate,
    );
  }
}
