import { randomUUID } from "node:crypto";
import type { ComputeGraphSpec, ComputeMemoCache, ComputeRegistry } from "../compute-graph.ts";
import type { ExactLookupAnchor } from "../store/search-ranking.ts";
import { MemoryWriteRejected } from "../write-policy.ts";
import type {
  LinkMemoriesInput,
  MemoryActor,
  MemoryContext,
  MemoryExportBundle,
  MemoryNode,
  MemoryRecord,
  MemoryRelationRecord,
  MemoryStorageState,
  MemoryWriteEvent,
  NodeRelation,
  RememberResult,
  RecordClaimOutcomesInput,
} from "../types.ts";
import type {
  MemoryBackend,
  MemoryCommitReceipt,
  MemoryReadView,
  MemoryVectorQuery,
} from "./backend.ts";
import { MemoryOperationConflict } from "./backend.ts";
import type { GraphProjectionOptions, MemoryGraphProjection } from "./graph-projection.ts";
import {
  boundedGraphHops,
  createSnapshotPort,
  readHistoriesBatch,
  resolveCandidateNode,
  searchLimit,
  type MemoryQueryOptions,
  type MemorySnapshotPort,
} from "./hydration.ts";
import { recordClaimOutcomes } from "./claim-outcomes.ts";
import {
  changeResolution,
  proposeMemoryRelation,
  type MemoryRelationProposal,
  type MemoryResolutionChange,
  type MemorySupersession,
} from "./lifecycle.ts";
import { memoryIdentity, requestHash, validateMemoryInput, visibleMemory } from "./model.ts";
import type { MemoryInput } from "./model.ts";
import { MemoryPlan } from "./plan.ts";
import {
  DEFAULT_ENGINE_SEARCH_GRAPH,
  ENGINE_SEARCH_REGISTRY,
  executeEngineSearchGraph,
} from "./search-compute-graph.ts";
import {
  DEFAULT_GET_CONTEXT_GRAPH,
  DEFAULT_NEIGHBORHOOD_GRAPH,
  DEFAULT_PROJECT_GRAPH,
  DEFAULT_USER_PROFILE_GRAPH,
  ENGINE_VIEW_REGISTRY,
  executeGetContextGraph,
  executeNeighborhoodGraph,
  executeProjectGraph,
  executeUserProfileGraph,
} from "./view-compute-graphs.ts";
import {
  DEFAULT_LIFECYCLE_PLAN_GRAPH,
  DEFAULT_REMEMBER_PLAN_GRAPH,
  ENGINE_WRITE_REGISTRY,
  executeLifecyclePlanGraph,
  executeRememberPlanGraph,
  type LifecyclePlanPayload,
} from "./write-compute-graphs.ts";

export { MAX_LEAF_CONTEXT_RESULTS, type MemoryQueryOptions } from "./hydration.ts";

export interface MemoryEngineGraphOptions {
  readonly searchGraph?: ComputeGraphSpec;
  readonly searchRegistry?: ComputeRegistry<MemorySnapshotPort>;
  readonly searchMemo?: ComputeMemoCache;
  readonly rerankGraph?: ComputeGraphSpec | false;
  readonly configIdentity?: string;
  readonly configResolver?: () => {
    readonly searchGraph?: ComputeGraphSpec;
    readonly rerankGraph?: ComputeGraphSpec | false;
    readonly configIdentity?: string;
  };
  readonly getGraph?: ComputeGraphSpec;
  readonly neighborhoodGraph?: ComputeGraphSpec;
  readonly projectGraph?: ComputeGraphSpec;
  readonly userProfileGraph?: ComputeGraphSpec;
  readonly viewRegistry?: ComputeRegistry<MemorySnapshotPort>;
  readonly rememberPlanGraph?: ComputeGraphSpec;
  readonly lifecyclePlanGraph?: ComputeGraphSpec;
  readonly writeRegistry?: ComputeRegistry<MemoryPlan>;
}

interface PlannedResult<T> {
  result: T;
  ids: string[];
}

/** Memory business orchestrator delegating recall, view, projection, and write-plan compute to ComputeGraphs. */
export class MemoryEngine {
  readonly backend: MemoryBackend;
  private readonly now: () => string;
  private readonly graphs: MemoryEngineGraphOptions;

  constructor(
    backend: MemoryBackend,
    now = () => new Date().toISOString(),
    graphs: MemoryEngineGraphOptions = {},
  ) {
    this.backend = backend;
    this.now = now;
    this.graphs = graphs;
  }

  async remember(input: MemoryInput, operationId: string = randomUUID()): Promise<RememberResult> {
    return (await this.rememberMany([input], operationId))[0]!;
  }

  async rememberMany(
    inputs: readonly MemoryInput[],
    operationId: string = randomUUID(),
  ): Promise<RememberResult[]> {
    if (!inputs.length || inputs.length > 128) {
      throw new Error("A memory batch needs 1..128 inputs");
    }
    const timestamp = this.now();
    await this.validateWrites(inputs, operationId, timestamp);
    return this.mutate(
      operationId,
      { action: "remember", inputs: inputs.map(rememberRequest) },
      (plan) =>
        executeRememberPlanGraph(
          { inputs, operationId, timestamp },
          plan,
          this.graphs.rememberPlanGraph ?? DEFAULT_REMEMBER_PLAN_GRAPH,
          this.graphs.writeRegistry ?? ENGINE_WRITE_REGISTRY,
        ),
      async (view, receipt) => {
        const result = receipt.result as RememberResult[];
        await this.requireAvailable(view, result);
        return result;
      },
    );
  }

  async get(ids: readonly string[], options: MemoryQueryOptions = {}): Promise<MemoryContext> {
    boundedGraphHops(options.graphHops);
    return this.withSnapshot((port) =>
      executeGetContextGraph(
        { ids, options },
        port,
        this.graphs.getGraph ?? DEFAULT_GET_CONTEXT_GRAPH,
        this.graphs.viewRegistry ?? ENGINE_VIEW_REGISTRY,
      ),
    );
  }

  /** Browse readable neighbors of a known record on a single backend snapshot. */
  async searchNeighborhood(
    id: string,
    options: MemoryQueryOptions,
  ): Promise<MemoryContext | undefined> {
    return this.withSnapshot((port) =>
      executeNeighborhoodGraph(
        { id, options },
        port,
        this.graphs.neighborhoodGraph ?? DEFAULT_NEIGHBORHOOD_GRAPH,
        this.graphs.viewRegistry ?? ENGINE_VIEW_REGISTRY,
      ),
    );
  }

  search(
    text: string,
    options: MemoryQueryOptions = {},
    semantic?: MemoryVectorQuery,
  ): Promise<MemoryContext> {
    return this.searchContext(text, options, semantic);
  }

  searchExactAnchor(
    anchor: ExactLookupAnchor,
    options: MemoryQueryOptions,
  ): Promise<MemoryContext> {
    return this.searchContext(anchor.text, options, undefined, anchor.pattern);
  }

  /** Build an on-demand multi-dimensional pivot graph across stored memories. */
  async projectGraph(options: GraphProjectionOptions = {}): Promise<MemoryGraphProjection> {
    return this.withSnapshot((port) =>
      executeProjectGraph(
        { options },
        port,
        this.graphs.projectGraph ?? DEFAULT_PROJECT_GRAPH,
        this.graphs.viewRegistry ?? ENGINE_VIEW_REGISTRY,
      ),
    );
  }

  async userProfile(text: string, options: MemoryQueryOptions = {}): Promise<MemoryContext> {
    searchLimit(options.limit);
    return this.withSnapshot((port) =>
      executeUserProfileGraph(
        { text, options },
        port,
        this.graphs.userProfileGraph ?? DEFAULT_USER_PROFILE_GRAPH,
        this.graphs.viewRegistry ?? ENGINE_VIEW_REGISTRY,
      ),
    );
  }

  /** Read profile/constraint records over a single engine snapshot port (pushdown or scan fallback). */
  async readProfileCandidates(options: {
    readonly sourceActor?: MemoryActor;
    readonly memoryTypes: readonly MemoryRecord["memoryType"][];
    readonly limit?: number;
    readonly now?: string;
  }): Promise<MemoryRecord[]> {
    return this.withSnapshot(async (port) => {
      const effectiveNow = options.now ?? port.now;
      if (port.projectMemories) {
        const limit = options.limit ?? 200;
        const pages = options.memoryTypes.map((memoryType) =>
          port.projectMemories!({
            sourceActor: options.sourceActor,
            memoryType,
            now: effectiveNow,
            limit,
            offset: 0,
          }),
        );
        return pages.flatMap((page) => page.memories);
      }
      const entities = await port.scan({ kind: "memory", limit: 1000 });
      const types = new Set(options.memoryTypes);
      return entities.flatMap((entity) =>
        entity.kind === "memory" &&
        types.has(entity.value.memoryType) &&
        (!options.sourceActor || entity.value.sourceActor === options.sourceActor)
          ? [entity.value]
          : [],
      );
    });
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
      (plan) => this.runLifecyclePlan(plan, { action: "tesseraFingerprint", input }),
      async () => null,
    );
  }

  async exportMemories(
    options: { sourceActor?: MemoryActor; includeDeleted?: boolean } = {},
  ): Promise<MemoryExportBundle> {
    return this.withSnapshot(async (port, view) => {
      const plan = new MemoryPlan(this.backend, view);
      const rows = await plan.find({ kind: "memory" });
      const selected = rows
        .flatMap((row) => (row.kind === "memory" ? [row.value] : []))
        .filter(
          (memory) =>
            (options.includeDeleted || memory.status !== "deleted") &&
            (!options.sourceActor || memory.sourceActor === options.sourceActor),
        );
      const evidenceIds = [...new Set(selected.flatMap(({ evidenceIds }) => evidenceIds))];
      const evidence = new Map(
        (await readHistoriesBatch(port, evidenceIds)).map((record) => [record.id, record]),
      );
      const nodes = new Map(
        (await plan.find({ kind: "node" })).flatMap((row) =>
          row.kind === "node" ? [[row.value.id, row.value] as const] : [],
        ),
      );
      const items = selected
        .map((memory) => ({
          memory,
          node: resolveCandidateNode(memory, nodes),
          evidence: memory.evidenceIds.map((id) => evidence.get(id)!),
        }))
        .sort(
          (a, b) =>
            a.memory.createdAt.localeCompare(b.memory.createdAt) ||
            a.memory.id.localeCompare(b.memory.id),
        );
      return { format: "nmg.memory-export.v1", exportedAt: this.now(), items };
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
    if (input.sourceNodeId === input.targetNodeId) {
      throw new Error("Self relations are not supported");
    }
    const now = this.now();
    return this.mutate(
      operationId,
      { action: "link", input },
      (plan) =>
        this.runLifecyclePlan<NodeRelation>(plan, {
          action: "linkNodes",
          namespace: this.backend.namespace,
          input,
          now,
        }),
      async (_view, receipt) => receipt.result as NodeRelation,
    );
  }

  /** Link two memories directly without requiring any pre-created MemoryNode. */
  async linkMemories(
    input: LinkMemoriesInput,
    operationId: string = randomUUID(),
  ): Promise<MemoryRelationRecord> {
    if (input.sourceMemoryId === input.targetMemoryId) {
      throw new Error("Self relations are not supported");
    }
    const now = this.now();
    return this.mutate(
      operationId,
      { action: "linkMemories", input },
      (plan) =>
        this.runLifecyclePlan<MemoryRelationRecord>(plan, {
          action: "linkMemories",
          namespace: this.backend.namespace,
          input,
          now,
        }),
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
      (plan) => this.runLifecyclePlan(plan, { action: "withdraw", memoryId, sessionId }),
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

  setResolution(input: MemoryResolutionChange): ReturnType<typeof changeResolution> {
    return this.lifecycle<Awaited<ReturnType<typeof changeResolution>>, MemoryResolutionChange>(
      "resolution",
      input,
      {
        action: "resolution",
        input,
        now: this.now(),
      },
    );
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
    const now = this.now();
    return this.mutate(
      operationId,
      { action: "attachNode", memoryId, input },
      (plan) =>
        this.runLifecyclePlan<{ memory: MemoryRecord; node: MemoryNode }>(plan, {
          action: "attachNode",
          memoryId,
          input,
          now,
        }),
      async (_view, receipt) => receipt.result as { memory: MemoryRecord; node: MemoryNode },
    );
  }

  recordClaimOutcomes(input: RecordClaimOutcomesInput): ReturnType<typeof recordClaimOutcomes> {
    const now = this.now();
    return this.mutate(
      randomUUID(),
      { action: "claimOutcomes", input },
      (plan) =>
        this.runLifecyclePlan<Awaited<ReturnType<typeof recordClaimOutcomes>>>(plan, {
          action: "claimOutcomes",
          input,
          now,
        }),
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
    return this.lifecycle<boolean, MemorySupersession>("supersession", input, {
      action: "supersession",
      input,
      now: this.now(),
    });
  }

  setStorageState(memoryId: string, target: MemoryStorageState, recoveryDays = 30) {
    return this.lifecycle<
      MemoryStorageState,
      { memoryId: string; target: MemoryStorageState; recoveryDays: number }
    >(
      "storageState",
      { memoryId, target, recoveryDays },
      { action: "storageState", memoryId, target, recoveryDays, now: this.now() },
    );
  }

  recordUsage(ids: readonly string[], sessionId?: string): Promise<void> {
    const now = this.now();
    return this.mutate(
      randomUUID(),
      { action: "usage", ids, sessionId },
      (plan) => this.runLifecyclePlan(plan, { action: "usage", ids, sessionId, now }),
      async () => null,
    ).then(() => undefined);
  }

  proposeRelation(input: MemoryRelationProposal): ReturnType<typeof proposeMemoryRelation> {
    return this.lifecycle<
      Awaited<ReturnType<typeof proposeMemoryRelation>>,
      MemoryRelationProposal
    >("relationProposal", input, {
      action: "relationProposal",
      input,
      now: this.now(),
    });
  }

  private searchContext(
    text: string,
    options: MemoryQueryOptions,
    semantic?: MemoryVectorQuery,
    exact?: RegExp,
  ): Promise<MemoryContext> {
    if (!text.trim()) throw new Error("Search query is required");
    searchLimit(options.limit);
    boundedGraphHops(options.graphHops);
    const resolved = this.graphs.configResolver?.();
    const searchGraph =
      options.searchGraph ??
      this.graphs.searchGraph ??
      resolved?.searchGraph ??
      DEFAULT_ENGINE_SEARCH_GRAPH;
    const registry = this.graphs.searchRegistry ?? ENGINE_SEARCH_REGISTRY;
    const resolvedRerank = this.graphs.rerankGraph ?? resolved?.rerankGraph;
    const effectiveOptions =
      options.rerankGraph === undefined && resolvedRerank !== undefined
        ? { ...options, rerankGraph: resolvedRerank }
        : options;
    const configIdentity = this.graphs.configIdentity ?? resolved?.configIdentity;
    const planOptions = configIdentity ? { configIdentity } : undefined;
    return this.withSnapshot((port) =>
      executeEngineSearchGraph(
        { text, options: effectiveOptions, callerNow: port.now, semantic, exact },
        port,
        searchGraph,
        registry,
        this.graphs.searchMemo,
        planOptions,
      ),
    );
  }

  private async withSnapshot<T>(
    run: (port: MemorySnapshotPort, view: MemoryReadView) => Promise<T>,
  ): Promise<T> {
    const view = await this.backend.openRead();
    try {
      const port = createSnapshotPort(this.backend, view, this.now());
      return await run(port, view);
    } finally {
      await this.backend.closeRead(view);
    }
  }

  private runLifecyclePlan<T>(
    plan: MemoryPlan,
    payload: LifecyclePlanPayload,
  ): Promise<PlannedResult<T>> {
    return executeLifecyclePlanGraph<T>(
      payload,
      plan,
      this.graphs.lifecyclePlanGraph ?? DEFAULT_LIFECYCLE_PLAN_GRAPH,
      this.graphs.writeRegistry ?? ENGINE_WRITE_REGISTRY,
    );
  }

  private lifecycle<T, Input extends { memoryId: string }>(
    action: string,
    input: Input,
    payload: LifecyclePlanPayload,
  ): Promise<T> {
    return this.mutate(
      randomUUID(),
      { action, input },
      (plan) => this.runLifecyclePlan<T>(plan, payload),
      async (_view, receipt) => receipt.result as T,
    );
  }

  private async validateWrites(inputs: readonly MemoryInput[], operationId: string, now: string) {
    for (const [slot, input] of inputs.entries()) {
      try {
        validateMemoryInput(input);
      } catch (error) {
        if (error instanceof MemoryWriteRejected) {
          await this.recordRejection(input, operationId, slot, error.reason, now);
        }
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
      (plan) =>
        this.runLifecyclePlan<null>(plan, {
          action: "rejectionAudit",
          event: { ...metadata, createdAt: now },
        }),
      async () => null,
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
      if (found[0]?.kind !== "memory" || !visibleMemory(found[0].value, sessionId, this.now())) {
        throw new Error("The recorded operation result is unavailable");
      }
    }
  }
}

function rememberRequest(input: MemoryInput): MemoryInput {
  if (!input.tesserae) return input;
  return {
    ...input,
    tesserae: input.tesserae.map(({ fileSimhash: _fileSimhash, ...item }) => item),
  };
}
