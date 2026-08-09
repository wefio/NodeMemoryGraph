import type { NodeRelation, NodeRelationType } from "./types.ts";

export const DEFAULT_EDGE_ACTIVATION = {
  maxHops: 1,
  decay: 0.7,
  threshold: 0.02,
  learningRate: 0.05,
} as const;

export interface DerivedEdgeActivation {
  relationId: string;
  sourceNodeId: string;
  targetNodeId: string;
  activation: number;
  channel: NodeRelation["activationRule"];
  hop: number;
}

export interface EdgePropagationResult {
  nodeActivations: Map<string, number>;
  edges: DerivedEdgeActivation[];
}

export function relationActivationDefaults(
  type: NodeRelationType,
): Pick<NodeRelation, "activationRule" | "direction" | "fanBudget"> {
  if (["contradicts", "supersedes", "exception_to", "same_as", "distinct_from"].includes(type)) {
    return {
      activationRule: "regulatory",
      direction: ["contradicts", "same_as", "distinct_from"].includes(type)
        ? "both"
        : "source->target",
      fanBudget: !["same_as", "distinct_from"].includes(type),
    };
  }
  if (["causes", "depends_on", "is_a", "part_of"].includes(type)) {
    return { activationRule: "conductive", direction: "source->target", fanBudget: true };
  }
  if (type === "derived_from" || type === "refines") {
    return { activationRule: "conductive", direction: "target->source", fanBudget: false };
  }
  return { activationRule: "conductive", direction: "both", fanBudget: true };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function directedSteps(relation: NodeRelation): Array<[string, string]> {
  if (relation.direction === "source->target") {
    return [[relation.sourceNodeId, relation.targetNodeId]];
  }
  if (relation.direction === "target->source") {
    return [[relation.targetNodeId, relation.sourceNodeId]];
  }
  return [
    [relation.sourceNodeId, relation.targetNodeId],
    [relation.targetNodeId, relation.sourceNodeId],
  ];
}

/**
 * Derive a bounded Active-Graph projection from query-local node activation.
 * No result is written to the relation store. Conductive and regulatory
 * channels remain separate; only the conductive channel propagates.
 */
export function propagateEdgeActivation(
  seeds: ReadonlyMap<string, number>,
  relations: readonly NodeRelation[],
  options: { maxHops?: number; decay?: number; threshold?: number } = {},
): EdgePropagationResult {
  const maxHops = Math.max(
    0,
    Math.min(4, Math.floor(options.maxHops ?? DEFAULT_EDGE_ACTIVATION.maxHops)),
  );
  const decay = clamp01(options.decay ?? DEFAULT_EDGE_ACTIVATION.decay);
  const threshold = clamp01(options.threshold ?? DEFAULT_EDGE_ACTIVATION.threshold);
  const nodeActivations = new Map(
    [...seeds].map(([nodeId, activation]) => [nodeId, clamp01(activation)] as const),
  );
  const edgeById = new Map<string, DerivedEdgeActivation>();

  for (let hop = 1; hop <= maxHops; hop += 1) {
    const outgoingFan = new Map<string, number>();
    for (const relation of relations) {
      if (relation.status !== "consolidated" || !relation.fanBudget) continue;
      for (const [from] of directedSteps(relation)) {
        outgoingFan.set(from, (outgoingFan.get(from) ?? 0) + 1);
      }
    }
    const additions = new Map<string, number>();
    let changed = false;
    for (const relation of relations) {
      if (relation.status !== "consolidated") continue;
      for (const [from, to] of directedSteps(relation)) {
        const source = nodeActivations.get(from) ?? 0;
        const target = nodeActivations.get(to) ?? 0;
        if (source <= 0) continue;
        const dilution = relation.fanBudget
          ? 1 + Math.log(Math.max(1, outgoingFan.get(from) ?? 1))
          : 1;
        let activation = clamp01((source * relation.strength * decay ** hop) / dilution);
        if (relation.type === "contradicts") activation *= Math.abs(source - target);
        if (relation.type === "supersedes" || relation.type === "exception_to") {
          activation *= 1 - target;
        }
        activation = clamp01(activation);
        if (activation < threshold) continue;
        const previous = edgeById.get(relation.id);
        if (!previous || activation > previous.activation) {
          edgeById.set(relation.id, {
            relationId: relation.id,
            sourceNodeId: from,
            targetNodeId: to,
            activation,
            channel: relation.activationRule,
            hop,
          });
        }
        if (relation.activationRule === "regulatory") continue;
        if (activation > (nodeActivations.get(to) ?? 0) && activation > (additions.get(to) ?? 0)) {
          additions.set(to, activation);
          changed = true;
        }
      }
    }
    for (const [nodeId, activation] of additions) nodeActivations.set(nodeId, activation);
    if (!changed) break;
  }

  return {
    nodeActivations,
    edges: [...edgeById.values()].sort(
      (left, right) =>
        right.activation - left.activation || left.relationId.localeCompare(right.relationId),
    ),
  };
}

/** One bounded Rescorla-Wagner prediction-error update. */
export function updateRelationStrength(
  current: number,
  outcome: number,
  totalPrediction: number,
  coactivation = 1,
  learningRate = DEFAULT_EDGE_ACTIVATION.learningRate,
): number {
  return clamp01(
    current +
      clamp01(learningRate) * (clamp01(outcome) - clamp01(totalPrediction)) * clamp01(coactivation),
  );
}
