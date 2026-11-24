import { recallTriggersFromStoredMarkers } from "../recall-triggers.ts";
import { serializeScope } from "../scope.ts";
import type {
  MemoryActor,
  MemoryNode,
  MemoryRecord,
  MemoryRelationRecord,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  NodeRelation,
  NodeRelationType,
} from "../types.ts";

export const GRAPH_PROJECTION_DIMENSIONS = [
  "node",
  "session",
  "stateKey",
  "scope",
  "memoryType",
  "time",
  "evidence",
  "actor",
] as const;

export type GraphProjectionDimension = (typeof GRAPH_PROJECTION_DIMENSIONS)[number];

export interface GraphProjectionPageInfo {
  offset: number;
  limit: number;
  returned: number;
  nextOffset: number | null;
  hasMore: boolean;
  truncatedRelationCount?: number;
}

export interface GraphProjectionOptions {
  dimensions?: readonly GraphProjectionDimension[];
  timeGranularity?: "day" | "month" | "year";
  scope?: MemoryScope;
  excludeScope?: MemoryScope;
  sessionId?: string;
  sourceSessionId?: string;
  nodeId?: string;
  nodeIds?: readonly string[];
  nodeName?: string;
  stateKey?: string;
  memoryType?: MemoryType;
  statuses?: readonly MemoryStatus[];
  evidenceId?: string;
  relationTypes?: readonly NodeRelationType[];
  sourceActor?: MemoryActor;
  eventTimeFrom?: string;
  eventTimeTo?: string;
  text?: string;
  includeHistorical?: boolean;
  maxTier?: 0 | 1 | 2 | 3;
  limit?: number;
  offset?: number;
  includeExplicitEdges?: boolean;
  includeSemanticEdges?: boolean;
}

export interface ProjectedPivotNode {
  id: string;
  dimension: GraphProjectionDimension;
  key: string;
  label: string;
  memoryIds: string[];
  explicitNodeId?: string;
}

export interface ProjectedEdgeProvenance {
  origin: string;
  algorithm: string;
  evidenceMemoryIds: string[];
}

export interface ProjectedPivotEdge {
  id: string;
  source: string;
  target: string;
  kind: "co_occurrence" | "sequential" | "explicit" | "semantic";
  authority: "explicit" | "inferred";
  weight: number;
  relationType?: string;
  provenance?: ProjectedEdgeProvenance;
}

export interface ProjectedBoundaryRelation {
  relationId: string;
  relationType: string;
  inPageId: string;
  externalId: string;
  endpointKind: "memory" | "node";
  direction: "outgoing" | "incoming" | "both";
  authority: "explicit";
}

export interface ProjectedMemoryBinding {
  memoryId: string;
  pivotNodeIds: string[];
}

export interface MemoryGraphProjection {
  dimensions: readonly GraphProjectionDimension[];
  nodes: ProjectedPivotNode[];
  edges: ProjectedPivotEdge[];
  bindings: ProjectedMemoryBinding[];
  memoryCount: number;
  boundaryRelations: ProjectedBoundaryRelation[];
  page?: GraphProjectionPageInfo;
}

export interface BuildGraphProjectionInput {
  memories: readonly MemoryRecord[];
  explicitNodes?: ReadonlyMap<string, MemoryNode>;
  explicitRelations?: readonly NodeRelation[];
  explicitMemoryRelations?: readonly MemoryRelationRecord[];
  dimensions?: readonly GraphProjectionDimension[];
  timeGranularity?: "day" | "month" | "year";
  includeExplicitEdges?: boolean;
  includeSemanticEdges?: boolean;
  page?: GraphProjectionPageInfo;
}

interface PivotEntry {
  id: string;
  key: string;
  label: string;
  explicitNodeId?: string;
}

const DEFAULT_DIMENSIONS: readonly GraphProjectionDimension[] = ["node", "session", "stateKey"];

function sessionDimensionKey(memory: MemoryRecord): string | null {
  if (memory.sourceSessionId) return memory.sourceSessionId;
  if (memory.sessionId) return memory.sessionId;
  const marker = memory.markers.find((item) => item.kind === "aml_session");
  const value = marker?.attributes?.session_id;
  return typeof value === "string" && value ? value : null;
}

function timeBucketKey(memory: MemoryRecord, granularity: "day" | "month" | "year"): string | null {
  const raw = memory.eventTime ?? memory.createdAt;
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  if (granularity === "year") return iso.slice(0, 4);
  if (granularity === "month") return iso.slice(0, 7);
  return iso.slice(0, 10);
}

const DIMENSION_EXTRACTORS: Record<
  GraphProjectionDimension,
  (
    memory: MemoryRecord,
    explicitNodes: ReadonlyMap<string, MemoryNode> | undefined,
    granularity: "day" | "month" | "year",
  ) => PivotEntry[]
> = {
  node: (memory, explicitNodes) => {
    if (!memory.nodeId) return [];
    const explicit = explicitNodes?.get(memory.nodeId);
    return [
      {
        id: `node:${memory.nodeId}`,
        key: memory.nodeId,
        label: explicit?.canonicalName || memory.nodeId,
        explicitNodeId: memory.nodeId,
      },
    ];
  },
  session: (memory) => {
    const session = sessionDimensionKey(memory);
    return session ? [{ id: `session:${session}`, key: session, label: session }] : [];
  },
  stateKey: (memory) =>
    memory.stateKey
      ? [{ id: `stateKey:${memory.stateKey}`, key: memory.stateKey, label: memory.stateKey }]
      : [],
  scope: (memory) => {
    const serialized = serializeScope(memory.scope);
    const label = serialized === "{}" ? "global" : serialized;
    return [{ id: `scope:${label}`, key: label, label }];
  },
  memoryType: (memory) => [
    {
      id: `memoryType:${memory.memoryType}`,
      key: memory.memoryType,
      label: memory.memoryType,
    },
  ],
  time: (memory, _explicitNodes, granularity) => {
    const bucket = timeBucketKey(memory, granularity);
    return bucket ? [{ id: `time:${bucket}`, key: bucket, label: bucket }] : [];
  },
  evidence: (memory) => {
    const ids = memory.evidenceIds.length
      ? memory.evidenceIds
      : memory.evidenceId
        ? [memory.evidenceId]
        : [];
    return [...new Set(ids)].map((id) => ({ id: `evidence:${id}`, key: id, label: id }));
  },
  actor: (memory) => [
    { id: `actor:${memory.sourceActor}`, key: memory.sourceActor, label: memory.sourceActor },
  ],
};

function dimensionEntries(
  memory: MemoryRecord,
  dimension: GraphProjectionDimension,
  explicitNodes: ReadonlyMap<string, MemoryNode> | undefined,
  granularity: "day" | "month" | "year",
): PivotEntry[] {
  return DIMENSION_EXTRACTORS[dimension](memory, explicitNodes, granularity);
}

interface BumpEdgeOptions {
  kind: ProjectedPivotEdge["kind"];
  authority: "explicit" | "inferred";
  relationType?: string;
  provenance?: ProjectedEdgeProvenance;
}

function bumpEdge(
  edges: Map<string, ProjectedPivotEdge>,
  source: string,
  target: string,
  options: BumpEdgeOptions,
): void {
  if (source === target) return;
  const id = options.relationType
    ? `${options.kind}:${options.relationType}:${source}->${target}`
    : `${options.kind}:${source}->${target}`;
  const existing = edges.get(id);
  if (existing) {
    existing.weight += 1;
    if (options.provenance && existing.provenance) {
      const merged = new Set([
        ...existing.provenance.evidenceMemoryIds,
        ...options.provenance.evidenceMemoryIds,
      ]);
      existing.provenance.evidenceMemoryIds = [...merged];
    }
    return;
  }
  edges.set(id, {
    id,
    source,
    target,
    kind: options.kind,
    authority: options.authority,
    weight: 1,
    ...(options.relationType ? { relationType: options.relationType } : {}),
    ...(options.provenance ? { provenance: options.provenance } : {}),
  });
}

function addBoundaryRelation(
  boundary: Map<string, ProjectedBoundaryRelation>,
  entry: ProjectedBoundaryRelation,
): void {
  const key = `${entry.endpointKind}:${entry.relationId}:${entry.inPageId}:${entry.externalId}`;
  if (!boundary.has(key)) boundary.set(key, entry);
}

function compareMemories(left: MemoryRecord, right: MemoryRecord): number {
  const leftTime = left.eventTime ?? left.createdAt;
  const rightTime = right.eventTime ?? right.createdAt;
  return leftTime.localeCompare(rightTime) || left.id.localeCompare(right.id);
}

function attachExplicitRelations(
  edges: Map<string, ProjectedPivotEdge>,
  boundary: Map<string, ProjectedBoundaryRelation>,
  nodes: ReadonlyMap<string, ProjectedPivotNode>,
  relations: readonly NodeRelation[] | undefined,
  dimensions: readonly GraphProjectionDimension[],
  includeExplicitEdges: boolean,
): void {
  if (!includeExplicitEdges || !relations?.length || !dimensions.includes("node")) return;
  for (const relation of relations) {
    if (relation.status !== "consolidated") continue;
    const source = `node:${relation.sourceNodeId}`;
    const target = `node:${relation.targetNodeId}`;
    const hasSrc = nodes.has(source);
    const hasTgt = nodes.has(target);
    if (hasSrc && hasTgt) {
      bumpEdge(edges, source, target, {
        kind: "explicit",
        authority: "explicit",
        relationType: relation.type,
      });
    } else if (hasSrc || hasTgt) {
      addBoundaryRelation(boundary, {
        relationId: relation.id,
        relationType: relation.type,
        inPageId: hasSrc ? relation.sourceNodeId : relation.targetNodeId,
        externalId: hasSrc ? relation.targetNodeId : relation.sourceNodeId,
        endpointKind: "node",
        direction: relation.direction === "both" ? "both" : hasSrc ? "outgoing" : "incoming",
        authority: "explicit",
      });
    }
  }
}

function bindMemoryPivotNodes(
  memory: MemoryRecord,
  dimensions: readonly GraphProjectionDimension[],
  explicitNodes: ReadonlyMap<string, MemoryNode> | undefined,
  granularity: "day" | "month" | "year",
  nodes: Map<string, ProjectedPivotNode>,
): string[] {
  const boundIds: string[] = [];
  for (const dimension of dimensions) {
    for (const entry of dimensionEntries(memory, dimension, explicitNodes, granularity)) {
      let node = nodes.get(entry.id);
      if (!node) {
        node = {
          id: entry.id,
          dimension,
          key: entry.key,
          label: entry.label,
          memoryIds: [],
          ...(entry.explicitNodeId ? { explicitNodeId: entry.explicitNodeId } : {}),
        };
        nodes.set(entry.id, node);
      }
      node.memoryIds.push(memory.id);
      boundIds.push(entry.id);
    }
  }
  return boundIds;
}

function connectCoOccurrences(
  edges: Map<string, ProjectedPivotEdge>,
  memoryId: string,
  boundIds: readonly string[],
): void {
  for (let i = 0; i < boundIds.length; i += 1) {
    for (let j = i + 1; j < boundIds.length; j += 1) {
      const [a, b] =
        boundIds[i]! < boundIds[j]! ? [boundIds[i]!, boundIds[j]!] : [boundIds[j]!, boundIds[i]!];
      bumpEdge(edges, a, b, {
        kind: "co_occurrence",
        authority: "inferred",
        provenance: {
          origin: "projection",
          algorithm: "dimension_co_occurrence",
          evidenceMemoryIds: [memoryId],
        },
      });
    }
  }
}

function connectSessionSequence(
  memory: MemoryRecord,
  boundIds: readonly string[],
  lastNonSessionBySession: Map<string, { memoryId: string; pivotIds: string[] }>,
  edges: Map<string, ProjectedPivotEdge>,
): void {
  const sessionKey = sessionDimensionKey(memory);
  const nonSessionIds = boundIds.filter((id) => !id.startsWith("session:"));
  if (!sessionKey || !nonSessionIds.length) return;
  const previous = lastNonSessionBySession.get(sessionKey);
  if (previous) {
    for (const prev of previous.pivotIds) {
      for (const curr of nonSessionIds) {
        if (prev !== curr) {
          bumpEdge(edges, prev, curr, {
            kind: "sequential",
            authority: "inferred",
            provenance: {
              origin: "projection",
              algorithm: "session_sequence",
              evidenceMemoryIds: [previous.memoryId, memory.id],
            },
          });
        }
      }
    }
  }
  lastNonSessionBySession.set(sessionKey, { memoryId: memory.id, pivotIds: nonSessionIds });
}

function anchorPivotId(boundIds: readonly string[] | undefined): string | undefined {
  if (!boundIds?.length) return undefined;
  for (const prefix of ["node:", "evidence:", "stateKey:", "time:", "session:"]) {
    const match = boundIds.find((id) => id.startsWith(prefix));
    if (match) return match;
  }
  return boundIds[0];
}

function connectSingleMemoryRelation(
  edges: Map<string, ProjectedPivotEdge>,
  boundary: Map<string, ProjectedBoundaryRelation>,
  boundByMemory: ReadonlyMap<string, readonly string[]>,
  rel: MemoryRelationRecord,
): void {
  if (rel.status !== "consolidated" || rel.origin === "node_edge") return;
  const hasSrc = boundByMemory.has(rel.sourceId);
  const hasTgt = boundByMemory.has(rel.targetId);
  if (hasSrc && hasTgt) {
    const src = anchorPivotId(boundByMemory.get(rel.sourceId));
    const tgt = anchorPivotId(boundByMemory.get(rel.targetId));
    if (src && tgt && src !== tgt) {
      bumpEdge(edges, src, tgt, {
        kind: "semantic",
        authority: "explicit",
        relationType: rel.relationType,
        provenance: {
          origin: rel.origin,
          algorithm: "stored_relation",
          evidenceMemoryIds: [rel.sourceId, rel.targetId],
        },
      });
    }
    return;
  }
  if (!hasSrc && !hasTgt) return;
  addBoundaryRelation(boundary, {
    relationId: rel.id,
    relationType: rel.relationType,
    inPageId: hasSrc ? rel.sourceId : rel.targetId,
    externalId: hasSrc ? rel.targetId : rel.sourceId,
    endpointKind: "memory",
    direction: rel.direction === "both" ? "both" : hasSrc ? "outgoing" : "incoming",
    authority: "explicit",
  });
}

function connectStoredMemoryRelations(
  edges: Map<string, ProjectedPivotEdge>,
  boundary: Map<string, ProjectedBoundaryRelation>,
  boundByMemory: ReadonlyMap<string, readonly string[]>,
  relations: readonly MemoryRelationRecord[] | undefined,
): void {
  if (!relations?.length) return;
  for (const rel of relations) {
    connectSingleMemoryRelation(edges, boundary, boundByMemory, rel);
  }
}

function connectPredicatePolarityEdges(
  edges: Map<string, ProjectedPivotEdge>,
  memories: readonly MemoryRecord[],
  boundByMemory: ReadonlyMap<string, readonly string[]>,
): void {
  const byPredicate = new Map<string, MemoryRecord[]>();
  for (const m of memories) {
    if (!m.predicateKey || !m.polarity) continue;
    const list = byPredicate.get(m.predicateKey) ?? [];
    list.push(m);
    byPredicate.set(m.predicateKey, list);
  }
  for (const group of byPredicate.values()) {
    const affirms = group.filter((m) => m.polarity === "affirmative");
    const negates = group.filter((m) => m.polarity === "negative");
    for (const pos of affirms.slice(0, 6)) {
      const pAnchor = anchorPivotId(boundByMemory.get(pos.id));
      if (!pAnchor) continue;
      for (const neg of negates.slice(0, 6)) {
        const nAnchor = anchorPivotId(boundByMemory.get(neg.id));
        if (nAnchor && pAnchor !== nAnchor) {
          bumpEdge(edges, pAnchor, nAnchor, {
            kind: "semantic",
            authority: "inferred",
            relationType: "contradicts",
            provenance: {
              origin: "projection",
              algorithm: "predicate_polarity_mismatch",
              evidenceMemoryIds: [pos.id, neg.id],
            },
          });
        }
      }
    }
  }
}

function connectSharedConceptEdges(
  edges: Map<string, ProjectedPivotEdge>,
  memories: readonly MemoryRecord[],
  boundByMemory: ReadonlyMap<string, readonly string[]>,
): void {
  const byTrigger = new Map<string, Array<{ anchor: string; memoryId: string }>>();
  for (const m of memories) {
    const anchor = anchorPivotId(boundByMemory.get(m.id));
    if (!anchor) continue;
    for (const term of new Set(recallTriggersFromStoredMarkers(m.markers))) {
      const list = byTrigger.get(term) ?? [];
      list.push({ anchor, memoryId: m.id });
      byTrigger.set(term, list);
    }
  }
  for (const items of byTrigger.values()) {
    const byAnchor = new Map<string, string>();
    for (const { anchor, memoryId } of items) {
      if (!byAnchor.has(anchor)) byAnchor.set(anchor, memoryId);
    }
    const anchors = [...byAnchor.keys()];
    if (anchors.length < 2 || anchors.length > 8) continue;
    for (let i = 0; i < anchors.length; i += 1) {
      for (let j = i + 1; j < anchors.length; j += 1) {
        const [a, b] =
          anchors[i]! < anchors[j]! ? [anchors[i]!, anchors[j]!] : [anchors[j]!, anchors[i]!];
        bumpEdge(edges, a, b, {
          kind: "semantic",
          authority: "inferred",
          relationType: "shared_concept",
          provenance: {
            origin: "projection",
            algorithm: "shared_recall_trigger",
            evidenceMemoryIds: [byAnchor.get(a)!, byAnchor.get(b)!],
          },
        });
      }
    }
  }
}

function connectDirectMemoryLineage(
  edges: Map<string, ProjectedPivotEdge>,
  boundary: Map<string, ProjectedBoundaryRelation>,
  memories: readonly MemoryRecord[],
  boundByMemory: ReadonlyMap<string, readonly string[]>,
): void {
  for (const m of memories) {
    const src = anchorPivotId(boundByMemory.get(m.id));
    if (m.supersedesId) {
      const tgt = anchorPivotId(boundByMemory.get(m.supersedesId));
      if (src && tgt && src !== tgt) {
        bumpEdge(edges, src, tgt, {
          kind: "semantic",
          authority: "explicit",
          relationType: "supersedes",
          provenance: {
            origin: "supersedes",
            algorithm: "direct_lineage",
            evidenceMemoryIds: [m.id, m.supersedesId],
          },
        });
      } else if (!boundByMemory.has(m.supersedesId)) {
        addBoundaryRelation(boundary, {
          relationId: `rel:sup:${m.id}->${m.supersedesId}`,
          relationType: "supersedes",
          inPageId: m.id,
          externalId: m.supersedesId,
          endpointKind: "memory",
          direction: "outgoing",
          authority: "explicit",
        });
      }
    }
    for (const relId of m.relatedMemoryIds) {
      const tgt = anchorPivotId(boundByMemory.get(relId));
      if (src && tgt && src !== tgt) {
        bumpEdge(edges, src, tgt, {
          kind: "semantic",
          authority: "explicit",
          relationType: "related_to",
          provenance: {
            origin: "related",
            algorithm: "direct_lineage",
            evidenceMemoryIds: [m.id, relId],
          },
        });
      } else if (!boundByMemory.has(relId) && relId !== m.id) {
        addBoundaryRelation(boundary, {
          relationId: `rel:rel:${m.id}->${relId}`,
          relationType: "related_to",
          inPageId: m.id,
          externalId: relId,
          endpointKind: "memory",
          direction: "both",
          authority: "explicit",
        });
      }
    }
  }
}

/**
 * Project stored memories across orthogonal dimensions with explicit vs. inferred
 * relation provenance and explicit cross-page boundary tracking.
 */
export function buildGraphProjection(input: BuildGraphProjectionInput): MemoryGraphProjection {
  const dimensions = input.dimensions?.length ? [...new Set(input.dimensions)] : DEFAULT_DIMENSIONS;
  const granularity = input.timeGranularity ?? "day";
  const sorted = [...input.memories].sort(compareMemories);
  const nodes = new Map<string, ProjectedPivotNode>();
  const edges = new Map<string, ProjectedPivotEdge>();
  const boundary = new Map<string, ProjectedBoundaryRelation>();
  const bindings: ProjectedMemoryBinding[] = [];
  const boundByMemory = new Map<string, string[]>();
  const lastNonSessionBySession = new Map<string, { memoryId: string; pivotIds: string[] }>();

  for (const memory of sorted) {
    const boundIds = bindMemoryPivotNodes(
      memory,
      dimensions,
      input.explicitNodes,
      granularity,
      nodes,
    );
    bindings.push({ memoryId: memory.id, pivotNodeIds: boundIds });
    boundByMemory.set(memory.id, boundIds);
    connectCoOccurrences(edges, memory.id, boundIds);
    connectSessionSequence(memory, boundIds, lastNonSessionBySession, edges);
  }

  attachExplicitRelations(
    edges,
    boundary,
    nodes,
    input.explicitRelations,
    dimensions,
    input.includeExplicitEdges !== false,
  );

  if (input.includeSemanticEdges !== false) {
    connectStoredMemoryRelations(edges, boundary, boundByMemory, input.explicitMemoryRelations);
    connectDirectMemoryLineage(edges, boundary, sorted, boundByMemory);
    connectPredicatePolarityEdges(edges, sorted, boundByMemory);
    connectSharedConceptEdges(edges, sorted, boundByMemory);
  }

  const boundaryRelations = [...boundary.values()];
  return {
    dimensions,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    bindings,
    memoryCount: sorted.length,
    boundaryRelations,
    ...(input.page
      ? { page: { ...input.page, truncatedRelationCount: boundaryRelations.length } }
      : {}),
  };
}
