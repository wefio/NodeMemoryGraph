import { Tensor, gradientStep } from "./autodiff.ts";

/**
 * Memory-Graph Reasoner — each memory node is a micro-operator that
 * transforms the query state during graph traversal.
 *
 * g  = σ(v^T @ q + b)     gate: how much this memory influences the query
 * q' = g·v + (1−g)·q      state update: memory-tinged query
 * r  = q'^T @ v           local relevance score
 *
 * The traversal path is the computation graph. Gradients flow through
 * every visited node back to the per-node gate biases.
 */

export interface MemoryNode {
  id: string;
  vector: Float32Array; // L2-normalized [d]
}

export interface TraversalStep {
  nodeId: string;
  score: number; // local relevance
  queryBefore: Float32Array;
  queryAfter: Float32Array;
  gate: number; // how much this node contributed
}

export interface TraversalResult {
  path: TraversalStep[];
  finalQuery: Float32Array;
  pathScore: number; // sum of per-step scores
}

export interface PathTrainingSample {
  queryVector: Float32Array;
  /** Ordered path of visited node IDs. Last node must be a target. */
  pathNodeIds: string[];
  /** Full graph for candidate evaluation at each step. */
  graph: Map<string, MemoryNode>;
}

export interface MemoryGraphReasonerState {
  version: 1;
  dimensions: number;
  trainingSteps: number;
  /** gate bias per node, keyed by node ID */
  gateBiases: Record<string, number>;
}

export class MemoryGraphReasoner {
  readonly dimensions: number;
  #trainingSteps: number;
  /** Per-node learnable gate bias. Lazily created as nodes are visited. */
  readonly #gateBiases: Map<string, Tensor>;
  /** Shared scalar (1) for arithmetic. */
  readonly #one: Tensor;

  constructor(dimensions: number, state?: MemoryGraphReasonerState) {
    this.dimensions = dimensions;
    this.#trainingSteps = state?.trainingSteps ?? 0;
    this.#gateBiases = new Map();
    if (state?.gateBiases) {
      for (const [id, bias] of Object.entries(state.gateBiases)) {
        this.#gateBiases.set(id, Tensor.scalar(bias, true));
      }
    }
    this.#one = Tensor.scalar(1);
  }

  get trainingSteps(): number {
    return this.#trainingSteps;
  }

  // ── single-step operator ──

  /**
   * Apply one reasoning step: query passes through a memory node.
   * Returns refined query and relevance score as Tensors (for DAG chaining).
   */
  #reasonStep(
    q: Tensor,
    v: Float32Array,
    nodeId: string,
  ): { nextQuery: Tensor; score: Tensor; gate: Tensor } {
    const vTensor = Tensor.vector(v);

    // g = σ(v^T @ q + b)  — learnable per-node gate
    const similarity = vTensor.transpose().matmul(q); // [1,1]
    const bias = this.#getOrCreateBias(nodeId);
    const gate = similarity.add(bias).sigmoid();

    // q' = g·v + (1−g)·q  — residual blend
    const gatedV = vTensor.multiply(gate);
    const gatedQ = q.multiply(this.#one.add(gate.negate()));
    const nextQuery = gatedV.add(gatedQ);

    // r = q'^T @ v  — local relevance
    const score = nextQuery.transpose().matmul(vTensor);

    return { nextQuery, score, gate };
  }

  #getOrCreateBias(nodeId: string): Tensor {
    let bias = this.#gateBiases.get(nodeId);
    if (!bias) {
      bias = Tensor.scalar(0, true); // init at 0 = sigmoid(cosine) ~ 0.5 for cos=0
      this.#gateBiases.set(nodeId, bias);
    }
    return bias;
  }

  // ── traversal ──

  /**
   * Greedy traversal: at each step, evaluate all neighbors of the current
   * best node and advance to the highest-scoring one.
   */
  traverse(
    queryVector: Float32Array,
    graph: Map<string, MemoryNode>,
    maxSteps: number,
  ): TraversalResult {
    const path: TraversalStep[] = [];
    let q = Tensor.vector(queryVector);
    let currentQuery = Float32Array.from(queryVector);
    let pathScore = 0;

    // Step 0: find best starting node by evaluating all nodes
    let candidates = Array.from(graph.values());
    for (let step = 0; step < maxSteps && candidates.length > 0; step++) {
      let bestScore = -Infinity;
      let bestNode: MemoryNode | null = null;
      let bestNextQ = currentQuery;
      let bestGate = 0;

      for (const node of candidates) {
        const { nextQuery, score, gate } = this.#reasonStep(q, node.vector, node.id);
        const s = score.scalarValue;
        if (s > bestScore) {
          bestScore = s;
          bestNode = node;
          bestNextQ = Float32Array.from(nextQuery.data);
          bestGate = gate.scalarValue;
        }
      }

      if (!bestNode) break;
      pathScore += bestScore;
      // Rebuild q as Tensor for the next step (from the winning node's output)
      const { nextQuery: winningQ } = this.#reasonStep(q, bestNode.vector, bestNode.id);

      path.push({
        nodeId: bestNode.id,
        score: bestScore,
        queryBefore: currentQuery,
        queryAfter: bestNextQ,
        gate: bestGate,
      });

      q = winningQ;
      currentQuery = bestNextQ;
      candidates = candidates.filter((n) => n.id !== bestNode.id);
    }

    return { path, finalQuery: currentQuery, pathScore };
  }

  // ── training ──

  /**
   * Train on a labeled path. Builds a DAG connecting every step,
   * so gradients flow from the final loss back through the entire traversal.
   */
  trainPath(
    sample: PathTrainingSample,
    learningRate = 0.05,
  ): number {
    if (sample.pathNodeIds.length < 1) {
      throw new Error("trainPath requires at least one node in path");
    }

    let q = Tensor.vector(sample.queryVector);
    let totalScore: Tensor | null = null;

    for (const nodeId of sample.pathNodeIds) {
      const node = sample.graph.get(nodeId);
      if (!node) throw new Error(`node not in graph: ${nodeId}`);
      const { nextQuery, score } = this.#reasonStep(q, node.vector, nodeId);
      totalScore = totalScore ? totalScore.add(score) : score;
      q = nextQuery;
    }

    // Loss: negative path score (maximize sum of per-step relevance)
    const loss = totalScore!.multiply(Tensor.scalar(-1));

    // Gather all parameters used along the path
    const params: Tensor[] = [];
    for (const nodeId of sample.pathNodeIds) {
      const bias = this.#gateBiases.get(nodeId);
      if (bias) params.push(bias);
    }

    params.forEach((p) => p.zeroGrad());
    const lossValue = loss.scalarValue;
    loss.backward();
    gradientStep(params, learningRate);
    this.#trainingSteps += 1;

    return lossValue;
  }

  // ── persistence ──

  toJSON(): MemoryGraphReasonerState {
    const biases: Record<string, number> = {};
    for (const [id, bias] of this.#gateBiases) {
      biases[id] = bias.scalarValue;
    }
    return {
      version: 1,
      dimensions: this.dimensions,
      trainingSteps: this.#trainingSteps,
      gateBiases: biases,
    };
  }

  static fromJSON(state: MemoryGraphReasonerState): MemoryGraphReasoner {
    return new MemoryGraphReasoner(state.dimensions, state);
  }
}
