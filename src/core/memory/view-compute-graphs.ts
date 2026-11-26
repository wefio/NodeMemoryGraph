import {
  ComputeRegistry,
  INPUT_NODE_ID,
  executeComputeGraph,
  type ComputeGraphSpec,
  type ComputeMemoCache,
  type PhysicalPlanOptions,
  type RelationalQueryExpr,
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
  if (port.profileEvidenceLinks) {
    const byEvidence = port.profileEvidenceLinks(
      results.flatMap(({ evidenceRecords }) => evidenceRecords.map(({ id }) => id)),
    );
    for (const result of results) {
      const links = result.evidenceRecords.flatMap(({ id }) => {
        const profileMemoryIds = byEvidence.get(id);
        return profileMemoryIds?.length ? [{ evidenceId: id, profileMemoryIds }] : [];
      });
      if (links.length) result.profileEvidence = links;
    }
    return;
  }
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

function matchesSourceSession(memory: MemoryRecord, sourceSessionId: string | undefined): boolean {
  if (sourceSessionId === undefined) return true;
  if (memory.sourceSessionId === sourceSessionId || memory.sessionId === sourceSessionId) {
    return true;
  }
  return (
    memory.markers.find((m) => m.kind === "aml_session")?.attributes?.session_id === sourceSessionId
  );
}

function matchesBasicProjectionMeta(
  memory: MemoryRecord,
  options: GraphProjectionOptions,
): boolean {
  if (memory.tier > (options.maxTier ?? 3)) return false;
  if (options.memoryType && memory.memoryType !== options.memoryType) return false;
  if (options.statuses?.length && !options.statuses.includes(memory.status)) return false;
  if (options.evidenceId && !memory.evidenceIds.includes(options.evidenceId)) return false;
  if (options.sourceActor !== undefined && memory.sourceActor !== options.sourceActor) return false;
  return true;
}

function matchesPortableProjectionFilter(
  memory: MemoryRecord,
  options: GraphProjectionOptions,
  now: string,
  relationMemoryIds: ReadonlySet<string> | null,
): boolean {
  return (
    searchableMemory(memory, options, now, Boolean(options.includeHistorical)) &&
    matchesBasicProjectionMeta(memory, options) &&
    matchesSourceSession(memory, options.sourceSessionId) &&
    (!relationMemoryIds || relationMemoryIds.has(memory.id))
  );
}

function comparePortableProjectionOrder(
  left: MemoryRecord,
  right: MemoryRecord,
  useEventTime: boolean,
): number {
  const leftKey = useEventTime ? (left.eventTime ?? "") : left.eventTime || left.createdAt;
  const rightKey = useEventTime ? (right.eventTime ?? "") : right.eventTime || right.createdAt;
  if (rightKey !== leftKey) return rightKey < leftKey ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

async function scanAllEntities(
  port: MemorySnapshotPort,
  baseQuery: Omit<MemoryEntityQuery, "limit" | "offset">,
): Promise<MemoryEntity[]> {
  const pageLimit = 512;
  const out: MemoryEntity[] = [];
  for (let scanOffset = 0; ; scanOffset += pageLimit) {
    const page = await port.scan({ ...baseQuery, limit: pageLimit, offset: scanOffset });
    out.push(...page);
    if (page.length < pageLimit) break;
  }
  return out;
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
  const allMemories = (
    await scanAllEntities(port, {
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
    })
  ).flatMap((entity) => (entity.kind === "memory" ? [entity.value] : []));
  const consolidatedRelations = (await scanAllEntities(port, { kind: "memoryRelation" })).flatMap(
    (entity) =>
      entity.kind === "memoryRelation" && entity.value.status === "consolidated"
        ? [entity.value]
        : [],
  );
  const relationTypeFilter = options.relationTypes?.length ? new Set(options.relationTypes) : null;
  const relationMemoryIds = relationTypeFilter
    ? new Set(
        consolidatedRelations
          .filter((rel) => relationTypeFilter.has(rel.relationType))
          .flatMap((rel) => [rel.sourceId, rel.targetId]),
      )
    : null;
  const useEventTime = Boolean(eventTimeFrom || eventTimeTo);
  const filtered = allMemories
    .filter((memory) =>
      matchesPortableProjectionFilter(memory, options, port.now, relationMemoryIds),
    )
    .sort((left, right) => comparePortableProjectionOrder(left, right, useEventTime));
  const hasMore = filtered.length > offset + limit;
  const memories = filtered.slice(offset, offset + limit);
  const memIds = new Set(memories.map((m) => m.id));
  const relations = memIds.size
    ? consolidatedRelations.filter((rel) => memIds.has(rel.sourceId) || memIds.has(rel.targetId))
    : [];
  return { limit, offset, options, memories, relations, hasMore };
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

async function selectProjectionTopologyViaPushdown(
  port: MemorySnapshotPort,
  options: GraphProjectionOptions,
): Promise<ProjectTopologyState> {
  const limit = Math.min(512, Math.max(1, Math.floor(options.limit ?? 500)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const eventTimeFrom = eventWindowStart(options.eventTimeFrom) ?? undefined;
  const eventTimeTo = eventWindowEnd(options.eventTimeTo) ?? undefined;
  const nodeIds = options.nodeIds ?? (await searchNodeIds(port, options.nodeName));
  const page = port.projectMemoriesWithTopology!({
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
    includeExplicitEdges: options.includeExplicitEdges !== false,
  });
  return {
    limit,
    offset,
    options,
    memories: page.memories,
    relations: page.relations,
    hasMore: page.hasMore,
    explicitNodes: new Map(page.nodes.map((node) => [node.id, node])),
    explicitRelations: page.explicitRelations,
  };
}

async function runUserProfilePushdown(
  port: MemorySnapshotPort,
  req: UserProfileGraphInput,
): Promise<MemoryContext> {
  const limit = searchLimit(req.options.limit);
  const list = req.text.trim() === "*";
  const query = normalizeStatement(req.text);
  const eventTimeFrom = eventWindowStart(req.options.eventTimeFrom) ?? undefined;
  const eventTimeTo = eventWindowEnd(req.options.eventTimeTo) ?? undefined;
  const nodeIds = await searchNodeIds(port, req.options.nodeName);
  if (port.queryUserProfile) {
    const page = port.queryUserProfile({
      text: query,
      list,
      limit,
      excludeScope: req.options.excludeScope,
      nodeName: req.options.nodeName,
      nodeIds,
      eventTimeFrom,
      eventTimeTo,
      sessionId: req.options.sessionId,
      sourceActor: req.options.sourceActor,
      maxTier: req.options.maxTier,
      now: port.now,
    });
    return {
      results: page.results,
      relations: [],
      retrieval: { mode: "lexical", degraded: false },
      ...(list ? { userProfile: page.profileItems } : {}),
    };
  }
  const normalizedOptions: MemoryQueryOptions = {
    ...req.options,
    limit,
    includeHistorical: false,
    eventTimeFrom,
    eventTimeTo,
  };
  const rows = await scanProfileCandidates(port, query, list, normalizedOptions);
  const results = await hydrateCandidates(port, rows.slice(0, limit), normalizedOptions);
  return {
    results,
    relations: [],
    retrieval: { mode: "lexical", degraded: false },
    ...(list
      ? {
          userProfile: rows.map(({ value: memory }) => ({
            memoryId: memory.id,
            memoryType: memory.memoryType,
            statement: memory.statement,
            evidenceIds: memory.evidenceIds,
          })),
        }
      : {}),
  };
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
    async (inputs, port, params): Promise<GetScanState> => {
      const req = inputs.default as GetGraphInput;
      const graphHops = boundedGraphHops(req.options.graphHops);
      if (
        params.$loweredTarget === "sqlite_pushdown" &&
        port.orderedGetPage &&
        !req.options.nodeName
      ) {
        const results = port.orderedGetPage({
          ids: req.ids,
          sessionId: req.options.sessionId,
          scope: req.options.scope,
          includeHistorical: req.options.includeHistorical,
          sourceActor: req.options.sourceActor,
          maxTier: req.options.maxTier,
          eventTimeFrom: eventWindowStart(req.options.eventTimeFrom) ?? undefined,
          eventTimeTo: eventWindowEnd(req.options.eventTimeTo) ?? undefined,
          now: port.now,
        });
        return { results, options: req.options, graphHops };
      }
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
    {
      ...readOp("memory.candidate_recall"),
      lowering: { target: "sqlite", exprKind: "relational_query", operation: "ordered_get_page" },
    },
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
      const usePushdown = params.$loweredTarget === "sqlite_pushdown" && port.hasRelationalPushdown;
      return selectProjectionMemories(port, req.options, usePushdown);
    },
    {
      ...readOp("memory.candidate_recall"),
      lowering: { target: "sqlite", exprKind: "relational_query", operation: "project_memories" },
    },
  );

  registry.register(
    "load_projection_topology",
    async (inputs, port, params): Promise<ProjectTopologyState> => {
      const expr = params.$expression as RelationalQueryExpr | undefined;
      if (expr?.operation === "project_memories_with_topology") {
        const req = inputs.default as ProjectGraphInput;
        const usePushdown =
          params.$loweredTarget === "sqlite_pushdown" &&
          typeof port.projectMemoriesWithTopology === "function";
        if (usePushdown) return selectProjectionTopologyViaPushdown(port, req.options);
        const fallbackSel = await selectProjectionMemories(
          port,
          req.options,
          params.$loweredTarget === "sqlite_pushdown" && port.hasRelationalPushdown,
        );
        const nodeEntities = await readNodesForMemories(port, fallbackSel.memories);
        const explicitNodes = new Map(
          nodeEntities.flatMap((row) =>
            row.kind === "node" ? [[row.value.id, row.value] as const] : [],
          ),
        );
        const explicitRelations = await loadProjectionNodeEdges(
          port,
          explicitNodes,
          fallbackSel.options.includeExplicitEdges !== false,
        );
        return { ...fallbackSel, explicitNodes, explicitRelations };
      }
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
    {
      ...readOp("memory.neighborhood_expand"),
      lowering: {
        target: "sqlite",
        exprKind: "relational_query",
        operation: "project_memories_with_topology",
        fusableWithUpstream: ["select_memories", "relational_memory_query"],
      },
    },
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
    {
      ...readOp("memory.profile_projection"),
      lowering: { target: "sqlite", exprKind: "relational_query", operation: "user_profile_query" },
    },
  );

  registry.register(
    "assemble_user_profile_context",
    async (inputs, port, params): Promise<MemoryContext> => {
      const expr = params.$expression as RelationalQueryExpr | undefined;
      if (expr?.operation === "user_profile_query") {
        const req = inputs.default as UserProfileGraphInput;
        if (params.$loweredTarget === "sqlite_pushdown") return runUserProfilePushdown(port, req);
        return runUserProfilePushdown({ ...port, queryUserProfile: undefined }, req);
      }
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
    {
      ...readOp("memory.profile_projection"),
      lowering: {
        target: "sqlite",
        exprKind: "relational_query",
        operation: "user_profile_query",
        fusableWithUpstream: ["candidates", "scan_user_profile_candidates"],
      },
    },
  );

  return registry;
}

export const ENGINE_VIEW_REGISTRY = buildViewRegistry();

export const DEFAULT_GET_CONTEXT_GRAPH: ComputeGraphSpec = {
  id: "engine-get-context-v1",
  nodes: [
    {
      id: "scan",
      op: "scan_ordered_get",
      contract: "memory.candidate_recall",
      expression: {
        kind: "relational_query",
        operation: "ordered_get_page",
        pushdownPreferred: true,
      },
    },
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
    {
      id: "candidates",
      op: "scan_user_profile_candidates",
      contract: "memory.profile_projection",
      expression: {
        kind: "relational_query",
        operation: "user_profile_query",
        pushdownPreferred: true,
      },
    },
    { id: "assemble", op: "assemble_user_profile_context", contract: "memory.profile_projection" },
  ],
  edges: [
    { from: INPUT_NODE_ID, to: "candidates" },
    { from: "candidates", to: "assemble" },
  ],
  output: "assemble",
};

function withDefaultBackendTarget(
  port: MemorySnapshotPort,
  planOptions?: PhysicalPlanOptions,
): PhysicalPlanOptions {
  return {
    backendTarget: port.hasRelationalPushdown ? "sqlite" : "portable",
    ...planOptions,
  };
}

export function executeGetContextGraph(
  input: GetGraphInput,
  port: MemorySnapshotPort,
  spec: ComputeGraphSpec = DEFAULT_GET_CONTEXT_GRAPH,
  registry: ComputeRegistry<MemorySnapshotPort> = ENGINE_VIEW_REGISTRY,
  memo?: ComputeMemoCache,
  planOptions?: PhysicalPlanOptions,
): Promise<MemoryContext> {
  return executeComputeGraph<GetGraphInput, MemoryContext, MemorySnapshotPort>(
    spec,
    registry,
    input,
    port,
    memo,
    withDefaultBackendTarget(port, planOptions),
  );
}

export function executeNeighborhoodGraph(
  input: NeighborhoodGraphInput,
  port: MemorySnapshotPort,
  spec: ComputeGraphSpec = DEFAULT_NEIGHBORHOOD_GRAPH,
  registry: ComputeRegistry<MemorySnapshotPort> = ENGINE_VIEW_REGISTRY,
  memo?: ComputeMemoCache,
  planOptions?: PhysicalPlanOptions,
): Promise<MemoryContext | undefined> {
  return executeComputeGraph<NeighborhoodGraphInput, MemoryContext | undefined, MemorySnapshotPort>(
    spec,
    registry,
    input,
    port,
    memo,
    withDefaultBackendTarget(port, planOptions),
  );
}

export function executeProjectGraph(
  input: ProjectGraphInput,
  port: MemorySnapshotPort,
  spec: ComputeGraphSpec = DEFAULT_PROJECT_GRAPH,
  registry: ComputeRegistry<MemorySnapshotPort> = ENGINE_VIEW_REGISTRY,
  memo?: ComputeMemoCache,
  planOptions?: PhysicalPlanOptions,
): Promise<MemoryGraphProjection> {
  return executeComputeGraph<ProjectGraphInput, MemoryGraphProjection, MemorySnapshotPort>(
    spec,
    registry,
    input,
    port,
    memo,
    withDefaultBackendTarget(port, planOptions),
  );
}

export function executeUserProfileGraph(
  input: UserProfileGraphInput,
  port: MemorySnapshotPort,
  spec: ComputeGraphSpec = DEFAULT_USER_PROFILE_GRAPH,
  registry: ComputeRegistry<MemorySnapshotPort> = ENGINE_VIEW_REGISTRY,
  memo?: ComputeMemoCache,
  planOptions?: PhysicalPlanOptions,
): Promise<MemoryContext> {
  return executeComputeGraph<UserProfileGraphInput, MemoryContext, MemorySnapshotPort>(
    spec,
    registry,
    input,
    port,
    memo,
    withDefaultBackendTarget(port, planOptions),
  );
}
