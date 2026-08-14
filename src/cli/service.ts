import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  configuredProvider,
  createEmbeddingClientFromEnv,
  type EmbeddingClient,
} from "../core/embedding-provider.ts";
import { NmgStore } from "../core/store.ts";
import {
  consolidateStgMemoryToLtg,
  copyLtgSubsetToStg,
  createStgStore,
  mergeStgLtgContexts,
  purgeSessionFromStg,
  retractStgConsolidation,
} from "../core/stg.ts";
import {
  CLAIM_OUTCOMES,
  CLAIM_OUTCOME_SOURCES,
  EVIDENCE_ROLES,
  MEMORY_ACTORS,
  MEMORY_NODE_KINDS,
  MEMORY_RESIDENCES,
  MEMORY_RESOLUTIONS,
  MEMORY_STORAGE_STATES,
  MEMORY_TYPES,
  TASK_BOARD_KINDS,
  RETRIEVAL_MODES,
  TRUTH_STATUSES,
  VECTOR_GRANULARITIES,
  type ActiveGraphBudget,
  type ClaimPosterior,
  type MemoryChain,
  type MemoryChainMember,
  type MemoryContext,
  type MemoryScope,
  type MemoryMarker,
  type MemoryTier,
  type SearchOptions,
} from "../core/types.ts";
import { assessMemoryWrite } from "../core/write-policy.ts";
import { searchMemoryContext } from "../integration/search.ts";
import {
  configuredMaintenancePolicy,
  configuredStgConsolidationPolicy,
} from "../integration/config.ts";
import { applyAdvancedFilters, parseAdvancedQuery } from "../core/store/advanced-query.ts";
import {
  NMG_CAPABILITIES,
  MEMORY_RELATION_JUDGEMENTS,
  NMG_PROTOCOL_VERSION,
  NmgProtocolError,
  type NmgChainAddParams,
  type NmgChainCreateParams,
  type NmgChainGetParams,
  type NmgChainListParams,
  type NmgGetParams,
  type NmgRecordActiveGraphUseParams,
  type NmgHelloResult,
  type NmgDeleteMemoryParams,
  type NmgExportMemoriesParams,
  type NmgMethod,
  type NmgMethodResult,
  type NmgMergeNodesParams,
  type NmgRememberParams,
  type NmgRecordClaimOutcomesParams,
  type NmgResolveRememberParams,
  type NmgRollbackNodeTransformParams,
  type NmgRetentionCandidatesParams,
  type NmgSearchParams,
  type NmgSetStorageStateParams,
  type NmgSplitNodeParams,
  type NmgStatusResult,
  type NmgSyncStgParams,
  type NmgStgPurgeSessionParams,
  type NmgTaskBoardParams,
} from "./protocol.ts";
import { resolveNmgDataDir } from "./data-path.ts";

const SERVICE_VERSION = "0.1.0";
export interface NmgServiceOptions {
  dataDirectory?: string;
  databasePath?: string;
  environment?: NodeJS.ProcessEnv;
}

export class NmgService {
  readonly databasePath: string;
  readonly #environment: NodeJS.ProcessEnv;
  #store: NmgStore | undefined;
  readonly #stgStores = new Map<string, NmgStore>();
  readonly #activeGraphParts = new Map<
    string,
    Array<{ store: NmgStore; traceId: string; memoryIds: Set<string> }>
  >();
  #embeddingClient: EmbeddingClient | undefined | null;
  #embeddingError: string | null = null;
  #shutdownRequested = false;
  readonly #maintenanceJobs = new Map<NmgStore, NodeJS.Immediate>();
  readonly #maintenanceSignals = new Map<
    NmgStore,
    { writes: number; accesses: number; backlogChecked: boolean; localBatches: number }
  >();

  constructor(options: NmgServiceOptions = {}) {
    const environment = options.environment ?? process.env;
    const dataDirectory = options.dataDirectory
      ? resolve(options.dataDirectory)
      : resolveNmgDataDir(environment);
    this.databasePath = resolve(options.databasePath ?? join(dataDirectory, "nmg.sqlite"));
    this.#environment = environment;
  }

  get shutdownRequested(): boolean {
    return this.#shutdownRequested;
  }

  async invoke<M extends NmgMethod>(method: M, params?: unknown): Promise<NmgMethodResult[M]> {
    switch (method) {
      case "hello":
        return this.#hello() as NmgMethodResult[M];
      case "status":
        return this.#status() as NmgMethodResult[M];
      case "remember":
        return this.#remember(parseRememberParams(params)) as NmgMethodResult[M];
      case "resolveRemember":
        return this.#resolveRemember(parseResolveRememberParams(params)) as NmgMethodResult[M];
      case "recordClaimOutcomes":
        return this.#recordClaimOutcomes(
          parseRecordClaimOutcomesParams(params),
        ) as NmgMethodResult[M];
      case "search":
        return (await this.#search(parseSearchParams(params))) as NmgMethodResult[M];
      case "get":
        return this.#get(parseGetParams(params)) as NmgMethodResult[M];
      case "recordActiveGraphUse":
        return this.#recordActiveGraphUse(
          parseRecordActiveGraphUseParams(params),
        ) as NmgMethodResult[M];
      case "retentionCandidates":
        return {
          candidates: this.#getStore().retentionCandidates(parseRetentionCandidatesParams(params)),
        } as NmgMethodResult[M];
      case "perfAggregates":
        return this.#getStore().perfAggregates() as NmgMethodResult[M];
      case "pruneRetrievalTraces":
        return {
          pruned: this.#getStore().pruneRetrievalTraces(parsePerfPruneParams(params)),
        } as NmgMethodResult[M];
      case "setStorageState": {
        const parsed = parseSetStorageStateParams(params);
        return {
          memoryId: parsed.memoryId,
          storageState: this.#getStore().setMemoryStorageState(
            parsed.memoryId,
            parsed.storageState,
            parsed.recoveryDays,
          ),
        } as NmgMethodResult[M];
      }
      case "deleteMemory": {
        const parsed = parseDeleteMemoryParams(params);
        const memory = this.#getStore().deleteMemory(parsed.memoryId);
        return { deleted: memory !== null, memory } as NmgMethodResult[M];
      }
      case "exportMemories":
        return this.#getStore().exportMemories(
          parseExportMemoriesParams(params),
        ) as NmgMethodResult[M];
      case "mergeNodes":
        return this.#getStore().mergeNodes(parseMergeNodesParams(params)) as NmgMethodResult[M];
      case "rollbackNodeTransform":
        return this.#getStore().rollbackNodeTransform(
          parseRollbackNodeTransformParams(params).transformId,
        ) as NmgMethodResult[M];
      case "splitNode":
        return this.#getStore().splitNode(parseSplitNodeParams(params)) as NmgMethodResult[M];
      case "syncStg": {
        const parsed = parseSyncStgParams(params);
        return {
          copied: copyLtgSubsetToStg(
            this.#getStore(),
            this.#getStgStore(parsed.projectDir, parsed.sessionId),
            parsed,
          ),
          projectDir: parsed.projectDir,
        } as NmgMethodResult[M];
      }
      case "stgPurgeSession": {
        const parsed = parseStgPurgeSessionParams(params);
        const purged = purgeSessionFromStg(
          this.#getStgStore(parsed.projectDir, parsed.sessionId),
          parsed.sessionId,
        );
        return { purged, projectDir: parsed.projectDir } as NmgMethodResult[M];
      }
      case "taskBoard": {
        const parsed = parseTaskBoardParams(params);
        if (parsed.action === "put") {
          const expiresAt =
            parsed.expiresAt ??
            new Date(Date.now() + (parsed.ttlSeconds ?? 86_400) * 1_000).toISOString();
          return {
            action: "put",
            entry: this.#getStore().putTaskBoardEntry({
              taskId: parsed.taskId,
              agentId: parsed.agentId,
              sourceSessionId: parsed.sourceSessionId,
              kind: parsed.kind ?? "note",
              content: parsed.content,
              expiresAt,
              to: parsed.to,
            }),
          } as NmgMethodResult[M];
        }
        if (parsed.action === "read") {
          return {
            action: "read",
            ...this.#getStore().readTaskBoard(parsed),
          } as NmgMethodResult[M];
        }
        if (parsed.action === "readDirected") {
          return {
            action: "readDirected",
            entries: this.#getStore().readDirectedTaskBoard(parsed),
          } as NmgMethodResult[M];
        }
        if (parsed.action === "list") {
          return {
            action: "list",
            boards: this.#getStore().listTaskBoards(),
          } as NmgMethodResult[M];
        }
        if (parsed.action === "claim") {
          return {
            action: "claim",
            entry: this.#getStore().claimTaskBoardEntry(parsed),
          } as NmgMethodResult[M];
        }
        if (parsed.action === "release") {
          return {
            action: "release",
            entry: this.#getStore().releaseTaskBoardEntry(parsed),
          } as NmgMethodResult[M];
        }
        if (parsed.action === "deliveryCheck") {
          const store = this.#getStore();
          return {
            action: "deliveryCheck",
            delivered: parsed.entryIds.filter((entryId) =>
              store.hasTaskBoardDelivery({ entryId, sessionId: parsed.sessionId }),
            ),
            acked: [
              ...store.taskBoardAckedIds(parsed.entryIds, [parsed.sessionId, parsed.agentId]),
            ],
            suppressed: store.isTaskBoardSuppressed({
              sessionId: parsed.sessionId,
              taskId: parsed.taskId,
            }),
          } as NmgMethodResult[M];
        }
        if (parsed.action === "recordDelivery") {
          this.#getStore().recordTaskBoardDelivery({
            entryId: parsed.entryId,
            sessionId: parsed.sessionId,
            source: parsed.source,
          });
          return { action: "recordDelivery", recorded: true } as NmgMethodResult[M];
        }
        if (parsed.action === "acknowledge") {
          this.#getStore().acknowledgeTaskBoardEntry({
            entryId: parsed.entryId,
            agentId: parsed.agentId,
            reason: parsed.reason,
          });
          return {
            action: "acknowledge",
            entry: this.#getStore().getTaskBoardEntryById(parsed.taskId, parsed.entryId)!,
          } as NmgMethodResult[M];
        }
        if (parsed.action === "unsubscribe") {
          this.#getStore().unsubscribeTaskBoard({
            sessionId: parsed.sessionId,
            taskId: parsed.taskId,
          });
          this.#getStore().suppressTaskBoard({
            sessionId: parsed.sessionId,
            taskId: parsed.taskId,
          });
          return { action: "unsubscribe", taskId: parsed.taskId } as NmgMethodResult[M];
        }
        if (parsed.action === "subscribe") {
          this.#getStore().subscribeTaskBoard({
            sessionId: parsed.sessionId,
            taskId: parsed.taskId,
          });
          this.#getStore().unsuppressTaskBoard({
            sessionId: parsed.sessionId,
            taskId: parsed.taskId,
          });
          return { action: "subscribe", taskId: parsed.taskId } as NmgMethodResult[M];
        }
        if (parsed.action === "registerAgent") {
          this.#getStore().registerTaskBoardAgent({
            id: parsed.id,
            agentName: parsed.agentName,
            description: parsed.description,
            version: parsed.version,
            url: parsed.url,
            capabilities: parsed.capabilities,
            skills: parsed.skills,
            supportedInterfaces: parsed.supportedInterfaces,
          });
          return {
            action: "registerAgent",
            agentName: parsed.agentName,
            id: parsed.id,
          } as NmgMethodResult[M];
        }
        if (parsed.action === "heartbeat") {
          this.#getStore().heartbeatTaskBoardAgent({ id: parsed.id });
          return { action: "heartbeat", agentName: "", id: parsed.id } as NmgMethodResult[M];
        }
        if (parsed.action === "rename") {
          this.#getStore().renameTaskBoardAgent({
            id: parsed.id,
            agentName: parsed.agentName,
          });
          return {
            action: "rename",
            agentName: parsed.agentName,
            id: parsed.id,
          } as NmgMethodResult[M];
        }
        if (parsed.action === "discover") {
          return {
            action: "discover",
            agents: this.#getStore().discoverTaskBoardAgents({
              capabilities: parsed.capabilities,
            }),
          } as NmgMethodResult[M];
        }
        if (parsed.action === "listSubscriptions") {
          return {
            action: "listSubscriptions",
            subscriptions: this.#getStore().listTaskBoardSubscriptions(parsed.sessionId),
          } as NmgMethodResult[M];
        }
        return {
          action: "resolve",
          entry: this.#getStore().resolveTaskBoardEntry(parsed),
        } as NmgMethodResult[M];
      }
      case "chainCreate":
        return this.#chainCreate(parseChainCreateParams(params)) as NmgMethodResult[M];
      case "chainAdd":
        return this.#chainAdd(parseChainAddParams(params)) as NmgMethodResult[M];
      case "chainGet":
        return this.#chainGet(parseChainGetParams(params)) as NmgMethodResult[M];
      case "chainList":
        return this.#chainList(parseChainListParams(params)) as NmgMethodResult[M];
      case "shutdown":
        this.#shutdownRequested = true;
        return { shuttingDown: true } as NmgMethodResult[M];
      default:
        throw new NmgProtocolError("METHOD_NOT_FOUND", `unknown method: ${String(method)}`);
    }
  }

  close(): void {
    for (const job of this.#maintenanceJobs.values()) clearImmediate(job);
    this.#maintenanceJobs.clear();
    this.#maintenanceSignals.clear();
    this.#store?.close();
    this.#store = undefined;
    for (const store of this.#stgStores.values()) store.close();
    this.#stgStores.clear();
    this.#activeGraphParts.clear();
  }

  #hello(): NmgHelloResult {
    return {
      protocol: NMG_PROTOCOL_VERSION,
      service: "node-memory-graph",
      version: SERVICE_VERSION,
      capabilities: NMG_CAPABILITIES,
    };
  }

  #status(): NmgStatusResult {
    const exists = existsSync(this.databasePath);
    const embeddingClient = this.#configuredEmbeddingClient();
    const provider = this.#configuredProvider();
    return {
      ...this.#hello(),
      process: { pid: process.pid, node: process.version },
      storage: {
        databasePath: this.databasePath,
        exists,
        bytes: exists ? statSync(this.databasePath).size : 0,
        loaded: this.#store !== undefined,
      },
      embedding: {
        configured: provider !== null,
        provider,
        indexId: embeddingClient?.indexId ?? null,
        health:
          embeddingClient && this.#store
            ? this.#store.embeddingIndexHealth(embeddingClient.indexId)
            : null,
        reason: this.#embeddingError,
      },
    };
  }

  #chainCreate(params: NmgChainCreateParams): MemoryChain {
    return this.#getStore().createMemoryChain({
      chainType: params.chainType,
      topic: params.topic,
      ownerSessionId: params.ownerSessionId,
    });
  }

  #chainAdd(params: NmgChainAddParams): MemoryChainMember {
    return this.#getStore().addMemoryToChain({
      chainId: params.chainId,
      memoryId: params.memoryId,
      position: params.position,
      note: params.note,
    });
  }

  #chainGet(
    params: NmgChainGetParams,
  ): { chain: MemoryChain; members: MemoryChainMember[] } | null {
    return this.#getStore().getMemoryChain(params.chainId);
  }

  #chainList(params: NmgChainListParams): MemoryChain[] {
    return this.#getStore().listMemoryChains({
      chainType: params.chainType,
      ownerSessionId: params.ownerSessionId,
    });
  }

  #remember(params: NmgRememberParams): NmgMethodResult["remember"] {
    const external = params.markers?.some((marker) => marker.kind === "external_source") ?? false;
    const assessment = assessMemoryWrite({
      statement: params.statement,
      evidence: params.evidence,
      memoryType: params.memoryType,
      bypass: params.unsafe,
    });
    if (!assessment.allowed) {
      this.#getStore().recordRejectedWrite({
        policyReason: assessment.reason,
        writeReason: params.writeReason ?? `cli_rejected_${params.memoryType ?? "fact"}`,
        writeSource: "user",
        memoryType: params.memoryType,
        requestedResidence: params.residence,
        sessionId: params.sessionId,
      });
      throw new NmgProtocolError("WRITE_REJECTED", assessment.reason);
    }
    const { projectDir, unsafe, ...memory } = params;
    const store =
      memory.residence === "stg" && projectDir
        ? this.#getStgStore(projectDir, memory.sessionId)
        : this.#getStore();
    // Escape hatch audit (docs §3.6): an explicit unsafe write leaves a
    // marker so the bypass is traceable, not a silent hole. The unsafe flag
    // itself never reaches the store layer (policy lives at the boundary).
    const bypassMarkers: MemoryMarker[] =
      params.unsafe
        ? [{ kind: "write_bypass", attributes: { policy: "unsafe" } }]
        : [];
    const result = store.remember({
      ...memory,
      markers: [...(memory.markers ?? []), ...bypassMarkers],
      // LTG rows are project/session-global: never attach a session_id. STG
      // rows keep the caller's sessionId (escape-hatch validated in the store).
      sessionId: store === this.#getStore() ? null : memory.sessionId,
      truthStatus: memory.truthStatus ?? (external ? "unverified" : undefined),
      writeReason: params.writeReason ?? `cli_confirmed_${params.memoryType ?? "fact"}`,
      writeSource: "user",
    });
    this.#signalMaintenance(store, "write");
    return result;
  }

  #signalMaintenance(store: NmgStore, kind: "write" | "access", force = false, count = 1): void {
    const state = this.#maintenanceSignals.get(store) ?? {
      writes: 0,
      accesses: 0,
      backlogChecked: false,
      localBatches: 0,
    };
    if (!force) {
      if (kind === "write") state.writes += Math.max(1, count);
      else state.accesses += Math.max(1, count);
    }
    this.#maintenanceSignals.set(store, state);
    const policy = configuredMaintenancePolicy(this.#environment);
    const { writeThreshold, accessThreshold } = policy;
    if (
      !force &&
      state.backlogChecked &&
      state.writes < writeThreshold &&
      state.accesses < accessThreshold
    ) {
      return;
    }
    if (this.#maintenanceJobs.has(store)) return;
    const job = setImmediate(() => {
      this.#maintenanceJobs.delete(store);
      try {
        const firstCheck = !state.backlogChecked;
        state.writes = 0;
        state.accesses = 0;
        state.backlogChecked = true;
        const { nodeLimit } = policy;
        const result = store.runDueMaintenance({
          writeThreshold,
          accessThreshold,
          nodeLimit,
        });
        if (result.consideredNodes > 0) state.localBatches += 1;
        if (
          firstCheck ||
          (result.consideredNodes > 0 && state.localBatches % policy.semanticEveryBatches === 0)
        ) {
          store.runSemanticMaintenance({
            expiryLimit: policy.expiryLimit,
            pairLimit: policy.pairLimit,
            topologyNodeLimit: policy.topologyNodeLimit,
            autoMerge: policy.autoMergeEnabled,
            autoMergeLimit: policy.autoMergeLimit,
          });
        }
        if (result.consideredNodes >= nodeLimit) this.#signalMaintenance(store, kind, true);
      } catch {
        // Maintenance is opportunistic. Dirty/delta counters remain durable and
        // the next write can retry; a failed batch must not fail remember.
      }
    });
    this.#maintenanceJobs.set(store, job);
  }

  #resolveRemember(params: NmgResolveRememberParams): NmgMethodResult["resolveRemember"] {
    const stores = params.projectDir
      ? [this.#getStgStore(params.projectDir, params.sessionId), this.#getStore()]
      : [this.#getStore()];
    if (params.action === "forget") {
      const store = stores.find(
        (candidate) => candidate.getMemory(params.memoryId, params.sessionId) !== null,
      );
      if (!store) {
        throw new NmgProtocolError("INVALID_PARAMS", `memory ${params.memoryId} does not exist`);
      }
      return {
        action: "forget",
        memoryId: params.memoryId,
        deleted: store.deleteMemory(params.memoryId) !== null,
      };
    }
    if (params.action === "resolve" || params.action === "reopen") {
      const store = stores.find(
        (candidate) => candidate.getMemory(params.memoryId, params.sessionId) !== null,
      );
      if (!store) {
        throw new NmgProtocolError("INVALID_PARAMS", `memory ${params.memoryId} does not exist`);
      }
      const state = store.setMemoryResolution(
        params.memoryId,
        params.action === "resolve" ? "resolved" : "reopened",
        {
          relatedMemoryIds: params.relatedMemoryIds,
          reason: params.reason,
        },
      );
      return { action: params.action, ...state };
    }
    const store = stores.find(
      (candidate) => candidate.getMemory(params.newMemoryId, params.sessionId) !== null,
    );
    if (!store) {
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        `new memory ${params.newMemoryId} does not exist`,
      );
    }
    const newer = store.getMemory(params.newMemoryId, params.sessionId);
    if (params.action === "relate") {
      const related = store.getMemory(params.relatedMemoryId, params.sessionId);
      if (!newer || !related) {
        throw new NmgProtocolError(
          "INVALID_PARAMS",
          "relation targets must exist in the same LTG or session-owned STG store",
        );
      }
      if (
        ["conflict", "refines", "same_entity"].includes(params.relationJudgement) &&
        !compatibleScope(newer.scope, related.scope)
      ) {
        throw new NmgProtocolError(
          "INVALID_PARAMS",
          `${params.relationJudgement} requires non-conflicting scope; use distinct for different entities or retain both memories`,
        );
      }
      if (params.relationJudgement === "conflict" && !overlappingValidity(newer, related)) {
        throw new NmgProtocolError(
          "INVALID_PARAMS",
          "conflict requires overlapping validity; sequential values should remain temporal states or use supersede",
        );
      }
      const relationType = {
        conflict: "contradicts",
        distinct: "distinct_from",
        refines: "refines",
        related: "related_to",
        same_entity: "same_as",
      } as const;
      const proposal = store.proposeSemanticRelation({
        sourceNodeId: newer.nodeId,
        targetNodeId: related.nodeId,
        relationType: relationType[params.relationJudgement],
        evidenceMemoryIds: [newer.id, related.id],
        confidence: params.confidence,
      });
      return {
        action: "relate",
        newMemoryId: newer.id,
        relatedMemoryId: related.id,
        proposal,
      };
    }
    const stale = store.getMemory(params.supersededMemoryId, params.sessionId);
    if (!newer || !stale) {
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        "supersession targets must exist in the same LTG or session-owned STG store",
      );
    }
    if (!sameScope(newer.scope, stale.scope)) {
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        "supersession requires identical scope; use distinct memories for different scopes",
      );
    }
    store.recordFeedback({
      sessionId: params.sessionId,
      supersede: {
        newMemoryId: params.newMemoryId,
        supersededMemoryId: params.supersededMemoryId,
        reason: params.reason,
      },
    });
    return {
      action: "supersede",
      newMemoryId: params.newMemoryId,
      supersededMemoryId: params.supersededMemoryId,
      applied:
        store.getMemory(params.supersededMemoryId, params.sessionId)?.status === "superseded",
    };
  }

  #recordClaimOutcomes(
    params: NmgRecordClaimOutcomesParams,
  ): NmgMethodResult["recordClaimOutcomes"] {
    const { projectDir, ...input } = params;
    const parts = params.activeGraphId
      ? this.#activeGraphParts.get(params.activeGraphId)
      : undefined;
    if (parts?.length) {
      const events: NmgMethodResult["recordClaimOutcomes"]["events"] = [];
      const posteriors: NmgMethodResult["recordClaimOutcomes"]["posteriors"] = [];
      const consolidationCandidates: string[] = [];
      const consolidatedMemories: Array<{ sourceMemoryId: string; memoryId: string }> = [];
      const retractedMemories: Array<{ sourceMemoryId: string; memoryId: string }> = [];
      const assigned = new Set<string>();
      for (const part of parts) {
        const votes = input.votes.filter((vote) => part.memoryIds.has(vote.memoryId));
        if (votes.length === 0) continue;
        votes.forEach((vote) => assigned.add(vote.memoryId));
        const result = part.store.recordClaimOutcomes({
          ...input,
          activeGraphId: part.traceId,
          votes,
        });
        events.push(...result.events);
        posteriors.push(...result.posteriors);
        this.#collectStgConsolidation(
          part.store,
          result.posteriors,
          consolidationCandidates,
          consolidatedMemories,
          retractedMemories,
          input.sessionId,
        );
      }
      const missing = input.votes.find((vote) => !assigned.has(vote.memoryId));
      if (missing) {
        throw new NmgProtocolError(
          "INVALID_PARAMS",
          `memory ${missing.memoryId} was not exposed by active graph ${params.activeGraphId}`,
        );
      }
      return {
        events,
        posteriors,
        consolidationCandidates,
        consolidatedMemories,
        retractedMemories,
      };
    }

    const stores = projectDir
      ? [this.#getStgStore(projectDir, params.sessionId), this.#getStore()]
      : [this.#getStore()];
    const grouped = new Map<NmgStore, typeof input.votes>();
    for (const vote of input.votes) {
      const store = stores.find(
        (candidate) => candidate.getMemory(vote.memoryId, params.sessionId) !== null,
      );
      if (!store)
        throw new NmgProtocolError("INVALID_PARAMS", `memory ${vote.memoryId} does not exist`);
      const bucket = grouped.get(store) ?? [];
      bucket.push(vote);
      grouped.set(store, bucket);
    }
    const events: NmgMethodResult["recordClaimOutcomes"]["events"] = [];
    const posteriors: NmgMethodResult["recordClaimOutcomes"]["posteriors"] = [];
    const consolidationCandidates: string[] = [];
    const consolidatedMemories: Array<{ sourceMemoryId: string; memoryId: string }> = [];
    const retractedMemories: Array<{ sourceMemoryId: string; memoryId: string }> = [];
    for (const [store, votes] of grouped) {
      const result = store.recordClaimOutcomes({ ...input, votes });
      events.push(...result.events);
      posteriors.push(...result.posteriors);
      this.#collectStgConsolidation(
        store,
        result.posteriors,
        consolidationCandidates,
        consolidatedMemories,
        retractedMemories,
        input.sessionId,
      );
    }
    return {
      events,
      posteriors,
      consolidationCandidates,
      consolidatedMemories,
      retractedMemories,
    };
  }

  #collectStgConsolidation(
    store: NmgStore,
    posteriors: readonly ClaimPosterior[],
    candidates: string[],
    consolidated: Array<{ sourceMemoryId: string; memoryId: string }>,
    retracted: Array<{ sourceMemoryId: string; memoryId: string }>,
    sessionId?: string,
  ): void {
    if (store === this.#getStore()) return;
    const policy = configuredStgConsolidationPolicy(this.#environment);
    const grouped = new Map<string, ClaimPosterior[]>();
    for (const posterior of posteriors) {
      const bucket = grouped.get(posterior.memoryId) ?? [];
      bucket.push(posterior);
      grouped.set(posterior.memoryId, bucket);
    }
    for (const [memoryId, claims] of grouped) {
      const eligible =
        claims.length > 0 &&
        claims.every(
          (claim) =>
            claim.independentVoteCount >= policy.minimumIndependentVotes &&
            claim.mean >= policy.minimumPosteriorMean &&
            claim.conservativeLowerBound >= policy.minimumConservativeLowerBound,
        );
      if (!eligible) {
        const retained =
          claims.length > 0 &&
          claims.every(
            (claim) =>
              claim.mean >= policy.minimumRetainedPosteriorMean &&
              claim.conservativeLowerBound >= policy.minimumRetainedConservativeLowerBound,
          );
        if (policy.enabled && !retained) {
          retracted.push(
            ...retractStgConsolidation(this.#getStore(), memoryId).map((retractedMemoryId) => ({
              sourceMemoryId: memoryId,
              memoryId: retractedMemoryId,
            })),
          );
        }
        continue;
      }
      candidates.push(memoryId);
      if (!policy.enabled) continue;
      const promoted = consolidateStgMemoryToLtg(store, this.#getStore(), memoryId, sessionId);
      if (
        promoted.memory.markers.some(
          (marker) =>
            marker.kind === "consolidated_from_stg" &&
            marker.attributes?.sourceMemoryId === memoryId,
        )
      ) {
        consolidated.push({ sourceMemoryId: memoryId, memoryId: promoted.memory.id });
      }
    }
  }

  async #search(params: NmgSearchParams): Promise<NmgMethodResult["search"]> {
    const { query, queries, projectDir, sessionId, ...options } = params;
    const searchOptions: SearchOptions = {
      ...options,
      sessionId,
      progressiveWarmDisclosure: options.progressiveWarmDisclosure ?? true,
    };
    const raws = [query, ...(queries ?? [])];
    const embedding = this.#configuredEmbeddingClient();
    const runOne = async (store: NmgStore, raw: string): Promise<MemoryContext> => {
      const { semantic, filters } = parseAdvancedQuery(raw);
      const ctx = await searchMemoryContext(store, embedding, semantic, searchOptions);
      ctx.results = applyAdvancedFilters(ctx.results, filters);
      return ctx;
    };
    const searchAcross = async (store: NmgStore, raw: string) => {
      const local = await runOne(store, raw);
      if (local.results.length > 0 && local.activeGraph?.qpp?.trigger === false) return local;
      const shared = await runOne(this.#getStore(), raw);
      if (local.results.length === 0) return shared;
      const merged = mergeStgLtgContexts(local, shared);
      if (merged.activeGraph) {
        this.#activeGraphParts.set(
          merged.activeGraph.id,
          [
            local.activeGraph
              ? {
                  store,
                  traceId: local.activeGraph.id,
                  memoryIds: new Set(local.activeGraph.memoryIds),
                }
              : undefined,
            shared.activeGraph
              ? {
                  store: this.#getStore(),
                  traceId: shared.activeGraph.id,
                  memoryIds: new Set(shared.activeGraph.memoryIds),
                }
              : undefined,
          ].filter(
            (part): part is { store: NmgStore; traceId: string; memoryIds: Set<string> } =>
              part !== undefined,
          ),
        );
      }
      return merged;
    };

    if (raws.length === 1) {
      if (!projectDir) return runOne(this.#getStore(), raws[0]!);
      return searchAcross(this.#getStgStore(projectDir, sessionId), raws[0]!);
    }

    // Multi-query fusion: primary keeps rank, extra clauses append unique
    // hits (their own order), then the hard limit is applied once.
    const primary = await runOne(this.#getStore(), raws[0]!);
    const seen = new Set(primary.results.map((result) => result.memory.id));
    for (let i = 1; i < raws.length; i += 1) {
      const extra = await runOne(this.#getStore(), raws[i]!);
      for (const result of extra.results) {
        if (seen.has(result.memory.id)) continue;
        seen.add(result.memory.id);
        primary.results.push(result);
      }
    }
    if (searchOptions.limit) primary.results = primary.results.slice(0, searchOptions.limit);
    return primary;
  }

  #get(params: NmgGetParams): NmgMethodResult["get"] {
    const sharedStore = this.#getStore();
    const localStore = params.projectDir
      ? this.#getStgStore(params.projectDir, params.sessionId)
      : undefined;
    const shared = sharedStore.getContext(params.memoryIds, params.graphHops ?? 0);
    const local = localStore
      ? localStore.getContext(params.memoryIds, params.graphHops ?? 0, params.sessionId)
      : undefined;
    const context = local ? mergeStgLtgContexts(local, shared) : shared;
    const found = new Set(context.results.map((result) => result.memory.id));
    if (params.activeGraphId) {
      const activeGraphId = params.activeGraphId;
      const parts = this.#activeGraphParts.get(activeGraphId);
      if (parts) {
        for (const part of parts) {
          const usedMemoryIds = [...found].filter((id) => part.memoryIds.has(id));
          part.store.recordActiveGraphUse(part.traceId, { usedMemoryIds }, params.sessionId);
          if (usedMemoryIds.length > 0) {
            this.#signalMaintenance(part.store, "access", false, usedMemoryIds.length);
          }
        }
        return {
          ...context,
          missingMemoryIds: params.memoryIds.filter((id) => !found.has(id)),
        };
      }
      const stores = [localStore, sharedStore].filter(
        (store): store is NmgStore => store !== undefined,
      );
      const traceStore = stores.find(
        (store) => store.traceOwnership(activeGraphId, params.sessionId) === "owned",
      );
      if (!traceStore) {
        const exists = stores.some(
          (store) => store.traceOwnership(activeGraphId, params.sessionId) !== "absent",
        );
        throw new NmgProtocolError(
          "NOT_FOUND",
          exists
            ? `active graph ${activeGraphId} belongs to another session`
            : `active graph ${activeGraphId} does not exist`,
        );
      }
      traceStore.recordActiveGraphUse(
        activeGraphId,
        { usedMemoryIds: [...found] },
        params.sessionId,
      );
      if (found.size > 0) this.#signalMaintenance(traceStore, "access", false, found.size);
    }
    return {
      ...context,
      missingMemoryIds: params.memoryIds.filter((id) => !found.has(id)),
    };
  }

  #recordActiveGraphUse(
    params: NmgRecordActiveGraphUseParams,
  ): NmgMethodResult["recordActiveGraphUse"] {
    // QPP agent-end implicit feedback (deriveUsedMemoryIds in the harness):
    // record which recalled memories actually surfaced in the final answer.
    const sharedStore = this.#getStore();
    const localStore = params.projectDir
      ? this.#getStgStore(params.projectDir, params.sessionId)
      : undefined;
    // isTraceOwned never throws on a foreign trace (vs retrievalTrace which
    // does), so a foreign-session trace in the STG cannot abort the search
    // for the real owner in the LTG. Record on EVERY owning store, not just
    // the first match: in a merged STG+LTG retrieval the same activeGraphId
    // can carry a trace in both stores, and the LTG (authoritative) side must
    // not lose its calibration sample.
    const stores = localStore ? [localStore, sharedStore] : [sharedStore];
    const owned = stores.filter(
      (store) => store.traceOwnership(params.activeGraphId, params.sessionId) === "owned",
    );
    if (owned.length === 0) {
      const exists = stores.some(
        (store) => store.traceOwnership(params.activeGraphId, params.sessionId) !== "absent",
      );
      throw new NmgProtocolError(
        "NOT_FOUND",
        exists
          ? `active graph ${params.activeGraphId} belongs to another session`
          : `active graph ${params.activeGraphId} does not exist`,
      );
    }
    for (const store of owned) {
      store.recordActiveGraphUse(
        params.activeGraphId,
        { usedMemoryIds: params.usedMemoryIds },
        params.sessionId,
      );
      if (params.usedMemoryIds.length > 0) {
        this.#signalMaintenance(store, "access", false, params.usedMemoryIds.length);
      }
    }
    return { activeGraphId: params.activeGraphId, usedMemoryIds: params.usedMemoryIds };
  }

  #getStore(): NmgStore {
    return (this.#store ??= new NmgStore(this.databasePath));
  }

  #getStgStore(projectDir: string, _sessionId = "cli"): NmgStore {
    // STG v2 shared store: one NmgStore instance per project file
    // (<project>/.nmg/stg.sqlite). Session isolation is row-level via
    // memory_records.session_id (docs/stg-shared-store-v2 §3), so the
    // sessionId parameter no longer selects a store. Call sites keep passing
    // it for remember/search filtering — it is consumed by the store methods,
    // not the file path.
    const resolved = resolve(projectDir);
    let store = this.#stgStores.get(resolved);
    if (!store) {
      store = createStgStore(resolved, undefined, _sessionId);
      this.#stgStores.set(resolved, store);
    }
    return store;
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

function parseRememberParams(value: unknown): NmgRememberParams {
  const params = objectParams(value);
  const parsed: NmgRememberParams = {
    statement: requiredString(params, "statement"),
    nodeName: requiredString(params, "nodeName"),
    memoryType: optionalEnum(params, "memoryType", MEMORY_TYPES),
    stateKey: optionalString(params, "stateKey"),
    eventTime: optionalString(params, "eventTime"),
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
    sessionId: optionalString(params, "sessionId"),
    sourceRef: optionalString(params, "sourceRef"),
    markers: optionalMarkers(params, "markers"),
    unsafe: optionalBoolean(params, "unsafe"),
    projectDir: optionalString(params, "projectDir"),
  };
  if (parsed.memoryType === "state" && !parsed.stateKey) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      "state memories require stateKey naming one replaceable property within scope (not a topic/group)",
    );
  }
  return parsed;
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

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return (
    JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort())
  );
}

function parseExportMemoriesParams(value: unknown): NmgExportMemoriesParams {
  const params = objectParams(value);
  return {
    sourceActor: optionalEnum(params, "sourceActor", MEMORY_ACTORS),
    includeDeleted: optionalBoolean(params, "includeDeleted"),
  };
}

function compatibleScope(left: MemoryScope, right: MemoryScope): boolean {
  return Object.entries(left).every(
    ([key, value]) => right[key] === undefined || right[key] === value,
  );
}

function overlappingValidity(
  left: { eventTime: string | null; validFrom: string | null; validUntil: string | null },
  right: { eventTime: string | null; validFrom: string | null; validUntil: string | null },
): boolean {
  const interval = (memory: typeof left) => {
    const start = Date.parse(memory.validFrom ?? memory.eventTime ?? "0001-01-01T00:00:00.000Z");
    const end = Date.parse(memory.validUntil ?? memory.eventTime ?? "9999-12-31T23:59:59.999Z");
    return { start, end };
  };
  const a = interval(left);
  const b = interval(right);
  return a.start <= b.end && b.start <= a.end;
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
    votes: rawVotes.map((rawVote) => {
      const vote = objectParams(rawVote);
      return {
        memoryId: requiredString(vote, "memoryId"),
        claimIndexes: optionalIntegerArray(vote, "claimIndexes", 0),
        outcome: requiredEnum(vote, "outcome", CLAIM_OUTCOMES),
        source: requiredEnum(vote, "source", CLAIM_OUTCOME_SOURCES),
        sourceLineage: requiredString(vote, "sourceLineage"),
        weight: optionalNumber(vote, "weight", Number.EPSILON, 1),
      };
    }),
  };
}

function parseSearchParams(value: unknown): NmgSearchParams {
  const params = objectParams(value);
  return {
    query: requiredString(params, "query"),
    queries: optionalStringArray(params, "queries"),
    nodeName: optionalString(params, "nodeName"),
    scope: optionalScope(params, "scope"),
    sourceActor: optionalEnum(params, "sourceActor", MEMORY_ACTORS),
    includeHistorical: optionalBoolean(params, "includeHistorical"),
    maxTier: optionalInteger(params, "maxTier", 0, 3) as MemoryTier | undefined,
    limit: optionalInteger(params, "limit", 1, 50),
    graphHops: optionalInteger(params, "graphHops", 0, 3),
    retrievalMode: optionalEnum(params, "retrievalMode", RETRIEVAL_MODES),
    vectorGranularity: optionalEnum(params, "vectorGranularity", VECTOR_GRANULARITIES),
    secondPass: optionalBoolean(params, "secondPass"),
    initialEvidenceTarget: optionalInteger(params, "initialEvidenceTarget", 1, 50),
    strongHitTopGap: optionalNumber(params, "strongHitTopGap", 0, 1),
    strongHitInitialTarget: optionalInteger(params, "strongHitInitialTarget", 1, 50),
    progressiveWarmDisclosure: optionalBoolean(params, "progressiveWarmDisclosure"),
    tieredDisclosure: optionalBoolean(params, "tieredDisclosure"),
    persistTrace: optionalBoolean(params, "persistTrace"),
    activeGraphBudget: optionalActiveGraphBudget(params, "activeGraphBudget"),
    perf: optionalBoolean(params, "perf"),
    projectDir: optionalString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
  };
}

function parsePerfPruneParams(value: unknown): { maxDays?: number; maxRows?: number } {
  const params = objectParams(value);
  return {
    maxDays: optionalInteger(params, "maxDays", 1, 3650),
    maxRows: optionalInteger(params, "maxRows", 100, 1_000_000),
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

function parseChainCreateParams(value: unknown): NmgChainCreateParams {
  const params = objectParams(value);
  const chainType = params.chainType;
  if (chainType !== "temporal" && chainType !== "logical") {
    throw new NmgProtocolError("INVALID_PARAMS", "chainType must be 'temporal' or 'logical'");
  }
  return {
    chainType,
    topic: requiredString(params, "topic"),
    ownerSessionId: optionalString(params, "ownerSessionId"),
    projectDir: optionalString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
  };
}

function parseChainAddParams(value: unknown): NmgChainAddParams {
  const params = objectParams(value);
  return {
    chainId: requiredString(params, "chainId"),
    memoryId: requiredString(params, "memoryId"),
    position: optionalInteger(params, "position", 0, 100_000),
    note: optionalString(params, "note"),
    projectDir: optionalString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
  };
}

function parseChainGetParams(value: unknown): NmgChainGetParams {
  const params = objectParams(value);
  return {
    chainId: requiredString(params, "chainId"),
    projectDir: optionalString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
  };
}

function parseChainListParams(value: unknown): NmgChainListParams {
  const params = objectParams(value);
  const chainType = params.chainType;
  if (chainType !== undefined && chainType !== "temporal" && chainType !== "logical") {
    throw new NmgProtocolError("INVALID_PARAMS", "chainType must be 'temporal' or 'logical'");
  }
  return {
    chainType: chainType as "temporal" | "logical" | undefined,
    ownerSessionId: optionalString(params, "ownerSessionId"),
    projectDir: optionalString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
  };
}

function parseRecordActiveGraphUseParams(value: unknown): NmgRecordActiveGraphUseParams {
  const params = objectParams(value);
  return {
    activeGraphId: requiredString(params, "activeGraphId"),
    // An empty list is meaningful negative feedback: recall happened, but no
    // candidate was used in the final answer.
    usedMemoryIds: requiredStringArray(params, "usedMemoryIds", 0, 10_000),
    projectDir: optionalString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
  };
}

function parseSyncStgParams(value: unknown): NmgSyncStgParams {
  const params = objectParams(value);
  const scope = optionalScope(params, "scope");
  if (!scope || Object.keys(scope).length === 0) {
    throw new NmgProtocolError("INVALID_PARAMS", "scope is required");
  }
  return {
    projectDir: requiredString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
    scope,
    limit: optionalInteger(params, "limit", 1, 200),
  };
}

function parseStgPurgeSessionParams(value: unknown): NmgStgPurgeSessionParams {
  const params = objectParams(value);
  return {
    projectDir: requiredString(params, "projectDir"),
    sessionId: requiredString(params, "sessionId"),
  };
}

function parseTaskBoardParams(value: unknown): NmgTaskBoardParams {
  const params = objectParams(value);
  const action = requiredEnum(params, "action", [
    "put",
    "read",
    "readDirected",
    "resolve",
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
    "heartbeat",
    "rename",
    "discover",
  ] as const);
  if (action === "registerAgent") {
    return {
      action,
      id: requiredString(params, "id"),
      agentName: requiredString(params, "agentName"),
      description: optionalString(params, "description"),
      version: optionalString(params, "version"),
      url: optionalString(params, "url"),
      capabilities: optionalString(params, "capabilities"),
      skills: optionalString(params, "skills"),
      supportedInterfaces: optionalString(params, "supportedInterfaces"),
    };
  }
  if (action === "heartbeat") {
    return { action, id: requiredString(params, "id") };
  }
  if (action === "rename") {
    return {
      action,
      id: requiredString(params, "id"),
      agentName: requiredString(params, "agentName"),
    };
  }
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
  if (action === "readDirected") {
    return {
      action,
      agentId,
      agentName: requiredString(params, "agentName"),
      limit: optionalInteger(params, "limit", 1, 200),
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
  if (action === "recordDelivery") {
    return {
      action,
      agentId,
      sessionId: requiredString(params, "sessionId"),
      entryId: requiredString(params, "entryId"),
      source: optionalString(params, "source"),
    };
  }
  if (action === "unsubscribe" || action === "subscribe") {
    return {
      action,
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
  if (action === "put") {
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
      action,
      content: requiredString(params, "content"),
      kind: optionalEnum(params, "kind", TASK_BOARD_KINDS),
      sourceSessionId: optionalString(params, "sourceSessionId"),
      to: optionalString(params, "to"),
      ttlSeconds,
      expiresAt,
    };
  }
  if (action === "read") {
    return {
      ...base,
      action,
      afterCursor: optionalInteger(params, "afterCursor", 0, Number.MAX_SAFE_INTEGER),
      limit: optionalInteger(params, "limit", 1, 200),
      includeResolved: optionalBoolean(params, "includeResolved"),
    };
  }
  const entryBase = {
    ...base,
    action,
    entryId: requiredString(params, "entryId"),
  };
  if (action === "claim") {
    return {
      ...entryBase,
      action,
      leaseSeconds: optionalInteger(params, "leaseSeconds", 60, 86_400),
    };
  }
  if (action === "acknowledge") {
    return {
      ...entryBase,
      action,
      reason: optionalString(params, "reason"),
    };
  }
  return {
    ...entryBase,
    action,
    resolution: optionalString(params, "resolution"),
  };
}

function parseRetentionCandidatesParams(value: unknown): NmgRetentionCandidatesParams {
  const params = objectParams(value);
  return {
    dormantAfterDays: optionalInteger(params, "dormantAfterDays", 1, 36500),
    quarantineAfterDays: optionalInteger(params, "quarantineAfterDays", 1, 36500),
    maximumImportance: optionalNumber(params, "maximumImportance", 0, 1),
    maximumAccessCount: optionalInteger(params, "maximumAccessCount", 0, 1_000_000_000),
  };
}

function parseSetStorageStateParams(value: unknown): NmgSetStorageStateParams {
  const params = objectParams(value);
  return {
    memoryId: requiredString(params, "memoryId"),
    storageState: optionalEnum(params, "storageState", MEMORY_STORAGE_STATES) ?? "indexed",
    recoveryDays: optionalInteger(params, "recoveryDays", 0, 36500),
  };
}

function parseDeleteMemoryParams(value: unknown): NmgDeleteMemoryParams {
  return { memoryId: requiredString(objectParams(value), "memoryId") };
}

function parseMergeNodesParams(value: unknown): NmgMergeNodesParams {
  const params = objectParams(value);
  return {
    sourceNodeIds: requiredStringArray(params, "sourceNodeIds", 2, 100),
    targetName: requiredString(params, "targetName"),
    targetKind: optionalEnum(params, "targetKind", MEMORY_NODE_KINDS),
    summary: optionalString(params, "summary"),
  };
}

function parseRollbackNodeTransformParams(value: unknown): NmgRollbackNodeTransformParams {
  return { transformId: requiredString(objectParams(value), "transformId") };
}

function parseSplitNodeParams(value: unknown): NmgSplitNodeParams {
  const params = objectParams(value);
  if (!Array.isArray(params.partitions) || params.partitions.length < 2) {
    throw new NmgProtocolError("INVALID_PARAMS", "partitions must contain at least two entries");
  }
  return {
    sourceNodeId: requiredString(params, "sourceNodeId"),
    partitions: params.partitions.map((value) => {
      const partition = objectParams(value);
      return {
        nodeName: requiredString(partition, "nodeName"),
        memoryIds: requiredStringArray(partition, "memoryIds", 1, 10_000),
        nodeKind: optionalEnum(partition, "nodeKind", MEMORY_NODE_KINDS),
        summary: optionalString(partition, "summary"),
      };
    }),
  };
}

function objectParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NmgProtocolError("INVALID_PARAMS", "params must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key);
  if (!value) throw new NmgProtocolError("INVALID_PARAMS", `${key} is required`);
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be a non-empty string`);
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
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be an array of non-empty strings`);
  }
  return value.map((entry) => String(entry).trim());
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
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be a boolean`);
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
    );
  }
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
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be an integer`);
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
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be one of: ${allowed.join(", ")}`);
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
