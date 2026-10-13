import type { NodeRelation, NodeRelationType } from "../../src/core/types.ts";

interface NodeRelationWriter {
  linkNodes(input: Pick<NodeRelation, "sourceNodeId" | "targetNodeId" | "type">): NodeRelation;
}

/** Each adjacent pair is a separate write; a later failure leaves the successful prefix. */
export function linkNodePath(
  store: NodeRelationWriter,
  nodeIds: readonly string[],
  relationType: NodeRelationType,
): NodeRelation[] {
  const relations: NodeRelation[] = [];
  for (let index = 1; index < nodeIds.length; index += 1) {
    relations.push(
      store.linkNodes({
        sourceNodeId: nodeIds[index - 1]!,
        targetNodeId: nodeIds[index]!,
        type: relationType,
      }),
    );
  }
  return relations;
}
