import { serializeScope } from "../scope.ts";
import type { MemoryNode, MemoryRecord, MemoryScope, NodeRelation } from "../types.ts";

export const GRAPH_PROJECTION_DIMENSIONS = [
  "node",
  "session",
  "stateKey",
  "scope",
  "memoryType",
] as const;

export type GraphProjectionDimension = (typeof GRAPH_PROJECTION_DIMENSIONS)[number];

export interface GraphProjectionOptions {
  dimensions?: readonly GraphProjectionDimension[];
  scope?: MemoryScope;
  excludeScope?: MemoryScope;
  sessionId?: string;
  includeHistorical?: boolean;
  maxTier?: 0 | 1 | 2 | 3;
  limit?: number;
  includeExplicitEdges?: boolean;
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
  kind: "co_occurrence" | "sequential" | "explicit";
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
}

export interface BuildGraphProjectionInput {
  memories: readonly MemoryRecord[];
  explicitNodes?: ReadonlyMap<string, MemoryNode>;
  explicitRelations?: readonly NodeRelation[];
  dimensions?: readonly GraphProjectionDimension[];
  includeExplicitEdges?: boolean;
}

const DEFAULT_DIMENSIONS: readonly GraphProjectionDimension[] = ["node", "session", "stateKey"];

function sessionDimensionKey(memory: MemoryRecord): string | null {
  if (memory.sourceSessionId) return memory.sourceSessionId;
  if (memory.sessionId) return memory.sessionId;
  const marker = memory.markers.find((item) => item.kind === "aml_session");
  const value = marker?.attributes?.session_id;
  return typeof value === "string" && value ? value : null;
}

function dimensionEntry(
  memory: MemoryRecord,
  dimension: GraphProjectionDimension,
  explicitNodes?: ReadonlyMap<string, MemoryNode>,
): { id: string; key: string; label: string; explicitNodeId?: string } | null {
  switch (dimension) {
    case "node": {
      if (!memory.nodeId) return null;
      const explicit = explicitNodes?.get(memory.nodeId);
      return {
        id: `node:${memory.nodeId}`,
        key: memory.nodeId,
        label: explicit?.canonicalName || memory.nodeId,
        explicitNodeId: memory.nodeId,
      };
    }
    case "session": {
      const session = sessionDimensionKey(memory);
      if (!session) return null;
      return { id: `session:${session}`, key: session, label: session };
    }
    case "stateKey": {
      if (!memory.stateKey) return null;
      return { id: `stateKey:${memory.stateKey}`, key: memory.stateKey, label: memory.stateKey };
    }
    case "scope": {
      const serialized = serializeScope(memory.scope);
      const label = serialized === "{}" ? "global" : serialized;
      return { id: `scope:${label}`, key: label, label };
    }
    case "memoryType":
      return {
        id: `memoryType:${memory.memoryType}`,
        key: memory.memoryType,
        label: memory.memoryType,
      };
  }
}

function bumpEdge(
  edges: Map<string, ProjectedPivotEdge>,
  source: string,
  target: string,
  kind: ProjectedPivotEdge["kind"],
  relationType?: string,
): void {
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
  nodes: Map<string, ProjectedPivotNode>,
): string[] {
  const boundIds: string[] = [];
  for (const dimension of dimensions) {
    const entry = dimensionEntry(memory, dimension, explicitNodes);
    if (!entry) continue;
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

/**
 * Project stored memories across arbitrary orthogonal dimensions (node, session,
 * stateKey, scope, memoryType) like an Excel PivotTable without mutating source rows.
 */
export function buildGraphProjection(input: BuildGraphProjectionInput): MemoryGraphProjection {
  const dimensions = input.dimensions?.length ? [...new Set(input.dimensions)] : DEFAULT_DIMENSIONS;
  const sorted = [...input.memories].sort(compareMemories);
  const nodes = new Map<string, ProjectedPivotNode>();
  const edges = new Map<string, ProjectedPivotEdge>();
  const bindings: ProjectedMemoryBinding[] = [];
  const lastNonSessionBySession = new Map<string, string[]>();

  for (const memory of sorted) {
    const boundIds = bindMemoryPivotNodes(memory, dimensions, input.explicitNodes, nodes);
    bindings.push({ memoryId: memory.id, pivotNodeIds: boundIds });
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

  return {
    dimensions,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    bindings,
    memoryCount: sorted.length,
  };
}
