import {
  ComputeRegistry,
  INPUT_NODE_ID,
  executeComputeGraph,
  type ComputeGraphSpec,
  type ComputeMemoCache,
  type PhysicalPlanOptions,
} from "../compute-graph.ts";
import { eventWindowEnd, eventWindowStart } from "../event-time.ts";
import { normalizeStatement } from "../memory-normalization.ts";
import { isUserProfileRecord, userProfileMatch, USER_PROFILE_SCOPE } from "../user-profile.ts";
import type {
  MemoryContext,
  MemoryNode,
  MemoryRecord,
  MemoryRelationRecord,
  MemorySearchResult,
  NodeRelation,
} from "../types.ts";
import {
  buildGraphProjection,
  type GraphProjectionOptions,
  type MemoryGraphProjection,
} from "./graph-projection.ts";
import type { MemoryEntity, MemoryEntityQuery } from "./backend.ts";
import {
  appendLeafPeers,
  attachedTesserae,
  boundedGraphHops,
  expandNodeHops,
  hydrateCandidates,
  projectResultChains,
  readNodesForMemories,
  searchLimit,
  searchNodeIds,
  type MemoryQueryOptions,
  type MemorySnapshotPort,
} from "./hydration.ts";
import { searchableMemory } from "./model.ts";

export interface GetGraphInput {
  readonly ids: readonly string[];
  readonly options: MemoryQueryOptions;
}

export interface NeighborhoodGraphInput {
  readonly id: string;
  readonly options: MemoryQueryOptions;
}

export interface ProjectGraphInput {
  readonly options: GraphProjectionOptions;
}

export interface UserProfileGraphInput {
  readonly text: string;
  readonly options: MemoryQueryOptions;
}

interface GetScanState {
  readonly results: MemorySearchResult[];
  readonly options: MemoryQueryOptions;
  readonly graphHops: number;
}

interface ProjectSelectionState {
  readonly limit: number;
  readonly offset: number;
  readonly options: GraphProjectionOptions;
  readonly memories: MemoryRecord[];
  readonly relations: MemoryRelationRecord[];
  readonly hasMore: boolean;
}

interface ProjectTopologyState extends ProjectSelectionState {
  readonly explicitNodes: ReadonlyMap<string, MemoryNode>;
  readonly explicitRelations: readonly NodeRelation[];
}

interface ProfileScanState {
  readonly query: string;
  readonly list: boolean;
  readonly rows: Extract<MemoryEntity, { kind: "memory" }>[];
  readonly options: MemoryQueryOptions;
}

async function scanProfileCandidates(
  port: MemorySnapshotPort,
  query: string,
  list: boolean,
  options: MemoryQueryOptions,
): Promise<Extract<MemoryEntity, { kind: "memory" }>[]> {
  const found: Array<{ entity: Extract<MemoryEntity, { kind: "memory" }>; score: number }> = [];
  const filter = {
    kind: "memory",
    scope: USER_PROFILE_SCOPE,
    nodeIds: await searchNodeIds(port, options.nodeName),
    eventTimeFrom: options.eventTimeFrom,
    eventTimeTo: options.eventTimeTo,
    limit: 128,
  } as const;
  for (let offset = 0; ; offset += filter.limit) {
    const page = await port.scan({ ...filter, offset });
    for (const entity of page) {
      if (entity.kind !== "memory" || !isUserProfileRecord(entity.value)) continue;
      if (
        !searchableMemory(entity.value, options, port.now) ||
        entity.value.tier > (options.maxTier ?? 3)
      ) {
        continue;
      }
      const score = list ? 1 : userProfileMatch(query, entity.value);
      if (score) found.push({ entity, score });
    }
    if (page.length < filter.limit) break;
  }
  return found.sort((left, right) => right.score - left.score).map(({ entity }) => entity);
}

async function attachProfileEvidenceLinks(
  port: MemorySnapshotPort,
  results: readonly MemorySearchResult[],
): Promise<void> {
  const byEvidence = new Map(
    results.flatMap(({ evidenceRecords }) =>
      evidenceRecords.map(({ id }): [string, string[]] => [id, []]),
    ),
  );
  for (const { value: memory } of await scanProfileCandidates(port, "", true, {})) {
    for (const evidenceId of memory.evidenceIds) byEvidence.get(evidenceId)?.push(memory.id);
  }
  for (const result of results) {
    const links = result.evidenceRecords.flatMap(({ id }) => {
      const profileMemoryIds = byEvidence.get(id);
      return profileMemoryIds?.length ? [{ evidenceId: id, profileMemoryIds }] : [];
    });
    if (links.length) result.profileEvidence = links;
  }
}

async function appendRelationalNeighbors(
  port: MemorySnapshotPort,
  anchor: MemoryRecord,
  selected: MemorySearchResult[],
  excluded: Set<string>,
  query: MemoryEntityQuery,
  options: MemoryQueryOptions,
  limit: number,
): Promise<void> {
  const rels = port.relationalNeighbors?.(anchor, { ...query, limit: limit * 2 });
  if (!rels?.length) return;
  const reasonById = new Map(rels.map(({ entity, reason }) => [entity.value.id, reason]));
  const peers = await hydrateCandidates(
    port,
    rels.map(({ entity }) => entity),
    options,
    false,
    (rows) =>
      rows.filter(({ memory }) => !excluded.has(memory.id)).slice(0, limit - selected.length),
  );
  for (const peer of peers) {
    excluded.add(peer.memory.id);
    selected.push({ ...peer, neighborhood: reasonById.get(peer.memory.id) ?? "memory_relation" });
  }
}

async function buildExpandedNeighborhood(
  port: MemorySnapshotPort,
  anchor: MemorySearchResult,
  input: MemoryQueryOptions,
): Promise<MemoryContext> {
  const id = anchor.memory.id;
  const limit = input.limit ?? 8;
  const options = {
    ...input,
    scope: input.scope ?? anchor.memory.scope,
    graphHops: boundedGraphHops(input.graphHops ?? 1),
    eventTimeFrom: eventWindowStart(input.eventTimeFrom) ?? undefined,
    eventTimeTo: eventWindowEnd(input.eventTimeTo) ?? undefined,
  };
  const query: MemoryEntityQuery = {
    kind: "memory",
    scope: options.scope,
    sessionId: options.sessionId,
    limit: limit * 2,
    eventTimeFrom: options.eventTimeFrom,
    eventTimeTo: options.eventTimeTo,
  };
  const neighbors = port.adjacentSources?.(anchor.evidence, query) ?? [];
  const reasons = new Map(neighbors.map(({ entity, relation }) => [entity.value.id, relation]));
  const nearby = await hydrateCandidates(
    port,
    neighbors.map(({ entity }) => entity),
    options,
  );
  const results: MemorySearchResult[] = nearby.map((item) => ({
    ...item,
    neighborhood: reasons.get(item.memory.id),
  }));
  const graph = [anchor];
  const relations = await expandNodeHops(port, graph, { ...options, limit: limit + 1 });
  results.push(
    ...graph.slice(1).map((item): MemorySearchResult => ({ ...item, neighborhood: "graph" })),
  );
  const unique = new Map<string, MemorySearchResult>([[id, anchor]]);
  for (const item of results) if (!unique.has(item.memory.id)) unique.set(item.memory.id, item);
  const page = [...unique.values()].slice(0, limit + 1);
  await appendLeafPeers(port, page, [id], query, options, limit + 1 - page.length);
  const selected = page.slice(1).map((item): MemorySearchResult => ({
    ...item,
    neighborhood: item.neighborhood ?? "source_group",
  }));
  const excluded = new Set([id, ...selected.map(({ memory }) => memory.id)]);
  if (selected.length < limit && anchor.memory.nodeId) {
    const sameNode = await port.scan({ ...query, nodeId: anchor.node.id });
    const peers = await hydrateCandidates(port, sameNode, options, false, (rows) =>
      rows.filter(({ memory }) => !excluded.has(memory.id)).slice(0, limit - selected.length),
    );
    for (const peer of peers) excluded.add(peer.memory.id);
    selected.push(
      ...peers.map((item): MemorySearchResult => ({ ...item, neighborhood: "same_node" })),
    );
  }
  if (selected.length < limit && port.relationalNeighbors) {
    await appendRelationalNeighbors(port, anchor.memory, selected, excluded, query, options, limit);
  }
  return {
    neighborhoodAnchorId: id,
    results: selected,
    relations,
    chainEdges: projectResultChains(port, selected, options.sessionId),
  };
}

async function selectProjectionMemories(
  port: MemorySnapshotPort,
  options: GraphProjectionOptions,
  usePushdown: boolean,
): Promise<ProjectSelectionState> {
  const limit = Math.min(512, Math.max(1, Math.floor(options.limit ?? 500)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const eventTimeFrom = eventWindowStart(options.eventTimeFrom) ?? undefined;
  const eventTimeTo = eventWindowEnd(options.eventTimeTo) ?? undefined;
  const nodeIds = options.nodeIds ?? (await searchNodeIds(port, options.nodeName));
  if (usePushdown && port.projectMemories) {
    const page = port.projectMemories({
      scope: options.scope,
      excludeScope: options.excludeScope,
      sessionId: options.sessionId,
      sourceSessionId: options.sourceSessionId,
      nodeId: options.nodeId,
      nodeIds,
      stateKey: options.stateKey,
      memoryType: options.memoryType,
      statuses: options.statuses,
      evidenceId: options.evidenceId,
      relationTypes: options.relationTypes,
      sourceActor: options.sourceActor,
      eventTimeFrom,
      eventTimeTo,
      includeHistorical: options.includeHistorical,
      maxTier: options.maxTier,
      text: options.text,
      now: port.now,
      limit,
      offset,
    });
    return { limit, offset, options, ...page };
  }
  const fetchLimit = Math.min(512, limit + 1);
  const entities = await port.scan({
    kind: "memory",
    nodeId: options.nodeId,
    nodeIds,
    stateKey: options.stateKey,
    scope: options.scope,
    excludeScope: options.excludeScope,
    sessionId: options.sessionId,
    eventTimeFrom,
    eventTimeTo,
    text: options.text,
    limit: fetchLimit,
    offset,
  });
  const hasMore = entities.length > limit;
  const memories = entities
    .slice(0, limit)
    .flatMap((entity) =>
      entity.kind === "memory" &&
      searchableMemory(entity.value, options, port.now, Boolean(options.includeHistorical)) &&
      entity.value.tier <= (options.maxTier ?? 3) &&
      (!options.memoryType || entity.value.memoryType === options.memoryType) &&
      (!options.statuses?.length || options.statuses.includes(entity.value.status)) &&
      (!options.evidenceId || entity.value.evidenceIds.includes(options.evidenceId)) &&
      (!options.sourceSessionId ||
        entity.value.sourceSessionId === options.sourceSessionId ||
        entity.value.sessionId === options.sourceSessionId)
        ? [entity.value]
        : [],
    );
  return { limit, offset, options, memories, relations: [], hasMore };
}

async function loadProjectionNodeEdges(
  port: MemorySnapshotPort,
  explicitNodes: ReadonlyMap<string, MemoryNode>,
  enabled: boolean,
): Promise<NodeRelation[]> {
  if (!enabled || !explicitNodes.size) return [];
  const nodeIdList = [...explicitNodes.keys()];
  if (port.scanBatch) {
    const pages = await port.scanBatch(
      nodeIdList.map((nodeId) => ({ kind: "edge", connectedTo: nodeId, limit: 128 })),
    );
    return pages.flat().flatMap((row) => (row.kind === "edge" ? [row.value] : []));
  }
  const explicitRelations: NodeRelation[] = [];
  for (const nodeId of nodeIdList) {
    const edges = await port.scan({ kind: "edge", connectedTo: nodeId, limit: 128 });
    for (const edge of edges) {
      if (edge.kind === "edge") explicitRelations.push(edge.value);
    }
  }
  return explicitRelations;
}

function buildViewRegistry(): ComputeRegistry<MemorySnapshotPort> {
  const registry = new ComputeRegistry<MemorySnapshotPort>();
  const readOp = (contract: string) => ({
    version: "1.0.0",
    effect: "read" as const,
    contract,
    externalDeps: ["storage_snapshot"] as const,
    cacheable: false,
    parallelSafe: false,
    resources: { execution: "async_io" as const },
  });

  registry.register(
    "scan_ordered_get",
    async (inputs, port): Promise<GetScanState> => {
      const req = inputs.default as GetGraphInput;
      const graphHops = boundedGraphHops(req.options.graphHops);
      const entities = await port.scan({
        kind: "memory",
        ids: req.ids,
        sessionId: req.options.sessionId,
        scope: req.options.scope,
        limit: 512,
      });
      const results = await hydrateCandidates(port, entities, req.options, true);
      const order = new Map(req.ids.map((id, index) => [id, index]));
      results.sort((left, right) => order.get(left.memory.id)! - order.get(right.memory.id)!);
      return { results, options: req.options, graphHops };
    },
    readOp("memory.candidate_recall"),
  );

  registry.register(
    "assemble_get_context",
    async (inputs, port): Promise<MemoryContext> => {
      const state = inputs.default as GetScanState;
      const results = [...state.results];
      const relations = await expandNodeHops(port, results, {
        ...state.options,
        graphHops: state.graphHops,
        limit: Math.max(results.length, state.options.limit ?? 50),
      });
      if (state.options.includeProfileEvidence && results.length) {
        await attachProfileEvidenceLinks(port, results);
      }
      const tesserae = await attachedTesserae(port, results);
      return {
        results,
        relations,
        chainEdges: projectResultChains(port, results, state.options.sessionId),
        ...(tesserae.length ? { tesserae } : {}),
      };
    },
    readOp("memory.context_assemble"),
  );

  registry.register(
    "resolve_and_expand_neighborhood",
    async (inputs, port): Promise<MemoryContext | undefined> => {
      const req = inputs.default as NeighborhoodGraphInput;
      const entities = await port.scan({
        kind: "memory",
        ids: [req.id],
        scope: req.options.scope,
        sessionId: req.options.sessionId,
        limit: 1,
      });
      const [anchor] = await hydrateCandidates(port, entities, {
        sessionId: req.options.sessionId,
        includeHistorical: req.options.includeHistorical,
      });
      if (!anchor) return undefined;
      return buildExpandedNeighborhood(port, anchor, req.options);
    },
    readOp("memory.neighborhood_expand"),
  );

  registry.register(
    "relational_memory_query",
    async (inputs, port, params): Promise<ProjectSelectionState> => {
      const req = inputs.default as ProjectGraphInput;
      const usePushdown = params.$loweredTarget !== "portable_scan" && port.hasRelationalPushdown;
      return selectProjectionMemories(port, req.options, usePushdown);
    },
    {
      ...readOp("memory.candidate_recall"),
      lowering: { target: "sqlite", exprKind: "relational_query" },
    },
  );

  registry.register(
    "load_projection_topology",
    async (inputs, port): Promise<ProjectTopologyState> => {
      const sel = inputs.default as ProjectSelectionState;
      const nodeEntities = await readNodesForMemories(port, sel.memories);
      const explicitNodes = new Map(
        nodeEntities.flatMap((row) =>
          row.kind === "node" ? [[row.value.id, row.value] as const] : [],
        ),
      );
      const explicitRelations = await loadProjectionNodeEdges(
        port,
        explicitNodes,
        sel.options.includeExplicitEdges !== false,
      );
      return { ...sel, explicitNodes, explicitRelations };
    },
    readOp("memory.neighborhood_expand"),
  );

  registry.register(
    "build_pivot_projection",
    (inputs): MemoryGraphProjection => {
      const topo = inputs.default as ProjectTopologyState;
      return buildGraphProjection({
        memories: topo.memories,
        explicitNodes: topo.explicitNodes,
        explicitRelations: topo.explicitRelations,
        explicitMemoryRelations: topo.relations,
        dimensions: topo.options.dimensions,
        timeGranularity: topo.options.timeGranularity,
        includeExplicitEdges: topo.options.includeExplicitEdges,
        includeSemanticEdges: topo.options.includeSemanticEdges,
        page: {
          offset: topo.offset,
          limit: topo.limit,
          returned: topo.memories.length,
          nextOffset: topo.hasMore ? topo.offset + topo.limit : null,
          hasMore: topo.hasMore,
        },
      });
    },
    {
      version: "1.0.0",
      effect: "pure",
      contract: "memory.graph_projection",
      cacheable: true,
      parallelSafe: true,
    },
  );

  registry.register(
    "scan_user_profile_candidates",
    async (inputs, port): Promise<ProfileScanState> => {
      const req = inputs.default as UserProfileGraphInput;
      const limit = searchLimit(req.options.limit);
      const list = req.text.trim() === "*";
      const query = normalizeStatement(req.text);
      const eventTimeFrom = eventWindowStart(req.options.eventTimeFrom) ?? undefined;
      const eventTimeTo = eventWindowEnd(req.options.eventTimeTo) ?? undefined;
      const normalizedOptions: MemoryQueryOptions = {
        ...req.options,
        limit,
        includeHistorical: false,
        eventTimeFrom,
        eventTimeTo,
      };
      const rows = await scanProfileCandidates(port, query, list, normalizedOptions);
      return { query, list, rows, options: normalizedOptions };
    },
    readOp("memory.profile_projection"),
  );

  registry.register(
    "assemble_user_profile_context",
    async (inputs, port): Promise<MemoryContext> => {
      const state = inputs.default as ProfileScanState;
      const limit = state.options.limit ?? 20;
      const results = await hydrateCandidates(port, state.rows.slice(0, limit), state.options);
      return {
        results,
        relations: [],
        retrieval: { mode: "lexical", degraded: false },
        ...(state.list
          ? {
              userProfile: state.rows.map(({ value: memory }) => ({
                memoryId: memory.id,
                memoryType: memory.memoryType,
                statement: memory.statement,
                evidenceIds: memory.evidenceIds,
              })),
            }
          : {}),
      };
    },
    readOp("memory.profile_projection"),
  );

  return registry;
}

export const ENGINE_VIEW_REGISTRY = buildViewRegistry();

export const DEFAULT_GET_CONTEXT_GRAPH: ComputeGraphSpec = {
  id: "engine-get-context-v1",
  nodes: [
    { id: "scan", op: "scan_ordered_get", contract: "memory.candidate_recall" },
    { id: "assemble", op: "assemble_get_context", contract: "memory.context_assemble" },
  ],
  edges: [
    { from: INPUT_NODE_ID, to: "scan" },
    { from: "scan", to: "assemble" },
  ],
  output: "assemble",
};

export const DEFAULT_NEIGHBORHOOD_GRAPH: ComputeGraphSpec = {
  id: "engine-neighborhood-v1",
  nodes: [
    {
      id: "neighborhood",
      op: "resolve_and_expand_neighborhood",
      contract: "memory.neighborhood_expand",
    },
  ],
  edges: [{ from: INPUT_NODE_ID, to: "neighborhood" }],
  output: "neighborhood",
};

export const DEFAULT_PROJECT_GRAPH: ComputeGraphSpec = {
  id: "engine-project-graph-v1",
  nodes: [
    {
      id: "select_memories",
      op: "relational_memory_query",
      contract: "memory.candidate_recall",
      expression: {
        kind: "relational_query",
        operation: "project_memories",
        pushdownPreferred: true,
      },
    },
    { id: "topology", op: "load_projection_topology", contract: "memory.neighborhood_expand" },
    { id: "project", op: "build_pivot_projection", contract: "memory.graph_projection" },
  ],
  edges: [
    { from: INPUT_NODE_ID, to: "select_memories" },
    { from: "select_memories", to: "topology" },
    { from: "topology", to: "project" },
  ],
  output: "project",
};

export const DEFAULT_USER_PROFILE_GRAPH: ComputeGraphSpec = {
  id: "engine-user-profile-v1",
  nodes: [
    { id: "candidates", op: "scan_user_profile_candidates", contract: "memory.profile_projection" },
    { id: "assemble", op: "assemble_user_profile_context", contract: "memory.profile_projection" },
  ],
  edges: [
    { from: INPUT_NODE_ID, to: "candidates" },
    { from: "candidates", to: "assemble" },
  ],
  output: "assemble",
};

export function executeGetContextGraph(
  input: GetGraphInput,
  port: MemorySnapshotPort,
  spec: ComputeGraphSpec = DEFAULT_GET_CONTEXT_GRAPH,
  registry: ComputeRegistry<MemorySnapshotPort> = ENGINE_VIEW_REGISTRY,
  memo?: ComputeMemoCache,
): Promise<MemoryContext> {
  return executeComputeGraph<GetGraphInput, MemoryContext, MemorySnapshotPort>(
    spec,
    registry,
    input,
    port,
    memo,
  );
}

export function executeNeighborhoodGraph(
  input: NeighborhoodGraphInput,
  port: MemorySnapshotPort,
  spec: ComputeGraphSpec = DEFAULT_NEIGHBORHOOD_GRAPH,
  registry: ComputeRegistry<MemorySnapshotPort> = ENGINE_VIEW_REGISTRY,
  memo?: ComputeMemoCache,
): Promise<MemoryContext | undefined> {
  return executeComputeGraph<NeighborhoodGraphInput, MemoryContext | undefined, MemorySnapshotPort>(
    spec,
    registry,
    input,
    port,
    memo,
  );
}

export function executeProjectGraph(
  input: ProjectGraphInput,
  port: MemorySnapshotPort,
  spec: ComputeGraphSpec = DEFAULT_PROJECT_GRAPH,
  registry: ComputeRegistry<MemorySnapshotPort> = ENGINE_VIEW_REGISTRY,
  memo?: ComputeMemoCache,
): Promise<MemoryGraphProjection> {
  const planOptions: PhysicalPlanOptions = {
    backendTarget: port.hasRelationalPushdown ? "sqlite" : "portable",
  };
  return executeComputeGraph<ProjectGraphInput, MemoryGraphProjection, MemorySnapshotPort>(
    spec,
    registry,
    input,
    port,
    memo,
    planOptions,
  );
}

export function executeUserProfileGraph(
  input: UserProfileGraphInput,
  port: MemorySnapshotPort,
  spec: ComputeGraphSpec = DEFAULT_USER_PROFILE_GRAPH,
  registry: ComputeRegistry<MemorySnapshotPort> = ENGINE_VIEW_REGISTRY,
  memo?: ComputeMemoCache,
): Promise<MemoryContext> {
  return executeComputeGraph<UserProfileGraphInput, MemoryContext, MemorySnapshotPort>(
    spec,
    registry,
    input,
    port,
    memo,
  );
}
