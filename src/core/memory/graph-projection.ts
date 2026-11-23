import { recallTriggersFromStoredMarkers } from "../recall-triggers.ts";
import { serializeScope } from "../scope.ts";
import type {
  MemoryActor,
  MemoryNode,
  MemoryRecord,
  MemoryRelationRecord,
  MemoryScope,
  MemoryType,
  NodeRelation,
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

export interface ProjectedPivotEdge {
  id: string;
  source: string;
  target: string;
  kind: "co_occurrence" | "sequential" | "explicit" | "semantic";
  weight: number;
  relationType?: string;
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

function bumpEdge(
  edges: Map<string, ProjectedPivotEdge>,
  source: string,
  target: string,
  kind: ProjectedPivotEdge["kind"],
  relationType?: string,
): void {
  if (source === target) return;
  const id = relationType
    ? `${kind}:${relationType}:${source}->${target}`
    : `${kind}:${source}->${target}`;
  const existing = edges.get(id);
  if (existing) {
    existing.weight += 1;
    return;
  }
  edges.set(id, {
    id,
    source,
    target,
    kind,
    weight: 1,
    ...(relationType ? { relationType } : {}),
  });
}

function compareMemories(left: MemoryRecord, right: MemoryRecord): number {
  const leftTime = left.eventTime ?? left.createdAt;
  const rightTime = right.eventTime ?? right.createdAt;
  return leftTime.localeCompare(rightTime) || left.id.localeCompare(right.id);
}

function attachExplicitRelations(
  edges: Map<string, ProjectedPivotEdge>,
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
    if (!nodes.has(source) || !nodes.has(target)) continue;
    bumpEdge(edges, source, target, "explicit", relation.type);
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
  boundIds: readonly string[],
): void {
  for (let i = 0; i < boundIds.length; i += 1) {
    for (let j = i + 1; j < boundIds.length; j += 1) {
      const [a, b] =
        boundIds[i]! < boundIds[j]! ? [boundIds[i]!, boundIds[j]!] : [boundIds[j]!, boundIds[i]!];
      bumpEdge(edges, a, b, "co_occurrence");
    }
  }
}

function connectSessionSequence(
  memory: MemoryRecord,
  boundIds: readonly string[],
  lastNonSessionBySession: Map<string, string[]>,
  edges: Map<string, ProjectedPivotEdge>,
): void {
  const sessionKey = sessionDimensionKey(memory);
  const nonSessionIds = boundIds.filter((id) => !id.startsWith("session:"));
  if (!sessionKey || !nonSessionIds.length) return;
  for (const prev of lastNonSessionBySession.get(sessionKey) ?? []) {
    for (const curr of nonSessionIds) {
      if (prev !== curr) bumpEdge(edges, prev, curr, "sequential");
    }
  }
  lastNonSessionBySession.set(sessionKey, nonSessionIds);
}

function anchorPivotId(boundIds: readonly string[] | undefined): string | undefined {
  if (!boundIds?.length) return undefined;
  for (const prefix of ["node:", "evidence:", "stateKey:", "time:", "session:"]) {
    const match = boundIds.find((id) => id.startsWith(prefix));
    if (match) return match;
  }
  return boundIds[0];
}

function connectStoredMemoryRelations(
  edges: Map<string, ProjectedPivotEdge>,
  boundByMemory: ReadonlyMap<string, readonly string[]>,
  relations: readonly MemoryRelationRecord[] | undefined,
): void {
  if (!relations?.length) return;
  for (const rel of relations) {
    if (rel.status !== "consolidated" || rel.origin === "node_edge") continue;
    const src = anchorPivotId(boundByMemory.get(rel.sourceId));
    const tgt = anchorPivotId(boundByMemory.get(rel.targetId));
    if (src && tgt && src !== tgt) bumpEdge(edges, src, tgt, "semantic", rel.relationType);
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
          bumpEdge(edges, pAnchor, nAnchor, "semantic", "contradicts");
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
  const byTrigger = new Map<string, string[]>();
  for (const m of memories) {
    const anchor = anchorPivotId(boundByMemory.get(m.id));
    if (!anchor) continue;
    for (const term of new Set(recallTriggersFromStoredMarkers(m.markers))) {
      const list = byTrigger.get(term) ?? [];
      list.push(anchor);
      byTrigger.set(term, list);
    }
  }
  for (const anchors of byTrigger.values()) {
    const unique = [...new Set(anchors)];
    if (unique.length < 2 || unique.length > 8) continue;
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const [a, b] =
          unique[i]! < unique[j]! ? [unique[i]!, unique[j]!] : [unique[j]!, unique[i]!];
        bumpEdge(edges, a, b, "semantic", "shared_concept");
      }
    }
  }
}

function connectDirectMemoryLineage(
  edges: Map<string, ProjectedPivotEdge>,
  memories: readonly MemoryRecord[],
  boundByMemory: ReadonlyMap<string, readonly string[]>,
): void {
  for (const m of memories) {
    const src = anchorPivotId(boundByMemory.get(m.id));
    if (!src) continue;
    if (m.supersedesId) {
      const tgt = anchorPivotId(boundByMemory.get(m.supersedesId));
      if (tgt && src !== tgt) bumpEdge(edges, src, tgt, "semantic", "supersedes");
    }
    for (const relId of m.relatedMemoryIds) {
      const tgt = anchorPivotId(boundByMemory.get(relId));
      if (tgt && src !== tgt) bumpEdge(edges, src, tgt, "semantic", "related_to");
    }
  }
}

/**
 * Project stored memories across orthogonal dimensions (node, session, stateKey, scope,
 * memoryType, time, evidence, actor) with explicit and implicit semantic relations.
 */
export function buildGraphProjection(input: BuildGraphProjectionInput): MemoryGraphProjection {
  const dimensions = input.dimensions?.length ? [...new Set(input.dimensions)] : DEFAULT_DIMENSIONS;
  const granularity = input.timeGranularity ?? "day";
  const sorted = [...input.memories].sort(compareMemories);
  const nodes = new Map<string, ProjectedPivotNode>();
  const edges = new Map<string, ProjectedPivotEdge>();
  const bindings: ProjectedMemoryBinding[] = [];
  const boundByMemory = new Map<string, string[]>();
  const lastNonSessionBySession = new Map<string, string[]>();

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
    connectCoOccurrences(edges, boundIds);
    connectSessionSequence(memory, boundIds, lastNonSessionBySession, edges);
  }

  attachExplicitRelations(
    edges,
    nodes,
    input.explicitRelations,
    dimensions,
    input.includeExplicitEdges !== false,
  );

  if (input.includeSemanticEdges !== false) {
    connectStoredMemoryRelations(edges, boundByMemory, input.explicitMemoryRelations);
    connectDirectMemoryLineage(edges, sorted, boundByMemory);
    connectPredicatePolarityEdges(edges, sorted, boundByMemory);
    connectSharedConceptEdges(edges, sorted, boundByMemory);
  }

  return {
    dimensions,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    bindings,
    memoryCount: sorted.length,
    ...(input.page ? { page: input.page } : {}),
  };
}
