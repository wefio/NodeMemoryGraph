import { Tensor, gradientStep } from "./autodiff.ts";

/**
 * Memory-Graph Reasoner — each memory node is a micro-operator that
 * transforms the query state during graph traversal.
 *
 * State-update design (KDA-inspired degrees of freedom):
 *
 *   g     = σ(v^T @ q + b_log)     absorption — how much of this node to take in
 *   A     = σ(a_log)                decay — global forgetting rate (0=wipe, 1=keep)
 *   β     = σ(β_log)                retention — how much old state vs new state
 *
 *   q_tmp = A·q_old + g·v          decay old context, absorb new memory
 *   q'    = β·q_tmp + (1−β)·query   output blend: new state vs original query
 *   r     = q'^T @ v                local relevance score
 *
 * Old design (v1): g = σ(v^T@q + b), q' = g·v + (1−g)·q.
 * This is the special case where A_log = 0 (no decay) and β_log = 0
 * (output = q_tmp only, no original-query anchor).
 *
 * The traversal path is the computation graph. Gradients flow through
 * every visited node back to the per-node gate biases.
 */

export interface MemoryNode {
  id: string;
  vector: Float32Array; // L2-normalized [d]
  /** Fact node IDs that must be active for this node's gate to open. */
  requires?: string[];
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
  version: 2;
  dimensions: number;
  trainingSteps: number;
  /** Global decay log-rate: A = exp(A_log). 0 = no decay. */
  aLog: number;
  /** Per-node absorption logit, keyed by node ID. g = σ(b_log). */
  nodeBiasLogits: Record<string, number>;
  /** Per-node retention logit, keyed by node ID. β = σ(β_log). */
  nodeBetaLogits: Record<string, number>;
}

export class MemoryGraphReasoner {
  readonly dimensions: number;
  #trainingSteps: number;
  /** Global decay: A = σ(a_log). 0 = full wipe, 1 = keep all context. */
  readonly #aLog: Tensor;
  /** Per-node absorption logit b_log → gate = σ(v^T@q + b_log). */
  readonly #nodeBiasLogits: Map<string, Tensor>;
  /** Per-node retention logit β_log → β = σ(β_log). */
  readonly #nodeBetaLogits: Map<string, Tensor>;
  /** Shared scalar (1) for arithmetic. */
  readonly #one: Tensor;

  constructor(dimensions: number, state?: MemoryGraphReasonerState) {
    this.dimensions = dimensions;
    this.#trainingSteps = state?.trainingSteps ?? 0;
    this.#aLog = Tensor.scalar(state?.aLog ?? 0, true); // 0 = no decay (backward compat)
    this.#nodeBiasLogits = new Map();
    this.#nodeBetaLogits = new Map();
    if (state?.nodeBiasLogits) {
      for (const [id, b] of Object.entries(state.nodeBiasLogits)) {
        this.#nodeBiasLogits.set(id, Tensor.scalar(b, true));
      }
    }
    if (state?.nodeBetaLogits) {
      for (const [id, b] of Object.entries(state.nodeBetaLogits)) {
        this.#nodeBetaLogits.set(id, Tensor.scalar(b, true));
      }
    }
    this.#one = Tensor.scalar(1);
  }

  get trainingSteps(): number {
    return this.#trainingSteps;
  }

  // ── single-step operator ──

  /**
   * Apply one reasoning step with KDA-inspired state update:
   *
   *   g     = σ(v^T@q + b_log)    absorption — how much of this node to take in
   *   A     = exp(A_log)           decay — global forgetting rate
   *   β     = σ(β_log)             retention — old state vs new state blend
   *
   *   q_tmp = A·q + g·v           decay old + absorb new
   *   q'    = β·q_tmp + (1-β)·q   output blend: state vs original
   *   r     = q'^T @ v            local relevance
   */
  #reasonStep(
    q: Tensor,
    queryOriginal: Tensor, // the original, unmodified query (anchor)
    v: Float32Array,
    nodeId: string,
    precondScore?: number,
  ): { nextQuery: Tensor; score: Tensor; gate: Tensor; retention: Tensor } {
    const vTensor = Tensor.vector(v);

    // ── absorption gate: g = σ(v^T @ q + b_log) ──
    const similarity = vTensor.transpose().matmul(q); // [1,1]
    const bLog = this.#getOrCreateBiasLogit(nodeId);
    let gate = similarity.add(bLog).sigmoid();

    // ── logical precondition: close gate unless required facts are active ──
    if (precondScore !== undefined) {
      gate = gate.multiply(Tensor.scalar(precondScore));
    }

    // ── A = σ(a_log): global decay, naturally bounded in (0,1) ──
    const A = this.#aLog.sigmoid();

    // ── β = σ(β_log): per-node retention ──
    const betaLog = this.#getOrCreateBetaLogit(nodeId);
    const beta = betaLog.sigmoid();

    // ── q_tmp = A·q + g·v: decay old + absorb new ──
    const decayedQ = q.multiply(A);
    const gatedV = vTensor.multiply(gate);
    const qTmp = decayedQ.add(gatedV);

    // ── q' = β·q_tmp + (1−β)·queryOriginal: output blend ──
    const qNew = qTmp.multiply(beta).add(queryOriginal.multiply(this.#one.add(beta.negate())));

    // ── r = q'^T @ v: local relevance ──
    const score = qNew.transpose().matmul(vTensor);

    return { nextQuery: qNew, score, gate, retention: beta };
  }

  #getOrCreateBiasLogit(nodeId: string): Tensor {
    let b = this.#nodeBiasLogits.get(nodeId);
    if (!b) {
      b = Tensor.scalar(0, true);
      this.#nodeBiasLogits.set(nodeId, b);
    }
    return b;
  }

  #getOrCreateBetaLogit(nodeId: string): Tensor {
    let b = this.#nodeBetaLogits.get(nodeId);
    if (!b) {
      b = Tensor.scalar(0, true); // 0 → β = σ(0) = 0.5 (neutral)
      this.#nodeBetaLogits.set(nodeId, b);
    }
    return b;
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
    const queryOriginal = Tensor.vector(queryVector); // anchor — never modified
    let q = queryOriginal;
    let currentQuery = Float32Array.from(queryVector);
    let pathScore = 0;

    // Step 0: find best starting node by evaluating all nodes
    let candidates = Array.from(graph.values());
    for (let step = 0; step < maxSteps && candidates.length > 0; step++) {
      // Pre-evaluate fact nodes referenced by any candidate
      const factCache = new Map<string, number>();
      for (const node of candidates) {
        if (node.requires) {
          for (const factId of node.requires) {
            if (!factCache.has(factId)) {
              const factNode = graph.get(factId);
              if (factNode) {
                // activation = cosine similarity between fact vector and current query
                let dot = 0;
                const fv = factNode.vector;
                for (let i = 0; i < this.dimensions; i++) dot += currentQuery[i]! * fv[i]!;
                factCache.set(factId, Math.max(0, dot)); // ReLU: negative cos = inactive
              } else {
                factCache.set(factId, 0); // missing fact = precondition fails
              }
            }
          }
        }
      }

      let bestScore = -Infinity;
      let bestNode: MemoryNode | null = null;
      let bestNextQ = currentQuery;
      let bestGate = 0;
      let bestPrecond: number | undefined;

      for (const node of candidates) {
        // Compute precondition score: product of fact activations (soft-AND)
        let precondScore: number | undefined;
        if (node.requires && node.requires.length > 0) {
          precondScore = 1;
          for (const factId of node.requires) {
            precondScore *= factCache.get(factId) ?? 0;
          }
        }
        const { nextQuery, score, gate } = this.#reasonStep(q, queryOriginal, node.vector, node.id, precondScore);
        const s = score.scalarValue;
        if (s > bestScore) {
          bestScore = s;
          bestNode = node;
          bestNextQ = Float32Array.from(nextQuery.data);
          bestGate = gate.scalarValue;
          bestPrecond = precondScore;
        }
      }

      if (!bestNode) break;
      pathScore += bestScore;
      // Rebuild q for the next step (same precondition as evaluation)
      const { nextQuery: winningQ } = this.#reasonStep(q, queryOriginal, bestNode.vector, bestNode.id, bestPrecond);

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

    const queryOriginal = Tensor.vector(sample.queryVector);
    let q = queryOriginal;
    let totalScore: Tensor | null = null;

    for (const nodeId of sample.pathNodeIds) {
      const node = sample.graph.get(nodeId);
      if (!node) throw new Error(`node not in graph: ${nodeId}`);
      const { nextQuery, score } = this.#reasonStep(q, queryOriginal, node.vector, nodeId);
      totalScore = totalScore ? totalScore.add(score) : score;
      q = nextQuery;
    }

    // Loss: negative path score (maximize sum of per-step relevance)
    const loss = totalScore!.multiply(Tensor.scalar(-1));

    // Gather all parameters: global A_log + per-node b_log + per-node β_log
    const params: Tensor[] = [this.#aLog];
    for (const nodeId of sample.pathNodeIds) {
      const bLog = this.#nodeBiasLogits.get(nodeId);
      if (bLog) params.push(bLog);
      const betaLog = this.#nodeBetaLogits.get(nodeId);
      if (betaLog) params.push(betaLog);
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
    const nodeBiasLogits: Record<string, number> = {};
    for (const [id, b] of this.#nodeBiasLogits) {
      nodeBiasLogits[id] = b.scalarValue;
    }
    const nodeBetaLogits: Record<string, number> = {};
    for (const [id, b] of this.#nodeBetaLogits) {
      nodeBetaLogits[id] = b.scalarValue;
    }
    return {
      version: 2,
      dimensions: this.dimensions,
      trainingSteps: this.#trainingSteps,
      aLog: this.#aLog.scalarValue,
      nodeBiasLogits,
      nodeBetaLogits,
    };
  }

  static fromJSON(state: MemoryGraphReasonerState): MemoryGraphReasoner {
    return new MemoryGraphReasoner(state.dimensions, state);
  }
}
