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

/** Impact of inserting a hypothetical node into the graph. */
export interface WhatIfResult {
  /** Traversal WITHOUT the hypothetical node. */
  baseline: TraversalResult;
  /** Traversal WITH the hypothetical node injected. */
  withNode: TraversalResult;
  /** Nodes whose scores changed significantly (|Δ| > threshold). */
  impacted: ImpactedNode[];
}

export interface ImpactedNode {
  nodeId: string;
  scoreBefore: number;
  scoreAfter: number;
  delta: number;
  /** Whether this node entered or exited the top-k path. */
  pathChange: "entered" | "exited" | "none";
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

  // ── what-if reasoning ──

  /**
   * What-if simulation: inject a hypothetical node and compare traversal
   * before/after. Returns impact analysis suitable for LLM consumption.
   *
   * Use case: "If I add constraint X, how does it affect decisions Y and Z?"
   */
  whatIf(
    queryVector: Float32Array,
    graph: Map<string, MemoryNode>,
    hypotheticalNode: MemoryNode,
    maxSteps: number,
    impactThreshold = 0.05,
  ): WhatIfResult {
    // Baseline: traversal without the new node
    const baseline = this.traverse(queryVector, graph, maxSteps);

    // Inject hypothetical node and re-traverse
    const augmentedGraph = new Map(graph);
    augmentedGraph.set(hypotheticalNode.id, hypotheticalNode);
    const withNode = this.traverse(queryVector, augmentedGraph, maxSteps);

    // Compute per-node impact
    const allNodeIds = new Set<string>();
    for (const step of baseline.path) allNodeIds.add(step.nodeId);
    for (const step of withNode.path) allNodeIds.add(step.nodeId);

    const baselineScoreMap = new Map<string, number>();
    for (const step of baseline.path) baselineScoreMap.set(step.nodeId, step.score);
    const withScoreMap = new Map<string, number>();
    for (const step of withNode.path) withScoreMap.set(step.nodeId, step.score);

    const baselinePathSet = new Set(baseline.path.map((s) => s.nodeId));
    const withPathSet = new Set(withNode.path.map((s) => s.nodeId));

    const impacted: ImpactedNode[] = [];
    for (const nodeId of allNodeIds) {
      const before = baselineScoreMap.get(nodeId) ?? 0;
      const after = withScoreMap.get(nodeId) ?? 0;
      const delta = after - before;
      if (Math.abs(delta) >= impactThreshold || before === 0 || after === 0) {
        let pathChange: ImpactedNode["pathChange"] = "none";
        const inBaseline = baselinePathSet.has(nodeId);
        const inWith = withPathSet.has(nodeId);
        if (!inBaseline && inWith) pathChange = "entered";
        if (inBaseline && !inWith) pathChange = "exited";
        impacted.push({ nodeId, scoreBefore: before, scoreAfter: after, delta, pathChange });
      }
    }
    impacted.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    return { baseline, withNode, impacted };
  }

  /**
   * Compact impact summary for LLM consumption (fits in limited context).
   *
   * Returns a short text summary like:
   * "Adding 'X' enters the path at step 1, shifts 'Y' score -0.12, 'Z' exits path."
   */
  impactSummary(result: WhatIfResult, hypotheticalNodeId: string): string {
    const lines: string[] = [];
    lines.push(`Inserting node "${hypotheticalNodeId}":`);

    // Is the hypothetical node itself picked?
    const hypoInPath = result.withNode.path.some(
      (s) => s.nodeId === hypotheticalNodeId,
    );
    if (hypoInPath) {
      const step = result.withNode.path.findIndex(
        (s) => s.nodeId === hypotheticalNodeId,
      );
      const score =
        result.withNode.path[step]!.score;
      lines.push(`  → enters path at step ${step + 1} (score ${score.toFixed(3)})`);
    } else {
      lines.push(`  → does NOT enter path`);
    }

    // Top impacts on existing nodes
    const others = result.impacted.filter(
      (i) => i.nodeId !== hypotheticalNodeId,
    );
    const top = others.slice(0, 5);
    if (top.length === 0) {
      lines.push(`  → no significant impact on existing nodes`);
    } else {
      for (const imp of top) {
        const dir = imp.delta > 0 ? "↑" : "↓";
        const flag = imp.pathChange !== "none" ? ` [${imp.pathChange}]` : "";
        lines.push(
          `  → ${imp.nodeId}: ${dir}${Math.abs(imp.delta).toFixed(3)}${flag}`,
        );
      }
    }

    const pathDelta = result.withNode.pathScore - result.baseline.pathScore;
    lines.push(
      `  path score: ${result.baseline.pathScore.toFixed(3)} → ${result.withNode.pathScore.toFixed(3)} (${pathDelta >= 0 ? "+" : ""}${pathDelta.toFixed(3)})`,
    );

    return lines.join("\n");
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
