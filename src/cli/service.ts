import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { deriveAnswerOverlapMemoryIds, statementFingerprint } from "../core/feedback.ts";
import type { PerfSnapshot } from "../core/perf.ts";

import { MAX_BOARD_DELIVERY_ENTRIES, parseBoardNotification } from "../core/board-notifications.ts";
import {
  configuredProvider,
  createEmbeddingClientFromEnv,
  type EmbeddingClient,
} from "../core/embedding-provider.ts";
import { eventWindowEnd, eventWindowStart, resolveWriteEventTime } from "../core/event-time.ts";
import type { MemoryBackendOptions } from "../core/memory/open.ts";
import { LOCAL_MEMORY_NAMESPACE, activatedLocalMemory } from "../core/memory/sqlite-backend.ts";
import { normalizeRecallTriggers } from "../core/recall-triggers.ts";
import {
  SessionActiveGraphRuntime,
  type ActiveGraphProjectionPart,
  type WorkingStateBinding,
} from "../core/session-active-graph.ts";
import { SessionRecallTrial, type SessionRecallPreparation } from "../core/session-recall.ts";
import { hammingDistance, simhash64, simhashFromHex, simhashToHex } from "../core/simhash.ts";
import { SqliteLocalDaemonState } from "../core/store/local-daemon-state.ts";
import type { RelevanceModelLike, TesseraHit, TesseraInput } from "../core/types.ts";
import {
  CLAIM_OUTCOMES,
  CLAIM_OUTCOME_SOURCES,
  EVIDENCE_ROLES,
  MEMORY_ACTORS,
  MEMORY_RESIDENCES,
  MEMORY_RESOLUTIONS,
  MEMORY_TYPES,
  MEMORY_WRITE_SOURCES,
  RETRIEVAL_MODES,
  TASK_BOARD_KINDS,
  TASK_BOARD_VERDICTS,
  TRUTH_STATUSES,
  VECTOR_GRANULARITIES,
  type ActiveGraph,
  type ActiveGraphBudget,
  type MemoryContext,
  type MemoryMarker,
  type MemoryScope,
  type MemoryTier,
} from "../core/types.ts";
import { MemoryWriteRejected } from "../core/write-policy.ts";
import {
  prepareSessionActiveGraphSurface,
  prepareTaskBoardSurface,
} from "../integration/agent-surface.ts";
import { configuredGraphHops, configuredStgConsolidationPolicy } from "../integration/config.ts";
import { ControllerPolicyChannel } from "../integration/controller-channel.ts";
import type { CoordinationPort, TaskBoardPort } from "../integration/coordination-port.ts";
import {
  COORDINATION_OPERATIONS,
  coordinationSummary,
  executeCoordinationState,
  prepareCoordinationSurface,
} from "../integration/coordination-state.ts";
import {
  LAB_CAPABILITIES,
  LabActivationAuthority,
  type LabCapability,
} from "../integration/lab-capabilities.ts";
import {
  MemoryReferenceError,
  captureMemoryReferenceTargets,
  createMemoryReferences,
  isMemoryReference,
  resolveMemoryReferences,
  type MemoryReferenceTarget,
} from "../integration/memory-reference.ts";
import { portableRecallGraph } from "../integration/portable-recall.ts";
import { ReasoningWorkspaces } from "../integration/reasoning-workspaces.ts";
import { RecallContextPolicy } from "../integration/recall-context-policy.ts";
import { STATE_AG_FIELDS, stateOperation } from "../integration/state.ts";
import {
  bindRunEntry,
  cancelRun,
  coordinatedEntryWrite,
  createBoundEntry,
  freezeRunPlan,
  registerRun,
  taskRunStatus,
  type RunPlanTaskInput,
} from "../integration/task-coordinator.ts";
import {
  ContextRouterOnlineLearner,
  contextFeaturesFromMemory,
  contextOnlineLearningEnabled,
  onlineRouterStatePath,
} from "../lab/context-router-online.ts";
import {
  MemoryGraphReasoner,
  type LogicExpr,
  type MemoryNode as ReasonerMemoryNode,
} from "../lab/memory-graph-reasoner.ts";
import {
  appendRecallLabel,
  instancesSurfacing,
  readRecallInstances,
  readRecallLabels,
  recallInstancesEnabled,
  recallInstancesPath,
  recallLabelsPath,
} from "../lab/recall-instance.ts";
import { readRelevanceModel } from "../lab/relevance-model.ts";
import { resolveNmgDataDir } from "./data-path.ts";
import { PortableMemoryService } from "./portable-memory.ts";
import {
  MEMORY_RELATION_JUDGEMENTS,
  NMG_CAPABILITIES,
  NMG_METHODS,
  NMG_PROTOCOL_VERSION,
  NMG_RPC_CATALOG_FINGERPRINT,
  NmgProtocolError,
  type NmgDeleteMemoryParams,
  type NmgGetParams,
  type NmgHelloResult,
  type NmgLabParams,
  type NmgMethod,
  type NmgMethodResult,
  type NmgRecordActiveGraphAttributionParams,
  type NmgRecordClaimOutcomesParams,
  type NmgRecordFeedbackParams,
  type NmgRememberBatchParams,
  type NmgRememberParams,
  type NmgResolveRememberParams,
  type NmgSearchParams,
  type NmgSessionActiveGraphParams,
  type NmgStatusResult,
  type NmgTaskBoardParams,
  type NmgTaskRunParams,
} from "./protocol.ts";
import { RpcRejections } from "./rpc-rejections.ts";

const SERVICE_VERSION = "0.1.0";
type ActiveGraphStorePart = {
  store: SqliteLocalDaemonState;
  traceId: string;
  memoryIds: Set<string>;
  referenceTargets?: readonly MemoryReferenceTarget[];
};
export interface NmgServiceOptions {
  /** Select a backend directly. Local SQLite follows the activated namespace when omitted. */
  memoryBackend?:
    | { kind: "sqlite"; namespace: string; path?: string; local?: true }
    | Extract<MemoryBackendOptions, { kind: "lancedb" }>;
  dataDirectory?: string;
  databasePath?: string;
  environment?: NodeJS.ProcessEnv;
}

export class NmgService {
  readonly #portableMemory: PortableMemoryService;
  readonly #rpcRejections: RpcRejections;
  /**
   * Concurrency contract:
   * - one resident service is the application-level writer for its LTG and
   *   opened project STGs;
   * - DatabaseSync phases are short and event-loop serialized;
   * - external embedding/summary awaits never hold a SQLite transaction;
   * - summary drains use stale-write protection or bounded-staleness
   *   hysteresis before their later synchronous write-back.
   *
   * Do not wrap invoke() in one global async mutex: that would let a slow model
   * call block unrelated reads and writes without adding database correctness.
   */
  readonly databasePath: string;
  readonly #dataDirectory: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #labAuthority = new LabActivationAuthority();
  readonly #sessionRecall = new SessionRecallTrial();
  readonly #recallContext = new RecallContextPolicy();
  readonly #reasoningWorkspaces: ReasoningWorkspaces;
  #labShadowController: ControllerPolicyChannel | undefined;
  /** Daemon-owned online learner for the context-use feedback loop (shared
   *  layer). Lazily constructed on first stage/feedback; null while the online
   *  learning gate is off. State persists at <dataDir>/context-router-online.json. */
  #onlineLearner: ContextRouterOnlineLearner | null | undefined;
  #store: SqliteLocalDaemonState | undefined;

  readonly #sessionActiveGraphs = new SessionActiveGraphRuntime<ActiveGraphStorePart>();
  readonly #getReferenceUsage = { fullIds: 0, compoundRefs: 0 };
  #embeddingClient: EmbeddingClient | undefined | null;
  #embeddingError: string | null = null;

  #shutdownRequested = false;
  /** Set by close(). New work is refused after this, so a shutdown cannot race a fresh request. */
  #closing = false;
  /** Calls accepted and not yet answered; see drain(). */
  #inFlight = 0;
  /** Lazily loaded learned relevance gate; undefined until first read, null when
   *  no model is configured or it fails to load. */
  #relevanceModel: RelevanceModelLike | null | undefined;
  /** Human-readable reason the learned gate is or is not active. */
  #relevanceModelNote = "unread";

  constructor(options: NmgServiceOptions = {}) {
    const environment = options.environment ?? process.env;
    const databasePath = options.databasePath ? resolve(options.databasePath) : undefined;
    // Diagnostic artifacts (recall corpus, router state, controller shadow) live
    // beside the database. When only `--db` is given, the data directory follows
    // it instead of silently falling back to the shared default — otherwise a
    // test daemon with a temp DB still writes its corpus into the developer's
    // ~/.nmg. An explicit data-dir still wins.
    const dataDirectory = options.dataDirectory
      ? resolve(options.dataDirectory)
      : databasePath
        ? dirname(databasePath)
        : resolveNmgDataDir(environment);
    this.databasePath = databasePath ?? join(dataDirectory, "nmg.sqlite");
    this.#rpcRejections = new RpcRejections(this.databasePath + ".rpc-rejections.sqlite");
    const memoryBackend = options.memoryBackend ?? localMemorySelection(this.databasePath);
    this.#portableMemory = new PortableMemoryService(
      memoryBackend.kind === "sqlite"
        ? {
            ...memoryBackend,
            path: memoryBackend.path ? resolve(memoryBackend.path) : this.databasePath,
          }
        : memoryBackend,
      memoryBackend.kind === "sqlite" && memoryBackend.local === true,
      () => this.#configuredEmbeddingClient(),
      () => this.#embeddingError !== null,
    );
    this.#dataDirectory = dataDirectory;
    this.#environment = environment;
    this.#reasoningWorkspaces = new ReasoningWorkspaces(join(dataDirectory, "lab", "reasoning"));
  }

  prepareMemory(): Promise<void> {
    return this.#portableMemory.prepare();
  }

  get dataDirectory(): string {
    return this.#dataDirectory;
  }

  get shutdownRequested(): boolean {
    return this.#shutdownRequested;
  }

  /** Load and cache the learned relevance gate from the data directory's
   *  `relevance-model.json` — opt-in by producing (and placing) a validated
   *  model; there is no env switch. */
  #getRelevanceModel(): RelevanceModelLike | undefined {
    if (this.#relevanceModel === undefined) {
      this.#relevanceModel = this.#loadRelevanceModel();
    }
    return this.#relevanceModel ?? undefined;
  }

  /** Why the learned gate is or is not active (diagnostics; also asserted in tests). */
  get relevanceModelStatus(): string {
    this.#getRelevanceModel();
    return this.#relevanceModelNote;
  }

  /** The embedding index this runtime embeds with, or "none" when degraded. */
  #embeddingIdentity(): string {
    return this.#configuredEmbeddingClient()?.indexId ?? "none";
  }

  /**
   * Load the learned gate, refusing one whose absolute scores came from another
   * embedder. An absolute score scale is not comparable across embedders, and
   * using it anyway fails *silently*: the numbers still look plausible while the
   * threshold no longer separates anything. A head that does not read the
   * scale-bound feature block is embedder-free and loads anywhere.
   */
  #loadRelevanceModel(): RelevanceModelLike | null {
    let model: RelevanceModelLike | null;
    try {
      model = readRelevanceModel(join(this.#dataDirectory, "relevance-model.json"));
    } catch (error) {
      this.#relevanceModelNote = `unreadable: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    }
    if (!model) {
      this.#relevanceModelNote = "absent";
      return null;
    }
    const identity = this.#embeddingIdentity();
    if (model.acceptsEmbedder && !model.acceptsEmbedder(identity)) {
      this.#relevanceModelNote = `refused: trained on embedder ${model.embedder ?? "unknown"}, runtime is ${identity}`;
      return null;
    }
    this.#relevanceModelNote = `loaded (runtime embedder ${identity})`;
    return model;
  }

  /** Lazily construct the daemon-owned online learner (shared state file). */ #getOnlineLearner(): ContextRouterOnlineLearner | null {
    if (this.#onlineLearner === undefined) {
      this.#onlineLearner = contextOnlineLearningEnabled(this.#environment)
        ? new ContextRouterOnlineLearner(onlineRouterStatePath(this.#dataDirectory))
        : null;
    }
    return this.#onlineLearner;
  }

  /** A call the daemon has accepted and not yet answered. Counted here rather than inferred from
   *  the store, because it is the service, not the database, that a shutdown has to fence. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Let the calls already accepted finish. Shutdown is a sequence - stop new work, then let the
   *  work in flight finish, then close once - and the middle step needs an await, which a
   *  synchronous close() does not have. So close() requires that this has happened, instead of
   *  pretending it can fence a call it cannot see. */
  async drain(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.#inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (this.#inFlight > 0) {
      throw new NmgProtocolError(
        "DRAINING",
        `${this.#inFlight} calls were still in flight after ${timeoutMs}ms`,
      );
    }
  }

  /** Reload admission is reversible only when draining fails; no accepted call is cancelled. */
  async prepareReload(timeoutMs = 5_000): Promise<void> {
    if (this.#closing) throw new NmgProtocolError("SHUTTING_DOWN", "the service takes no new work");
    this.#closing = true;
    try {
      await this.drain(timeoutMs);
    } catch (error) {
      this.#closing = false;
      this.#shutdownRequested = false;
      throw error;
    }
  }

  async invoke<M extends NmgMethod>(
    method: M,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<NmgMethodResult[M]> {
    if (this.#closing)
      throw new NmgProtocolError("SHUTTING_DOWN", "the service is closing and takes no new work");
    // Count the awaited application operation, including asynchronous backend publication.
    this.#inFlight += 1;
    try {
      if (PortableMemoryService.handles(method))
        return (await this.#invokeMemory(method, params, signal)) as NmgMethodResult[M];
      this.#portableMemory.requireLocalMethod(method);
      switch (method) {
        case "hello":
          return this.#hello() as NmgMethodResult[M];
        case "status":
          return this.#status() as NmgMethodResult[M];
        case "resolveRemember":
          return (await this.#resolveMemory(
            parseResolveRememberParams(params),
          )) as NmgMethodResult[M];
        case "recordClaimOutcomes":
          return (await this.#claimOutcomes(
            parseRecordClaimOutcomesParams(params),
          )) as NmgMethodResult[M];
        case "recordFeedback":
          return this.#recordFeedback(parseRecordFeedbackParams(params)) as NmgMethodResult[M];
        case "exportMemories": {
          const input = objectParams(params);
          return (await this.#portableMemory.exportMemories({
            sourceActor: optionalEnum(input, "sourceActor", MEMORY_ACTORS),
            includeDeleted: optionalBoolean(input, "includeDeleted"),
          })) as NmgMethodResult[M];
        }
        case "setStorageState": {
          const input = objectParams(params);
          return (await this.#portableMemory.setStorageState({
            memoryId: requiredString(input, "memoryId"),
            storageState: requiredEnum(input, "storageState", [
              "indexed",
              "dormant",
              "quarantine",
            ] as const),
            recoveryDays: optionalInteger(input, "recoveryDays", 0, 3650),
          })) as NmgMethodResult[M];
        }
        case "perfAggregates":
          return this.#getStore().perfAggregates() as NmgMethodResult[M];
        case "pruneRetrievalTraces": {
          const input = objectParams(params);
          return {
            pruned: this.#getStore().pruneRetrievalTraces({
              maxDays: optionalInteger(input, "maxDays", 1, 3650),
              maxRows: optionalInteger(input, "maxRows", 100, 1_000_000),
            }),
          } as NmgMethodResult[M];
        }
        case "recordActiveGraphAttribution":
          return (await this.#attributeRecall(
            parseRecordActiveGraphAttributionParams(params),
          )) as NmgMethodResult[M];
        case "taskBoard": {
          const parsed = parseTaskBoardParams(params);
          return taskBoardHandlers[parsed.action](this.#getStore(), parsed) as NmgMethodResult[M];
        }
        case "taskRun": {
          const parsed = parseTaskRunParams(params);
          return taskRunHandlers[parsed.action](this.#getStore(), parsed) as NmgMethodResult[M];
        }
        case "state":
          return this.#state(params) as NmgMethodResult[M];
        case "lab":
          return this.#lab(parseLabParams(params)) as NmgMethodResult[M];
        case "sessionActiveGraph":
          return this.#sessionActiveGraph(
            parseSessionActiveGraphParams(params),
          ) as NmgMethodResult[M];
        case "shutdown":
          this.#shutdownRequested = true;
          return { shuttingDown: true } as NmgMethodResult[M];
        default:
          throw new NmgProtocolError("METHOD_NOT_FOUND", "Unknown NMG method " + method);
      }
    } catch (error) {
      this.#rpcRejections.record(method, error);
      throw error;
    } finally {
      this.#inFlight -= 1;
    }
  }

  recordUnknownRpcMethod(): void {
    this.#rpcRejections.record("(unknown)", new NmgProtocolError("METHOD_NOT_FOUND", ""));
  }

  /** Closes in the order the design asks for: stop taking new work, revoke the timers and signals
   *  that could start more of it, then close each store exactly once. A second call is a no-op, so
   *  a shutdown path that runs twice cannot close a store out from under a live reader. */
  close(options: { cancelBackfill?: boolean } = {}): void | Promise<void> {
    // A close that silently drops calls already accepted would lose writes that were answered as
    // accepted; the sequence is drain() first, and this refuses rather than pretending.
    if (this.#inFlight > 0) {
      throw new NmgProtocolError(
        "DRAINING",
        `${this.#inFlight} calls were still in flight; drain before closing`,
      );
    }
    this.#closing = true;
    this.#store?.close();
    this.#store = undefined;
    this.#sessionActiveGraphs.clear();
    return this.#portableMemory.close(options.cancelBackfill);
  }

  async #invokeMemory(method: NmgMethod, value: unknown, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.#invokePortable(method, value, signal);
    } catch (error) {
      if (error instanceof MemoryWriteRejected)
        throw new NmgProtocolError("WRITE_REJECTED", error.reason);
      throw error;
    }
  }

  async #invokePortable(method: NmgMethod, value: unknown, signal?: AbortSignal): Promise<unknown> {
    const memory = this.#portableMemory;
    const params = objectParams(value);
    const operationId = optionalString(params, "operationId");
    switch (method) {
      case "remember":
        return memory.remember(this.#portableWriteInput(parseRememberParams(params)), operationId);
      case "rememberBatch":
        return memory.rememberMany(
          parseRememberBatchParams(params).items.map((item) => this.#portableWriteInput(item)),
          operationId,
        );
      case "search":
        return this.#searchPortable(parseSearchParams(params), signal);
      case "get":
        return this.#getPortable(parseGetParams(params));
      case "deleteMemory": {
        const parsed = parseDeleteMemoryParams(params);
        return memory.withdraw(parsed.memoryId, operationId, optionalString(params, "sessionId"));
      }
      default:
        throw new NmgProtocolError(
          "METHOD_NOT_FOUND",
          `${method} is not a portable memory operation`,
        );
    }
  }

  #portableWriteInput(params: NmgRememberParams): NmgRememberParams {
    if (!this.#portableMemory.local) return params;
    return { ...params, tesserae: this.#withTesseraSimhashes(params.tesserae, params.projectDir) };
  }

  async #searchPortable(params: NmgSearchParams, signal?: AbortSignal): Promise<MemoryContext> {
    signal?.throwIfAborted();
    const memory = this.#portableMemory;
    const started = performance.now();
    if (memory.local) this.#offerSearchCue(params);
    const retrieval = { ...params };
    if (memory.local) {
      retrieval.graphHops ??= configuredGraphHops(0, this.#environment);
      delete retrieval.recallCue;
      delete retrieval.recallRevision;
      delete retrieval.recallSource;
      if (params.autoRecall && params.sessionId)
        retrieval.query = this.#recallContext.automaticQuery(
          params.sessionId,
          resolve(params.projectDir ?? process.cwd()),
          params.query,
        );
    }
    const context = await memory.search(retrieval, signal);
    signal?.throwIfAborted();
    if (!memory.local) return context;
    const directMs = performance.now() - started;
    if (!params.autoRecall)
      context.tesserae = await this.#resolveTesseraLines(context.tesserae ?? [], params);
    if (params.sessionId) {
      context.results = this.#recallContext.rank(
        params.sessionId,
        resolve(params.projectDir ?? process.cwd()),
        params.query,
        context.results,
      );
      if (params.autoRecall) context.recallDisplayMode = this.#recallContext.mode(params.sessionId);
    }
    return this.#registerPortableSearch(
      context,
      { ...params, graphHops: retrieval.graphHops },
      started,
      directMs,
    );
  }

  #registerPortableSearch(
    context: MemoryContext,
    params: NmgSearchParams,
    started: number,
    directMs: number,
  ): MemoryContext {
    const projected = portableRecallGraph(context, params, performance.now() - started);
    const taskFrame = this.#labAuthority.status(
      "working_state",
      params.sessionId ?? "",
    )?.workingStateBinding;
    if (taskFrame) projected.activeGraph.taskId = taskFrame.taskFrameId;
    const timings =
      params.perf === false
        ? undefined
        : {
            timings: { "search.direct": directMs },
            totalMs: performance.now() - started,
          };
    const targets = captureMemoryReferenceTargets(projected.results);
    const activeGraph = this.#sessionActiveGraphs.registerProjection(
      projected.activeGraph,
      this.#portableTraceParts(projected.activeGraph, targets, params.persistTrace, timings),
      projected.activeGraph.id,
    );
    const result = { ...projected, activeGraph: activeGraph.graph, timings };
    if (params.persistTrace !== false) this.#stageOnlineDecision(params, result);
    return params.persistTrace === false
      ? result
      : { ...result, memoryReferences: createMemoryReferences(result, targets) };
  }

  #portableTraceParts(
    graph: ActiveGraph,
    referenceTargets: readonly MemoryReferenceTarget[],
    persistTrace?: boolean,
    timings?: PerfSnapshot,
  ): Array<ActiveGraphProjectionPart<ActiveGraphStorePart>> {
    if (persistTrace === false) return [];
    const store = this.#getStore();
    const traceId = store.recordTrace(
      {
        sessionId: graph.sessionId ?? undefined,
        query: graph.query,
        taskId: graph.taskId,
        resultMemoryIds: graph.memoryIds,
        resultNodeIds: graph.nodeIds,
        relationIds: graph.edges.map((edge) => edge.id),
        activeGraphBudget: graph.budget,
        activeGraphUsage: graph.usage,
        selections: graph.selections,
        expansions: graph.expansions,
        budgetLedger: graph.budgetLedger,
        qpp: graph.qpp,
        timings,
      },
      graph.id,
    );
    store.recordPerfAggregates(timings);
    const memoryIds = new Set(graph.memoryIds);
    return [{ traceId, memoryIds, value: { store, traceId, memoryIds, referenceTargets } }];
  }

  async #getPortable(params: NmgGetParams): Promise<NmgMethodResult["get"]> {
    this.#countGetReferences(params.memoryIds);
    const trace = params.activeGraphId
      ? this.#portableDisclosureTrace(params.activeGraphId, params.sessionId)
      : undefined;
    params = await this.#resolvePortableGetReferences(params);
    const context = await this.#portableMemory.get(params);
    const found = new Set(context.results.map((result) => result.memory.id));
    if (trace) {
      trace.store.recordActiveGraphDisclosure(trace.id, [...found], params.sessionId);
      const graphIds = new Set(trace.memoryIds);
      await this.#portableMemory.recordUsage(
        [...found].filter((id) => graphIds.has(id)),
        params,
      );
    }
    if (this.#portableMemory.local)
      context.tesserae = await this.#resolveTesseraLines(context.tesserae ?? [], params);
    return { ...context, missingMemoryIds: params.memoryIds.filter((id) => !found.has(id)) };
  }

  #portableDisclosureTrace(id: string, sessionId?: string) {
    if (!this.#portableMemory.local)
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        "Portable memory does not support activeGraphId",
        "activeGraphId",
      );
    const store = this.#getStore();
    const ownership = store.traceOwnership(id, sessionId);
    if (ownership === "foreign")
      throw new NmgProtocolError(
        "NOT_FOUND",
        "Active Graph projection belongs to another session.",
      );
    if (ownership === "owned") {
      const trace = store.retrievalTrace(id, sessionId)!;
      return { id, store, memoryIds: trace.resultMemoryIds };
    }
    this.#ownedPortableGraph(id, sessionId);
    return undefined; // Live ephemeral probes have no persisted trace.
  }

  async #resolvePortableGetReferences(params: NmgGetParams): Promise<NmgGetParams> {
    if (!params.memoryIds.some(isMemoryReference)) return params;
    if (!params.activeGraphId)
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        "Memory references require their activeGraphId.",
        "activeGraphId",
      );
    const parts = this.#projectionParts(params.activeGraphId, params.sessionId) ?? [];
    if (parts.length === 0)
      throw new NmgProtocolError("NOT_FOUND", "Active Graph projection is absent or not owned.");
    const targets = parts.flatMap((part) => part.referenceTargets ?? []);
    const current = await this.#portableMemory.get({
      ...params,
      memoryIds: targets.map(({ memory }) => memory.id),
      graphHops: 0,
    });
    try {
      return {
        ...params,
        memoryIds: resolveMemoryReferences(params.memoryIds, targets, current.results),
      };
    } catch (error) {
      if (error instanceof MemoryReferenceError)
        throw new NmgProtocolError("INVALID_PARAMS", error.message, "memoryIds");
      throw error;
    }
  }

  #ownedPortableGraph(id: string, sessionId?: string) {
    const projection = this.#sessionActiveGraphs.projection(id, sessionId);
    if (!projection || projection.sessionId !== (sessionId?.trim() || "__anonymous__"))
      throw new NmgProtocolError(
        "NOT_FOUND",
        this.#sessionActiveGraphs.projectionOwner(id)
          ? "Active Graph projection belongs to another session."
          : "Active Graph projection is absent or not owned.",
      );
    return projection.graph;
  }

  async #attributeRecall(
    params: NmgRecordActiveGraphAttributionParams,
  ): Promise<NmgMethodResult["recordActiveGraphAttribution"]> {
    const graph = this.#ownedPortableGraph(params.activeGraphId, params.sessionId);
    const visible = new Set(graph.memoryIds);
    const attributedMemoryIds =
      params.answerText === undefined
        ? params.attributedMemoryIds.filter((id) => visible.has(id))
        : await this.#portableOverlap(graph, params);
    for (const part of this.#projectionParts(graph.id, params.sessionId) ?? [])
      part.store.recordActiveGraphAttribution(
        part.traceId,
        { method: "answer_overlap", attributedMemoryIds },
        params.sessionId,
      );
    return { activeGraphId: graph.id, attributedMemoryIds };
  }

  async #portableOverlap(
    graph: ActiveGraph,
    params: NmgRecordActiveGraphAttributionParams,
  ): Promise<string[]> {
    const versions = new Map(
      params.memoryVersions!.map((item) => [item.memoryId, item.statementHash]),
    );
    const ids = graph.memoryIds.filter((id) => versions.has(id));
    const context = await this.#portableMemory.get({
      memoryIds: ids,
      sessionId: params.sessionId,
      projectDir: params.projectDir,
    });
    const candidates = context.results.filter(
      ({ memory }) => versions.get(memory.id) === statementFingerprint(memory.statement),
    );
    return deriveAnswerOverlapMemoryIds(params.answerText!, candidates, graph.query);
  }

  #hello(): NmgHelloResult {
    const result: NmgHelloResult = {
      protocol: NMG_PROTOCOL_VERSION,
      service: "node-memory-graph",
      version: SERVICE_VERSION,
      capabilities: NMG_CAPABILITIES,
      methods: NMG_METHODS,
      catalogFingerprint: NMG_RPC_CATALOG_FINGERPRINT,
    };
    return this.#portableMemory.hello(result);
  }

  #status(): NmgStatusResult {
    return {
      ...this.#hello(),
      process: { pid: process.pid, node: process.version },
      storage: this.#portableMemory.storageStatus,
      getReferenceUsage: { ...this.#getReferenceUsage },
      rpcRejections: this.#rpcRejections.report(),
      embedding: this.#portableEmbeddingStatus(),
    };
  }

  #portableEmbeddingStatus(): NmgStatusResult["embedding"] {
    const portable = this.#portableMemory;
    const provider = portable.local ? this.#configuredProvider() : null;
    const client = provider ? this.#configuredEmbeddingClient() : undefined;
    return {
      configured: provider !== null,
      provider,
      indexId: client?.indexId ?? null,
      health: client ? portable.embeddingHealth(client.indexId) : null,
      reason: portable.local ? this.#embeddingError : "portable_memory_lexical",
    };
  }

  #state(value: unknown): NmgMethodResult["state"] {
    const params = objectParams(value);
    const action = requiredEnum(params, "action", ["read", "write"] as const);
    const space = requiredEnum(params, "space", ["ag", "board"] as const);
    const operation = stateOperation({
      action,
      space,
      operation: optionalString(params, "operation"),
    });
    if (space === "ag") return this.#stateAg(action, operation, params);
    return this.#stateBoard(action, operation, params);
  }

  #stateBoard(
    action: "read" | "write",
    operation: string,
    params: Record<string, unknown>,
  ): NmgMethodResult["state"] {
    const space = "board";
    if (COORDINATION_OPERATIONS.has(operation)) {
      const result = executeCoordinationState(this.#getStore(), operation, params);
      return { action, space, operation, result, information: prepareCoordinationSurface(result) };
    }
    const parsed = parseTaskBoardParams({
      ...params,
      action: operation,
      taskId: params.taskId ?? "default",
    });
    const result = taskBoardHandlers[parsed.action](this.#getStore(), parsed);
    const taskId = "taskId" in parsed ? parsed.taskId : "default";
    const directory =
      operation === "list" && result.action === "list"
        ? result.boards
        : operation === "read" && taskId === "default"
          ? this.#getStore().listTaskBoards()
          : undefined;
    const presentsContent = [
      "read",
      "readInbox",
      "readPreviews",
      "discover",
      "list",
      "put",
      "claim",
      "release",
      "acknowledge",
      "deliver",
      "judge",
      "resolve",
    ].includes(operation);
    const information = presentsContent
      ? prepareTaskBoardSurface(result, { taskId, directory })
      : undefined;
    return { action, space, operation, result, information };
  }

  #stateAg(
    action: "read" | "write",
    operation: string,
    params: Record<string, unknown>,
  ): NmgMethodResult["state"] {
    const sessionId = requiredString(params, "sessionId");
    if (Object.keys(params).some((key) => !(STATE_AG_FIELDS as readonly string[]).includes(key)))
      throw new NmgProtocolError("INVALID_PARAMS", "unsupported AG state field");
    if (operation === "read") {
      const snapshot = this.#sessionActiveGraphs.snapshot(sessionId);
      return {
        action,
        space: "ag",
        operation,
        result: { action: "snapshot", snapshot },
        information: prepareSessionActiveGraphSurface(snapshot),
      };
    }
    const lab =
      operation === "replace" || operation === "clear"
        ? {
            action: "invoke",
            capability: "working_state",
            sessionId,
            operation,
            workingStateBinding: params.workingStateBinding,
            input: operation === "replace" ? { text: params.text } : {},
          }
        : {
            ...params,
            action: operation,
            capability: "working_state",
            sessionId,
          };
    return {
      action,
      space: "ag",
      operation,
      result: this.#lab(parseLabParams(lab)),
    };
  }

  #lab(params: NmgLabParams): NmgMethodResult["lab"] {
    if (params.action === "list") {
      return { action: "list", capabilities: this.#labAuthority.list() };
    }
    if (params.action === "status") {
      const activation = this.#labAuthority.status(params.capability, params.sessionId);
      if (!activation) this.#resetRecallGate(params.capability, params.sessionId);
      return {
        action: "status",
        activation,
      };
    }
    if (params.action === "enable") {
      if (params.capability === "working_state" && params.scope && params.scope !== "session") {
        throw new NmgProtocolError("INVALID_PARAMS", "working_state requires session scope");
      }
      const workingStateBinding =
        params.capability === "working_state"
          ? this.#sessionActiveGraphs.bindWorkingState(params.sessionId)
          : undefined;
      const activation = this.#labAuthority.enable({
        capability: params.capability,
        scope: params.scope ?? "session",
        sessionId: params.sessionId,
        requester: params.requester,
        reason: params.reason,
        ttlSeconds: params.ttlSeconds,
        workingStateBinding,
      });
      this.#resetRecallGate(params.capability, params.sessionId);
      return {
        action: "enable",
        activation,
      };
    }
    if (params.action === "disable") {
      const binding = this.#labAuthority.status(
        params.capability,
        params.sessionId,
      )?.workingStateBinding;
      if (binding) this.#sessionActiveGraphs.unbindWorkingState(binding);
      this.#resetRecallGate(params.capability, params.sessionId);
      return {
        action: "disable",
        activation: this.#labAuthority.disable(params.capability, params.sessionId),
      };
    }

    const activation = this.#labAuthority.requireEnabled(params.capability, params.sessionId);
    if (params.capability === "working_state") {
      const output = this.#invokeWorkingState(params, activation.workingStateBinding);
      return {
        action: "invoke",
        capability: params.capability,
        operation: params.operation,
        output,
      };
    }
    const output =
      params.capability === "recall_gate"
        ? this.#invokeRecallGate(params.sessionId, params.operation, params.input)
        : this.#invokeLabCapability(
            params.capability,
            params.sessionId,
            params.operation,
            params.input,
          );
    return {
      action: "invoke",
      capability: params.capability,
      operation: params.operation,
      output,
    };
  }

  #invokeWorkingState(
    params: Extract<NmgLabParams, { action: "invoke" }>,
    expected: WorkingStateBinding | undefined,
  ): "updated" | "unchanged" | "cleared" {
    const binding = params.workingStateBinding;
    if (
      !binding ||
      !expected ||
      binding.sessionId !== params.sessionId ||
      binding.agId !== expected.agId ||
      binding.taskFrameId !== expected.taskFrameId ||
      binding.bindingId !== expected.bindingId
    ) {
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        "working_state requires its captured host binding",
      );
    }
    const input = objectParams(params.input ?? {});
    const allowed = params.operation === "replace" ? ["text"] : [];
    if (Object.keys(input).some((key) => !allowed.includes(key))) {
      throw new NmgProtocolError("INVALID_PARAMS", "unsupported working_state input field");
    }
    if (params.operation === "clear") return this.#sessionActiveGraphs.clearWorkingState(binding);
    if (params.operation !== "replace" || typeof input.text !== "string") {
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        "working_state requires replace(text) or clear()",
      );
    }
    return this.#sessionActiveGraphs.replaceWorkingState(binding, input.text);
  }

  #invokeLabCapability(
    capability: LabCapability,
    sessionId: string,
    operation: string,
    input: unknown,
  ): unknown {
    if (capability === "memory_graph_reasoner") {
      return this.#invokeMemoryGraphReasoner(sessionId, operation, input);
    }
    if (capability === "controller_shadow") {
      if (operation !== "observe")
        throw new NmgProtocolError(
          "INVALID_PARAMS",
          `unknown controller shadow operation: ${operation}`,
        );
      const context = input as MemoryContext;
      if (!context || typeof context !== "object" || !context.activeGraph) {
        throw new NmgProtocolError(
          "INVALID_PARAMS",
          "controller shadow observe requires a MemoryContext with activeGraph",
        );
      }
      this.#labShadowController ??= new ControllerPolicyChannel({
        mode: "shadow",
        statePath: join(this.#dataDirectory, "controller-shadow-state.json"),
      });
      return {
        descriptor: this.#labShadowController.descriptor,
        decision: this.#labShadowController.shadow(context),
      };
    }
    if (capability !== "reasoning_workspace") {
      throw new NmgProtocolError(
        "LAB_OPERATION_UNAVAILABLE",
        `${capability} does not expose operation ${operation} through this daemon yet`,
      );
    }
    const values = objectParams(input);
    if (operation === "add") {
      return this.#reasoningWorkspaces.add(sessionId, {
        kind: requiredEnum(values, "kind", [
          "goal",
          "observation",
          "hypothesis",
          "evidence",
          "conclusion",
          "decision",
          "open_question",
          "next_action",
        ] as const),
        content: requiredString(values, "content"),
        status: optionalEnum(values, "status", [
          "active",
          "supported",
          "rejected",
          "resolved",
          "superseded",
        ] as const),
        importance: optionalNumber(values, "importance", 0, 1),
        evidenceRefs: optionalStringArray(values, "evidenceRefs"),
      });
    }
    if (operation === "update") {
      return this.#reasoningWorkspaces.update(sessionId, requiredString(values, "nodeId"), {
        content: optionalString(values, "content"),
        status: optionalEnum(values, "status", [
          "active",
          "supported",
          "rejected",
          "resolved",
          "superseded",
        ] as const),
        importance: optionalNumber(values, "importance", 0, 1),
        evidenceRefs: optionalStringArray(values, "evidenceRefs"),
      });
    }
    if (operation === "link") {
      return this.#reasoningWorkspaces.link(
        sessionId,
        requiredString(values, "sourceId"),
        requiredString(values, "targetId"),
        requiredEnum(values, "type", [
          "supports",
          "contradicts",
          "derived_from",
          "tests",
          "rejects",
          "depends_on",
          "next_step",
        ] as const),
      );
    }
    if (operation === "checkpoint") {
      return this.#reasoningWorkspaces.checkpoint(sessionId, {
        maxNodes: optionalInteger(values, "maxNodes", 1, 1_000),
        maxChars: optionalInteger(values, "maxChars", 256, 100_000),
      });
    }
    if (operation === "mark_compacted") {
      return { marked: this.#reasoningWorkspaces.markCompacted(sessionId) };
    }
    if (operation === "consume_checkpoint") {
      return this.#reasoningWorkspaces.consumeCompactionCheckpoint(sessionId, {
        maxNodes: optionalInteger(values, "maxNodes", 1, 1_000),
        maxChars: optionalInteger(values, "maxChars", 256, 100_000),
      });
    }
    if (operation === "clear") return { cleared: this.#reasoningWorkspaces.clear(sessionId) };
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      `unknown reasoning workspace operation: ${operation}`,
    );
  }

  #invokeMemoryGraphReasoner(sessionId: string, operation: string, input: unknown): unknown {
    const values = objectParams(input);
    const projectionId = requiredString(values, "projectionId");
    const projection = this.#sessionActiveGraphs.projection(projectionId, sessionId);
    if (!projection) {
      const owner = this.#sessionActiveGraphs.projectionOwner(projectionId);
      throw new NmgProtocolError(
        "NOT_FOUND",
        owner
          ? `Active Graph projection ${projectionId} belongs to another session`
          : `Active Graph projection ${projectionId} does not exist`,
      );
    }
    const queryVector = requiredNumberArray(values, "queryVector");
    const graph = parseReasonerGraph(values.graph, queryVector.length);
    const allowedNodeIds = new Set(projection.graph.nodeIds);
    for (const nodeId of graph.keys()) {
      if (!allowedNodeIds.has(nodeId)) {
        throw new NmgProtocolError(
          "INVALID_PARAMS",
          `reasoner node ${nodeId} is outside Active Graph projection ${projectionId}`,
        );
      }
    }
    if (graph.size > projection.graph.budget.maxNodes) {
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        `reasoner graph exceeds Active Graph node budget ${projection.graph.budget.maxNodes}`,
      );
    }
    const edgeCount = [...graph.values()].reduce(
      (sum, node) => sum + (node.outgoing?.length ?? 0),
      0,
    );
    if (edgeCount > projection.graph.budget.maxEdges) {
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        `reasoner graph exceeds Active Graph edge budget ${projection.graph.budget.maxEdges}`,
      );
    }
    const reasoner = new MemoryGraphReasoner(queryVector.length);
    const envelope = {
      projectionId,
      agId: projection.agId,
      persisted: false,
    } as const;
    if (operation === "traverse") {
      return {
        ...envelope,
        hypothetical: false,
        ...labJson(
          reasoner.traverse(
            queryVector,
            graph,
            boundedReasonerSteps(values, projection.graph.budget.maxGraphHops),
          ),
        ),
      };
    }
    if (operation === "logic_search") {
      return {
        ...envelope,
        hypothetical: false,
        ...labJson(
          reasoner.logicSearch(
            parseLogicExpression(values.expression, queryVector.length),
            graph,
            Math.min(
              optionalInteger(values, "topK", 1, 100) ?? 10,
              projection.graph.budget.maxNodes,
            ),
          ),
        ),
      };
    }
    if (operation === "what_if") {
      const hypothetical = parseReasonerNode(values.hypotheticalNode, queryVector.length);
      const result = reasoner.whatIf(
        queryVector,
        graph,
        hypothetical,
        boundedReasonerSteps(values, projection.graph.budget.maxGraphHops),
        optionalNumber(values, "impactThreshold", 0, 1) ?? 0.05,
      );
      return {
        ...envelope,
        hypothetical: true,
        ...labJson(result),
        summary: reasoner.impactSummary(result, hypothetical.id),
      };
    }
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      `unknown memory graph reasoner operation: ${operation}`,
    );
  }

  #resetRecallGate(capability: LabCapability, sessionId: string): void {
    if (capability === "recall_gate") this.#sessionRecall.clear(sessionId);
  }

  #invokeRecallGate(sessionId: string, operation: string, input: unknown): unknown {
    const values = objectParams(input ?? {});
    if (operation === "prepare") {
      return this.#sessionRecall.prepare(
        sessionId,
        resolve(optionalString(values, "projectDir") ?? process.cwd()),
        requiredString(values, "prompt"),
        optionalBoolean(values, "scheduled") ?? false,
      );
    }
    if (operation === "correct") {
      return this.#sessionRecall.correct(
        sessionId,
        requiredNumber(values, "revision", 1, Number.MAX_SAFE_INTEGER),
        requiredString(values, "phrase"),
        requiredString(values, "reason"),
      );
    }
    if (operation === "list") return this.#sessionRecall.list(sessionId);
    if (operation === "events") return this.#sessionRecall.events(sessionId);
    if (operation === "remove")
      return { removed: this.#sessionRecall.remove(sessionId, requiredString(values, "phrase")) };
    if (operation === "clear") return { cleared: this.#sessionRecall.clear(sessionId) };
    throw new NmgProtocolError("INVALID_PARAMS", `unknown recall gate operation: ${operation}`);
  }

  #prepareRecallGate(
    sessionId: string,
    recall: Extract<NmgSessionActiveGraphParams, { action: "beginDisclosureTurn" }>["recall"],
  ): SessionRecallPreparation | undefined {
    if (!this.#labAuthority.isEnabled("recall_gate", sessionId)) {
      this.#sessionRecall.clear(sessionId);
      return undefined;
    }
    if (!recall) return undefined;
    return this.#sessionRecall.prepare(
      sessionId,
      resolve(recall.projectDir),
      recall.prompt,
      recall.scheduled,
      this.#sessionRecall.snapshot(sessionId, resolve(recall.projectDir)).turn,
    );
  }

  #recallTurnMetadata(
    params: Extract<NmgSessionActiveGraphParams, { action: "beginDisclosureTurn" }>,
  ) {
    const lease = this.#labAuthority.status("recall_gate", params.sessionId);
    if (!lease) {
      this.#sessionRecall.clear(params.sessionId);
      return {};
    }
    const projectDir = params.projectDir ? resolve(params.projectDir) : undefined;
    if (projectDir) this.#sessionRecall.snapshot(params.sessionId, projectDir);
    this.#sessionRecall.beginTurn(params.sessionId);
    return {
      recallGateActive: true as const,
      ...(projectDir
        ? {
            recallGate: {
              ...this.#sessionRecall.snapshot(params.sessionId, projectDir),
              expiresAt: lease.expiresAt,
            },
          }
        : {}),
      ...(params.recall
        ? { sessionRecall: this.#prepareRecallGate(params.sessionId, params.recall) }
        : {}),
    };
  }

  #observeRecallTurn(
    params: Extract<NmgSessionActiveGraphParams, { action: "beginDisclosureTurn" }>,
  ): void {
    const prompt = params.prompt ?? params.recall?.prompt;
    if (prompt)
      this.#recallContext.observe(
        params.sessionId,
        prompt,
        resolve(params.projectDir ?? params.recall?.projectDir ?? process.cwd()),
      );
  }

  #sessionActiveGraph(params: NmgSessionActiveGraphParams): NmgMethodResult["sessionActiveGraph"] {
    if (params.action === "observe") {
      return {
        action: "observe",
        ...this.#sessionActiveGraphs.observe(params),
      };
    }
    if (params.action === "snapshot") {
      return {
        action: "snapshot",
        snapshot: this.#sessionActiveGraphs.snapshot(params.sessionId),
      };
    }
    if (params.action === "activate") {
      return {
        action: "activate",
        snapshot: this.#sessionActiveGraphs.activateTemporaryProjection(params.sessionId),
      };
    }
    if (params.action === "beginDisclosureTurn") {
      this.#observeRecallTurn(params);
      return {
        action: "beginDisclosureTurn",
        turn: this.#sessionActiveGraphs.beginDisclosureTurn(params.sessionId),
        ...this.#recallTurnMetadata(params),
      };
    }
    if (params.action === "recallDisplay") {
      if (params.mode) this.#recallContext.setMode(params.sessionId, params.mode);
      return { action: "recallDisplay", mode: this.#recallContext.mode(params.sessionId) };
    }
    if (params.action === "disclose") {
      return {
        action: "disclose",
        ...this.#sessionActiveGraphs.disclose(params),
      };
    }
    if (params.action === "clearDisclosures") {
      return {
        action: "clearDisclosures",
        cleared: this.#sessionActiveGraphs.clearDisclosures(params.sessionId),
      };
    }
    const released = this.#sessionActiveGraphs.release(params.sessionId);
    this.#recallContext.clear(params.sessionId);
    this.#labAuthority.disable("working_state", params.sessionId);
    this.#labAuthority.disable("recall_gate", params.sessionId);
    this.#sessionRecall.clear(params.sessionId);
    return { action: "release", released };
  }

  /** Stamp each tessera with a 64-bit SimHash of its target file (16-hex), or
   *  leave it absent when the file is unreadable at write time (or no project
   *  root is known). Fingerprint is drift tolerance only — it never gates or
   *  alters the write. */
  #withTesseraSimhashes(
    tesserae: TesseraInput[] | undefined,
    projectDir: string | undefined,
  ): TesseraInput[] | undefined {
    if (!projectDir || !tesserae || tesserae.length === 0) return tesserae;
    return tesserae.map((tessera) => {
      if (!tessera.path) return tessera;
      try {
        const content = readFileSafe(resolve(projectDir, tessera.path));
        if (content === null) return tessera;
        return { ...tessera, fileSimhash: simhashToHex(simhash64(content)) };
      } catch {
        return tessera; // never fail a memory write for a missing fingerprint
      }
    });
  }

  async #resolveMemory(
    params: NmgResolveRememberParams,
  ): Promise<NmgMethodResult["resolveRemember"]> {
    const result = await this.#portableMemory.resolveRemember(params);
    if (result.action === "supersede" && result.applied)
      this.#settleRecallDebtOnSupersede(result.supersededMemoryId);
    return result;
  }

  /** Consume one labeled auto-recall graph (RSCB context-use feedback) into the
   *  daemon-owned online learner. No usable label or no staged decision → not
   *  trained. Best-effort: never breaks the remember path on a foreign graph. */
  #recordFeedback(params: NmgRecordFeedbackParams): NmgMethodResult["recordFeedback"] {
    const result: NmgMethodResult["recordFeedback"] = {
      trained: false,
      activeGraphId: null,
    };
    const owner =
      params.activeGraphId && this.#sessionActiveGraphs.projectionOwner(params.activeGraphId);
    if (owner && owner !== (params.sessionId?.trim() || "__anonymous__")) return result;
    try {
      const learner = this.#getOnlineLearner();
      if (!learner) return result; // online learning disabled
      // Feedback binds only to the graph it names (the recall surface shows the
      // activeGraphId the consumer is rating). No latest-staged fallback: that
      // fallback bound feedback to an unrelated staged decision whenever the
      // rated recall was not itself staged (e.g. an explicit search), silently
      // training on the wrong context. Skip rather than mis-bind.
      const graphId = params.activeGraphId;
      if (!graphId) return result; // no explicit graph: nothing safe to train on
      const trained = learner.consumeFeedback(graphId, params);
      learner.persistIfDirty();
      if (trained.trained) {
        result.trained = true;
        result.reward = trained.reward;
        result.loss = trained.loss;
      }
      result.activeGraphId = graphId;
    } catch {
      // Feedback must never break the surrounding remember call.
    }
    return result;
  }

  async #claimOutcomes(params: NmgRecordClaimOutcomesParams) {
    if (params.activeGraphId) {
      const projection = this.#sessionActiveGraphs.projection(
        params.activeGraphId,
        params.sessionId,
      );
      const trace = this.#portableDisclosureTrace(params.activeGraphId, params.sessionId);
      const exposed = new Set(projection?.graph.memoryIds ?? trace?.memoryIds);
      if (params.votes.some((vote) => !exposed.has(vote.memoryId)))
        throw new NmgProtocolError(
          "INVALID_PARAMS",
          "Claim outcome targets must be exposed by the Active Graph",
        );
    }
    return this.#portableMemory.recordClaimOutcomes(
      params,
      configuredStgConsolidationPolicy(this.#environment),
    );
  }

  #offerSearchCue(params: NmgSearchParams): void {
    const { sessionId, recallCue, recallSource, recallRevision } = params;
    if (!sessionId || !recallCue || params.autoRecall || params.persistTrace === false) return;
    if (!this.#labAuthority.isEnabled("recall_gate", sessionId)) {
      this.#sessionRecall.clear(sessionId);
      return;
    }
    if (recallSource) {
      const snapshot = this.#sessionRecall.snapshot(
        sessionId,
        resolve(params.projectDir ?? process.cwd()),
      );
      if (snapshot.generation !== recallSource.generation || snapshot.turn !== recallSource.turn)
        return;
      this.#sessionRecall.offerFromSearch(
        sessionId,
        resolve(params.projectDir ?? process.cwd()),
        recallSource.prompt,
        recallCue,
        recallSource.turn,
      );
    } else if (recallRevision !== undefined) {
      if (params.projectDir) this.#sessionRecall.snapshot(sessionId, resolve(params.projectDir));
      this.#sessionRecall.offerPrepared(sessionId, recallRevision, recallCue);
    }
  }

  /** Remember-time debt settlement: when the write path supersedes a memory,
   *  any outstanding (unlabeled) recall instance that surfaced that memory is
   *  settled on_target. Store-verifiable — the superseded memory was the current
   *  value the write corrected — so it is attributable evidence, never an
   *  assistant self-report. Best-effort; never breaks the write path. */
  #settleRecallDebtOnSupersede(supersededMemoryId: string): void {
    if (!recallInstancesEnabled(this.#environment)) return;
    try {
      const instances = readRecallInstances(recallInstancesPath(this.#dataDirectory));
      const labeled = new Set(
        readRecallLabels(recallLabelsPath(this.#dataDirectory)).map((entry) => entry.activeGraphId),
      );
      for (const instance of instancesSurfacing(instances, supersededMemoryId)) {
        if (labeled.has(instance.activeGraphId)) continue;
        appendRecallLabel(this.#dataDirectory, {
          activeGraphId: instance.activeGraphId,
          label: "on_target",
          source: "remember",
          at: new Date().toISOString(),
        });
      }
    } catch {
      // Settlement is diagnostic; never breaks supersession.
    }
  }

  #stageOnlineDecision(params: NmgSearchParams, context: MemoryContext): void {
    try {
      const graphId = context.activeGraph?.id;
      if (!graphId) return; // no disclosure graph: nothing for feedback to bind to
      const learner = this.#getOnlineLearner();
      if (!learner) return; // online learning disabled (NMG_CONTEXT_ONLINE_LEARNING=0)
      learner.stage(
        graphId,
        params.sessionId ?? "",
        contextFeaturesFromMemory(context),
        "retrieve",
      );
    } catch {
      // Online learning must never break a recall search.
    }
  }

  /** Resolve tessera snippets to current line numbers against a project root.
   *  Best-effort: file missing/unreadable or snippet absent marks stale. */
  async #resolveTesseraLines(
    tesserae: TesseraHit[],
    scope: { projectDir?: string; sessionId?: string },
  ): Promise<TesseraHit[]> {
    const projectRoot = scope.projectDir;
    if (!projectRoot || tesserae.length === 0) return tesserae;
    const cache = new Map<string, string[] | null>(); // absPath -> lines | null
    const linesFor = (path: string): string[] | null => {
      const abs = resolve(projectRoot, path);
      if (cache.has(abs)) return cache.get(abs)!;
      const lines = readLinesSafe(abs);
      cache.set(abs, lines);
      return lines;
    };
    return Promise.all(
      tesserae.map((tessera) => {
        if (!tessera.snippet) return { ...tessera, stale: true };
        const target = tessera.snippet.trim();
        const pathLines = linesFor(tessera.path);
        if (pathLines) {
          // Stage 1 — exact relocation against the stored path.
          const found = pathLines.findIndex((line) => line.includes(target));
          if (found !== -1) return this.#resolvedTessera(tessera, pathLines, found + 1, scope);
        }
        // Stage 2 — SimHash drift fallback. The stored path no longer relocates
        // (edited or moved). Compare the stored file fingerprint against current
        // files; a near-identical document (Hamming ≤ 6) elsewhere is the same
        // file after a move — locate the snippet there. Never auto-rewrites the
        // row; a stored file that still matches but lost the snippet is stale.
        const relocated = this.#relocateTesseraViaSimhash(tessera, target, projectRoot);
        return relocated ?? { ...tessera, stale: true };
      }),
    );
  }

  async #resolvedTessera(
    tessera: TesseraHit,
    lines: string[],
    line: number,
    scope: { projectDir?: string; sessionId?: string },
  ): Promise<TesseraHit> {
    if (tessera.fileSimhash) return { ...tessera, line };
    const fileSimhash = simhashToHex(simhash64(lines.join("\n")));
    try {
      if (tessera.memoryId)
        await this.#portableMemory.backfillTesseraFingerprint(
          { id: tessera.id, memoryId: tessera.memoryId, path: tessera.path, fileSimhash },
          scope,
        );
    } catch {
      // A file lookup still returns its resolved line if fingerprint persistence fails.
    }
    return { ...tessera, line, fileSimhash };
  }

  /** SimHash drift relocation: find a current file whose fingerprint is within
   *  Hamming SIMHASH_DRIFT_THRESHOLD of the tessera's stored fingerprint and
   *  locate the snippet inside it. Only meaningful when the stored path no
   *  longer relocates the snippet (file moved or rewritten). Returns a resolved
   *  hit, or null when no candidate contains the snippet. */
  #relocateTesseraViaSimhash(
    tessera: TesseraHit,
    snippet: string,
    projectRoot: string,
  ): TesseraHit | null {
    const stored = tessera.fileSimhash;
    if (!stored) return null;
    const storedFingerprint = simhashFromHex(stored);
    const absStoredPath = resolve(projectRoot, tessera.path);
    const current = readLinesSafe(absStoredPath);
    if (current) {
      // (a) The stored file still exists. If it still resembles the written
      // document (Hamming ≤ threshold), the snippet itself was rewritten —
      // honestly stale: relocation by content cannot recover a fragment that no
      // longer exists. If it no longer resembles the document, the file was
      // replaced/rewritten — also not a move to chase.
      const currentFingerprint = simhash64(current.join("\n"));
      const storedPathMatches =
        hammingDistance(currentFingerprint, storedFingerprint) <= SIMHASH_DRIFT_THRESHOLD;
      if (storedPathMatches) return null;
    }
    // (b) The stored file is gone or rewritten past tolerance: the tessera may
    // point at a document that moved. Scan project files for a near-identical
    // file and locate the snippet there. Only a file whose fingerprint matches
    // AND whose content contains the snippet is accepted — never guessed.
    for (const candidate of projectCandidateFiles(projectRoot)) {
      if (absStoredPath === resolve(candidate)) continue; // tried above
      const candidateLines = readLinesSafe(candidate);
      if (!candidateLines) continue;
      const candidateFingerprint = simhash64(candidateLines.join("\n"));
      if (hammingDistance(candidateFingerprint, storedFingerprint) > SIMHASH_DRIFT_THRESHOLD) {
        continue;
      }
      const line = locateSnippetLine(candidateLines, snippet);
      if (line !== null) {
        // Canonical project-relative path: always forward slashes, matching how
        // tesserae paths are stored and searched (Windows relative() yields \).
        const rel = relative(projectRoot, candidate).replaceAll("\\", "/");
        return { ...tessera, path: rel, line, relocated: true };
      }
    }
    return null;
  }

  #countGetReferences(memoryIds: readonly string[]): void {
    for (const id of memoryIds) {
      const kind = isMemoryReference(id) ? "compoundRefs" : "fullIds";
      this.#getReferenceUsage[kind] += 1;
    }
  }

  #projectionParts(activeGraphId: string, sessionId?: string): ActiveGraphStorePart[] | undefined {
    const projection = this.#sessionActiveGraphs.projection(activeGraphId, sessionId);
    if (!projection) return undefined;
    return projection.parts.map((part) => ({
      store: part.value.store,
      traceId: part.traceId,
      memoryIds: new Set(part.memoryIds),
      referenceTargets: part.value.referenceTargets,
    }));
  }

  #getStore(): SqliteLocalDaemonState {
    return (this.#store ??= new SqliteLocalDaemonState(this.databasePath));
  }

  #configuredEmbeddingClient(): EmbeddingClient | undefined {
    if (this.#embeddingClient !== undefined) return this.#embeddingClient ?? undefined;
    try {
      this.#embeddingClient = createEmbeddingClientFromEnv(this.#environment) ?? null;
    } catch (error) {
      this.#embeddingClient = null;
      this.#embeddingError = error instanceof Error ? error.message : String(error);
    }
    return this.#embeddingClient ?? undefined;
  }

  #configuredProvider(): string | null {
    try {
      return configuredProvider(this.#environment) ?? null;
    } catch (error) {
      this.#embeddingError ??= error instanceof Error ? error.message : String(error);
      return this.#environment.NMG_EMBED_PROVIDER?.trim() || null;
    }
  }
}

function localMemorySelection(path: string): NonNullable<NmgServiceOptions["memoryBackend"]> {
  const namespace = activatedLocalMemory(path) ?? LOCAL_MEMORY_NAMESPACE;
  return { kind: "sqlite", namespace, local: true };
}

function parseRememberParams(value: unknown): NmgRememberParams {
  const params = objectParams(value);
  const parsed: NmgRememberParams = {
    statement: requiredString(params, "statement"),
    nodeName: requiredString(params, "nodeName"),
    memoryType: optionalEnum(params, "memoryType", MEMORY_TYPES),
    stateKey: optionalString(params, "stateKey"),
    eventTime: optionalString(params, "eventTime"),
    referenceTime: optionalString(params, "referenceTime"),
    timeZone: optionalString(params, "timeZone"),
    sourceActor: optionalEnum(params, "sourceActor", MEMORY_ACTORS),
    truthStatus: optionalEnum(params, "truthStatus", TRUTH_STATUSES),
    evidence: optionalString(params, "evidence"),
    evidenceSource: optionalEvidenceSource(params, "evidenceSource"),
    tier: optionalInteger(params, "tier", 0, 3) as MemoryTier | undefined,
    importance: optionalNumber(params, "importance", 0, 1),
    scope: optionalScope(params, "scope"),
    validFrom: optionalString(params, "validFrom"),
    validUntil: optionalString(params, "validUntil"),
    evidenceRole: optionalEnum(params, "evidenceRole", EVIDENCE_ROLES),
    supersedesId: optionalString(params, "supersedesId"),
    resolution: optionalEnum(params, "resolution", MEMORY_RESOLUTIONS),
    openedAt: optionalString(params, "openedAt"),
    relatedMemoryIds: optionalStringArray(params, "relatedMemoryIds"),
    residence: optionalEnum(params, "residence", MEMORY_RESIDENCES),
    expiresAt: optionalString(params, "expiresAt"),
    writeReason: optionalString(params, "writeReason"),
    writeSource: optionalEnum(params, "writeSource", MEMORY_WRITE_SOURCES),
    sessionId: optionalString(params, "sessionId"),
    sourceRef: optionalString(params, "sourceRef"),
    markers: optionalMarkers(params, "markers"),
    recallTriggers: optionalRecallTriggers(params),
    tesserae: optionalTesserae(params, "tesserae"),
    unsafe: optionalBoolean(params, "unsafe"),
    projectDir: optionalString(params, "projectDir"),
  };
  if (parsed.memoryType === "state" && !parsed.stateKey) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      "state memories require stateKey naming one replaceable property within scope (not a topic/group)",
    );
  }
  try {
    resolveWriteEventTime(parsed.eventTime, parsed);
  } catch (error) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      error instanceof Error ? error.message : String(error),
    );
  }
  return parsed;
}

function parseRememberBatchParams(value: unknown): NmgRememberBatchParams {
  const params = objectParams(value);
  const items = params.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 512) {
    throw new NmgProtocolError("INVALID_PARAMS", "rememberBatch items must contain 1..512 writes");
  }
  return { items: items.map((item) => parseRememberParams(item)) };
}

function optionalEvidenceSource(
  params: Record<string, unknown>,
  key: string,
): NmgRememberParams["evidenceSource"] {
  const value = params[key];
  if (value === undefined) return undefined;
  const source = objectParams(value);
  return {
    actor: requiredEnum(source, "actor", MEMORY_ACTORS),
    content: requiredString(source, "content"),
    sourceMessageId: requiredString(source, "sourceMessageId"),
    sourceRef: optionalString(source, "sourceRef"),
  };
}

/** Parse the optional tesserae array on a remember write. Each tessera needs a
 *  path and a snippet (the relocation key); label/kind are optional. */
function optionalTesserae(
  params: Record<string, unknown>,
  key: string,
): TesseraInput[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be an array of at most 10 tesserae`);
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new NmgProtocolError("INVALID_PARAMS", `${key} entries must be objects`);
    }
    const tessera = entry as Record<string, unknown>;
    return {
      path: requiredString(tessera, "path"),
      snippet: requiredString(tessera, "snippet"),
      label: optionalString(tessera, "label"),
      kind: optionalString(tessera, "kind"),
    };
  });
}

/** Max Hamming distance for a SimHash drift match. Measured on real repo
 *  files (5–60 KB): near-identical pairs sit at 1–3, unrelated at ~24, so 6
 *  cleanly separates without false positives (see simhash.ts). */
const SIMHASH_DRIFT_THRESHOLD = 6;

/** Files scanned by the SimHash drift fallback when the stored tessera path
 *  no longer relocates (moved-file case). Bounded walk of a project root:
 *  skips VCS/dependency/build directories and non-regular files, caps at
 *  SIMHASH_SCOPE_MAX_FILES so a pathological tree cannot stall a search. */
const SIMHASH_SCOPE_MAX_FILES = 200;
const TESSERA_MAX_FILE_BYTES = 1024 * 1024;

const SIMHASH_SCOPE_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".cache",
  ".benchmarks",
]);

/** Locate a snippet inside file lines. Returns the 1-based line whose content
 *  contains the snippet, or null. Snippet is the relocation key — MVP keeps
 *  single-line relocation (a snippet spanning an edit's new line boundary is
 *  reported stale rather than guessed). */
function locateSnippetLine(lines: string[], snippet: string): number | null {
  const found = lines.findIndex((line) => line.includes(snippet));
  return found === -1 ? null : found + 1;
}

/** Bounded, order-stable list of readable files under a project root that the
 *  SimHash fallback may scan. Never follows symlinks out of the root. */
function projectCandidateFiles(root: string, limit = SIMHASH_SCOPE_MAX_FILES): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= limit) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      const name = entry.name;
      if (entry.isDirectory()) {
        if (!name.startsWith(".") && !SIMHASH_SCOPE_SKIP_DIRS.has(name)) walk(`${dir}/${name}`);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(`${dir}/${name}`);
    }
  };
  walk(root);
  return files;
}

/** Read a file's full content, or null when unreadable/missing. Used by the
 *  tessera write-time SimHash computation. */
function readFileSafe(absPath: string): string | null {
  try {
    const stats = statSync(absPath);
    if (!stats.isFile() || stats.size > TESSERA_MAX_FILE_BYTES) return null;
    const text = readFileSync(absPath, "utf8");
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

/** Read a file's lines, or null when unreadable/missing. Used by tessera
 *  snippet relocation. */
function readLinesSafe(absPath: string): string[] | null {
  return readFileSafe(absPath)?.split(/\r?\n/) ?? null;
}

function parseResolveRememberParams(value: unknown): NmgResolveRememberParams {
  const params = objectParams(value);
  const action = requiredString(params, "action");
  if (action === "forget") {
    return {
      action,
      memoryId: requiredString(params, "memoryId"),
      projectDir: optionalString(params, "projectDir"),
      sessionId: optionalString(params, "sessionId"),
    };
  }
  if (action === "relate") {
    return {
      action,
      newMemoryId: requiredString(params, "newMemoryId"),
      relatedMemoryId: requiredString(params, "relatedMemoryId"),
      relationJudgement: requiredEnum(params, "relationJudgement", MEMORY_RELATION_JUDGEMENTS),
      confidence: optionalNumber(params, "confidence", 0, 1),
      projectDir: optionalString(params, "projectDir"),
      sessionId: optionalString(params, "sessionId"),
    };
  }
  if (action === "resolve" || action === "reopen") {
    return {
      action,
      memoryId: requiredString(params, "memoryId"),
      relatedMemoryIds: optionalStringArray(params, "relatedMemoryIds"),
      reason: optionalString(params, "reason"),
      projectDir: optionalString(params, "projectDir"),
      sessionId: optionalString(params, "sessionId"),
    };
  }
  if (action !== "supersede") {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      "resolveRemember action must be supersede, relate, forget, resolve, or reopen",
    );
  }
  return {
    action,
    newMemoryId: requiredString(params, "newMemoryId"),
    supersededMemoryId: requiredString(params, "supersededMemoryId"),
    reason: optionalString(params, "reason"),
    projectDir: optionalString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
  };
}

function parseRecordClaimOutcomesParams(value: unknown): NmgRecordClaimOutcomesParams {
  const params = objectParams(value);
  const rawVotes = params.votes;
  if (!Array.isArray(rawVotes)) {
    throw new NmgProtocolError("INVALID_PARAMS", "votes must be an array");
  }
  return {
    semanticTaskId: requiredString(params, "semanticTaskId"),
    activeGraphId: optionalString(params, "activeGraphId"),
    sessionId: optionalString(params, "sessionId"),
    projectDir: optionalString(params, "projectDir"),
    collectionOrigin: optionalEnum(params, "collectionOrigin", ["controlled", "natural"]),
    votes: rawVotes.map((rawVote) => {
      const vote = objectParams(rawVote);
      return {
        memoryId: requiredString(vote, "memoryId"),
        claimIndexes: optionalIntegerArray(vote, "claimIndexes", 0),
        outcome: requiredEnum(vote, "outcome", CLAIM_OUTCOMES),
        source: requiredEnum(vote, "source", CLAIM_OUTCOME_SOURCES),
        sourceLineage: requiredString(vote, "sourceLineage"),
        evidenceSource: optionalClaimOutcomeEvidenceSource(vote, "evidenceSource"),
        weight: optionalNumber(vote, "weight", Number.EPSILON, 1),
      };
    }),
  };
}

function optionalClaimOutcomeEvidenceSource(
  params: Record<string, unknown>,
  key: string,
): NmgRecordClaimOutcomesParams["votes"][number]["evidenceSource"] {
  const value = params[key];
  if (value === undefined) return undefined;
  const source = objectParams(value);
  return {
    actor: requiredEnum(source, "actor", MEMORY_ACTORS),
    content: requiredString(source, "content"),
    sessionId: requiredString(source, "sessionId"),
    sourceMessageId: requiredString(source, "sourceMessageId"),
    sourceRef: optionalString(source, "sourceRef"),
  };
}

function parseRecordFeedbackParams(value: unknown): NmgRecordFeedbackParams {
  const params = objectParams(value);
  return {
    activeGraphId: optionalString(params, "activeGraphId"),
    sessionId: optionalString(params, "sessionId"),
    taskSuccess: optionalBoolean(params, "taskSuccess"),
    userCorrection: optionalBoolean(params, "userCorrection"),
    evidenceSufficient: optionalBoolean(params, "evidenceSufficient"),
    expansionUseful: optionalBoolean(params, "expansionUseful"),
    excessiveNoise: optionalBoolean(params, "excessiveNoise"),
    noMemoryNeeded: optionalBoolean(params, "noMemoryNeeded"),
    memoryMisleading: optionalBoolean(params, "memoryMisleading"),
    note: optionalString(params, "note"),
  };
}

function recallSearchSource(value: unknown): NmgSearchParams["recallSource"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.prompt !== "string" || source.prompt.length > 4096) return undefined;
  if (!Number.isSafeInteger(source.generation) || Number(source.generation) < 1) return undefined;
  if (!Number.isSafeInteger(source.turn) || Number(source.turn) < 1) return undefined;
  return {
    prompt: source.prompt,
    generation: Number(source.generation),
    turn: Number(source.turn),
  };
}

/** A window bound must resolve: silently dropping one would answer a different
 *  question than the caller asked. */
function eventTimeBound(params: Record<string, unknown>, name: string): string | undefined {
  const raw = optionalString(params, name);
  if (raw === undefined) return undefined;
  const resolved = name === "eventTimeFrom" ? eventWindowStart(raw) : eventWindowEnd(raw);
  if (!resolved) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      `${name} must be a date or a resolvable date phrase`,
      name,
    );
  }
  return raw;
}

function parseSearchParams(value: unknown): NmgSearchParams {
  const params = objectParams(value);
  return {
    query: requiredString(params, "query"),
    queries: optionalStringArray(params, "queries"),
    recallCue: typeof params.recallCue === "string" ? params.recallCue : undefined,
    recallRevision:
      Number.isSafeInteger(params.recallRevision) && Number(params.recallRevision) > 0
        ? Number(params.recallRevision)
        : undefined,
    recallSource: recallSearchSource(params.recallSource),
    nodeName: optionalString(params, "nodeName"),
    scope: optionalScope(params, "scope"),
    sourceActor: optionalEnum(params, "sourceActor", MEMORY_ACTORS),
    includeHistorical: optionalBoolean(params, "includeHistorical"),
    eventTimeFrom: eventTimeBound(params, "eventTimeFrom"),
    eventTimeTo: eventTimeBound(params, "eventTimeTo"),
    maxTier: optionalInteger(params, "maxTier", 0, 3) as MemoryTier | undefined,
    limit: optionalInteger(params, "limit", 1, 50),
    graphHops: optionalInteger(params, "graphHops", 0, 3),
    expandChains: optionalBoolean(params, "expandChains"),
    chainExpansionMaxMembers: optionalInteger(params, "chainExpansionMaxMembers", 0, 100),
    chainExpansionMaxChains: optionalInteger(params, "chainExpansionMaxChains", 1, 8),
    chainExpansionMaxHops: optionalInteger(params, "chainExpansionMaxHops", 0, 1),
    chainExpansionMaxMemoryHops: optionalInteger(params, "chainExpansionMaxMemoryHops", 0, 8),
    chainExpansionMaxEdges: optionalInteger(params, "chainExpansionMaxEdges", 0, 128),
    appendedMaxChars: optionalInteger(params, "appendedMaxChars", 0, 1_000_000),
    appendedMaxRatio: optionalNumber(params, "appendedMaxRatio", 0, 10),
    retrievalMode: optionalEnum(params, "retrievalMode", RETRIEVAL_MODES),
    vectorGranularity: optionalEnum(params, "vectorGranularity", VECTOR_GRANULARITIES),
    secondPass: optionalBoolean(params, "secondPass"),
    initialEvidenceTarget: optionalInteger(params, "initialEvidenceTarget", 1, 50),
    strongHitTopGap: optionalNumber(params, "strongHitTopGap", 0, 1),
    strongHitInitialTarget: optionalInteger(params, "strongHitInitialTarget", 1, 50),
    progressiveWarmDisclosure: optionalBoolean(params, "progressiveWarmDisclosure"),
    tieredDisclosure: optionalBoolean(params, "tieredDisclosure"),
    autoRecall: optionalBoolean(params, "autoRecall"),
    autoRecallBudgetMs: optionalInteger(params, "autoRecallBudgetMs", 1, 5_000),
    persistTrace: optionalBoolean(params, "persistTrace"),
    activeGraphBudget: optionalActiveGraphBudget(params, "activeGraphBudget"),
    perf: optionalBoolean(params, "perf"),
    projectDir: optionalString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
  };
}

function parseGetParams(value: unknown): NmgGetParams {
  const params = objectParams(value);
  const ids = params.memoryIds;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 50 ||
    ids.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      "memoryIds must contain between 1 and 50 non-empty strings",
    );
  }
  return {
    memoryIds: ids.map((id) => String(id).trim()),
    activeGraphId: optionalString(params, "activeGraphId"),
    graphHops: optionalInteger(params, "graphHops", 0, 3),
    projectDir: optionalString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
  };
}

function parseLabParams(value: unknown): NmgLabParams {
  const params = objectParams(value);
  const action = requiredEnum(params, "action", [
    "list",
    "status",
    "enable",
    "disable",
    "invoke",
  ] as const);
  if (action === "list") return { action };
  const capability = requiredEnum(params, "capability", LAB_CAPABILITIES);
  const sessionId = requiredString(params, "sessionId");
  if (action === "status" || action === "disable") return { action, capability, sessionId };
  if (action === "enable") {
    return {
      action,
      capability,
      sessionId,
      scope: optionalEnum(params, "scope", ["session", "project", "global"] as const),
      requester: requiredString(params, "requester"),
      reason: requiredString(params, "reason"),
      ttlSeconds: optionalInteger(params, "ttlSeconds", 60, 86_400),
    };
  }
  return {
    action,
    capability,
    sessionId,
    operation: requiredString(params, "operation"),
    input: params.input,
    workingStateBinding:
      params.workingStateBinding === undefined
        ? undefined
        : parseWorkingStateBinding(params.workingStateBinding),
  };
}

function parseWorkingStateBinding(value: unknown): WorkingStateBinding {
  const values = objectParams(value);
  return {
    sessionId: requiredString(values, "sessionId"),
    agId: requiredString(values, "agId"),
    taskFrameId: requiredString(values, "taskFrameId"),
    bindingId: requiredString(values, "bindingId"),
  };
}

function parseSessionActiveGraphParams(value: unknown): NmgSessionActiveGraphParams {
  const params = objectParams(value);
  const action = requiredEnum(params, "action", [
    "observe",
    "snapshot",
    "activate",
    "release",
    "beginDisclosureTurn",
    "recallDisplay",
    "disclose",
    "clearDisclosures",
  ] as const);
  const sessionId = requiredString(params, "sessionId");
  if (action === "recallDisplay")
    return {
      action,
      sessionId,
      mode:
        params.mode === undefined
          ? undefined
          : requiredEnum(params, "mode", ["compact", "full"] as const),
    };
  if (action === "beginDisclosureTurn") {
    const recall = params.recall === undefined ? undefined : objectParams(params.recall);
    return {
      action,
      sessionId,
      projectDir: optionalString(params, "projectDir"),
      recall: recall
        ? {
            prompt: requiredString(recall, "prompt"),
            scheduled: optionalBoolean(recall, "scheduled") ?? false,
            projectDir: requiredString(recall, "projectDir"),
          }
        : undefined,
      prompt: optionalString(params, "prompt"),
    };
  }
  if (
    action === "snapshot" ||
    action === "activate" ||
    action === "release" ||
    action === "clearDisclosures"
  ) {
    return { action, sessionId };
  }
  if (action === "disclose") {
    if (!Array.isArray(params.entries)) {
      throw new NmgProtocolError("INVALID_PARAMS", "entries must be an array");
    }
    return {
      action,
      sessionId,
      projectionId: optionalString(params, "projectionId"),
      disclosure: requiredEnum(params, "disclosure", ["header", "exact", "evidence"] as const),
      entries: params.entries.map((entry) => {
        const parsed = objectParams(entry);
        return {
          memoryId: requiredString(parsed, "memoryId"),
          contentHash: requiredString(parsed, "contentHash"),
        };
      }),
    };
  }
  return {
    action,
    sessionId,
    statement: requiredString(params, "statement"),
    sourceId: optionalString(params, "sourceId"),
    sourceKind: optionalString(params, "sourceKind"),
    nodeId: optionalString(params, "nodeId"),
    taskFrameId: optionalString(params, "taskFrameId"),
    kind: optionalEnum(params, "kind", [
      "tool_observation",
      "board_projection",
      "reasoning_artifact",
    ] as const),
    activation: optionalNumber(params, "activation", 0, 1),
  };
}

function parseRecordActiveGraphAttributionParams(
  value: unknown,
): NmgRecordActiveGraphAttributionParams {
  const params = objectParams(value);
  const answerText = optionalString(params, "answerText");
  const attributedMemoryIds = requiredStringArray(params, "attributedMemoryIds", 0, 10_000);
  const memoryVersions = parseAttributionVersions(params.memoryVersions, answerText);
  if (
    answerText !== undefined &&
    (answerText.length > 256_000 ||
      attributedMemoryIds.length > 0 ||
      !optionalString(params, "sessionId"))
  )
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      "answerText requires sessionId, empty attributedMemoryIds and at most 256000 characters",
    );
  return {
    activeGraphId: requiredString(params, "activeGraphId"),
    // An empty list is meaningful diagnostic coverage: recall happened, but
    // no candidate wording overlapped the final answer. It is not a negative label.
    attributedMemoryIds,
    ...(answerText !== undefined ? { answerText, memoryVersions } : {}),
    projectDir: optionalString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
  };
}

function parseAttributionVersions(value: unknown, answer: string | undefined) {
  if (answer === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50)
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      "memoryVersions must be an array of at most 50 references",
    );
  return value.map((item) => {
    const record = objectParams(item);
    const statementHash = requiredString(record, "statementHash");
    if (!/^[a-f0-9]{64}$/.test(statementHash))
      throw new NmgProtocolError("INVALID_PARAMS", "Invalid attribution statementHash");
    return { memoryId: requiredString(record, "memoryId"), statementHash };
  });
}

/** Read-style actions share one parse shape (taskId/agentId + paging). A Set
 * guard costs a single decision point regardless of how many actions it holds,
 * so adding another read-style action does not raise the parser's complexity. */
const TASK_BOARD_READ_STYLE = new Set<string>(["read", "readPreviews"]);
const TASK_BOARD_DIRECTED_STYLE = new Set<string>(["readDirected", "readInbox"]);
const TASK_BOARD_ACK_STYLE = new Set<string>(["acknowledge", "veto"]);
const TASK_BOARD_REGISTRY_STYLE = new Set<string>([
  "registerAgent",
  "heartbeat",
  "unregisterAgent",
  "rename",
]);
const TASK_BOARD_SUBSCRIPTION_STYLE = new Set<string>(["unsubscribe", "subscribe"]);

function parseTaskBoardRegistry(
  action: "registerAgent" | "heartbeat" | "unregisterAgent" | "rename",
  params: Record<string, unknown>,
): NmgTaskBoardParams {
  const id = requiredString(params, "id");
  if (action === "registerAgent")
    return {
      action,
      id,
      agentName: requiredString(params, "agentName"),
      description: optionalString(params, "description"),
      version: optionalString(params, "version"),
      url: optionalString(params, "url"),
      capabilities: optionalString(params, "capabilities"),
      skills: optionalString(params, "skills"),
      supportedInterfaces: optionalString(params, "supportedInterfaces"),
      presenceToken: optionalString(params, "presenceToken"),
    };
  if (action === "rename") return { action, id, agentName: requiredString(params, "agentName") };
  return { action, id, presenceToken: optionalString(params, "presenceToken") };
}

function parseBoardNotificationParams(value: unknown) {
  try {
    return parseBoardNotification(value);
  } catch (error) {
    throw new NmgProtocolError("INVALID_PARAMS", (error as Error).message);
  }
}
function parseTaskBoardPut(
  base: { taskId: string; agentId: string },
  params: Record<string, unknown>,
): TaskBoardParamsOf<"put"> {
  const expiresAt = optionalString(params, "expiresAt");
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    throw new NmgProtocolError("INVALID_PARAMS", "expiresAt must be an ISO timestamp");
  }
  const ttlSeconds = optionalInteger(params, "ttlSeconds", 60, 2_592_000);
  if (expiresAt && ttlSeconds !== undefined) {
    throw new NmgProtocolError("INVALID_PARAMS", "use expiresAt or ttlSeconds, not both");
  }
  return {
    ...base,
    action: "put",
    content: requiredString(params, "content"),
    kind: optionalEnum(params, "kind", TASK_BOARD_KINDS),
    sourceSessionId: optionalString(params, "sourceSessionId"),
    eventId: optionalString(params, "eventId"),
    notification: parseBoardNotificationParams(params.notification),
    to: optionalString(params, "to"),
    ttlSeconds,
    expiresAt,
    adopt: optionalAdoption(params.adopt),
  };
}

function parseTaskBoardDelivery(
  agentId: string,
  params: Record<string, unknown>,
): TaskBoardParamsOf<"recordDelivery"> {
  const entryIds = optionalStringArray(params, "entryIds");
  if (entryIds && (entryIds.length > MAX_BOARD_DELIVERY_ENTRIES || params.entryId !== undefined))
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      `Use entryId or 1..${MAX_BOARD_DELIVERY_ENTRIES} entryIds`,
    );
  return {
    action: "recordDelivery",
    agentId,
    sessionId: requiredString(params, "sessionId"),
    ...(entryIds
      ? { entryIds: [...new Set(entryIds)] }
      : { entryId: requiredString(params, "entryId") }),
    source: optionalString(params, "source"),
  };
}

function parseTaskBoardParams(value: unknown): NmgTaskBoardParams {
  const params = objectParams(value);
  const action = requiredEnum(params, "action", [
    "put",
    "read",
    "readPreviews",
    "readDirected",
    "readInbox",
    "resolve",
    "veto",
    "deliver",
    "judge",
    "acknowledge",
    "claim",
    "release",
    "list",
    "listSubscriptions",
    "deliveryCheck",
    "recordDelivery",
    "unsubscribe",
    "subscribe",
    "registerAgent",
    "unregisterAgent",
    "heartbeat",
    "rename",
    "discover",
  ] as const);
  if (TASK_BOARD_REGISTRY_STYLE.has(action))
    return parseTaskBoardRegistry(
      action as "registerAgent" | "heartbeat" | "unregisterAgent" | "rename",
      params,
    );
  const agentId = requiredString(params, "agentId");
  if (action === "discover") {
    return {
      action,
      taskId: requiredString(params, "taskId"),
      agentId,
      need: optionalString(params, "need"),
      capabilities: optionalString(params, "capabilities"),
    };
  }
  if (action === "list") {
    return { action, agentId };
  }
  if (TASK_BOARD_DIRECTED_STYLE.has(action)) {
    return {
      action: action as "readDirected" | "readInbox",
      agentId,
      agentName: requiredString(params, "agentName"),
      limit: optionalInteger(params, "limit", 1, 200),
      ...(action === "readDirected"
        ? { pendingForSession: optionalString(params, "pendingForSession") }
        : {}),
    };
  }
  if (action === "listSubscriptions") {
    return {
      action,
      agentId,
      sessionId: requiredString(params, "sessionId"),
    };
  }
  if (action === "deliveryCheck") {
    return {
      action,
      agentId,
      sessionId: requiredString(params, "sessionId"),
      taskId: requiredString(params, "taskId"),
      entryIds: optionalStringArray(params, "entryIds") ?? [],
    };
  }
  if (action === "recordDelivery") return parseTaskBoardDelivery(agentId, params);
  if (TASK_BOARD_SUBSCRIPTION_STYLE.has(action)) {
    return {
      action: action as "unsubscribe" | "subscribe",
      agentId,
      sessionId: requiredString(params, "sessionId"),
      taskId: requiredString(params, "taskId"),
    };
  }
  const base = {
    action,
    taskId: requiredString(params, "taskId"),
    agentId,
  };
  if (action === "put") return parseTaskBoardPut(base, params);
  if (TASK_BOARD_READ_STYLE.has(action)) {
    return {
      ...base,
      action: action as "read" | "readPreviews",
      ...(action === "read"
        ? { pendingForSession: optionalString(params, "pendingForSession") }
        : {}),
      afterCursor: optionalString(params, "afterCursor"),
      limit: optionalInteger(params, "limit", 1, 200),
      includeResolved: optionalBoolean(params, "includeResolved"),
    };
  }
  const entryBase = {
    ...base,
    action,
    entryId: requiredString(params, "entryId"),
  };
  const entryStyle = parseEntryStyleTaskBoardParams(action, entryBase, params);
  if (entryStyle) return entryStyle;
  return {
    ...entryBase,
    action: "resolve",
    resolution: optionalString(params, "resolution"),
  };
}

/** The entry-scoped actions, which share one parse shape: an entryId plus their own
 *  fields. Kept out of parseTaskBoardParams so that adding an entry-scoped action costs
 *  the parser nothing — a branch here is a decision point there, and the parser is
 *  already the most complex function in this file. */
function parseEntryStyleTaskBoardParams(
  action: NmgTaskBoardParams["action"],
  entryBase: Record<string, unknown>,
  params: Record<string, unknown>,
): NmgTaskBoardParams | null {
  if (action === "claim") {
    return {
      ...entryBase,
      action,
      leaseSeconds: optionalInteger(params, "leaseSeconds", 60, 86_400),
    } as NmgTaskBoardParams;
  }
  if (TASK_BOARD_ACK_STYLE.has(action)) {
    return {
      ...entryBase,
      action: action as "acknowledge" | "veto",
      reason: optionalString(params, "reason"),
    } as NmgTaskBoardParams;
  }
  if (action === "deliver") {
    return {
      ...entryBase,
      action,
      digest: requiredString(params, "digest"),
      ref: optionalString(params, "ref"),
      summary: optionalString(params, "summary"),
    } as NmgTaskBoardParams;
  }
  if (action === "judge") {
    return {
      ...entryBase,
      action,
      verdict: requiredEnum(params, "verdict", TASK_BOARD_VERDICTS),
      reason: optionalString(params, "reason"),
    } as NmgTaskBoardParams;
  }
  return null;
}

/** The adoption request when the caller sent one, or undefined. The branch lives here rather than in
 *  the put expression so an optional field does not decide points for the whole board parser. */
function optionalAdoption(
  value: unknown,
): { runId: string; taskId: string; attempt?: number } | undefined {
  return value === undefined ? undefined : parseAdoption(value);
}

/** A board put's adoption request, or the shape it must have to be one. */
function parseAdoption(value: unknown): {
  runId: string;
  taskId: string;
  attempt?: number;
} {
  const params = objectParams(value);
  return {
    runId: requiredString(params, "runId"),
    taskId: requiredString(params, "taskId"),
    attempt: optionalInteger(params, "attempt", 1, 1_000_000),
  };
}

/** Request bounds, not semantics: a plan's meaning is the coordinator's and the compiler's, this
 *  only keeps one call from being unbounded. */
const TASK_RUN_PLAN_LIMIT = 200;
const TASK_RUN_DEPENDENCY_LIMIT = 64;

/**
 * The run surface's parameters. Every field is validated here so the coordinator and the store can
 * treat their inputs as well-formed: a wire type that admits a value the layer below cannot hold is
 * a validation gap, not a caller's mistake.
 */
function parseTaskRunParams(value: unknown): NmgTaskRunParams {
  const params = objectParams(value);
  const action = requiredEnum(params, "action", [
    "register",
    "freeze",
    "bind",
    "cancel",
    "status",
  ] as const);
  const runId = requiredString(params, "runId");
  if (action === "register") {
    return {
      action,
      runId,
      planDigest: requiredString(params, "planDigest"),
      policy: requiredString(params, "policy"),
      revision: requiredString(params, "revision"),
      retention: requiredString(params, "retention"),
    };
  }
  if (action === "freeze") {
    const tasks = params.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > TASK_RUN_PLAN_LIMIT) {
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        `tasks must be an array of 1..${TASK_RUN_PLAN_LIMIT} tasks`,
      );
    }
    return {
      action,
      runId,
      tasks: tasks.map((task) => parseRunPlanTask(task)),
    };
  }
  if (action === "bind") {
    return {
      action,
      runId,
      taskId: requiredString(params, "taskId"),
      boardTaskId: requiredString(params, "boardTaskId"),
      entryId: requiredString(params, "entryId"),
      attempt: optionalInteger(params, "attempt", 1, 1_000_000),
    };
  }
  if (action === "cancel") {
    return {
      action,
      runId,
      taskId: optionalString(params, "taskId"),
      reason: optionalString(params, "reason"),
    };
  }
  return { action: "status", runId };
}

/** One task of a freeze request. It carries no position: the array order is the plan order, and
 *  turning that order into positions is the coordinator's, so a caller cannot contradict it. */
function parseRunPlanTask(value: unknown): RunPlanTaskInput {
  const params = objectParams(value);
  return {
    taskId: requiredString(params, "taskId"),
    revision: requiredString(params, "revision"),
    input: requiredString(params, "input"),
    dependencies: requiredStringArray(params, "dependencies", 0, TASK_RUN_DEPENDENCY_LIMIT),
    effect: requiredString(params, "effect"),
    waitEvent: optionalString(params, "waitEvent"),
    operation: optionalString(params, "operation"),
    kind: optionalString(params, "kind"),
    patchFiles: optionalStringArray(params, "patchFiles"),
    patchEditable: optionalStringArray(params, "patchEditable"),
  };
}

type TaskBoardParamsOf<A extends NmgTaskBoardParams["action"]> = Extract<
  NmgTaskBoardParams,
  { action: A }
>;
type TaskBoardHandler = (
  store: TaskBoardPort,
  parsed: NmgTaskBoardParams,
) => NmgMethodResult["taskBoard"];

/** Table-driven taskBoard dispatch: adding a new action is one record entry
 * instead of another branch in the (already large) `invoke` dispatcher, so the
 * per-method complexity gate does not ratchet with every protocol addition. */
const taskBoardHandlers: Record<NmgTaskBoardParams["action"], TaskBoardHandler> = {
  put: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"put">;
    const expiresAt =
      p.expiresAt ?? new Date(Date.now() + (p.ttlSeconds ?? 86_400) * 1_000).toISOString();
    const entry = {
      taskId: p.taskId,
      agentId: p.agentId,
      sourceSessionId: p.sourceSessionId,
      kind: p.kind ?? "note",
      content: p.content,
      expiresAt,
      to: p.to,
      eventId: p.eventId,
      notification: p.notification,
    };
    // Adoption is part of creating the entry, not a second call after it: an entry that exists
    // without its binding is exactly the unmanaged hole the run fence exists to close, and a crash
    // between two calls would leave one. An unadopted put takes the path it always took.
    if (!p.adopt) return { action: "put", entry: store.postBoardMessage(entry) };
    if (p.notification)
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        "notification cannot be combined with run adoption",
      );
    return { action: "put", ...createBoundEntry(store, { entry, ...p.adopt }) };
  },
  read: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"read">;
    return {
      action: "read",
      ...store.readTaskBoard(p),
      ...(p.taskId === "default"
        ? {
            events: store
              .listCoordinationEvents({ includeEnded: true, limit: Math.min(p.limit ?? 5, 5) })
              .map(coordinationSummary),
          }
        : {}),
    };
  },
  readDirected: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"readDirected">;
    return { action: "readDirected", entries: store.readDirectedTaskBoard(p) };
  },
  readInbox: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"readInbox">;
    return { action: "readInbox", entries: store.readInboxTaskBoard(p) };
  },
  readPreviews: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"readPreviews">;
    return { action: "readPreviews", ...store.readTaskBoardPreviews(p) };
  },
  list: (store) => ({ action: "list", boards: store.listTaskBoards() }),
  claim: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"claim">;
    return {
      action: "claim",
      entry: coordinatedEntryWrite(store, {
        verb: "claim",
        entryId: p.entryId,
        actorId: p.agentId,
        apply: () => store.claimTaskBoardEntry(p),
      }),
    };
  },
  release: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"release">;
    return {
      action: "release",
      entry: coordinatedEntryWrite(store, {
        verb: "release",
        entryId: p.entryId,
        actorId: p.agentId,
        apply: () => store.releaseTaskBoardEntry(p),
      }),
    };
  },
  deliveryCheck: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"deliveryCheck">;
    return {
      action: "deliveryCheck",
      delivered: p.entryIds.filter((entryId) =>
        store.hasTaskBoardDelivery({ entryId, sessionId: p.sessionId }),
      ),
      acked: [...store.taskBoardAckedIds(p.entryIds, [p.sessionId, p.agentId])],
      inactive: store.inactiveTaskBoardEntries(p.entryIds),
      suppressed: store.isTaskBoardSuppressed({
        sessionId: p.sessionId,
        taskId: p.taskId,
      }),
    };
  },
  recordDelivery: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"recordDelivery">;
    store.writeTransaction(() => {
      for (const entryId of p.entryIds ?? [p.entryId!])
        store.recordTaskBoardDelivery({
          entryId,
          sessionId: p.sessionId,
          source: p.source,
        });
    });
    return { action: "recordDelivery", recorded: true };
  },
  acknowledge: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"acknowledge">;
    coordinatedEntryWrite(store, {
      verb: "acknowledge",
      entryId: p.entryId,
      actorId: p.agentId,
      apply: () =>
        store.acknowledgeTaskBoardEntry({
          entryId: p.entryId,
          agentId: p.agentId,
          reason: p.reason,
        }),
    });
    return {
      action: "acknowledge",
      entry: store.getTaskBoardEntryById(p.taskId, p.entryId)!,
    };
  },
  veto: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"veto">;
    return {
      action: "veto",
      entry: coordinatedEntryWrite(store, {
        verb: "veto",
        entryId: p.entryId,
        actorId: p.agentId,
        apply: () => store.vetoTaskBoardEntry(p),
      }),
    };
  },
  deliver: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"deliver">;
    return {
      action: "deliver",
      entry: coordinatedEntryWrite(store, {
        verb: "deliver",
        entryId: p.entryId,
        actorId: p.agentId,
        apply: () => store.deliverTaskBoardEntry(p),
      }),
    };
  },
  judge: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"judge">;
    return {
      action: "judge",
      entry: coordinatedEntryWrite(store, {
        verb: "judge",
        entryId: p.entryId,
        actorId: p.agentId,
        apply: () => store.judgeTaskBoardEntry(p),
      }),
    };
  },
  unsubscribe: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"unsubscribe">;
    store.setBoardChannelSubscription({ ...p, subscribed: false });
    return { action: "unsubscribe", taskId: p.taskId };
  },
  subscribe: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"subscribe">;
    store.setBoardChannelSubscription({ ...p, subscribed: true });
    return { action: "subscribe", taskId: p.taskId };
  },
  registerAgent: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"registerAgent">;
    store.registerTaskBoardAgent({
      id: p.id,
      agentName: p.agentName,
      description: p.description,
      version: p.version,
      url: p.url,
      capabilities: p.capabilities,
      skills: p.skills,
      supportedInterfaces: p.supportedInterfaces,
      presenceToken: p.presenceToken,
    });
    return { action: "registerAgent", agentName: p.agentName, id: p.id };
  },
  heartbeat: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"heartbeat">;
    store.heartbeatTaskBoardAgent({ id: p.id, presenceToken: p.presenceToken });
    return { action: "heartbeat", agentName: "", id: p.id };
  },
  rename: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"rename">;
    store.renameTaskBoardAgent({ id: p.id, agentName: p.agentName });
    return { action: "rename", agentName: p.agentName, id: p.id };
  },
  unregisterAgent: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"unregisterAgent">;
    store.unregisterTaskBoardAgent({ id: p.id, presenceToken: p.presenceToken });
    return { action: "unregisterAgent", agentName: "", id: p.id };
  },
  discover: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"discover">;
    return {
      action: "discover",
      agents: store
        .discoverTaskBoardAgents({ capabilities: p.capabilities })
        .map((agent) => ({ ...agent, ...store.getAgentWorkStatus(agent.id) })),
    };
  },
  listSubscriptions: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"listSubscriptions">;
    return {
      action: "listSubscriptions",
      subscriptions: store.listBoardChannelSubscriptions(p),
    };
  },
  resolve: (store, parsed) => {
    const p = parsed as TaskBoardParamsOf<"resolve">;
    return {
      action: "resolve",
      entry: coordinatedEntryWrite(store, {
        verb: "resolve",
        entryId: p.entryId,
        actorId: p.agentId,
        apply: () => store.resolveTaskBoardEntry(p),
      }),
    };
  },
};

type TaskRunParamsOf<A extends NmgTaskRunParams["action"]> = Extract<
  NmgTaskRunParams,
  { action: A }
>;
type TaskRunHandler = (
  store: CoordinationPort,
  parsed: NmgTaskRunParams,
) => NmgMethodResult["taskRun"];

/** Table-driven run-surface dispatch, for the same reason as `taskBoardHandlers`: the transition
 *  rules live in the coordinator, and every branch here is one call into it. */
const taskRunHandlers: Record<NmgTaskRunParams["action"], TaskRunHandler> = {
  register: (store, parsed) => {
    const p = parsed as TaskRunParamsOf<"register">;
    return { action: "register", ...registerRun(store, p) };
  },
  freeze: (store, parsed) => {
    const p = parsed as TaskRunParamsOf<"freeze">;
    return {
      action: "freeze",
      ...freezeRunPlan(store, { runId: p.runId, tasks: p.tasks }),
    };
  },
  bind: (store, parsed) => {
    const p = parsed as TaskRunParamsOf<"bind">;
    return {
      action: "bind",
      ...bindRunEntry(store, {
        runId: p.runId,
        taskId: p.taskId,
        boardTaskId: p.boardTaskId,
        entryId: p.entryId,
        attempt: p.attempt,
      }),
    };
  },
  cancel: (store, parsed) => {
    const p = parsed as TaskRunParamsOf<"cancel">;
    return { action: "cancel", ...cancelRun(store, p) };
  },
  status: (store, parsed) => {
    const p = parsed as TaskRunParamsOf<"status">;
    return { action: "status", status: taskRunStatus(store, p.runId) };
  },
};

function parseDeleteMemoryParams(value: unknown): NmgDeleteMemoryParams {
  return { memoryId: requiredString(objectParams(value), "memoryId") };
}

function objectParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NmgProtocolError("INVALID_PARAMS", "params must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredNumberArray(params: Record<string, unknown>, key: string): Float32Array {
  const value = params[key];
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.some((item) => typeof item !== "number" || !Number.isFinite(item))
  ) {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be a non-empty finite number array`);
  }
  return Float32Array.from(value as number[]);
}

function parseReasonerNode(value: unknown, dimensions: number): ReasonerMemoryNode {
  const params = objectParams(value);
  const vector = requiredNumberArray(params, "vector");
  if (vector.length !== dimensions)
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      "reasoner node vector dimensions must match queryVector",
    );
  return {
    id: requiredString(params, "id"),
    vector,
    requires: optionalStringArray(params, "requires"),
    outgoing: optionalStringArray(params, "outgoing"),
  };
}

function parseReasonerGraph(value: unknown, dimensions: number): Map<string, ReasonerMemoryNode> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) {
    throw new NmgProtocolError("INVALID_PARAMS", "graph must contain between 1 and 10000 nodes");
  }
  const graph = new Map<string, ReasonerMemoryNode>();
  for (const raw of value) {
    const node = parseReasonerNode(raw, dimensions);
    if (graph.has(node.id))
      throw new NmgProtocolError("INVALID_PARAMS", `duplicate reasoner node: ${node.id}`);
    graph.set(node.id, node);
  }
  for (const node of graph.values()) {
    for (const targetId of node.outgoing ?? []) {
      if (!graph.has(targetId)) {
        throw new NmgProtocolError(
          "INVALID_PARAMS",
          `reasoner node ${node.id} references missing outgoing node: ${targetId}`,
        );
      }
    }
  }
  return graph;
}

function parseLogicExpression(value: unknown, dimensions: number): LogicExpr {
  const params = objectParams(value);
  const kind = requiredEnum(params, "kind", ["atom", "and", "or", "not"] as const);
  if (kind === "atom") {
    const queryVector = requiredNumberArray(params, "queryVector");
    if (queryVector.length !== dimensions)
      throw new NmgProtocolError("INVALID_PARAMS", "logic atom dimensions must match queryVector");
    return { kind, queryVector };
  }
  if (kind === "not") return { kind, child: parseLogicExpression(params.child, dimensions) };
  if (
    !Array.isArray(params.children) ||
    params.children.length < 1 ||
    params.children.length > 32
  ) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      "logic children must contain between 1 and 32 expressions",
    );
  }
  return {
    kind,
    children: params.children.map((child) => parseLogicExpression(child, dimensions)),
  };
}

function labJson<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (item instanceof Float32Array ? [...item] : item)),
  ) as T;
}

function boundedReasonerSteps(values: Record<string, unknown>, graphHopBudget: number): number {
  return Math.min(
    optionalInteger(values, "maxSteps", 1, 100) ?? 8,
    Math.max(1, graphHopBudget + 1),
  );
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key);
  if (!value) throw new NmgProtocolError("INVALID_PARAMS", `${key} is required`, key);
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be a non-empty string`, key);
  }
  return value.trim();
}

function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      `${key} must be an array of non-empty strings`,
      key,
    );
  }
  return value.map((entry) => String(entry).trim());
}

function optionalRecallTriggers(params: Record<string, unknown>): string[] | undefined {
  const values = optionalStringArray(params, "recallTriggers");
  if (!values) return undefined;
  try {
    return normalizeRecallTriggers(values);
  } catch (error) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      error instanceof Error ? error.message : "invalid recallTriggers",
    );
  }
}

function requiredStringArray(
  params: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): string[] {
  const value = params[key];
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      `${key} must contain between ${minimum} and ${maximum} non-empty strings`,
    );
  }
  return value.map((entry) => String(entry).trim());
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be a boolean`, key);
  }
  return value;
}

function optionalNumber(
  params: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      `${key} must be a number from ${minimum} to ${maximum}`,
      key,
    );
  }
  return value;
}

function requiredNumber(
  params: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = optionalNumber(params, key, minimum, maximum);
  if (value === undefined) throw new NmgProtocolError("INVALID_PARAMS", `${key} is required`);
  return value;
}

function optionalInteger(
  params: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = optionalNumber(params, key, minimum, maximum);
  if (value !== undefined && !Number.isInteger(value)) {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be an integer`, key);
  }
  return value;
}

function optionalIntegerArray(
  params: Record<string, unknown>,
  key: string,
  minimum: number,
): number[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => !Number.isInteger(entry) || Number(entry) < minimum)
  ) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      `${key} must be a non-empty array of integers >= ${minimum}`,
    );
  }
  return value.map(Number);
}

function optionalEnum<const T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      `${key} must be one of: ${allowed.join(", ")}`,
      key,
    );
  }
  return value as T;
}

function requiredEnum<const T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = optionalEnum(params, key, allowed);
  if (!value) throw new NmgProtocolError("INVALID_PARAMS", `${key} is required`);
  return value;
}

function optionalScope(params: Record<string, unknown>, key: string): MemoryScope | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((entry) => typeof entry !== "string")
  ) {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be a string map`);
  }
  return value as MemoryScope;
}

function optionalActiveGraphBudget(
  params: Record<string, unknown>,
  key: string,
): Partial<ActiveGraphBudget> | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  const budget = objectParams(value);
  return {
    maxNodes: optionalInteger(budget, "maxNodes", 1, 50),
    maxEdges: optionalInteger(budget, "maxEdges", 0, 100),
    maxEvidence: optionalInteger(budget, "maxEvidence", 1, 50),
    maxTokens: optionalInteger(budget, "maxTokens", 64, 100_000),
    maxGraphHops: optionalInteger(budget, "maxGraphHops", 0, 3),
    maxLocalTier: optionalInteger(budget, "maxLocalTier", 0, 3) as MemoryTier | undefined,
    maxTierBudget: optionalInteger(budget, "maxTierBudget", 0, 50),
    maxLatencyMs: optionalInteger(budget, "maxLatencyMs", 1, 60_000),
  };
}

function optionalMarkers(params: Record<string, unknown>, key: string): MemoryMarker[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be an array of at most 20 markers`);
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new NmgProtocolError("INVALID_PARAMS", `${key} entries must be objects`);
    }
    const marker = entry as Record<string, unknown>;
    const kind = requiredString(marker, "kind");
    const attributes = marker.attributes;
    if (
      attributes !== undefined &&
      (!attributes ||
        typeof attributes !== "object" ||
        Array.isArray(attributes) ||
        Object.values(attributes).some(
          (item) =>
            item !== null &&
            typeof item !== "string" &&
            typeof item !== "number" &&
            typeof item !== "boolean",
        ))
    ) {
      throw new NmgProtocolError("INVALID_PARAMS", `${key} attributes must contain scalar values`);
    }
    return { kind, attributes: attributes as MemoryMarker["attributes"] };
  });
}
