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
  /**
   * Global sharpness log-rate for logic membership: τ = exp(tauLog).
   * membership(v, q) = σ(τ · cos(v, q)). Optional; defaults to ln(8).
   */
  tauLog?: number;
  /** Per-node absorption logit, keyed by node ID. g = σ(b_log). */
  nodeBiasLogits: Record<string, number>;
  /** Per-node retention logit, keyed by node ID. β = σ(β_log). */
  nodeBetaLogits: Record<string, number>;
}

/**
 * Differentiable set-logic expression over memory nodes.
 *
 * An `atom` maps every node to a fuzzy membership σ(τ·cos(v, q)) — a soft set.
 * Combinators are t-norm operators, so the whole expression stays inside the
 * autodiff DAG and gradients flow back to τ (and any future parameters):
 *
 *   and = product t-norm        a·b           (intersection)
 *   or  = probabilistic sum     a+b−a·b       (union)
 *   not = complement            1−a           (negation)
 */
export type LogicExpr =
  | { kind: "atom"; queryVector: Float32Array }
  | { kind: "and" | "or"; children: LogicExpr[] }
  | { kind: "not"; child: LogicExpr };

/** Ergonomic constructors for LogicExpr trees. */
export const Logic = {
  atom(queryVector: Float32Array): LogicExpr {
    return { kind: "atom", queryVector };
  },
  and(...children: LogicExpr[]): LogicExpr {
    return { kind: "and", children };
  },
  or(...children: LogicExpr[]): LogicExpr {
    return { kind: "or", children };
  },
  not(child: LogicExpr): LogicExpr {
    return { kind: "not", child };
  },
  /**
   * NAND = NOT(AND(...)). Functionally complete, but as a ranking operator it
   * is an anti-selector (irrelevant nodes score highest). Use it as a building
   * block — see xor — or as a differentiable conflict penalty, never alone.
   */
  nand(...children: LogicExpr[]): LogicExpr {
    return { kind: "not", child: { kind: "and", children } };
  },
  /**
   * XOR = OR(a,b) · NAND(a,b): evidence that belongs to exactly one side.
   * Surfaces decisive evidence for contradiction-resolution questions while
   * excluding ambiguous statements that match both sides.
   */
  xor(a: LogicExpr, b: LogicExpr): LogicExpr {
    return {
      kind: "and",
      children: [
        { kind: "or", children: [a, b] },
        { kind: "not", child: { kind: "and", children: [a, b] } },
      ],
    };
  },
} as const;

export interface LogicSearchResult {
  nodeId: string;
  /** Combined membership of the whole expression, in (0,1). */
  membership: number;
  /** Per-unique-atom memberships for explanation, in expression order. */
  atomScores: number[];
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
  /** Global membership sharpness: τ = exp(tauLog), used by logicSearch. */
  readonly #tauLog: Tensor;
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
    this.#tauLog = Tensor.scalar(state?.tauLog ?? Math.log(8), true);
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
    precond?: Tensor, // optional precondition scalar (connected to DAG)
  ): { nextQuery: Tensor; score: Tensor; gate: Tensor; retention: Tensor } {
    const vTensor = Tensor.vector(v);

    // ── absorption gate: g = σ(v^T @ q + b_log) ──
    const similarity = vTensor.transpose().matmul(q); // [1,1]
    const bLog = this.#getOrCreateBiasLogit(nodeId);
    const rawGate = similarity.add(bLog).sigmoid();

    // ── logical precondition: soft-AND gate via DAG multiply ──
    const gate = precond ? rawGate.multiply(precond) : rawGate;

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
      // ── Build precondition DAG: one matmul for all fact activations ──
      // Collect unique fact IDs → stack vectors → [K,d] @ q = [K,1] → sigmoid
      let factIds: string[] | null = null;
      for (const node of candidates) {
        if (node.requires) {
          for (const factId of node.requires) {
            if (!factIds) factIds = [];
            if (!factIds.includes(factId)) factIds.push(factId);
          }
        }
      }
      let factActsTensor: Tensor | null = null;
      const factIndex = new Map<string, number>();
      if (factIds && factIds.length > 0) {
        const factData = new Float32Array(factIds.length * this.dimensions);
        for (let fi = 0; fi < factIds.length; fi++) {
          const fn = graph.get(factIds[fi]!);
          factData.set(fn?.vector ?? new Float32Array(this.dimensions), fi * this.dimensions);
          factIndex.set(factIds[fi]!, fi);
        }
        const Fmat = Tensor.fromBuffer(factData, factIds.length, this.dimensions);
        factActsTensor = Fmat.matmul(q).sigmoid(); // [K,1] connected to DAG
      }

      let bestScore = -Infinity;
      let bestNode: MemoryNode | null = null;
      let bestNextQ = currentQuery;
      let bestGate = 0;
      let bestPrecond: Tensor | undefined;

      for (const node of candidates) {
        // Build precondition Tensor: Π factActs[i] (soft-AND, connected to DAG)
        let precondTensor: Tensor | undefined;
        if (node.requires && factActsTensor) {
          for (const factId of node.requires) {
            const idx = factIndex.get(factId);
            if (idx === undefined) {
              precondTensor = Tensor.scalar(0);
              break;
            }
            const act = factActsTensor.at(idx); // Index op, stays in DAG
            precondTensor = precondTensor ? precondTensor.multiply(act) : act;
          }
        }
        const { nextQuery, score, gate } = this.#reasonStep(
          q,
          queryOriginal,
          node.vector,
          node.id,
          precondTensor,
        );
        const s = score.scalarValue;
        if (s > bestScore) {
          bestScore = s;
          bestNode = node;
          bestNextQ = Float32Array.from(nextQuery.data);
          bestGate = gate.scalarValue;
          bestPrecond = precondTensor;
        }
      }

      if (!bestNode) break;
      pathScore += bestScore;
      // Rebuild q for the next step (same precondition as evaluation)
      const { nextQuery: winningQ } = this.#reasonStep(
        q,
        queryOriginal,
        bestNode.vector,
        bestNode.id,
        bestPrecond,
      );

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
    const hypoInPath = result.withNode.path.some((s) => s.nodeId === hypotheticalNodeId);
    if (hypoInPath) {
      const step = result.withNode.path.findIndex((s) => s.nodeId === hypotheticalNodeId);
      const score = result.withNode.path[step]!.score;
      lines.push(`  → enters path at step ${step + 1} (score ${score.toFixed(3)})`);
    } else {
      lines.push(`  → does NOT enter path`);
    }

    // Top impacts on existing nodes
    const others = result.impacted.filter((i) => i.nodeId !== hypotheticalNodeId);
    const top = others.slice(0, 5);
    if (top.length === 0) {
      lines.push(`  → no significant impact on existing nodes`);
    } else {
      for (const imp of top) {
        const dir = imp.delta > 0 ? "↑" : "↓";
        const flag = imp.pathChange !== "none" ? ` [${imp.pathChange}]` : "";
        lines.push(`  → ${imp.nodeId}: ${dir}${Math.abs(imp.delta).toFixed(3)}${flag}`);
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
  trainPath(sample: PathTrainingSample, learningRate = 0.05): number {
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

  // ── differentiable set logic ──

  /** Fuzzy membership of every node in an atom: σ(τ·cos(v, q)) → [N,1]. */
  #membership(nodeMat: Tensor, queryVector: Float32Array): Tensor {
    const q = Tensor.vector(queryVector);
    const tau = this.#tauLog.exp();
    return nodeMat.matmul(q).multiply(tau).sigmoid();
  }

  /**
   * Evaluate a LogicExpr over the stacked node matrix [N,d], returning the
   * combined membership [N,1]. Atom memberships are computed once and cached
   * by expression identity, so shared sub-queries cost one matmul.
   */
  #evalLogic(expr: LogicExpr, nodeMat: Tensor, atomCache: Map<LogicExpr, Tensor>): Tensor {
    if (expr.kind === "atom") {
      let m = atomCache.get(expr);
      if (!m) {
        m = this.#membership(nodeMat, expr.queryVector);
        atomCache.set(expr, m);
      }
      return m;
    }
    if (expr.kind === "not") {
      return this.#one.subtract(this.#evalLogic(expr.child, nodeMat, atomCache));
    }
    const parts = expr.children.map((c) => this.#evalLogic(c, nodeMat, atomCache));
    if (parts.length === 0) {
      return Tensor.scalar(expr.kind === "and" ? 1 : 0);
    }
    let acc = parts[0]!;
    for (const part of parts.slice(1)) {
      acc = expr.kind === "and" ? acc.multiply(part) : acc.add(part).subtract(acc.multiply(part)); // probabilistic sum
    }
    return acc;
  }

  #collectAtoms(expr: LogicExpr, into: LogicExpr[]): void {
    if (expr.kind === "atom") {
      if (!into.includes(expr)) into.push(expr);
      return;
    }
    if (expr.kind === "not") {
      this.#collectAtoms(expr.child, into);
      return;
    }
    for (const c of expr.children) this.#collectAtoms(c, into);
  }

  #stackGraph(graph: Map<string, MemoryNode>): { nodeIds: string[]; nodeMat: Tensor } {
    const nodeIds = Array.from(graph.keys());
    const data = new Float32Array(nodeIds.length * this.dimensions);
    for (let i = 0; i < nodeIds.length; i++) {
      data.set(graph.get(nodeIds[i]!)!.vector, i * this.dimensions);
    }
    return { nodeIds, nodeMat: Tensor.fromBuffer(data, nodeIds.length, this.dimensions) };
  }

  /**
   * Rank nodes by the membership of a set-logic expression.
   *
   * Example — "cities both Jean and John visited":
   *   logicSearch(Logic.and(Logic.atom(jeanCities), Logic.atom(johnCities)), graph, 10)
   * Bridge nodes relevant to both atoms score highest, without leaving the DAG.
   */
  logicSearch(expr: LogicExpr, graph: Map<string, MemoryNode>, topK: number): LogicSearchResult[] {
    const { nodeIds, nodeMat } = this.#stackGraph(graph);
    const atomCache = new Map<LogicExpr, Tensor>();
    const combined = this.#evalLogic(expr, nodeMat, atomCache);
    const atoms: LogicExpr[] = [];
    this.#collectAtoms(expr, atoms);

    const results: LogicSearchResult[] = nodeIds.map((nodeId, i) => ({
      nodeId,
      membership: combined.at(i).scalarValue,
      atomScores: atoms.map((a) => atomCache.get(a)!.at(i).scalarValue),
    }));
    results.sort((a, b) => b.membership - a.membership);
    return results.slice(0, Math.max(0, topK));
  }

  /**
   * Contrastive training for the membership sharpness τ: pull positives'
   * memberships up and the strongest non-positives' down. Loss stays in the
   * DAG; only τ (and future logic parameters) receives gradients.
   */
  trainLogic(
    expr: LogicExpr,
    graph: Map<string, MemoryNode>,
    positiveIds: string[],
    learningRate = 0.05,
  ): number {
    if (positiveIds.length === 0) {
      throw new Error("trainLogic requires at least one positive node");
    }
    const { nodeIds, nodeMat } = this.#stackGraph(graph);
    const combined = this.#evalLogic(expr, nodeMat, new Map());
    const positives = new Set(positiveIds);

    const posLosses: Tensor[] = [];
    const negCandidates: { i: number; m: number }[] = [];
    for (let i = 0; i < nodeIds.length; i++) {
      if (positives.has(nodeIds[i]!)) {
        // −log(p): push membership toward 1 (clamp away from log(0))
        const p = combined.at(i);
        posLosses.push(p.add(Tensor.scalar(1e-9)).log().negate());
      } else {
        negCandidates.push({ i, m: combined.at(i).scalarValue });
      }
    }
    negCandidates.sort((a, b) => b.m - a.m);
    // −log(1−p) on the hardest negatives, as many as there are positives
    const negLosses = negCandidates.slice(0, posLosses.length).map(({ i }) => {
      const p = combined.at(i);
      return this.#one.subtract(p).add(Tensor.scalar(1e-9)).log().negate();
    });

    const loss = Tensor.sumN([...posLosses, ...negLosses]).divide(
      Tensor.scalar(posLosses.length + negLosses.length),
    );

    const params: Tensor[] = [this.#tauLog];
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
      tauLog: this.#tauLog.scalarValue,
      nodeBiasLogits,
      nodeBetaLogits,
    };
  }

  static fromJSON(state: MemoryGraphReasonerState): MemoryGraphReasoner {
    return new MemoryGraphReasoner(state.dimensions, state);
  }
}
