import { randomUUID } from "node:crypto";
import { sameScope } from "../scope.ts";
import { scopesOverlap, validityIntervalsOverlap } from "../semantic-domain.ts";
import type { MemoryRecord, MemoryResolution, TopologyProposal } from "../types.ts";
import type { MemoryPlan } from "./plan.ts";
import { memoryIdentity } from "./model.ts";

export interface MemoryLifecycleTarget {
  memoryId: string;
  sessionId?: string;
}

export interface MemoryResolutionChange extends MemoryLifecycleTarget {
  resolution: MemoryResolution;
  relatedMemoryIds?: string[];
  reason?: string;
}

export interface MemorySupersession extends MemoryLifecycleTarget {
  newMemoryId: string;
  reason?: string;
}

const RELATION_TYPES = {
  conflict: "contradicts",
  distinct: "distinct_from",
  refines: "refines",
  related: "related_to",
  same_entity: "same_as",
} as const;

export interface MemoryRelationProposal extends MemoryLifecycleTarget {
  newMemoryId: string;
  relationJudgement: keyof typeof RELATION_TYPES;
  confidence?: number;
}

export class MemoryLifecycleError extends Error {}

async function requireRecord(plan: MemoryPlan, id: string, sessionId?: string) {
  const memory = await plan.record(id, sessionId);
  if (!memory || memory.status === "deleted")
    throw new MemoryLifecycleError("Memory does not exist in this store and session");
  return memory;
}

export async function changeResolution(
  plan: MemoryPlan,
  change: MemoryResolutionChange,
  now: string,
) {
  const memory = await requireRecord(plan, change.memoryId, change.sessionId);
  const relatedMemoryIds = [...new Set(change.relatedMemoryIds ?? memory.relatedMemoryIds)];
  if (change.resolution !== "resolved" && relatedMemoryIds.length === 0)
    throw new MemoryLifecycleError("Open memories require relatedMemoryIds");
  for (const id of relatedMemoryIds) await requireRecord(plan, id, memory.sessionId ?? undefined);
  const same =
    memory.resolution === change.resolution &&
    JSON.stringify(relatedMemoryIds) === JSON.stringify(memory.relatedMemoryIds);
  const openedAt = same || change.resolution === "resolved" ? memory.openedAt : now;
  const result = { memoryId: memory.id, resolution: change.resolution, openedAt, relatedMemoryIds };
  if (!same) {
    plan.put({
      kind: "memory",
      value: { ...memory, resolution: change.resolution, openedAt, relatedMemoryIds },
    });
    plan.put({
      kind: "resolutionEvent",
      value: {
        id: randomUUID(),
        ...result,
        fromResolution: memory.resolution,
        toResolution: change.resolution,
        reason: change.reason ?? null,
        sessionId: memory.sessionId,
        createdAt: now,
      },
    });
  }
  return result;
}

export async function supersedeMemory(plan: MemoryPlan, input: MemorySupersession, now: string) {
  const updated = await requireRecord(plan, input.newMemoryId, input.sessionId);
  const previous = await requireRecord(plan, input.memoryId, input.sessionId);
  if (
    updated.id === previous.id ||
    updated.sessionId !== previous.sessionId ||
    !sameScope(updated.scope, previous.scope)
  )
    throw new MemoryLifecycleError(
      "Supersession requires distinct memories in identical scope and residence",
    );
  if (updated.supersedesId === previous.id && previous.status === "superseded") return true;
  if (updated.supersedesId || previous.status === "superseded")
    throw new MemoryLifecycleError("Memory already has a supersession link");
  const successors = await plan.find({
    kind: "memory",
    supersedesId: previous.id,
    sessionId: input.sessionId,
  });
  if (successors.some((item) => item.kind === "memory" && item.value.supersedesId === previous.id))
    throw new MemoryLifecycleError("Memory already has a supersession link");
  await requireAcyclic(plan, previous, updated.id, input.sessionId);
  plan.put({
    kind: "memory",
    value: { ...previous, status: "superseded", validUntil: previous.validUntil ?? now },
  });
  plan.put({
    kind: "memory",
    value: { ...updated, supersedesId: previous.id, evidenceRole: "update" },
  });
  return true;
}

async function requireAcyclic(
  plan: MemoryPlan,
  previous: MemoryRecord,
  next: string,
  sessionId?: string,
) {
  const visited = new Set([next]);
  let current: MemoryRecord | null = previous;
  while (current) {
    if (visited.has(current.id))
      throw new MemoryLifecycleError("Supersession would create a cycle");
    visited.add(current.id);
    current = current.supersedesId ? await plan.record(current.supersedesId, sessionId) : null;
  }
}

export async function proposeMemoryRelation(
  plan: MemoryPlan,
  input: MemoryRelationProposal,
  now: string,
) {
  const source = await requireRecord(plan, input.newMemoryId, input.sessionId);
  const target = await requireRecord(plan, input.memoryId, input.sessionId);
  const judgement = input.relationJudgement;
  if (!source.nodeId || !target.nodeId || source.nodeId === target.nodeId)
    throw new MemoryLifecycleError("Semantic relation requires two distinct nodes");
  if (
    ["conflict", "refines", "same_entity"].includes(judgement) &&
    !scopesOverlap(source.scope, target.scope)
  )
    throw new MemoryLifecycleError("Relation requires non-conflicting scope");
  if (judgement === "conflict" && !validityIntervalsOverlap(source, target))
    throw new MemoryLifecycleError("Conflict requires overlapping validity");
  const type = RELATION_TYPES[judgement];
  const nodes = [source.nodeId, target.nodeId];
  const keyNodes = judgement === "refines" ? nodes : [...nodes].sort();
  const proposalKey = `semantic:${type}:${keyNodes.join(":")}`;
  const sessionId = source.sessionId ?? target.sessionId;
  const id = memoryIdentity(
    plan.backend.namespace,
    "relation-proposal",
    sessionId ?? "",
    proposalKey,
  );
  const [existing] = await plan.find({
    kind: "relationProposal",
    ids: [id],
    sessionId: input.sessionId,
  });
  const original = existing?.kind === "relationProposal" ? existing.value : undefined;
  const proposal = updateProposal(
    { id, proposalKey, type, nodes, source, target, now },
    input.confidence ?? 0.5,
    original,
  );
  plan.put({ kind: "relationProposal", value: { ...proposal, sessionId } });
  return proposal;
}

function updateProposal(
  input: {
    id: string;
    proposalKey: string;
    type: TopologyProposal["relationType"];
    nodes: string[];
    source: MemoryRecord;
    target: MemoryRecord;
    now: string;
  },
  confidence: number,
  original?: TopologyProposal,
): TopologyProposal {
  const evidenceMemoryIds = [
    ...new Set([...(original?.evidenceMemoryIds ?? []), input.source.id, input.target.id]),
  ];
  const count = original?.observations ?? 0;
  return {
    id: input.id,
    proposalKey: input.proposalKey,
    type: "link",
    sourceNodeIds: original?.sourceNodeIds ?? input.nodes,
    relationType: input.type,
    partitions: [],
    evidenceTraceIds: [],
    evidenceMemoryIds,
    observations: count + 1,
    estimatedGain: ((original?.estimatedGain ?? 0) * count + confidence) / (count + 1),
    status: "pending",
    actuatedTransformId: null,
    actuationError: null,
    actuatedAt: null,
    createdAt: original?.createdAt ?? input.now,
  };
}
