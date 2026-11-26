import { attachStateStamp, type ComputeGraphSpec } from "../compute-graph.ts";
import { TESSERA_REF_MARKER } from "../types.ts";
import type {
  EdgePathStep,
  HistoryRecord,
  MemoryActor,
  MemoryContext,
  MemoryNode,
  MemoryRecord,
  MemoryScope,
  MemorySearchResult,
  NodeRelation,
  TesseraHit,
} from "../types.ts";
import type {
  MemoryBackend,
  MemoryChainProjection,
  MemoryEntity,
  MemoryEntityQuery,
  MemoryHybridPage,
  MemoryLexicalSearchQuery,
  MemoryOrderedGetQuery,
  MemoryReadView,
  MemoryRelationalProjectionPage,
  MemoryRelationalProjectionQuery,
  MemoryRelationalTopologyPage,
  MemoryUserProfilePage,
  MemoryUserProfileQuery,
  MemoryVectorCandidate,
  MemoryVectorQuery,
  RelationalMemoryNeighbor,
  SourceNeighbor,
} from "./backend.ts";
import { searchableMemory, unboundMemoryNode } from "./model.ts";

export interface MemoryQueryOptions {
  scope?: MemoryScope;
  excludeScope?: MemoryScope;
  includeProfileEvidence?: boolean;
  sessionId?: string;
  limit?: number;
  maxTier?: 0 | 1 | 2 | 3;
  graphHops?: number;
  includeHistorical?: boolean;
  sourceActor?: MemoryActor;
  nodeName?: string;
  eventTimeFrom?: string;
  eventTimeTo?: string;
  /** Optional caller clock (ISO instant with Z or offset) for query-time windows and due reminders. */
  now?: string;
  dueReminders?: boolean;
  findTesserae?: boolean;
  expandLeafContext?: boolean;
  expandSourceContext?: boolean;
  /** Collect independent candidates for an injected evidence ranker before reading sources. */
  evidenceShortlist?: boolean;
  /** Optional composable rerank ComputeGraphSpec; pass false to bypass zero-model reranking. */
  rerankGraph?: ComputeGraphSpec | false;
  /** Optional composable search ComputeGraphSpec overriding the engine default search graph. */
  searchGraph?: ComputeGraphSpec;
}

export type SearchCandidate = Omit<MemorySearchResult, "evidence" | "evidenceRecords">;
export type SelectCandidates = (
  candidates: SearchCandidate[],
) => SearchCandidate[] | Promise<SearchCandidate[]>;
export const MAX_LEAF_CONTEXT_RESULTS = 4;

/** Narrow read-only snapshot port passed to compute graphs instead of MemoryEngine or DB handles. */
export interface MemorySnapshotPort {
  readonly namespace: string;
  readonly revision: number;
  readonly now: string;
  readonly backendKind: MemoryBackend["kind"];
  readonly hasVectorIndex: boolean;
  readonly hasRelationalPushdown: boolean;
  readonly scan: (query: MemoryEntityQuery) => Promise<MemoryEntity[]>;
  readonly scanBatch?: (queries: readonly MemoryEntityQuery[]) => Promise<MemoryEntity[][]>;
  readonly adjacentSources?: (source: HistoryRecord, query: MemoryEntityQuery) => SourceNeighbor[];
  readonly relationalNeighbors?: (
    anchor: MemoryRecord,
    query: MemoryEntityQuery,
  ) => RelationalMemoryNeighbor[];
  readonly leafPeers?: (
    seedIds: readonly string[],
    excluded: readonly string[],
    query: MemoryEntityQuery,
  ) => Promise<MemoryEntity[]>;
  readonly chainProjection?: (ids: readonly string[], sessionId?: string) => MemoryChainProjection;
  readonly projectMemories?: (
    query: MemoryRelationalProjectionQuery,
  ) => MemoryRelationalProjectionPage;
  readonly projectMemoriesWithTopology?: (
    query: MemoryRelationalProjectionQuery & { includeExplicitEdges?: boolean },
  ) => MemoryRelationalTopologyPage;
  readonly queryUserProfile?: (query: MemoryUserProfileQuery) => MemoryUserProfilePage;
  readonly profileEvidenceLinks?: (evidenceIds: readonly string[]) => Map<string, string[]>;
  readonly lexicalSearchPage?: (query: MemoryLexicalSearchQuery) => MemorySearchResult[];
  readonly orderedGetPage?: (query: MemoryOrderedGetQuery) => MemorySearchResult[];
  readonly hybridCandidates?: (
    query: MemoryEntityQuery & { text: string },
    semantic: MemoryVectorQuery,
  ) => MemoryHybridPage;
  readonly vectorCandidates?: (
    query: MemoryEntityQuery,
    semantic: MemoryVectorQuery,
  ) => MemoryVectorCandidate[];
}

/** Construct a narrow read-only snapshot port stamped with namespace, revision, and clock. */
export function createSnapshotPort(
  backend: MemoryBackend,
  view: MemoryReadView,
  now: string,
): MemorySnapshotPort {
  const port: MemorySnapshotPort = {
    namespace: backend.namespace,
    revision: view.revision,
    now,
    backendKind: backend.kind,
    hasVectorIndex: Boolean(backend.vectorIndex),
    hasRelationalPushdown: typeof backend.projectMemories === "function",
    scan: (query) => backend.scan(view, query),
    ...(backend.scanBatch ? { scanBatch: (queries) => backend.scanBatch!(view, queries) } : {}),
    ...(backend.adjacentSources
      ? { adjacentSources: (source, query) => backend.adjacentSources!(view, source, query) }
      : {}),
    ...(backend.relationalNeighbors
      ? {
          relationalNeighbors: (anchor, query) => backend.relationalNeighbors!(view, anchor, query),
        }
      : {}),
    ...(backend.leafPeers
      ? {
          leafPeers: (seedIds, excluded, query) =>
            backend.leafPeers!(view, seedIds, excluded, query),
        }
      : {}),
    ...(backend.chainProjection
      ? { chainProjection: (ids, sessionId) => backend.chainProjection!(view, ids, sessionId) }
      : {}),
    ...(backend.projectMemories
      ? { projectMemories: (query) => backend.projectMemories!(view, query) }
      : {}),
    ...(backend.projectMemoriesWithTopology
      ? {
          projectMemoriesWithTopology: (query) => backend.projectMemoriesWithTopology!(view, query),
        }
      : {}),
    ...(backend.queryUserProfile
      ? { queryUserProfile: (query) => backend.queryUserProfile!(view, query) }
      : {}),
    ...(backend.profileEvidenceLinks
      ? {
          profileEvidenceLinks: (evidenceIds) =>
            backend.profileEvidenceLinks!(view, evidenceIds, now),
        }
      : {}),
    ...(backend.lexicalSearchPage
      ? { lexicalSearchPage: (query) => backend.lexicalSearchPage!(view, query) }
      : {}),
    ...(backend.orderedGetPage
      ? { orderedGetPage: (query) => backend.orderedGetPage!(view, query) }
      : {}),
    ...(backend.hybridCandidates
      ? { hybridCandidates: (query, semantic) => backend.hybridCandidates!(view, query, semantic) }
      : {}),
    ...(backend.vectorIndex
      ? {
          vectorCandidates: (query, semantic) =>
            backend.vectorIndex!.candidates(view, query, semantic),
        }
      : {}),
  };
  return attachStateStamp(port, {
    namespace: backend.namespace,
    revision: view.revision,
    snapshotId: `${backend.namespace}@${view.revision}`,
    extra: { now },
  });
}

export function boundedGraphHops(hops = 0): number {
  if (!Number.isInteger(hops) || hops < 0 || hops > 3) throw new Error("Graph hops must be 0..3");
  return hops;
}

export function searchLimit(limit = 20): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Search limit must be 1..100");
  }
  return limit;
}

export function inEventWindow(memory: MemoryRecord, options: MemoryQueryOptions): boolean {
  const { eventTimeFrom, eventTimeTo } = options;
  if (!eventTimeFrom && !eventTimeTo) return true;
  const time = memory.eventTime;
  return Boolean(
    time && (!eventTimeFrom || time >= eventTimeFrom) && (!eventTimeTo || time <= eventTimeTo),
  );
}

export function resolveCandidateNode(
  memory: MemoryRecord,
  nodesById: ReadonlyMap<string, MemoryNode>,
): MemoryNode {
  if (!memory.nodeId) return unboundMemoryNode(memory.residence, memory.createdAt);
  const node = nodesById.get(memory.nodeId);
  if (!node) throw new Error("Broken memory references");
  return node;
}

export function seedNodeIds(results: readonly MemorySearchResult[]): string[] {
  return [...new Set(results.map((item) => item.node.id).filter(Boolean))];
}

export async function searchNodeIds(
  port: MemorySnapshotPort,
  nodeName: string | undefined,
): Promise<string[] | undefined> {
  if (!nodeName) return undefined;
  const nodes = await port.scan({ kind: "node", nodeName, limit: 512 });
  return nodes.flatMap((node) =>
    node.kind === "node" && node.value.canonicalName === nodeName ? [node.value.id] : [],
  );
}

export function readNodesForMemories(
  port: MemorySnapshotPort,
  memories: readonly MemoryRecord[],
): Promise<MemoryEntity[]> {
  const ids = [...new Set(memories.map((memory) => memory.nodeId).filter(Boolean))];
  if (!ids.length) return Promise.resolve([] as MemoryEntity[]);
  return port.scan({ kind: "node", ids, limit: 512 });
}

export async function readHistoriesBatch(
  port: MemorySnapshotPort,
  ids: readonly string[],
  wanted?: ReadonlySet<string>,
): Promise<HistoryRecord[]> {
  const result: HistoryRecord[] = [];
  for (let offset = 0; offset < ids.length; offset += 512) {
    const batch = ids.slice(offset, offset + 512);
    const selected = wanted ? batch.filter((id) => wanted.has(id)) : batch;
    if (!selected.length) continue;
    const entities = await port.scan({ kind: "history", ids: selected, limit: 512 });
    for (const entity of entities) if (entity.kind === "history") result.push(entity.value);
  }
  return result;
}

export async function attachEvidenceToCandidates(
  port: MemorySnapshotPort,
  selected: readonly SearchCandidate[],
  candidates: readonly MemoryRecord[],
): Promise<MemorySearchResult[]> {
  if (!selected.length) return [];
  const wanted = new Set(selected.flatMap(({ memory }) => memory.evidenceIds));
  const ordered = [...new Set(candidates.flatMap(({ evidenceIds }) => evidenceIds))];
  const histories = await readHistoriesBatch(port, ordered, wanted);
  const byId = new Map(histories.map((history, index) => [history.id, { history, index }]));
  return selected.map((item) => {
    const { memory } = item;
    const evidenceRecords = [...new Set(memory.evidenceIds)]
      .flatMap((id) => byId.get(id) ?? [])
      .sort((left, right) => left.index - right.index)
      .map(({ history }) => history);
    const evidence = byId.get(memory.evidenceId)?.history;
    if (!evidence || !memory.evidenceIds.includes(evidence.id)) {
      throw new Error("Broken memory references");
    }
    return { ...item, evidence, evidenceRecords };
  });
}

export async function hydrateCandidates(
  port: MemorySnapshotPort,
  entities: readonly MemoryEntity[],
  options: MemoryQueryOptions,
  includeRetained = false,
  select?: SelectCandidates,
): Promise<MemorySearchResult[]> {
  const memories = entities.flatMap((entity) =>
    entity.kind === "memory" &&
    searchableMemory(entity.value, options, port.now, includeRetained) &&
    inEventWindow(entity.value, options) &&
    entity.value.tier <= (options.maxTier ?? 3)
      ? [entity.value]
      : [],
  );
  if (!memories.length) return [];
  const nodes = await readNodesForMemories(port, memories);
  const nodesById = new Map(
    nodes.flatMap((node) => (node.kind === "node" ? [[node.value.id, node.value] as const] : [])),
  );
  const candidates = memories.flatMap((memory, index): SearchCandidate[] => {
    const node = resolveCandidateNode(memory, nodesById);
    if (options.nodeName && node.canonicalName !== options.nodeName) return [];
    return [
      {
        memory,
        node,
        lexicalScore: 1 / (index + 1),
        vectorScore: 0,
        routeScore: 0,
        combinedScore: 1 / (index + 1),
        recallReason: "lexical_match",
      },
    ];
  });
  const selected = select?.(candidates) ?? candidates;
  return attachEvidenceToCandidates(
    port,
    Array.isArray(selected) ? selected : await selected,
    memories,
  );
}

export async function attachedTesserae(
  port: MemorySnapshotPort,
  results: readonly MemorySearchResult[],
): Promise<TesseraHit[]> {
  const references = collectTesseraReferences(results);
  const ids = [...references.keys()];
  const hits: TesseraHit[] = [];
  for (let offset = 0; offset < ids.length; offset += 512) {
    const entities = await port.scan({
      kind: "tessera",
      ids: ids.slice(offset, offset + 512),
      limit: 512,
    });
    for (const entity of entities) {
      if (
        entity.kind !== "tessera" ||
        !references.get(entity.value.id)?.has(entity.value.memoryId ?? "")
      ) {
        continue;
      }
      const { id, path, snippet, label, kind, memoryId, fileSimhash } = entity.value;
      hits.push({ id, path, snippet, label, kind, memoryId, fileSimhash });
    }
  }
  return hits;
}

function collectTesseraReferences(
  results: readonly MemorySearchResult[],
): Map<string, Set<string>> {
  const references = new Map<string, Set<string>>();
  for (const { memory } of results) {
    for (const marker of memory.markers) {
      const id = marker.attributes?.tesseraId;
      if (marker.kind !== TESSERA_REF_MARKER || typeof id !== "string") continue;
      const owners = references.get(id) ?? new Set<string>();
      owners.add(memory.id);
      references.set(id, owners);
    }
  }
  return references;
}

export function projectResultChains(
  port: MemorySnapshotPort,
  results: MemorySearchResult[],
  sessionId?: string,
): MemoryContext["chainEdges"] | undefined {
  const projection = port.chainProjection?.(
    results.map((item) => item.memory.id),
    sessionId,
  );
  if (!projection) return undefined;
  for (const result of results) {
    const memberships = projection.memberships.get(result.memory.id);
    const primary = memberships?.[0];
    if (!primary) continue;
    result.chainId = primary.chainId;
    result.chainPosition = primary.position;
    result.chainType = primary.chainType;
    result.chainMemberships = memberships;
  }
  return projection.edges.length ? projection.edges : undefined;
}

export async function appendLeafPeers(
  port: MemorySnapshotPort,
  results: MemorySearchResult[],
  seeds: readonly string[],
  query: MemoryEntityQuery,
  options: MemoryQueryOptions,
  budget: number,
): Promise<void> {
  if (budget <= 0 || !seeds.length || !port.leafPeers) return;
  const peers = await port.leafPeers(
    seeds,
    results.map(({ memory }) => memory.id),
    { ...query, limit: 64 },
  );
  const context = await hydrateCandidates(port, peers, options, false, (rows) =>
    rows.slice(0, budget),
  );
  results.push(
    ...context.map((item): MemorySearchResult => ({
      ...item,
      lexicalScore: 0,
      combinedScore: 0,
      recallReason: "leaf_context",
    })),
  );
}

interface HopExpandState {
  readonly port: MemorySnapshotPort;
  readonly results: MemorySearchResult[];
  readonly options: MemoryQueryOptions;
  readonly visited: Set<string>;
  readonly paths: Map<string, EdgePathStep[]>;
  readonly relations: Map<string, NodeRelation>;
  readonly next: string[];
}

async function visitEdgeNeighbors(state: HopExpandState, nodeId: string, depth: number) {
  const edges = await state.port.scan({ kind: "edge", connectedTo: nodeId, limit: 128 });
  for (const entity of edges) {
    if (
      entity.kind !== "edge" ||
      entity.value.status !== "consolidated" ||
      state.relations.size >= 128
    ) {
      continue;
    }
    const edge = entity.value;
    if (edge.direction === "source->target" && edge.sourceNodeId !== nodeId) continue;
    state.relations.set(edge.id, edge);
    const adjacent = edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;
    if (state.visited.has(adjacent)) continue;
    state.visited.add(adjacent);
    state.next.push(adjacent);
    const path: EdgePathStep[] = [
      ...state.paths.get(nodeId)!,
      {
        relationId: edge.id,
        sourceNodeId: nodeId,
        targetNodeId: adjacent,
        relationType: edge.type,
        hop: depth + 1,
      },
    ];
    state.paths.set(adjacent, path);
    const found = await state.port.scan({
      kind: "memory",
      nodeId: adjacent,
      scope: state.options.scope,
      excludeScope: state.options.excludeScope,
      sessionId: state.options.sessionId,
      limit: 100,
    });
    const projected = await hydrateCandidates(state.port, found, state.options);
    for (const item of projected) {
      if (state.results.length < state.options.limit!) state.results.push({ ...item, path });
    }
  }
}

export async function expandNodeHops(
  port: MemorySnapshotPort,
  results: MemorySearchResult[],
  options: MemoryQueryOptions,
): Promise<NodeRelation[]> {
  let frontier = seedNodeIds(results);
  const visited = new Set(frontier);
  const paths = new Map<string, EdgePathStep[]>(frontier.map((id) => [id, []]));
  const relations = new Map<string, NodeRelation>();
  for (
    let depth = 0;
    depth < (options.graphHops ?? 0) && results.length < options.limit!;
    depth += 1
  ) {
    const next: string[] = [];
    const state: HopExpandState = { port, results, options, visited, paths, relations, next };
    for (const nodeId of frontier) {
      await visitEdgeNeighbors(state, nodeId, depth);
    }
    frontier = next;
  }
  return [...relations.values()];
}
