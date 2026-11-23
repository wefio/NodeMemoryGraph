import type {
  MemoryBackend,
  MemoryCommitReceipt,
  MemoryCommitRequest,
  MemoryEntity,
} from "./backend.ts";
import { requestHash } from "./model.ts";

/** Rehearse graph migration into one empty namespace in a single publication. */
export async function importMemoryGraph(
  backend: MemoryBackend,
  entities: readonly MemoryEntity[],
): Promise<MemoryCommitReceipt> {
  const result = await backend.commit(graphImportRequest(entities));
  if (result.status === "conflict") throw new Error("Graph import requires an empty namespace");
  return result.receipt;
}

export function graphImportRequest(
  entities: readonly MemoryEntity[],
  preserveLegacyLinks = false,
): MemoryCommitRequest {
  validateGraph(entities, preserveLegacyLinks);
  return {
    operationId: "migration:legacy-sqlite-graph:v1",
    requestHash: requestHash(entities),
    expectedRevision: 0,
    changes: { upsert: entities },
    resultIds: entities.flatMap((entity) => (entity.kind === "memory" ? [entity.value.id] : [])),
  };
}

function validateGraph(entities: readonly MemoryEntity[], preserveLegacyLinks: boolean): void {
  if (!entities.length) throw new Error("Graph import requires a nonempty snapshot");
  const ids = new Map(entities.map((entity) => [`${entity.kind}:${entity.value.id}`, entity]));
  const requireEntity = (kind: MemoryEntity["kind"], id: string) => {
    const entity = ids.get(`${kind}:${id}`);
    if (!entity) throw new Error(`Snapshot references missing ${kind} ${id}`);
    return entity;
  };
  const requireEvidence = (id: string, sessionId: string | null, preserveOrigin = false) => {
    const entity = requireEntity("history", id);
    if (
      !preserveOrigin &&
      entity.kind === "history" &&
      entity.value.sessionId &&
      entity.value.sessionId !== sessionId
    )
      throw new Error(`Snapshot evidence ${id} belongs to another session`);
  };
  const requireMemory = (id: string, sessionId: string | null) => {
    const entity = requireEntity("memory", id);
    if (
      !preserveLegacyLinks &&
      entity.kind === "memory" &&
      entity.value.sessionId &&
      entity.value.sessionId !== sessionId
    )
      throw new Error(`Snapshot memory ${id} belongs to another session`);
  };
  for (const entity of entities) {
    if (entity.kind === "memory") {
      const memory = entity.value;
      if (memory.nodeId) requireEntity("node", memory.nodeId);
      if (!memory.evidenceIds.includes(memory.evidenceId))
        throw new Error(`Snapshot memory ${memory.id} is missing its primary evidence link`);
      for (const id of memory.evidenceIds)
        requireEvidence(id, memory.sessionId, preserveLegacyLinks);
      for (const id of memory.relatedMemoryIds) requireMemory(id, memory.sessionId);
      if (memory.supersedesId) requireMemory(memory.supersedesId, memory.sessionId);
    } else if (entity.kind === "edge") {
      requireEntity("node", entity.value.sourceNodeId);
      requireEntity("node", entity.value.targetNodeId);
      for (const id of entity.value.evidenceIds) requireEvidence(id, null);
    }
  }
}
