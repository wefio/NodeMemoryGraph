import type { VectorEmbedder } from "./types.ts";
import { cosineSimilarity } from "./vector.ts";
import {
  HierarchicalActivation,
  type HierarchicalActivationState,
  type NodeActivationInput,
  type GraphStateSnapshot,
} from "./hierarchical-activation.ts";

export interface HierarchicalRouteOptions {
  queryVector: Float32Array;
  candidates: NodeActivationInput[];
  neighborhood?: NodeActivationInput[];
  graphState?: GraphStateSnapshot;
}

export interface HierarchicalRouteResult {
  nodeScores: Float32Array;
  g1Context: Float32Array;
  g1AttentionWeights: Float32Array;
  g2Context: Float32Array;
  g2AttentionWeights: Float32Array;
  g3Context: Float32Array;
}

export interface RouterState {
  haState: HierarchicalActivationState | null;
}

export class Router {
  readonly #embedder: VectorEmbedder;
  #ha: HierarchicalActivation | null = null;
  #haDimensions = 0;

  constructor(embedder: VectorEmbedder, haState?: HierarchicalActivationState | null) {
    this.#embedder = embedder;
    if (haState) {
      this.#ha = HierarchicalActivation.fromJSON(haState);
      this.#haDimensions = haState.dimensions;
    }
  }

  get dimensions(): number {
    return this.#embedder.dimensions;
  }

  get ha(): HierarchicalActivation | null {
    return this.#ha;
  }

  /** Lazily initialize HA on first use with the actual vector dimensions. */
  ensureHA(dimensions: number): HierarchicalActivation {
    if (!this.#ha || this.#haDimensions !== dimensions) {
      this.#ha = new HierarchicalActivation(dimensions);
      this.#haDimensions = dimensions;
    }
    return this.#ha;
  }

  // ── per-node scoring (legacy, for lexical routing fallback) ──

  score(query: string, weights: readonly number[]): number {
    // Empty weights = no learned signal yet. Skip embedding the query entirely
    // (cosine against [] is 0 anyway) so cold-start nodes don't pay the hash
    // embed cost on every search.
    if (!weights || weights.length === 0) return 0;
    return cosineSimilarity(this.#embedder.embed(query), weights);
  }

  update(query: string, weights: readonly number[] | undefined, learningRate = 0.2): number[] {
    const queryVector = this.#embedder.embed(query);
    const current = weights ?? new Array<number>(this.#embedder.dimensions).fill(0);
    return current.map(
      (value, index) => value * (1 - learningRate) + (queryVector[index] ?? 0) * learningRate,
    );
  }

  // ── hierarchical batch scoring ──

  routeHierarchical(options: HierarchicalRouteOptions): HierarchicalRouteResult {
    const ha = this.#ha;
    if (!ha) throw new Error("hierarchical activation is not available — call ensureHA first");
    const out = ha.propagate(
      options.queryVector,
      options.candidates,
      options.neighborhood ?? [],
      options.graphState,
    );
    return {
      nodeScores: out.nodeScores,
      g1Context: out.g1Context,
      g1AttentionWeights: out.g1AttentionWeights,
      g2Context: out.g2Context,
      g2AttentionWeights: out.g2AttentionWeights,
      g3Context: out.g3Context,
    };
  }

  trainHierarchical(
    options: HierarchicalRouteOptions,
    usedNodeIds: Set<string>,
    learningRate?: number,
  ): number {
    const ha = this.#ha;
    if (!ha) throw new Error("hierarchical activation is not available — call ensureHA first");
    const result = ha.train(
      {
        queryVector: options.queryVector,
        candidates: options.candidates,
        neighborhood: options.neighborhood,
        graphState: options.graphState,
        usedNodeIds,
      },
      learningRate,
    );
    return result.loss;
  }

  // ── persistence ──

  toJSON(): RouterState {
    return { haState: this.#ha?.toJSON() ?? null };
  }

  static fromJSON(embedder: VectorEmbedder, state: RouterState): Router {
    return new Router(embedder, state.haState);
  }
}
