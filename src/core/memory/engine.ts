import { randomUUID } from "node:crypto";
import type {
  MemoryBackend,
  MemoryCommitReceipt,
  MemoryEntity,
  MemoryEntityQuery,
  MemoryHybridPage,
  MemoryReadView,
  MemoryVectorQuery,
  SourceNeighbor,
} from "./backend.ts";
import { MemoryOperationConflict } from "./backend.ts";
import {
  memoryIdentity,
  requestHash,
  searchableMemory,
  unboundMemoryNode,
  validateMemoryInput,
  visibleMemory,
} from "./model.ts";
import type { MemoryInput } from "./model.ts";
import type { ComputeGraphSpec } from "../compute-graph.ts";
import {
  buildGraphProjection,
  type GraphProjectionOptions,
  type MemoryGraphProjection,
} from "./graph-projection.ts";
import { rerankCandidatesWithGraph } from "./piecewise-rerank.ts";
import { evidenceShortlist } from "./evidence-ranking.ts";
import { rankLocalLogOdds } from "./local-log-odds.ts";
import { MemoryPlan } from "./plan.ts";
import { recordClaimOutcomes } from "./claim-outcomes.ts";
import { changeResolution, proposeMemoryRelation, supersedeMemory } from "./lifecycle.ts";
import type {
  MemoryRelationProposal,
  MemoryResolutionChange,
  MemorySupersession,
} from "./lifecycle.ts";
import { MemoryWriteRejected } from "../write-policy.ts";
import { hybridScore, lexicalTextScore, searchTerms } from "../store/search-ranking.ts";
import type { ExactLookupAnchor } from "../store/search-ranking.ts";
import { hostTimeZone, queryEventWindow, referenceTimeZone } from "../store/advanced-query.ts";
import { normalize, normalizeStatement } from "../memory-normalization.ts";
import { calendarDay, eventWindowEnd, eventWindowStart, futureDueDays } from "../event-time.ts";
import { recallTriggersFromStoredMarkers } from "../recall-triggers.ts";
import { TESSERA_REF_MARKER } from "../types.ts";
import { isUserProfileRecord, userProfileMatch, USER_PROFILE_SCOPE } from "../user-profile.ts";
import type {
  LinkMemoriesInput,
  MemoryContext,
  EdgePathStep,
  MemoryActor,
  MemoryExportBundle,
  MemoryNode,
  MemoryRecord,
  MemoryRelationRecord,
  MemoryScope,
  MemoryStorageState,
  MemorySearchResult,
  MemoryWriteEvent,
  NodeRelation,
  RememberResult,
  RecordClaimOutcomesInput,
  TesseraHit,
} from "../types.ts";

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
}

interface PlannedResult<T> {
  result: T;
  ids: string[];
}

type SearchCandidate = Omit<MemorySearchResult, "evidence" | "evidenceRecords">;
type SelectCandidates = (candidates: SearchCandidate[]) => SearchCandidate[];
export const MAX_LEAF_CONTEXT_RESULTS = 4;

/** Memory semantics and graph organization depend only on the asynchronous domain port. */
export class MemoryEngine {
  readonly backend: MemoryBackend;
  private readonly now: () => string;

  constructor(backend: MemoryBackend, now = () => new Date().toISOString()) {
    this.backend = backend;
    this.now = now;
  }

  async remember(input: MemoryInput, operationId: string = randomUUID()): Promise<RememberResult> {
    return (await this.rememberMany([input], operationId))[0]!;
  }

  async rememberMany(
    inputs: readonly MemoryInput[],
    operationId: string = randomUUID(),
  ): Promise<RememberResult[]> {
    if (!inputs.length || inputs.length > 128)
      throw new Error("A memory batch needs 1..128 inputs");
    const timestamp = this.now();
    await this.validateWrites(inputs, operationId, timestamp);
    return this.mutate(
      operationId,
      { action: "remember", inputs: inputs.map(rememberRequest) },
      async (plan) => {
        await plan.prefetchRemember(inputs);
        const result: RememberResult[] = [];
        for (const [slot, input] of inputs.entries())
          result.push(await plan.remember(input, operationId, slot, timestamp));
        return { result, ids: result.map((item) => item.memory.id) };
      },
      async (view, receipt) => {
        const result = receipt.result as RememberResult[];
        await this.requireAvailable(view, result);
        return result;
      },
    );
  }

  private async validateWrites(inputs: readonly MemoryInput[], operationId: string, now: string) {
    for (const [slot, input] of inputs.entries()) {
      try {
        validateMemoryInput(input);
      } catch (error) {
        if (error instanceof MemoryWriteRejected)
          await this.recordRejection(input, operationId, slot, error.reason, now);
        throw error;
      }
    }
  }

  private async recordRejection(
    input: MemoryInput,
    operationId: string,
    slot: number,
    policyReason: string,
    now: string,
  ) {
    const id = memoryIdentity("rejected-memory-write", operationId, String(slot), policyReason);
    const metadata: Omit<MemoryWriteEvent, "createdAt"> = {
      id,
      memoryId: null,
      historyId: null,
      sessionId: input.sessionId ?? null,
      decision: "rejected",
      policyReason,
      writeReason: `cli_rejected_${input.memoryType ?? "fact"}`,
      writeSource: input.writeSource ?? "agent",
      memoryType: input.memoryType ?? "fact",
      requestedResidence: input.residence ?? "ltg",
    };
    await this.mutate(
      `audit:${id}`,
      metadata,
      async (plan) => {
        plan.audit.push({ ...metadata, createdAt: now });
        return { result: null, ids: [] };
      },
      async () => null,
    );
  }

  async get(ids: readonly string[], options: MemoryQueryOptions = {}): Promise<MemoryContext> {
    const graphHops = boundedGraphHops(options.graphHops);
    const view = await this.backend.openRead();
    try {
      const entities = await this.backend.scan(view, {
        kind: "memory",
        ids,
        sessionId: options.sessionId,
        scope: options.scope,
        limit: 512,
      });
      const results = await this.project(view, entities, options, true);
      const order = new Map(ids.map((id, index) => [id, index]));
      results.sort((left, right) => order.get(left.memory.id)! - order.get(right.memory.id)!);
      const relations = await this.expand(view, results, {
        ...options,
        graphHops,
        limit: Math.max(results.length, options.limit ?? 50),
      });
      if (options.includeProfileEvidence && results.length)
        await this.attachProfileEvidence(view, results);
      const tesserae = await this.attachedTesserae(view, results);
      return {
        results,
        relations,
        chainEdges: this.projectChains(view, results, options.sessionId),
        ...(tesserae.length ? { tesserae } : {}),
      };
    } finally {
      await this.backend.closeRead(view);
    }
  }

  /** Browse readable neighbors of a known record on a single backend snapshot. */
  async searchNeighborhood(
    id: string,
    options: MemoryQueryOptions,
  ): Promise<MemoryContext | undefined> {
    const view = await this.backend.openRead();
    try {
      const entities = await this.backend.scan(view, {
        kind: "memory",
        ids: [id],
        scope: options.scope,
        sessionId: options.sessionId,
        limit: 1,
      });
      const [anchor] = await this.project(view, entities, {
        sessionId: options.sessionId,
        includeHistorical: options.includeHistorical,
      });
      if (!anchor) return;
      return await this.expandNeighborhood(view, anchor, options);
    } finally {
      await this.backend.closeRead(view);
    }
  }

  private async expandNeighborhood(
    view: MemoryReadView,
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
    const neighbors = this.backend.adjacentSources?.(view, anchor.evidence, query) ?? [];
    const reasons = new Map(neighbors.map(({ entity, relation }) => [entity.value.id, relation]));
    const nearby = await this.project(
      view,
      neighbors.map(({ entity }) => entity),
      options,
    );
    const results: MemorySearchResult[] = nearby.map((item) => ({
      ...item,
      neighborhood: reasons.get(item.memory.id),
    }));
    const graph = [anchor];
    const relations = await this.expand(view, graph, { ...options, limit: limit + 1 });
    results.push(
      ...graph.slice(1).map((item): MemorySearchResult => ({ ...item, neighborhood: "graph" })),
    );
    const unique = new Map<string, MemorySearchResult>([[id, anchor]]);
    for (const item of results) if (!unique.has(item.memory.id)) unique.set(item.memory.id, item);
    const page = [...unique.values()].slice(0, limit + 1);
    await this.appendLeafContext(view, page, [id], query, options, limit + 1 - page.length);
    const selected = page.slice(1).map((item): MemorySearchResult => ({
      ...item,
      neighborhood: item.neighborhood ?? "source_group",
    }));
    const excluded = new Set([id, ...selected.map(({ memory }) => memory.id)]);
    if (selected.length < limit && anchor.memory.nodeId) {
      const sameNode = await this.backend.scan(view, { ...query, nodeId: anchor.node.id });
      const peers = await this.project(view, sameNode, options, false, (rows) =>
        rows.filter(({ memory }) => !excluded.has(memory.id)).slice(0, limit - selected.length),
      );
      for (const peer of peers) excluded.add(peer.memory.id);
      selected.push(
        ...peers.map((item): MemorySearchResult => ({ ...item, neighborhood: "same_node" })),
      );
    }
    if (selected.length < limit && this.backend.relationalNeighbors) {
      await this.appendRelationalNeighbors(
        view,
        anchor.memory,
        selected,
        excluded,
        query,
        options,
        limit,
      );
    }
    return {
      neighborhoodAnchorId: id,
      results: selected,
      relations,
      chainEdges: this.projectChains(view, selected, options.sessionId),
    };
  }

  private async appendRelationalNeighbors(
    view: MemoryReadView,
    anchor: MemoryRecord,
    selected: MemorySearchResult[],
    excluded: Set<string>,
    query: MemoryEntityQuery,
    options: MemoryQueryOptions,
    limit: number,
  ): Promise<void> {
    const rels = this.backend.relationalNeighbors?.(view, anchor, {
      ...query,
      limit: limit * 2,
    });
    if (!rels?.length) return;
    const reasonById = new Map(rels.map(({ entity, reason }) => [entity.value.id, reason]));
    const peers = await this.project(
      view,
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

  async backfillTesseraFingerprint(input: {
    id: string;
    memoryId: string;
    path: string;
    fileSimhash: string;
    sessionId?: string;
  }): Promise<void> {
    await this.mutate(
      memoryIdentity("tessera-fingerprint", JSON.stringify(input)),
      input,
      async (plan) => {
        const [entity] = await plan.find({ kind: "tessera", ids: [input.id] });
        const owner = await plan.record(input.memoryId, input.sessionId);
        if (
          entity?.kind === "tessera" &&
          entity.value.memoryId === owner?.id &&
          entity.value.path === input.path &&
          !entity.value.fileSimhash
        ) {
          plan.put({ kind: "tessera", value: { ...entity.value, fileSimhash: input.fileSimhash } });
        }
        return { result: null, ids: [] };
      },
      async () => null,
    );
  }

  async exportMemories(
    options: { sourceActor?: MemoryActor; includeDeleted?: boolean } = {},
  ): Promise<MemoryExportBundle> {
    const view = await this.backend.openRead();
    try {
      const plan = new MemoryPlan(this.backend, view);
      const rows = await plan.find({ kind: "memory" });
      const memories = rows.flatMap((row) => (row.kind === "memory" ? [row.value] : []));
      const items = await this.exportItems(view, plan, memories, options);
      items.sort(
        (a, b) =>
          a.memory.createdAt.localeCompare(b.memory.createdAt) ||
          a.memory.id.localeCompare(b.memory.id),
      );
      return { format: "nmg.memory-export.v1", exportedAt: this.now(), items };
    } finally {
      await this.backend.closeRead(view);
    }
  }

  private async exportItems(
    view: MemoryReadView,
    plan: MemoryPlan,
    memories: readonly MemoryRecord[],
    options: { sourceActor?: MemoryActor; includeDeleted?: boolean },
  ): Promise<MemoryExportBundle["items"]> {
    const selected = memories.filter(
      (memory) =>
        (options.includeDeleted || memory.status !== "deleted") &&
        (!options.sourceActor || memory.sourceActor === options.sourceActor),
    );
    const evidence = new Map(
      (
        await this.histories(view, [...new Set(selected.flatMap(({ evidenceIds }) => evidenceIds))])
      ).map((record) => [record.id, record]),
    );
    const nodes = new Map(
      (await plan.find({ kind: "node" })).flatMap((row) =>
        row.kind === "node" ? [[row.value.id, row.value] as const] : [],
      ),
    );
    return selected.map((memory) => ({
      memory,
      node: resolveCandidateNode(memory, nodes),
      evidence: memory.evidenceIds.map((id) => evidence.get(id)!),
    }));
  }

  search(
    text: string,
    options: MemoryQueryOptions = {},
    semantic?: MemoryVectorQuery,
  ): Promise<MemoryContext> {
    return this.searchContext(text, options, semantic);
  }

  /** Build an on-demand multi-dimensional pivot graph across stored memories. */
  async projectGraph(options: GraphProjectionOptions = {}): Promise<MemoryGraphProjection> {
    const view = await this.backend.openRead();
    try {
      const now = this.now();
      const limit = Math.min(512, Math.max(1, Math.floor(options.limit ?? 500)));
      const offset = Math.max(0, Math.floor(options.offset ?? 0));
      const eventTimeFrom = eventWindowStart(options.eventTimeFrom) ?? undefined;
      const eventTimeTo = eventWindowEnd(options.eventTimeTo) ?? undefined;
      const nodeIds = options.nodeIds ?? (await this.searchNodeIds(view, options.nodeName));
      const loaded = await this.loadProjectionMemories(view, {
        ...options,
        nodeIds,
        eventTimeFrom,
        eventTimeTo,
        now,
        limit,
        offset,
      });
      const nodeEntities = await this.readNodesForMemories(view, loaded.memories);
      const explicitNodes = new Map(
        nodeEntities.flatMap((row) =>
          row.kind === "node" ? [[row.value.id, row.value] as const] : [],
        ),
      );
      const explicitRelations = await this.loadProjectionNodeEdges(
        view,
        explicitNodes,
        options.includeExplicitEdges !== false,
      );
      return buildGraphProjection({
        memories: loaded.memories,
        explicitNodes,
        explicitRelations,
        explicitMemoryRelations: loaded.relations,
        dimensions: options.dimensions,
        timeGranularity: options.timeGranularity,
        includeExplicitEdges: options.includeExplicitEdges,
        includeSemanticEdges: options.includeSemanticEdges,
        page: {
          offset,
          limit,
          returned: loaded.memories.length,
          nextOffset: loaded.hasMore ? offset + limit : null,
          hasMore: loaded.hasMore,
        },
      });
    } finally {
      await this.backend.closeRead(view);
    }
  }

  private async loadProjectionMemories(
    view: MemoryReadView,
    params: GraphProjectionOptions & { now: string; limit: number; offset: number },
  ): Promise<{
    memories: MemoryRecord[];
    relations: MemoryRelationRecord[];
    hasMore: boolean;
  }> {
    if (this.backend.projectMemories) {
      return this.backend.projectMemories(view, {
        scope: params.scope,
        excludeScope: params.excludeScope,
        sessionId: params.sessionId,
        sourceSessionId: params.sourceSessionId,
        nodeId: params.nodeId,
        nodeIds: params.nodeIds,
        stateKey: params.stateKey,
        memoryType: params.memoryType,
        statuses: params.statuses,
        evidenceId: params.evidenceId,
        relationTypes: params.relationTypes,
        sourceActor: params.sourceActor,
        eventTimeFrom: params.eventTimeFrom,
        eventTimeTo: params.eventTimeTo,
        includeHistorical: params.includeHistorical,
        maxTier: params.maxTier,
        text: params.text,
        now: params.now,
        limit: params.limit,
        offset: params.offset,
      });
    }
    const fetchLimit = Math.min(512, params.limit + 1);
    const entities = await this.backend.scan(view, {
      kind: "memory",
      nodeId: params.nodeId,
      nodeIds: params.nodeIds,
      stateKey: params.stateKey,
      scope: params.scope,
      excludeScope: params.excludeScope,
      sessionId: params.sessionId,
      eventTimeFrom: params.eventTimeFrom,
      eventTimeTo: params.eventTimeTo,
      text: params.text,
      limit: fetchLimit,
      offset: params.offset,
    });
    const hasMore = entities.length > params.limit;
    const memories = entities
      .slice(0, params.limit)
      .flatMap((entity) =>
        entity.kind === "memory" &&
        searchableMemory(entity.value, params, params.now, Boolean(params.includeHistorical)) &&
        entity.value.tier <= (params.maxTier ?? 3) &&
        (!params.memoryType || entity.value.memoryType === params.memoryType) &&
        (!params.statuses?.length || params.statuses.includes(entity.value.status)) &&
        (!params.evidenceId || entity.value.evidenceIds.includes(params.evidenceId)) &&
        (!params.sourceSessionId ||
          entity.value.sourceSessionId === params.sourceSessionId ||
          entity.value.sessionId === params.sourceSessionId)
          ? [entity.value]
          : [],
      );
    return { memories, relations: [], hasMore };
  }

  private async loadProjectionNodeEdges(
    view: MemoryReadView,
    explicitNodes: ReadonlyMap<string, MemoryNode>,
    enabled: boolean,
  ): Promise<NodeRelation[]> {
    if (!enabled || !explicitNodes.size) return [];
    const nodeIdList = [...explicitNodes.keys()];
    if (this.backend.scanBatch) {
      const pages = await this.backend.scanBatch(
        view,
        nodeIdList.map((nodeId) => ({ kind: "edge", connectedTo: nodeId, limit: 128 })),
      );
      return pages.flat().flatMap((row) => (row.kind === "edge" ? [row.value] : []));
    }
    const explicitRelations: NodeRelation[] = [];
    for (const nodeId of nodeIdList) {
      const edges = await this.backend.scan(view, {
        kind: "edge",
        connectedTo: nodeId,
        limit: 128,
      });
      for (const edge of edges) {
        if (edge.kind === "edge") explicitRelations.push(edge.value);
      }
    }
    return explicitRelations;
  }

  async userProfile(text: string, options: MemoryQueryOptions = {}): Promise<MemoryContext> {
    const limit = searchLimit(options.limit);
    const list = text.trim() === "*";
    const query = normalizeStatement(text);
    const view = await this.backend.openRead();
    try {
      const eventTimeFrom = eventWindowStart(options.eventTimeFrom) ?? undefined;
      const eventTimeTo = eventWindowEnd(options.eventTimeTo) ?? undefined;
      const rows = await this.profileCandidates(view, query, list, {
        ...options,
        includeHistorical: false,
        eventTimeFrom,
        eventTimeTo,
      });
      const results = await this.project(view, rows.slice(0, limit), {
        ...options,
        includeHistorical: false,
        eventTimeFrom,
        eventTimeTo,
      });
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
    } finally {
      await this.backend.closeRead(view);
    }
  }

  private async profileCandidates(
    view: MemoryReadView,
    query: string,
    list: boolean,
    options: MemoryQueryOptions,
  ): Promise<Extract<MemoryEntity, { kind: "memory" }>[]> {
    const found: Array<{ entity: Extract<MemoryEntity, { kind: "memory" }>; score: number }> = [];
    const filter = {
      kind: "memory",
      scope: USER_PROFILE_SCOPE,
      nodeIds: await this.searchNodeIds(view, options.nodeName),
      eventTimeFrom: options.eventTimeFrom,
      eventTimeTo: options.eventTimeTo,
      limit: 128,
    } as const;
    const now = this.now();
    for (let offset = 0; ; offset += filter.limit) {
      const page = await this.backend.scan(view, { ...filter, offset });
      for (const entity of page) {
        if (entity.kind !== "memory" || !isUserProfileRecord(entity.value)) continue;
        if (
          !searchableMemory(entity.value, options, now) ||
          entity.value.tier > (options.maxTier ?? 3)
        )
          continue;
        const score = list ? 1 : userProfileMatch(query, entity.value);
        if (score) found.push({ entity, score });
      }
      if (page.length < filter.limit) break;
    }
    return found.sort((left, right) => right.score - left.score).map(({ entity }) => entity);
  }

  private async attachProfileEvidence(
    view: MemoryReadView,
    results: readonly MemorySearchResult[],
  ): Promise<void> {
    const byEvidence = new Map(
      results.flatMap(({ evidenceRecords }) =>
        evidenceRecords.map(({ id }): [string, string[]] => [id, []]),
      ),
    );
    for (const { value: memory } of await this.profileCandidates(view, "", true, {})) {
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

  searchExactAnchor(
    anchor: ExactLookupAnchor,
    options: MemoryQueryOptions,
  ): Promise<MemoryContext> {
    return this.searchContext(anchor.text, options, undefined, anchor.pattern);
  }

  private async searchContext(
    text: string,
    options: MemoryQueryOptions,
    semantic?: MemoryVectorQuery,
    exact?: RegExp,
  ): Promise<MemoryContext> {
    if (!text.trim()) throw new Error("Search query is required");
    const limit = searchLimit(options.limit);
    boundedGraphHops(options.graphHops);
    const eventTimeFrom = eventWindowStart(options.eventTimeFrom) ?? undefined;
    const eventTimeTo = eventWindowEnd(options.eventTimeTo) ?? undefined;
    options = { ...options, eventTimeFrom, eventTimeTo };
    const view = await this.backend.openRead();
    try {
      const query: MemoryEntityQuery = {
        kind: "memory",
        nodeIds: await this.searchNodeIds(view, options.nodeName),
        scope: options.scope,
        excludeScope: options.excludeScope,
        sessionId: options.sessionId,
        eventTimeFrom,
        eventTimeTo,
        limit: 512,
      };
      const normal = await this.retrieveResults(view, text, query, options, limit, semantic, exact);
      if (exact && !normal.length)
        return { results: normal, relations: [], retrieval: { mode: "lexical", degraded: false } };
      const results = exact
        ? normal
        : await this.applyTemporalWindow(view, text, query, options, normal, limit, semantic);
      const stepOptions = { ...options, limit };
      await this.appendMatchingSourceNeighbors(view, results, text, query, stepOptions, semantic);
      if (!exact) await this.appendDueToday(view, results, stepOptions, limit);
      const relations = await this.expandSearchStructure(view, results, query, stepOptions);
      const tesserae = await this.searchTesserae(view, text, options, results);
      return {
        results,
        relations,
        chainEdges: this.projectChains(view, results, options.sessionId),
        retrieval: { mode: semantic ? "hybrid" : "lexical", degraded: false },
        ...(tesserae.length ? { tesserae } : {}),
      };
    } finally {
      await this.backend.closeRead(view);
    }
  }

  private async searchNodeIds(
    view: MemoryReadView,
    nodeName: string | undefined,
  ): Promise<string[] | undefined> {
    if (!nodeName) return;
    const nodes = await this.backend.scan(view, { kind: "node", nodeName, limit: 512 });
    return nodes.flatMap((node) =>
      node.kind === "node" && node.value.canonicalName === nodeName ? [node.value.id] : [],
    );
  }

  private async expandSearchStructure(
    view: MemoryReadView,
    results: MemorySearchResult[],
    query: MemoryEntityQuery,
    options: MemoryQueryOptions & { limit: number },
  ): Promise<NodeRelation[]> {
    // Take seeds only from direct search results. Peers never seed another leaf expansion.
    const includeLeaves = options.expandLeafContext || options.graphHops;
    const seeds = includeLeaves
      ? results.slice(0, MAX_LEAF_CONTEXT_RESULTS).map(({ memory }) => memory.id)
      : [];
    const relations = await this.expand(view, results, options);
    const budget = Math.min(MAX_LEAF_CONTEXT_RESULTS, options.limit - results.length);
    if (includeLeaves) await this.appendLeafContext(view, results, seeds, query, options, budget);
    return relations;
  }

  private async appendMatchingSourceNeighbors(
    view: MemoryReadView,
    results: MemorySearchResult[],
    text: string,
    query: MemoryEntityQuery,
    options: MemoryQueryOptions & { limit: number },
    semantic?: MemoryVectorQuery,
  ): Promise<void> {
    if (!options.expandSourceContext || semantic?.mode !== "hybrid") return;
    if (!this.backend.adjacentSources || !results.length || options.limit < 10) return;
    const terms = searchTerms(normalize(text)).filter((term) => /\p{L}/u.test(term));
    const seen = new Set(results.map(({ memory }) => memory.id));
    const matches: Array<SourceNeighbor & { overlap: number }> = [];
    for (const [anchorIndex, anchor] of results.slice(0, 2).entries()) {
      for (const neighbor of this.backend.adjacentSources(view, anchor.evidence, {
        ...query,
        scope: anchor.memory.scope,
        limit: 8,
      })) {
        const { id, statement } = neighbor.entity.value;
        if (seen.has(id)) continue;
        seen.add(id);
        const tokens = new Set(searchTerms(normalize(statement)));
        const overlap = terms.filter((term) => tokens.has(term)).length;
        if (overlap > 0 || anchorIndex === 0) matches.push({ ...neighbor, overlap });
      }
    }
    matches.sort((a, b) => b.overlap - a.overlap);
    const relation = new Map(matches.map(({ entity, relation }) => [entity.value.id, relation]));
    const neighbors = await this.project(
      view,
      matches.map(({ entity }) => entity),
      options,
      false,
      (rows) => rows.slice(0, 2),
    );
    const pivot = Math.min(results.length, options.limit - neighbors.length);
    const floor = results.slice(0, pivot).at(-1)?.combinedScore;
    results.splice(
      pivot,
      results.length - pivot,
      ...capTailScores(
        floor,
        neighbors.map((result) => ({
          ...result,
          neighborhood: relation.get(result.memory.id),
        })),
      ),
    );
  }

  private retrieveResults(
    view: MemoryReadView,
    text: string,
    query: MemoryEntityQuery,
    options: MemoryQueryOptions,
    limit: number,
    semantic?: MemoryVectorQuery,
    exact?: RegExp,
  ): Promise<MemorySearchResult[]> {
    return semantic
      ? this.semanticResults(view, text, query, options, semantic, limit)
      : this.lexicalResults(view, text, query, options, limit, exact);
  }

  private async applyTemporalWindow(
    view: MemoryReadView,
    text: string,
    query: MemoryEntityQuery,
    options: MemoryQueryOptions,
    normal: MemorySearchResult[],
    limit: number,
    semantic?: MemoryVectorQuery,
  ): Promise<MemorySearchResult[]> {
    if (options.eventTimeFrom || options.eventTimeTo) return normal;
    const reference = options.now ?? this.now();
    const zone = options.now ? undefined : hostTimeZone(new Date(reference));
    const temporal = queryEventWindow(text, reference, zone);
    if (!temporal.from && !temporal.to) return normal;
    const windowed = await this.retrieveResults(
      view,
      text,
      { ...query, eventTimeFrom: temporal.from, eventTimeTo: temporal.to },
      { ...options, eventTimeFrom: temporal.from, eventTimeTo: temporal.to },
      limit,
      semantic,
    );
    return mergeTemporalWindow(normal, windowed, limit);
  }

  private async appendDueToday(
    view: MemoryReadView,
    results: MemorySearchResult[],
    options: MemoryQueryOptions,
    limit: number,
  ): Promise<void> {
    if (!options.dueReminders) return;
    const reference = options.now ?? this.now();
    const refDate = new Date(reference);
    if (!Number.isFinite(refDate.getTime())) return;
    const zone = options.now ? referenceTimeZone(reference, refDate) : hostTimeZone(refDate);
    const today = calendarDay(refDate, zone);
    const candidates = await this.scanDueTodayCandidates(
      view,
      results,
      options,
      refDate,
      zone,
      today,
    );
    if (!candidates.length) return;
    const projected = await this.project(view, candidates, options, false, (rows) =>
      rows.slice(0, Math.min(2, limit)),
    );
    if (!projected.length) return;
    const tail = results.filter(isAdjacentTurn);
    const ranked = results.filter((item) => !isAdjacentTurn(item));
    const keepRanked = Math.max(0, limit - projected.length - tail.length);
    const kept = ranked.slice(0, keepRanked);
    const floor = kept.at(-1)?.combinedScore;
    const due = capTailScores(
      floor,
      projected.map((item) => ({ ...item, neighborhood: "due_today" as const })),
    );
    const next = [
      ...kept,
      ...due,
      ...capTailScores(due.at(-1)?.combinedScore ?? floor, tail),
    ].slice(0, limit);
    results.splice(0, results.length, ...next);
  }

  private async scanDueTodayCandidates(
    view: MemoryReadView,
    results: readonly MemorySearchResult[],
    options: MemoryQueryOptions,
    refDate: Date,
    zone: string,
    today: string,
  ): Promise<Extract<MemoryEntity, { kind: "memory" }>[]> {
    const seen = new Set(results.map(({ memory }) => memory.id));
    const windowFrom = new Date(refDate.getTime() - 45 * 86_400_000).toISOString();
    const windowTo = refDate.toISOString();
    const matches: Extract<MemoryEntity, { kind: "memory" }>[] = [];
    for (let page = 0; page < 4; page += 1) {
      const rows = await this.backend.scan(view, {
        kind: "memory",
        scope: options.scope,
        excludeScope: options.excludeScope,
        sessionId: options.sessionId,
        eventTimeFrom: windowFrom,
        eventTimeTo: windowTo,
        limit: 512,
        offset: page * 512,
      });
      for (const entity of rows) {
        if (isDueMemoryCandidate(entity, seen, zone, today)) matches.push(entity);
      }
      if (rows.length < 512) break;
    }
    matches.sort(
      (a, b) =>
        (b.value.eventTime ?? "").localeCompare(a.value.eventTime ?? "") ||
        a.value.id.localeCompare(b.value.id),
    );
    return matches;
  }

  private async appendLeafContext(
    view: MemoryReadView,
    results: MemorySearchResult[],
    seeds: string[],
    query: MemoryEntityQuery,
    options: MemoryQueryOptions,
    budget: number,
  ): Promise<void> {
    if (budget <= 0 || !seeds.length || !this.backend.leafPeers) return;
    const peers = await this.backend.leafPeers(
      view,
      seeds,
      results.map(({ memory }) => memory.id),
      { ...query, limit: 64 },
    );
    const context = await this.project(view, peers, options, false, (rows) =>
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

  private async lexicalResults(
    view: MemoryReadView,
    text: string,
    query: MemoryEntityQuery,
    options: MemoryQueryOptions,
    limit: number,
    exact?: RegExp,
  ): Promise<MemorySearchResult[]> {
    const entities = await this.backend.scan(view, { ...query, text });
    const matches = exact
      ? entities.filter(
          (entity) => entity.kind === "memory" && exact.test(normalize(entity.value.statement)),
        )
      : entities;
    return this.project(view, matches, options, false, (candidates) => candidates.slice(0, limit));
  }

  private projectChains(view: MemoryReadView, results: MemorySearchResult[], sessionId?: string) {
    const projection = this.backend.chainProjection?.(
      view,
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

  private async searchTesserae(
    view: MemoryReadView,
    text: string,
    options: MemoryQueryOptions,
    results: MemorySearchResult[],
  ): Promise<TesseraHit[]> {
    const attached = await this.attachedTesserae(view, results);
    if (!options.findTesserae) return attached;
    const rows = await this.backend.scan(view, { kind: "tessera", text, limit: 50 });
    const matches = rows.flatMap((row) => (row.kind === "tessera" ? [row.value] : []));
    const ids = [...new Set(matches.flatMap(({ memoryId }) => (memoryId ? [memoryId] : [])))];
    const owners = await this.backend.scan(view, {
      kind: "memory",
      ids,
      sessionId: options.sessionId,
    });
    const now = this.now();
    const visible = new Set(
      owners.flatMap((row) =>
        row.kind === "memory" && searchableMemory(row.value, options, now) ? [row.value.id] : [],
      ),
    );
    const independent = matches
      .filter(({ memoryId }) => !memoryId || visible.has(memoryId))
      .slice(0, Math.min(options.limit ?? 8, 10))
      .map((item, rank) => ({ ...item, score: 1 / (rank + 1) }));
    return [...new Map([...attached, ...independent].map((item) => [item.id, item])).values()];
  }

  private async semanticResults(
    view: MemoryReadView,
    text: string,
    query: MemoryEntityQuery,
    options: MemoryQueryOptions,
    semantic: MemoryVectorQuery,
    limit: number,
  ): Promise<MemorySearchResult[]> {
    if (!this.backend.vectorIndex) throw new Error("This memory backend has no vector index");
    if (semantic.mode === "hybrid" && this.backend.hybridCandidates) {
      const page = this.backend.hybridCandidates(view, { ...query, text, limit: 100 }, semantic);
      return this.project(
        view,
        page.candidates.map(({ entity }) => entity),
        options,
        false,
        (candidates) =>
          selectLocalHybrid(
            candidates,
            page,
            text,
            options.evidenceShortlist,
            options.rerankGraph,
            limit,
          ),
      );
    }
    const semanticLimit = semantic.mode === "vector" ? 512 : 256;
    const vectors = this.backend.vectorIndex.candidates(
      view,
      { ...query, limit: semanticLimit },
      semantic,
    );
    const lexical =
      semantic.mode === "vector"
        ? []
        : await this.backend.scan(view, { ...query, text, limit: 256 });
    const candidates = new Map(
      [...lexical, ...vectors.map((item) => item.entity)].map((entity) => [
        entity.value.id,
        entity,
      ]),
    );
    const scores = new Map(vectors.map((item) => [item.entity.value.id, item]));
    const queryText = normalize(text);
    const terms = searchTerms(queryText);
    return this.project(view, [...candidates.values()], options, false, (projected) => {
      const ranked = projected
        .map((result): SearchCandidate => {
          const score = scores.get(result.memory.id);
          const vectorScore = score?.recordScore ?? 0;
          const triggers = recallTriggersFromStoredMarkers(result.memory.markers).join(" ");
          const lexicalScore = lexicalTextScore(
            queryText,
            `${result.memory.statement} ${result.node.canonicalName} ${result.node.summary} ${triggers}`,
            terms,
          );
          const combinedScore =
            semantic.mode === "vector" ? vectorScore : hybridScore(lexicalScore, vectorScore, 0);
          const recallReason = score
            ? lexicalScore
              ? "hybrid_match"
              : "vector_match"
            : "lexical_match";
          return {
            ...result,
            lexicalScore,
            vectorScore,
            combinedScore,
            recallReason,
          };
        })
        .sort((left, right) => right.combinedScore - left.combinedScore);
      if (semantic.mode !== "hybrid" || !options.evidenceShortlist) return ranked.slice(0, limit);
      const vectorIds = vectors.map((item) => item.entity.value.id);
      const lexicalIds = lexical.flatMap((item) => (item.kind === "memory" ? [item.value.id] : []));
      return evidenceShortlist(ranked, vectorIds, lexicalIds, limit);
    });
  }

  async linkNodes(
    input: {
      sourceNodeId: string;
      targetNodeId: string;
      type: NodeRelation["type"];
      evidenceIds?: string[];
    },
    operationId: string = randomUUID(),
  ): Promise<NodeRelation> {
    if (input.sourceNodeId === input.targetNodeId)
      throw new Error("Self relations are not supported");
    const timestamp = this.now();
    return this.mutate(
      operationId,
      { action: "link", input },
      async (plan) => {
        const nodes = await plan.find({
          kind: "node",
          ids: [input.sourceNodeId, input.targetNodeId],
        });
        if (
          nodes.length !== 2 ||
          nodes.some(
            (entity) =>
              entity.kind !== "node" ||
              entity.value.status !== "active" ||
              entity.value.residence !== "ltg",
          )
        )
          throw new Error("Relations require active LTG nodes");
        const evidenceIds = input.evidenceIds ?? [];
        const evidence = await plan.find({ kind: "history", ids: evidenceIds });
        if (
          evidence.length !== new Set(evidenceIds).size ||
          evidence.some((entity) => entity.kind !== "history" || entity.value.sessionId !== null)
        )
          throw new Error("Relation evidence must exist and be shared");
        const result: NodeRelation = {
          ...input,
          evidenceIds,
          id: memoryIdentity(
            this.backend.namespace,
            "edge",
            input.sourceNodeId,
            input.targetNodeId,
            input.type,
          ),
          residence: "ltg",
          status: "consolidated",
          stability: 1,
          strength: 1,
          direction: "both",
          fanBudget: true,
          activationRule: "conductive",
          consolidationSource: "explicit",
          consolidatedAt: timestamp,
          createdAt: timestamp,
        };
        plan.put({ kind: "edge", value: result });
        return { result, ids: [result.id] };
      },
      async (_view, receipt) => receipt.result as NodeRelation,
    );
  }

  /** Link two memories directly without requiring any pre-created MemoryNode. */
  async linkMemories(
    input: LinkMemoriesInput,
    operationId: string = randomUUID(),
  ): Promise<MemoryRelationRecord> {
    if (input.sourceMemoryId === input.targetMemoryId)
      throw new Error("Self relations are not supported");
    const timestamp = this.now();
    return this.mutate(
      operationId,
      { action: "linkMemories", input },
      async (plan) => {
        const rows = await plan.find({
          kind: "memory",
          ids: [input.sourceMemoryId, input.targetMemoryId],
          sessionId: input.sessionId,
        });
        const memories = rows.flatMap((row) => (row.kind === "memory" ? [row.value] : []));
        if (memories.length !== 2 || memories.some((m) => m.status === "deleted")) {
          throw new Error("Memory relations require two accessible memories");
        }
        const result: MemoryRelationRecord = {
          id: memoryIdentity(
            this.backend.namespace,
            "memoryRelation",
            input.sourceMemoryId,
            input.targetMemoryId,
            input.type,
          ),
          sourceId: input.sourceMemoryId,
          targetId: input.targetMemoryId,
          sourceKind: "memory",
          targetKind: "memory",
          relationType: input.type,
          weight: input.weight ?? 1.0,
          status: "consolidated",
          direction: input.direction ?? "both",
          origin: "explicit",
          createdAt: timestamp,
        };
        plan.put({ kind: "memoryRelation", value: result });
        return { result, ids: [result.id] };
      },
      async (_view, receipt) => receipt.result as MemoryRelationRecord,
    );
  }

  async withdraw(
    memoryId: string,
    operationId: string = randomUUID(),
    sessionId?: string,
  ): Promise<{ memoryId: string; memory: MemoryRecord }> {
    return this.mutate(
      operationId,
      { action: "withdraw", memoryId, sessionId },
      async (plan) => {
        const found = await plan.find({ kind: "memory", ids: [memoryId], sessionId });
        if (found[0]?.kind !== "memory") throw new Error("Memory does not exist in this session");
        plan.put({ kind: "memory", value: { ...found[0].value, status: "deleted" } });
        return {
          result: { memoryId, memory: { ...found[0].value, status: "deleted" as const } },
          ids: [memoryId],
        };
      },
      async (_view, receipt) => receipt.result as { memoryId: string; memory: MemoryRecord },
    );
  }

  async record(id: string, sessionId?: string): Promise<MemoryRecord | null> {
    const view = await this.backend.openRead();
    try {
      return await new MemoryPlan(this.backend, view).record(id, sessionId);
    } finally {
      await this.backend.closeRead(view);
    }
  }

  setResolution(input: MemoryResolutionChange) {
    return this.lifecycle("resolution", input, (plan) => changeResolution(plan, input, this.now()));
  }

  /** Attach or rebind an existing memory record to a named graph node progressively. */
  attachNode(
    memoryId: string,
    input: {
      nodeName: string;
      nodeSummary?: string;
      nodeKind?: MemoryNode["kind"];
      sessionId?: string;
    },
    operationId: string = randomUUID(),
  ) {
    return this.mutate(
      operationId,
      { action: "attachNode", memoryId, input },
      async (plan) => {
        const result = await plan.attachNode(memoryId, input, this.now());
        return { result, ids: [result.memory.id, result.node.id] };
      },
      async (_view, receipt) => receipt.result as Awaited<ReturnType<MemoryPlan["attachNode"]>>,
    );
  }

  recordClaimOutcomes(input: RecordClaimOutcomesInput) {
    return this.mutate(
      randomUUID(),
      { action: "claimOutcomes", input },
      async (plan) => {
        const result = await recordClaimOutcomes(plan, input, this.now());
        return { result, ids: result.events.map((event) => event.id) };
      },
      async (_view, receipt) => receipt.result as Awaited<ReturnType<typeof recordClaimOutcomes>>,
    );
  }

  async consolidatedFrom(sourceMemoryId: string): Promise<MemoryRecord[]> {
    const view = await this.backend.openRead();
    try {
      const entities = await new MemoryPlan(this.backend, view).find({
        kind: "memory",
        consolidatedFrom: sourceMemoryId,
      });
      return entities.flatMap((entity) =>
        entity.kind === "memory" &&
        entity.value.status === "active" &&
        entity.value.markers.some(
          (marker) =>
            marker.kind === "consolidated_from_stg" &&
            marker.attributes?.sourceMemoryId === sourceMemoryId,
        )
          ? [entity.value]
          : [],
      );
    } finally {
      await this.backend.closeRead(view);
    }
  }

  supersede(input: MemorySupersession) {
    return this.lifecycle("supersession", input, (plan) =>
      supersedeMemory(plan, input, this.now()),
    );
  }

  setStorageState(memoryId: string, target: MemoryStorageState, recoveryDays = 30) {
    return this.lifecycle("storageState", { memoryId, target, recoveryDays }, async (plan) => {
      const memory = await plan.record(memoryId);
      if (!memory) throw new Error(`memory ${memoryId} does not exist`);
      if (memory.residence !== "ltg")
        throw new Error("Retention applies only to shared LTG memories");
      if ((memory.storageState ?? "indexed") === target) return target;
      if (memory.resolution !== "resolved" && target !== "indexed")
        throw new Error("open memories must be resolved before archival or quarantine");
      const now = this.now();
      const quarantineUntil =
        target === "quarantine"
          ? new Date(Date.parse(now) + recoveryDays * 86_400_000).toISOString()
          : null;
      plan.put({
        kind: "memory",
        value: {
          ...memory,
          storageState: target === "indexed" ? undefined : target,
          retentionChangedAt: now,
          quarantineUntil,
        },
      });
      return target;
    });
  }

  recordUsage(ids: readonly string[], sessionId?: string): Promise<void> {
    return this.mutate(
      randomUUID(),
      { action: "usage", ids, sessionId },
      async (plan) => {
        const now = this.now();
        const rows = await plan.find({ kind: "memory", ids, sessionId });
        for (const row of rows) {
          if (row.kind !== "memory" || !visibleMemory(row.value, sessionId, now)) continue;
          plan.put({
            kind: "memory",
            value: { ...row.value, accessCount: row.value.accessCount + 1, lastAccessedAt: now },
          });
        }
        return { result: null, ids: [] };
      },
      async () => null,
    ).then(() => undefined);
  }

  proposeRelation(input: MemoryRelationProposal) {
    return this.lifecycle("relationProposal", input, (plan) =>
      proposeMemoryRelation(plan, input, this.now()),
    );
  }

  private lifecycle<T, Input extends { memoryId: string }>(
    action: string,
    input: Input,
    apply: (plan: MemoryPlan) => Promise<T>,
  ): Promise<T> {
    return this.mutate(
      randomUUID(),
      { action, input },
      async (plan) => ({ result: await apply(plan), ids: [input.memoryId] }),
      async (_view, receipt) => receipt.result as T,
    );
  }

  private async mutate<T>(
    operationId: string,
    request: unknown,
    prepare: (plan: MemoryPlan) => Promise<PlannedResult<T>>,
    replay: (view: MemoryReadView, receipt: MemoryCommitReceipt) => Promise<T>,
  ): Promise<T> {
    const hash = requestHash(request);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const view = await this.backend.openRead();
      try {
        const previous = await this.backend.receipt(view, operationId);
        if (previous) {
          if (previous.requestHash !== hash) throw new MemoryOperationConflict(operationId);
          return await replay(view, previous);
        }
        const plan = new MemoryPlan(this.backend, view);
        const prepared = await prepare(plan);
        const outcome = await this.backend.commit({
          operationId,
          requestHash: hash,
          expectedRevision: view.revision,
          changes: { upsert: [...plan.changes.values()] },
          audit: plan.audit,
          resultIds: prepared.ids,
          result: prepared.result,
        });
        if (outcome.status === "committed") return prepared.result;
        if (outcome.status === "replayed") {
          const current = await this.backend.openRead();
          try {
            return await replay(current, outcome.receipt);
          } finally {
            await this.backend.closeRead(current);
          }
        }
      } finally {
        await this.backend.closeRead(view);
      }
    }
    throw new Error("Memory write conflicted repeatedly; retry the same operation ID");
  }

  private async project(
    view: MemoryReadView,
    entities: MemoryEntity[],
    options: MemoryQueryOptions,
    includeRetained = false,
    select?: SelectCandidates,
  ): Promise<MemorySearchResult[]> {
    const now = this.now();
    const memories = entities.flatMap((entity) =>
      entity.kind === "memory" &&
      searchableMemory(entity.value, options, now, includeRetained) &&
      inEventWindow(entity.value, options) &&
      entity.value.tier <= (options.maxTier ?? 3)
        ? [entity.value]
        : [],
    );
    if (!memories.length) return [];
    const nodes = await this.readNodesForMemories(view, memories);
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
    return this.attachEvidence(view, select ? select(candidates) : candidates, memories);
  }

  private async attachEvidence(
    view: MemoryReadView,
    selected: SearchCandidate[],
    candidates: MemoryRecord[],
  ): Promise<MemorySearchResult[]> {
    if (!selected.length) return [];
    const wanted = new Set(selected.flatMap(({ memory }) => memory.evidenceIds));
    // Keep the original read batches so the evidence order stays stable even across batch boundaries.
    const ordered = [...new Set(candidates.flatMap(({ evidenceIds }) => evidenceIds))];
    const histories = await this.histories(view, ordered, wanted);
    const byId = new Map(histories.map((history, index) => [history.id, { history, index }]));
    return selected.map((item) => {
      const { memory } = item;
      const evidenceRecords = [...new Set(memory.evidenceIds)]
        .flatMap((id) => byId.get(id) ?? [])
        .sort((left, right) => left.index - right.index)
        .map(({ history }) => history);
      const evidence = byId.get(memory.evidenceId)?.history;
      if (!evidence || !memory.evidenceIds.includes(evidence.id))
        throw new Error("Broken memory references");
      return { ...item, evidence, evidenceRecords };
    });
  }

  private async histories(view: MemoryReadView, ids: string[], wanted?: ReadonlySet<string>) {
    const result = [];
    for (let offset = 0; offset < ids.length; offset += 512) {
      const batch = ids.slice(offset, offset + 512);
      const selected = wanted ? batch.filter((id) => wanted.has(id)) : batch;
      if (!selected.length) continue;
      const entities = await this.backend.scan(view, {
        kind: "history",
        ids: selected,
        limit: 512,
      });
      for (const entity of entities) if (entity.kind === "history") result.push(entity.value);
    }
    return result;
  }

  private async attachedTesserae(
    view: MemoryReadView,
    results: MemorySearchResult[],
  ): Promise<TesseraHit[]> {
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
    const ids = [...references.keys()];
    const hits: TesseraHit[] = [];
    for (let offset = 0; offset < ids.length; offset += 512) {
      const entities = await this.backend.scan(view, {
        kind: "tessera",
        ids: ids.slice(offset, offset + 512),
        limit: 512,
      });
      for (const entity of entities) {
        if (
          entity.kind !== "tessera" ||
          !references.get(entity.value.id)?.has(entity.value.memoryId ?? "")
        )
          continue;
        const { id, path, snippet, label, kind, memoryId, fileSimhash } = entity.value;
        hits.push({ id, path, snippet, label, kind, memoryId, fileSimhash });
      }
    }
    return hits;
  }

  private readNodesForMemories(view: MemoryReadView, memories: readonly MemoryRecord[]) {
    const ids = [...new Set(memories.map((memory) => memory.nodeId).filter(Boolean))];
    if (!ids.length) return Promise.resolve([] as MemoryEntity[]);
    return this.backend.scan(view, { kind: "node", ids, limit: 512 });
  }

  private async expand(
    view: MemoryReadView,
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
      for (const nodeId of frontier) {
        const edges = await this.backend.scan(view, {
          kind: "edge",
          connectedTo: nodeId,
          limit: 128,
        });
        for (const entity of edges) {
          if (
            entity.kind !== "edge" ||
            entity.value.status !== "consolidated" ||
            relations.size >= 128
          )
            continue;
          const edge = entity.value;
          if (edge.direction === "source->target" && edge.sourceNodeId !== nodeId) continue;
          relations.set(edge.id, edge);
          const adjacent = edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;
          if (visited.has(adjacent)) continue;
          visited.add(adjacent);
          next.push(adjacent);
          const path = [
            ...paths.get(nodeId)!,
            {
              relationId: edge.id,
              sourceNodeId: nodeId,
              targetNodeId: adjacent,
              relationType: edge.type,
              hop: depth + 1,
            },
          ];
          paths.set(adjacent, path);
          const found = await this.backend.scan(view, {
            kind: "memory",
            nodeId: adjacent,
            scope: options.scope,
            excludeScope: options.excludeScope,
            sessionId: options.sessionId,
            limit: 100,
          });
          const projected = await this.project(view, found, options);
          for (const item of projected)
            if (results.length < options.limit!) results.push({ ...item, path });
        }
      }
      frontier = next;
    }
    return [...relations.values()];
  }

  private async requireAvailable(view: MemoryReadView, results: RememberResult[]): Promise<void> {
    // Receipts acknowledge prior writes, but must not disclose subsequently withdrawn evidence.
    for (const result of results) {
      const sessionId = result.memory.sessionId ?? undefined;
      const found = await this.backend.scan(view, {
        kind: "memory",
        ids: [result.memory.id],
        sessionId,
        limit: 1,
      });
      if (found[0]?.kind !== "memory" || !visibleMemory(found[0].value, sessionId, this.now()))
        throw new Error("The recorded operation result is unavailable");
    }
  }
}

function resolveCandidateNode(
  memory: MemoryRecord,
  nodesById: ReadonlyMap<string, MemoryNode>,
): MemoryNode {
  if (!memory.nodeId) return unboundMemoryNode(memory.residence, memory.createdAt);
  const node = nodesById.get(memory.nodeId);
  if (!node) throw new Error("Broken memory references");
  return node;
}

function seedNodeIds(results: readonly MemorySearchResult[]): string[] {
  return [...new Set(results.map((item) => item.node.id).filter(Boolean))];
}

function selectStandardHybrid(
  ranked: readonly SearchCandidate[],
  text: string,
  limit: number,
  rerankGraph: ComputeGraphSpec | false | undefined,
  turnMeta?: ReadonlyMap<string, { sourceSessionId?: string | null; turnOrdinal?: number | null }>,
): SearchCandidate[] {
  if (rerankGraph === false) return ranked.slice(0, limit);
  const ordered = rerankCandidatesWithGraph(
    ranked.map((candidate) => {
      const meta = turnMeta?.get(candidate.memory.id);
      return {
        candidate,
        id: candidate.memory.id,
        statement: candidate.memory.statement,
        combinedScore: candidate.combinedScore,
        eventTime: candidate.memory.eventTime,
        createdAt: candidate.memory.createdAt,
        sessionId:
          candidate.memory.sourceSessionId ??
          candidate.memory.sessionId ??
          meta?.sourceSessionId ??
          null,
        nodeId: candidate.memory.nodeId,
        evidenceId: candidate.memory.evidenceId,
        turnOrdinal: meta?.turnOrdinal ?? null,
        markers: candidate.memory.markers,
        stateKey: candidate.memory.stateKey,
        predicateKey: candidate.memory.predicateKey,
        supersedesId: candidate.memory.supersedesId,
        relatedMemoryIds: candidate.memory.relatedMemoryIds,
      };
    }),
    text,
    rerankGraph,
  );
  return ordered
    .slice(0, limit)
    .map(({ candidate, combinedScore }) => ({ ...candidate, combinedScore }));
}

function selectLocalHybrid(
  candidates: SearchCandidate[],
  page: MemoryHybridPage,
  text: string,
  shortlist: boolean | undefined,
  rerankGraph: ComputeGraphSpec | false | undefined,
  limit: number,
): SearchCandidate[] {
  const byId = new Map(page.candidates.map((row) => [row.entity.value.id, row]));
  const ranked = rankLocalLogOdds(candidates, ({ memory }) => {
    const { recordScore, bm25 } = byId.get(memory.id)!;
    return { id: memory.id, vectorScore: recordScore, bm25 };
  }).map(({ candidate, score }) => ({ ...candidate, combinedScore: score }));
  const selected = shortlist
    ? evidenceShortlist(ranked, page.vectorIds, page.lexicalIds, limit)
    : selectStandardHybrid(ranked, text, limit, rerankGraph, byId);
  const query = normalize(text);
  const terms = searchTerms(query);
  return selected.map((candidate) => {
    const { memory, node } = candidate;
    const { recordScore, bm25 } = byId.get(memory.id)!;
    const triggers = recallTriggersFromStoredMarkers(memory.markers).join(" ");
    // Preserve the historical component scale consumed by QPP and feedback.
    const lexicalScore = lexicalTextScore(
      query,
      `${memory.statement} ${node.canonicalName} ${node.summary} ${triggers}`,
      terms,
    );
    const recallReason =
      recordScore > 0
        ? bm25 > 0 || lexicalScore > 0
          ? "hybrid_match"
          : "vector_match"
        : "lexical_match";
    return { ...candidate, lexicalScore, vectorScore: recordScore, recallReason };
  });
}

function boundedGraphHops(hops = 0): number {
  if (!Number.isInteger(hops) || hops < 0 || hops > 3) throw new Error("Graph hops must be 0..3");
  return hops;
}

function searchLimit(limit = 20): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Search limit must be 1..100");
  return limit;
}

function rememberRequest(input: MemoryInput): MemoryInput {
  if (!input.tesserae) return input;
  return {
    ...input,
    tesserae: input.tesserae.map(({ fileSimhash: _fileSimhash, ...item }) => item),
  };
}

function inEventWindow(memory: MemoryRecord, options: MemoryQueryOptions): boolean {
  const { eventTimeFrom, eventTimeTo } = options;
  if (!eventTimeFrom && !eventTimeTo) return true;
  const time = memory.eventTime;
  return Boolean(
    time && (!eventTimeFrom || time >= eventTimeFrom) && (!eventTimeTo || time <= eventTimeTo),
  );
}

function mergeTemporalWindow(
  normal: readonly MemorySearchResult[],
  windowed: readonly MemorySearchResult[],
  limit: number,
): MemorySearchResult[] {
  if (!windowed.length) return [...normal];
  const maxNormal = normal.reduce((max, item) => Math.max(max, item.combinedScore), 0);
  const boosted = windowed.slice(0, Math.ceil(limit / 2)).map((item) => ({
    ...item,
    combinedScore: item.combinedScore + maxNormal + 1,
  }));
  const seen = new Set(boosted.map(({ memory }) => memory.id));
  return [...boosted, ...normal.filter(({ memory }) => !seen.has(memory.id))].slice(0, limit);
}

function isAdjacentTurn(result: MemorySearchResult): boolean {
  return result.neighborhood === "previous_turn" || result.neighborhood === "next_turn";
}

function capTailScores(
  floor: number | undefined,
  items: readonly MemorySearchResult[],
): MemorySearchResult[] {
  if (floor === undefined) return [...items];
  return items.map((item, index) => ({
    ...item,
    combinedScore: Math.min(item.combinedScore, Math.max(0, floor - (index + 1) * 1e-6)),
  }));
}

function isDueMemoryCandidate(
  entity: MemoryEntity,
  seen: ReadonlySet<string>,
  zone: string,
  today: string,
): entity is Extract<MemoryEntity, { kind: "memory" }> {
  if (entity.kind !== "memory" || seen.has(entity.value.id)) return false;
  const time = entity.value.eventTime;
  if (!time) return false;
  const anchor = new Date(time);
  if (!Number.isFinite(anchor.getTime()) || calendarDay(anchor, zone) >= today) return false;
  return futureDueDays(entity.value.statement, anchor, zone).includes(today);
}
