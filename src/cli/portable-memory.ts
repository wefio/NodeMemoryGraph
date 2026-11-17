import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryEngine } from "../core/memory/engine.ts";
import { MemoryLifecycleError } from "../core/memory/lifecycle.ts";
import type { MemoryBackend } from "../core/memory/backend.ts";
import { openMemoryBackend } from "../core/memory/open.ts";
import type { MemoryBackendOptions } from "../core/memory/open.ts";
import { activatedLocalMemory } from "../core/memory/sqlite-backend.ts";
import type {
  NmgGetParams,
  NmgExportMemoriesParams,
  NmgHelloResult,
  NmgMethod,
  NmgMethodResult,
  NmgRememberParams,
  NmgResolveRememberParams,
  NmgRecordClaimOutcomesParams,
  NmgSearchParams,
  NmgSetStorageStateParams,
} from "./protocol.ts";
import { NmgProtocolError } from "./protocol.ts";
import { mergeStgLtgContexts, stgConsolidationInput, stgStorePath } from "../core/stg.ts";
import type { ClaimPosterior, MemoryContext } from "../core/types.ts";
import type { StgConsolidationPolicyConfig } from "../integration/config.ts";
import { LocalMemoryEmbeddings } from "./local-memory-embeddings.ts";
import { openLocalMemory } from "./local-memory-migration.ts";
import type { EmbeddingClient } from "../core/embedding-provider.ts";

const METHODS = new Set<NmgMethod>(["remember", "rememberBatch", "search", "get", "deleteMemory"]);
const LOCAL_METHODS = new Set<NmgMethod>(["hello", "status", "taskBoard", "taskRun", "shutdown"]);
const SESSION_METHODS = new Set<NmgMethod>([
  "state",
  "sessionActiveGraph",
  "recordActiveGraphAttribution",
  "resolveRemember",
  "recordFeedback",
  "recordClaimOutcomes",
  "exportMemories",
  "setStorageState",
  "perfAggregates",
  "pruneRetrievalTraces",
  "lab",
]);
const SEARCH_FIELDS = [
  "query",
  "scope",
  "sessionId",
  "maxTier",
  "limit",
  "graphHops",
  "includeHistorical",
  "sourceActor",
  "nodeName",
];
const LOCAL_SEARCH_FIELDS = [
  ...SEARCH_FIELDS,
  "projectDir",
  "autoRecall",
  "tieredDisclosure",
  "autoRecallBudgetMs",
  "persistTrace",
  "activeGraphBudget",
  "queries",
  "retrievalMode",
  "vectorGranularity",
  "eventTimeFrom",
  "eventTimeTo",
  "progressiveWarmDisclosure",
  "secondPass",
  "initialEvidenceTarget",
  "strongHitTopGap",
  "strongHitInitialTarget",
  "recallCue",
  "recallRevision",
  "recallSource",
  "perf",
];

/** Application-level memory owner. Coordination continues through the local service. */
export class PortableMemoryService {
  private readonly options: MemoryBackendOptions;
  private pending: Promise<MemoryEngine> | undefined;
  private backend: MemoryBackend | undefined;
  private readonly projects = new Map<string, Promise<MemoryEngine>>();
  private readonly projectBackends = new Set<MemoryBackend>();
  private readonly embeddings: LocalMemoryEmbeddings;
  readonly local: boolean;

  constructor(
    options: MemoryBackendOptions,
    local = false,
    embedding: () => EmbeddingClient | undefined = () => undefined,
    embeddingUnavailable: () => boolean = () => false,
  ) {
    // Do not retain a caller-mutable credentials/options object.
    this.options = structuredClone(options);
    this.local = local;
    this.embeddings = new LocalMemoryEmbeddings(embedding, embeddingUnavailable);
  }

  static handles(method: NmgMethod): boolean {
    return METHODS.has(method);
  }

  requireLocalMethod(method: NmgMethod): void {
    if (!LOCAL_METHODS.has(method) && !(this.local && SESSION_METHODS.has(method)))
      throw new NmgProtocolError(
        "METHOD_NOT_FOUND",
        `${method} is not supported by portable memory`,
      );
  }

  hello(base: NmgHelloResult): NmgHelloResult {
    return {
      ...base,
      methods: [...METHODS, ...LOCAL_METHODS, ...(this.local ? SESSION_METHODS : [])],
      searchParameters: this.local ? LOCAL_SEARCH_FIELDS : SEARCH_FIELDS,
      capabilities: [
        "hello",
        "status",
        "remember",
        "event-time-reference",
        "batch-remember",
        "search",
        "get",
        "delete-memory",
        "task-board",
        "http",
        "json-rpc",
        "lexical-retrieval",
        "portable-memory",
        ...(this.local
          ? ([
              "session-active-graph",
              "optional-embedding-retrieval",
              "lab-capabilities",
              "resolve-remember",
              "claim-outcome-posterior",
              "claim-outcome-origin-provenance",
              "export-memories",
              "set-storage-state",
              "state-spaces",
              "diagnostic-answer-attribution",
              "versioned-answer-attribution",
              "board-events",
              "board-wake-batches",
              "board-agent-activity",
              "board-agent-presence",
              "directed-task-board-inbox",
              "controlled-reload",
            ] as const)
          : []),
      ],
    };
  }

  get storageStatus() {
    const path = this.options.kind === "sqlite" ? this.options.path : undefined;
    const file = path && existsSync(path) ? statSync(path) : undefined;
    return {
      databasePath: this.options.kind === "sqlite" ? this.options.path : this.options.uri,
      exists: file !== undefined || this.backend !== undefined,
      loaded: this.backend !== undefined,
      bytes: file?.size ?? 0,
    };
  }

  async remember(input: NmgRememberParams, operationId?: string) {
    if (this.local) {
      const engine = await this.writer(input);
      const result = await engine.remember(input, operationId);
      this.embeddings.afterWrite(engine.backend.vectorIndex);
      return result;
    }
    rejectOptions(input, ["projectDir"]);
    return (await this.engine()).remember(input, operationId);
  }

  async exportMemories(input: NmgExportMemoriesParams) {
    return (await this.engine()).exportMemories(input);
  }

  async setStorageState(input: NmgSetStorageStateParams) {
    const engine = await this.engine();
    const storageState = await engine.setStorageState(
      input.memoryId,
      input.storageState,
      input.recoveryDays,
    );
    return { memoryId: input.memoryId, storageState };
  }

  async recordUsage(ids: readonly string[], input: NmgGetParams): Promise<void> {
    if (!ids.length) return;
    const project = await this.project(input.projectDir);
    const localIds = new Set<string>();
    if (project) {
      for (const id of ids) if (await project.record(id, input.sessionId)) localIds.add(id);
      if (localIds.size) await project.recordUsage([...localIds], input.sessionId);
    }
    const sharedIds = ids.filter((id) => !localIds.has(id));
    if (sharedIds.length) await (await this.engine()).recordUsage(sharedIds, input.sessionId);
  }

  async rememberMany(inputs: readonly NmgRememberParams[], operationId?: string) {
    if (this.local) {
      const paths = new Set(inputs.map(projectForWrite));
      if (paths.size !== 1)
        throw new NmgProtocolError(
          "INVALID_PARAMS",
          "rememberBatch items must target one physical memory store",
        );
      const engine = await this.writer(inputs[0]!);
      const results = await engine.rememberMany(inputs, operationId);
      this.embeddings.afterWrite(engine.backend.vectorIndex);
      return { results };
    }
    inputs.forEach((input) => rejectOptions(input, ["projectDir"]));
    return { results: await (await this.engine()).rememberMany(inputs, operationId) };
  }

  async search(input: NmgSearchParams) {
    if (!this.local) {
      allowOptions(input, SEARCH_FIELDS);
      return (await this.engine()).search(input.query, input);
    }
    allowOptions(input, LOCAL_SEARCH_FIELDS);
    const shared = await this.engine();
    const project = await this.project(input.projectDir);
    const results = await Promise.all(
      [...new Set([input.query, ...(input.queries ?? [])])].map(async (query) => {
        const indexes = [shared.backend.vectorIndex, project?.backend.vectorIndex].flatMap(
          (index) => (index ? [index] : []),
        );
        const { semantic, reason } = await this.embeddings.query(query, input, indexes);
        const search = async (engine: MemoryEngine) => {
          const useVector =
            semantic && engine.backend.vectorIndex?.has(semantic.indexId, semantic.vector.length);
          const context = await engine.search(
            query,
            {
              ...input,
              limit: candidateLimit(input),
              findTesserae: !input.autoRecall,
            },
            useVector ? semantic : undefined,
          );
          if (reason) context.retrieval = { mode: "lexical", degraded: true, reason };
          return context;
        };
        const main = await search(shared);
        return project ? mergeLocalContexts(await search(project), main) : main;
      }),
    );
    const primary = results[0]!;
    return {
      ...primary,
      results: [
        ...new Map(
          results.flatMap((context) =>
            context.results.map((item) => [item.memory.id, item] as const),
          ),
        ).values(),
      ].slice(0, candidateLimit(input)),
    };
  }

  async get(input: NmgGetParams) {
    allowOptions(input, [
      "memoryIds",
      "sessionId",
      ...(this.local ? ["projectDir", "graphHops", "activeGraphId"] : []),
    ]);
    const main = await (await this.engine()).get(input.memoryIds, input);
    const project = await this.project(input.projectDir);
    return project ? mergeLocalContexts(await project.get(input.memoryIds, input), main) : main;
  }

  async withdraw(memoryId: string, operationId: string = randomUUID(), sessionId?: string) {
    const result = await (await this.engine()).withdraw(memoryId, operationId, sessionId);
    return { deleted: true, memory: result.memory };
  }

  async resolveRemember(
    input: NmgResolveRememberParams,
  ): Promise<NmgMethodResult["resolveRemember"]> {
    const id = "newMemoryId" in input ? input.newMemoryId : input.memoryId;
    const engine = await this.storeForRecord(id, input);
    try {
      return await this.applyResolution(engine, input);
    } catch (error) {
      if (error instanceof MemoryLifecycleError)
        throw new NmgProtocolError("INVALID_PARAMS", error.message);
      throw error;
    }
  }

  async recordClaimOutcomes(
    input: NmgRecordClaimOutcomesParams,
    policy: StgConsolidationPolicyConfig,
  ): Promise<NmgMethodResult["recordClaimOutcomes"]> {
    const stores = new Map<MemoryEngine, typeof input.votes>();
    for (const vote of input.votes) {
      const store = await this.storeForRecord(vote.memoryId, input);
      const votes = stores.get(store) ?? [];
      votes.push(vote);
      stores.set(store, votes);
    }
    const result: NmgMethodResult["recordClaimOutcomes"] = {
      events: [],
      posteriors: [],
      consolidationCandidates: [],
      consolidatedMemories: [],
      retractedMemories: [],
    };
    try {
      for (const [store, votes] of stores) {
        const recorded = await store.recordClaimOutcomes({ ...input, votes });
        result.events.push(...recorded.events);
        result.posteriors.push(...recorded.posteriors);
        const shared = await this.engine();
        if (store !== shared)
          await this.applyConsolidation(
            shared,
            store,
            recorded.posteriors,
            input.sessionId,
            policy,
            result,
          );
      }
    } catch (error) {
      if (error instanceof MemoryLifecycleError)
        throw new NmgProtocolError("INVALID_PARAMS", error.message);
      throw error;
    }
    return result;
  }

  private async applyConsolidation(
    shared: MemoryEngine,
    store: MemoryEngine,
    posteriors: ClaimPosterior[],
    sessionId: string | undefined,
    policy: StgConsolidationPolicyConfig,
    result: NmgMethodResult["recordClaimOutcomes"],
  ) {
    const groups = new Map<string, ClaimPosterior[]>();
    for (const claim of posteriors) {
      const group = groups.get(claim.memoryId) ?? [];
      group.push(claim);
      groups.set(claim.memoryId, group);
    }
    for (const [memoryId, claims] of groups) {
      const eligible = claims.every(
        (claim) =>
          claim.independentVoteCount >= policy.minimumIndependentVotes &&
          claim.mean >= policy.minimumPosteriorMean &&
          claim.conservativeLowerBound >= policy.minimumConservativeLowerBound,
      );
      if (eligible) {
        result.consolidationCandidates.push(memoryId);
        if (policy.enabled)
          await this.promoteConsolidation(shared, store, memoryId, sessionId, result);
      } else if (
        policy.enabled &&
        claims.some(
          (claim) =>
            claim.mean < policy.minimumRetainedPosteriorMean ||
            claim.conservativeLowerBound < policy.minimumRetainedConservativeLowerBound,
        )
      ) {
        for (const memory of await shared.consolidatedFrom(memoryId)) {
          await shared.withdraw(memory.id);
          result.retractedMemories.push({ sourceMemoryId: memoryId, memoryId: memory.id });
        }
      }
    }
  }

  private async promoteConsolidation(
    shared: MemoryEngine,
    store: MemoryEngine,
    memoryId: string,
    sessionId: string | undefined,
    result: NmgMethodResult["recordClaimOutcomes"],
  ) {
    const context = await store.get([memoryId], { sessionId });
    const source = context.results[0];
    if (!source || source.memory.markers.some((marker) => marker.kind === "cached_from_ltg"))
      return;
    const promoted = await shared.remember(stgConsolidationInput(source));
    this.embeddings.afterWrite(shared.backend.vectorIndex);
    if (
      promoted.memory.markers.some(
        (marker) =>
          marker.kind === "consolidated_from_stg" && marker.attributes?.sourceMemoryId === memoryId,
      )
    )
      result.consolidatedMemories.push({ sourceMemoryId: memoryId, memoryId: promoted.memory.id });
  }

  private async applyResolution(
    engine: MemoryEngine,
    input: NmgResolveRememberParams,
  ): Promise<NmgMethodResult["resolveRemember"]> {
    const { action, sessionId } = input;
    switch (action) {
      case "forget": {
        await engine.withdraw(input.memoryId, undefined, sessionId);
        return { action, memoryId: input.memoryId, deleted: true };
      }
      case "resolve":
      case "reopen":
        return {
          action,
          ...(await engine.setResolution({
            ...input,
            resolution: action === "resolve" ? "resolved" : "reopened",
          })),
        };
      case "supersede": {
        const { newMemoryId, supersededMemoryId, reason } = input;
        const applied = await engine.supersede({
          newMemoryId,
          memoryId: supersededMemoryId,
          reason,
          sessionId,
        });
        return { action, newMemoryId, supersededMemoryId, applied };
      }
      case "relate": {
        const { newMemoryId, relatedMemoryId, relationJudgement, confidence } = input;
        const proposal = await engine.proposeRelation({
          newMemoryId,
          memoryId: relatedMemoryId,
          relationJudgement,
          confidence,
          sessionId,
        });
        return { action, newMemoryId, relatedMemoryId, proposal };
      }
    }
  }

  private async storeForRecord(
    id: string,
    input: { projectDir?: string; sessionId?: string },
  ): Promise<MemoryEngine> {
    const project = await this.project(input.projectDir);
    if (project && (await project.record(id, input.sessionId))) return project;
    const shared = await this.engine();
    if (await shared.record(id, input.sessionId)) return shared;
    throw new NmgProtocolError("INVALID_PARAMS", "Memory does not exist in this store and session");
  }

  close(): Promise<void> {
    const finalEmbeddings = this.embeddings.close();
    const opening = Array.from(this.projects.values());
    if (this.pending && !this.backend) opening.push(this.pending);
    if (finalEmbeddings || opening.length !== this.projectBackends.size)
      return Promise.allSettled([finalEmbeddings, ...opening]).then(() => this.closeBackends());
    return this.closeBackends();
  }

  private closeBackends(): Promise<void> {
    const backends = [...this.projectBackends];
    if (this.backend) backends.push(this.backend);
    this.backend = undefined;
    this.pending = undefined;
    this.projects.clear();
    this.projectBackends.clear();
    return Promise.all(backends.map((backend) => backend.close())).then(() => undefined);
  }

  async prepare(): Promise<void> {
    if (this.local) await this.engine();
  }

  embeddingHealth(indexId: string) {
    const stats = this.backend?.vectorIndex?.stats(indexId);
    return stats
      ? {
          indexId,
          targets: ["records"],
          indexed: { records: stats.indexed },
          pending: { records: stats.pending },
          status: stats.pending ? "running" : "ready",
        }
      : null;
  }

  private engine(): Promise<MemoryEngine> {
    return (this.pending ??= this.open(this.options)
      .then((backend) => {
        this.backend = backend;
        return new MemoryEngine(backend);
      })
      .catch((error: unknown) => {
        this.pending = undefined;
        throw error;
      }));
  }

  private async open(options: MemoryBackendOptions): Promise<MemoryBackend> {
    if (!this.local || options.kind !== "sqlite") return openMemoryBackend(options);
    return (await openLocalMemory(options.path, options.namespace)).backend;
  }

  private async writer(input: NmgRememberParams): Promise<MemoryEngine> {
    return (await this.project(projectForWrite(input), true)) ?? this.engine();
  }

  private project(
    projectDir: string | undefined,
    create = false,
  ): Promise<MemoryEngine> | undefined {
    if (!this.local || !projectDir || this.options.kind !== "sqlite") return undefined;
    const path = stgStorePath(resolve(projectDir));
    if (path === this.options.path) return undefined;
    const found = this.projects.get(path);
    if (found) return found;
    if (!create && !existsSync(path)) return undefined;
    const namespace = activatedLocalMemory(path) ?? this.options.namespace;
    const opened = this.open({ ...this.options, path, namespace })
      .then((backend) => {
        this.projectBackends.add(backend);
        return new MemoryEngine(backend);
      })
      .catch((error: unknown) => {
        this.projects.delete(path);
        throw error;
      });
    this.projects.set(path, opened);
    return opened;
  }
}

function projectForWrite(input: NmgRememberParams): string | undefined {
  return input.residence === "stg" && input.projectDir ? resolve(input.projectDir) : undefined;
}

function candidateLimit(input: NmgSearchParams): number {
  return input.sessionId && (input.secondPass || input.progressiveWarmDisclosure)
    ? 50
    : (input.limit ?? 20);
}

function mergeLocalContexts(project: MemoryContext, main: MemoryContext): MemoryContext {
  return {
    ...mergeStgLtgContexts(project, main),
    tesserae: [
      ...new Map(
        [...(project.tesserae ?? []), ...(main.tesserae ?? [])].map((item) => [item.id, item]),
      ).values(),
    ],
  };
}

function rejectOptions(input: object, keys: string[]): void {
  const values = input as Record<string, unknown>;
  for (const key of keys)
    if (values[key] !== undefined)
      throw new NmgProtocolError("INVALID_PARAMS", `Portable memory does not support ${key}`, key);
}

function allowOptions(input: object, keys: string[]): void {
  rejectOptions(
    input,
    Object.keys(input).filter((key) => !keys.includes(key)),
  );
}
