import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  configuredProvider,
  createEmbeddingClientFromEnv,
  type EmbeddingClient,
} from "../core/embedding-provider.ts";
import {
  syncLeafEmbeddings,
  syncNodeEmbeddings,
  syncRecordEmbeddings,
} from "../core/embedding-sync.ts";
import {
  createLeafSummaryProviderFromEnv,
  drainLeafSummaries,
} from "../integration/leaf-summarizer.ts";
import {
  createNodeSummaryProviderFromEnv,
  drainNodeSummaries,
} from "../integration/node-summarizer.ts";
import type {
  TesseraInput,
  TesseraHit,
  LeafSummaryProvider,
  NodeSummaryProvider,
  RememberInput,
} from "../core/types.ts";
import { NmgStore } from "../core/store.ts";
import {
  SessionActiveGraphRuntime,
  type ActiveGraphProjectionPart,
} from "../core/session-active-graph.ts";
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
  MEMORY_WRITE_SOURCES,
  TASK_BOARD_KINDS,
  RETRIEVAL_MODES,
  TRUTH_STATUSES,
  VECTOR_GRANULARITIES,
  type ActiveGraphBudget,
  type ClaimPosterior,
  type MemoryChain,
  type MemoryChainEdge,
  type MemoryChainMember,
  type MemoryContext,
  type MemoryScope,
  type MemoryMarker,
  type MemoryTier,
  type SearchOptions,
} from "../core/types.ts";
import { assessMemoryWrite } from "../core/write-policy.ts";
import {
  MemoryGraphReasoner,
  type LogicExpr,
  type MemoryNode as ReasonerMemoryNode,
} from "../lab/memory-graph-reasoner.ts";
import { scopesOverlap, validityIntervalsOverlap } from "../core/semantic-domain.ts";
import { sameScope } from "../core/scope.ts";
import { normalizeRecallTriggers } from "../core/recall-triggers.ts";
import { searchMemoryContext } from "../integration/search.ts";
import { simhash64, simhashToHex, simhashFromHex, hammingDistance } from "../core/simhash.ts";
import { ControllerPolicyChannel } from "../integration/controller-channel.ts";
import {
  LAB_CAPABILITIES,
  LabActivationAuthority,
  type LabCapability,
} from "../integration/lab-capabilities.ts";
import { ReasoningWorkspaces } from "../integration/reasoning-workspaces.ts";
import {
  configuredGraphHops,
  configuredMaintenancePolicy,
  configuredStgConsolidationPolicy,
  configuredStgSyncPolicy,
} from "../integration/config.ts";
import { applyAdvancedFilters, parseAdvancedQuery } from "../core/store/advanced-query.ts";
import {
  NMG_CAPABILITIES,
  NMG_METHODS,
  NMG_RPC_CATALOG_FINGERPRINT,
  MEMORY_RELATION_JUDGEMENTS,
  NMG_PROTOCOL_VERSION,
  NmgProtocolError,
  type NmgChainAddParams,
  type NmgChainCreateParams,
  type NmgChainEdgeAddParams,
  type NmgChainEdgeRemoveParams,
  type NmgChainGetParams,
  type NmgChainListParams,
  type NmgChainRemoveParams,
  type NmgGetParams,
  type NmgRecordActiveGraphAttributionParams,
  type NmgHelloResult,
  type NmgLabParams,
  type NmgDeleteMemoryParams,
  type NmgExportMemoriesParams,
  type NmgMethod,
  type NmgMethodResult,
  type NmgMergeNodesParams,
  type NmgMemoryMaintenanceProposalParams,
  type NmgRememberParams,
  type NmgRememberBatchParams,
  type NmgRecordClaimOutcomesParams,
  type NmgResolveRememberParams,
  type NmgRollbackNodeTransformParams,
  type NmgRetentionCandidatesParams,
  type NmgSearchParams,
  type NmgSessionActiveGraphParams,
  type NmgSetStorageStateParams,
  type NmgSplitNodeParams,
  type NmgStatusResult,
  type NmgSyncStgParams,
  type NmgStgPurgeSessionParams,
  type NmgTaskBoardParams,
  type NmgTopologyProposalParams,
} from "./protocol.ts";
import { resolveNmgDataDir } from "./data-path.ts";

const SERVICE_VERSION = "0.1.0";
type ActiveGraphStorePart = { store: NmgStore; traceId: string; memoryIds: Set<string> };
export interface NmgServiceOptions {
  dataDirectory?: string;
  databasePath?: string;
  environment?: NodeJS.ProcessEnv;
}

export class NmgService {
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
  readonly #reasoningWorkspaces: ReasoningWorkspaces;
  #labShadowController: ControllerPolicyChannel | undefined;
  #store: NmgStore | undefined;
  readonly #stgStores = new Map<string, NmgStore>();
  readonly #sessionActiveGraphs = new SessionActiveGraphRuntime<NmgStore>();
  #embeddingClient: EmbeddingClient | undefined | null;
  #embeddingError: string | null = null;
  /** When the embedding provider last failed; search skips provider calls
   *  until this cooldown elapses so a down/rate-limited provider cannot hang
   *  or fail every query. Mirrors degrade-on-persistent-failure practice. */
  #embeddingCooldownUntil = 0;
  readonly #embeddingCooldownMs = 30_000;
  #summaryProvider: LeafSummaryProvider | undefined | null;
  readonly #summaryDrains = new Set<NmgStore>();
  #nodeSummaryProvider: NodeSummaryProvider | undefined | null;
  readonly #nodeSummaryDrains = new Set<NmgStore>();
  readonly #embeddingDrains = new Set<NmgStore>();
  /** Project roots whose tessera SimHash backfill pass already ran. One batched
   *  pass per root per process: rows are stamped once, then never revisited. */
  readonly #tesseraBackfillRoots = new Set<string>();
  readonly #stgSyncTimes = new WeakMap<NmgStore, Map<string, number>>();
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
    this.#dataDirectory = dataDirectory;
    this.#environment = environment;
    this.#reasoningWorkspaces = new ReasoningWorkspaces(join(dataDirectory, "lab", "reasoning"));
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
      case "rememberBatch":
        return this.#rememberBatch(parseRememberBatchParams(params)) as NmgMethodResult[M];
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
      case "recordActiveGraphAttribution":
        return this.#recordActiveGraphAttribution(
          parseRecordActiveGraphAttributionParams(params),
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
      case "topologyProposal": {
        const parsed = parseTopologyProposalParams(params);
        if (parsed.action === "list") {
          return {
            action: "list",
            proposals: this.#getStore().topologyProposals(parsed.status),
          } as NmgMethodResult[M];
        }
        if (parsed.action === "assess") {
          return {
            action: "assess",
            assessment: this.#getStore().assessAutomaticMergeProposal(parsed.proposalId, {
              minimumObservations: parsed.minimumObservations,
              minimumEstimatedGain: parsed.minimumEstimatedGain,
              minimumEvidenceMemories: parsed.minimumEvidenceMemories,
            }),
          } as NmgMethodResult[M];
        }
        if (parsed.action === "review") {
          return {
            action: "review",
            proposal: this.#getStore().reviewTopologyProposal(parsed.proposalId, parsed.decision),
          } as NmgMethodResult[M];
        }
        return {
          action: "actuate",
          transform: this.#getStore().actuateAutomaticMergeProposal(parsed.proposalId),
        } as NmgMethodResult[M];
      }
      case "memoryMaintenanceProposal": {
        const parsed = parseMemoryMaintenanceProposalParams(params);
        if (parsed.action === "list") {
          return {
            action: "list",
            proposals: this.#getStore().memoryMaintenanceProposals(parsed.status),
          } as NmgMethodResult[M];
        }
        if (parsed.action === "review") {
          return {
            action: "review",
            proposal: this.#getStore().reviewMemoryMaintenanceProposal(
              parsed.proposalId,
              parsed.decision,
              parsed.reason,
            ),
          } as NmgMethodResult[M];
        }
        return {
          action: "propose",
          proposal: this.#getStore().createMemoryMaintenanceProposal({
            defectType: parsed.defectType,
            action: parsed.maintenanceAction,
            targetMemoryIds: parsed.targetMemoryIds,
            evidenceMemoryIds: parsed.evidenceMemoryIds,
            evidenceTraceIds: parsed.evidenceTraceIds,
            proposedStatement: parsed.proposedStatement,
            proposedScope: parsed.proposedScope,
            policy: parsed.policy,
            longHorizonScore: parsed.longHorizonScore,
            evaluationKind: parsed.evaluationKind,
            evaluationRef: parsed.evaluationRef,
          }),
        } as NmgMethodResult[M];
      }
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
      case "chainRemove":
        return this.#chainRemove(parseChainRemoveParams(params)) as NmgMethodResult[M];
      case "chainEdgeAdd":
        return this.#chainEdgeAdd(parseChainEdgeAddParams(params)) as NmgMethodResult[M];
      case "chainEdgeRemove":
        return this.#chainEdgeRemove(parseChainEdgeRemoveParams(params)) as NmgMethodResult[M];
      case "chainGet":
        return this.#chainGet(parseChainGetParams(params)) as NmgMethodResult[M];
      case "chainList":
        return this.#chainList(parseChainListParams(params)) as NmgMethodResult[M];
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
    this.#sessionActiveGraphs.clear();
  }

  #hello(): NmgHelloResult {
    return {
      protocol: NMG_PROTOCOL_VERSION,
      service: "node-memory-graph",
      version: SERVICE_VERSION,
      capabilities: NMG_CAPABILITIES,
      methods: NMG_METHODS,
      catalogFingerprint: NMG_RPC_CATALOG_FINGERPRINT,
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

  #lab(params: NmgLabParams): NmgMethodResult["lab"] {
    if (params.action === "list") {
      return { action: "list", capabilities: this.#labAuthority.list() };
    }
    if (params.action === "status") {
      return {
        action: "status",
        activation: this.#labAuthority.status(params.capability, params.sessionId),
      };
    }
    if (params.action === "enable") {
      return {
        action: "enable",
        activation: this.#labAuthority.enable({
          capability: params.capability,
          scope: params.scope ?? "session",
          sessionId: params.sessionId,
          requester: params.requester,
          reason: params.reason,
          ttlSeconds: params.ttlSeconds,
        }),
      };
    }
    if (params.action === "disable") {
      return {
        action: "disable",
        activation: this.#labAuthority.disable(params.capability, params.sessionId),
      };
    }

    this.#labAuthority.requireEnabled(params.capability, params.sessionId);
    const output = this.#invokeLabCapability(
      params.capability,
      params.sessionId,
      params.operation,
      params.input,
    );
    return { action: "invoke", capability: params.capability, operation: params.operation, output };
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
    const envelope = { projectionId, agId: projection.agId, persisted: false } as const;
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

  #sessionActiveGraph(params: NmgSessionActiveGraphParams): NmgMethodResult["sessionActiveGraph"] {
    if (params.action === "observe") {
      return { action: "observe", ...this.#sessionActiveGraphs.observe(params) };
    }
    if (params.action === "snapshot") {
      return { action: "snapshot", snapshot: this.#sessionActiveGraphs.snapshot(params.sessionId) };
    }
    if (params.action === "activate") {
      return {
        action: "activate",
        snapshot: this.#sessionActiveGraphs.activateTemporaryProjection(params.sessionId),
      };
    }
    if (params.action === "beginDisclosureTurn") {
      return {
        action: "beginDisclosureTurn",
        turn: this.#sessionActiveGraphs.beginDisclosureTurn(params.sessionId),
      };
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
    this.#store?.clearSessionActivation(params.sessionId);
    for (const store of this.#stgStores.values()) store.clearSessionActivation(params.sessionId);
    return { action: "release", released };
  }

  #chainCreate(params: NmgChainCreateParams): MemoryChain {
    const { store, ownerSessionId } = this.#chainStore(params);
    if (
      ownerSessionId !== undefined &&
      params.ownerSessionId !== undefined &&
      params.ownerSessionId !== ownerSessionId
    ) {
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        "an STG chain owner must match the requesting session",
      );
    }
    return store.createMemoryChain({
      chainType: params.chainType,
      topic: params.topic,
      ownerSessionId: ownerSessionId ?? params.ownerSessionId,
    });
  }

  #chainAdd(params: NmgChainAddParams): MemoryChainMember {
    const { store, ownerSessionId } = this.#chainStore(params);
    this.#assertChainAccess(store, params.chainId, ownerSessionId);
    this.#assertChainMemoryAccess(store, params.memoryId, ownerSessionId);
    return store.addMemoryToChain({
      chainId: params.chainId,
      memoryId: params.memoryId,
      position: params.position,
      note: params.note,
    });
  }

  #chainRemove(params: NmgChainRemoveParams): { removed: boolean } {
    const { store, ownerSessionId } = this.#chainStore(params);
    this.#assertChainAccess(store, params.chainId, ownerSessionId);
    return { removed: store.removeMemoryFromChain(params) };
  }

  #chainEdgeAdd(params: NmgChainEdgeAddParams): MemoryChainEdge {
    const { store, ownerSessionId } = this.#chainStore(params);
    this.#assertChainAccess(store, params.chainId, ownerSessionId);
    this.#assertChainMemoryAccess(store, params.sourceMemoryId, ownerSessionId);
    this.#assertChainMemoryAccess(store, params.targetMemoryId, ownerSessionId);
    return store.addMemoryChainEdge(params);
  }

  #chainEdgeRemove(params: NmgChainEdgeRemoveParams): { removed: boolean } {
    const { store, ownerSessionId } = this.#chainStore(params);
    this.#assertChainAccess(store, params.chainId, ownerSessionId);
    return { removed: store.removeMemoryChainEdge(params) };
  }

  #chainGet(params: NmgChainGetParams): NmgMethodResult["chainGet"] {
    const { store, ownerSessionId } = this.#chainStore(params);
    const result = store.getMemoryChain(params.chainId);
    if (!result) return null;
    this.#assertChainAccess(store, params.chainId, ownerSessionId);
    return {
      ...result,
      edges: store.getMemoryChainEdges(params.chainId),
      topologicalOrder: store.topologicalChainOrder(params.chainId),
    };
  }

  #chainList(params: NmgChainListParams): MemoryChain[] {
    const { store, ownerSessionId } = this.#chainStore(params);
    if (
      ownerSessionId !== undefined &&
      params.ownerSessionId !== undefined &&
      params.ownerSessionId !== ownerSessionId
    ) {
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        "an STG chain owner filter must match the requesting session",
      );
    }
    return store.listMemoryChains({
      chainType: params.chainType,
      ownerSessionId: ownerSessionId ?? params.ownerSessionId,
    });
  }

  #chainStore(params: { projectDir?: string; sessionId?: string }): {
    store: NmgStore;
    ownerSessionId?: string;
  } {
    if (!params.projectDir) return { store: this.#getStore() };
    const ownerSessionId = params.sessionId?.trim() || "cli";
    return {
      store: this.#getStgStore(params.projectDir, ownerSessionId),
      ownerSessionId,
    };
  }

  #assertChainAccess(store: NmgStore, chainId: string, ownerSessionId?: string): void {
    const result = store.getMemoryChain(chainId);
    if (!result) {
      throw new NmgProtocolError("NOT_FOUND", `memory chain ${chainId} does not exist`);
    }
    if (ownerSessionId !== undefined && result.chain.ownerSessionId !== ownerSessionId) {
      throw new NmgProtocolError("NOT_FOUND", `memory chain ${chainId} belongs to another session`);
    }
  }

  #assertChainMemoryAccess(store: NmgStore, memoryId: string, ownerSessionId?: string): void {
    if (!store.getMemory(memoryId, ownerSessionId)) {
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        `memory ${memoryId} does not exist in the chain's storage and session scope`,
      );
    }
  }

  #remember(params: NmgRememberParams): NmgMethodResult["remember"] {
    const prepared = this.#prepareRemember(params);
    const result = prepared.store.remember(prepared.input);
    this.#signalMaintenance(prepared.store, "write");
    return result;
  }

  #rememberBatch(params: NmgRememberBatchParams): NmgMethodResult["rememberBatch"] {
    const prepared = params.items.map((item) => this.#prepareRemember(item));
    const store = prepared[0]!.store;
    if (prepared.some((item) => item.store !== store)) {
      throw new NmgProtocolError(
        "INVALID_PARAMS",
        "rememberBatch items must target one physical memory store",
      );
    }
    const results = store.rememberMany(prepared.map((item) => item.input));
    this.#signalMaintenance(store, "write", false, results.length);
    return { results };
  }

  #prepareRemember(params: NmgRememberParams): { store: NmgStore; input: RememberInput } {
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
        writeSource: params.writeSource ?? "agent",
        memoryType: params.memoryType,
        requestedResidence: params.residence,
        sessionId: params.sessionId,
      });
      throw new NmgProtocolError("WRITE_REJECTED", assessment.reason);
    }
    const { projectDir, ...memory } = params;
    delete memory.unsafe;
    const store =
      memory.residence === "stg" && projectDir
        ? this.#getStgStore(projectDir, memory.sessionId)
        : this.#getStore();
    // Escape hatch audit (docs §3.6): an explicit unsafe write leaves a
    // marker so the bypass is traceable, not a silent hole. The unsafe flag
    // itself never reaches the store layer (policy lives at the boundary).
    const bypassMarkers: MemoryMarker[] = params.unsafe
      ? [{ kind: "write_bypass", attributes: { policy: "unsafe" } }]
      : [];
    // Best-effort SimHash drift fingerprint: computed at write time from the
    // project file when a project root is known, so a later snippet relocation
    // can survive a small edit or file move. Absent for project-less writes —
    // the tessera still writes, without drift tolerance.
    const tesserae = this.#withTesseraSimhashes(memory.tesserae, projectDir);
    const input: RememberInput = {
      ...memory,
      tesserae,
      markers: [...(memory.markers ?? []), ...bypassMarkers],
      // LTG rows are project/session-global: never attach a session_id. STG
      // rows keep the caller's sessionId (escape-hatch validated in the store).
      sessionId: store === this.#getStore() ? null : memory.sessionId,
      truthStatus: memory.truthStatus ?? (external ? "unverified" : undefined),
      writeReason: params.writeReason ?? `cli_confirmed_${params.memoryType ?? "fact"}`,
      writeSource: params.writeSource ?? "agent",
    };
    return { store, input };
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
    // Every write/access tops up a bounded embedding batch immediately,
    // independent of the maintenance thresholds below — so a low-activity
    // store still converges toward a complete index and a new memory becomes
    // vector-searchable within one operation cycle.
    this.#drainEmbeddings(store);
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
        // Blocks rebuilt above may lack (or have stale) semantic summaries;
        // drain a bounded slice. No-op unless NMG_SUMMARY_* / NMG_JUDGE_* is set.
        this.#drainLeafSummaries(store);
        // Node summaries consume the node's leaf-block summaries (coarser
        // tier), so they drain after blocks get their summaries.
        this.#drainNodeSummaries(store);
        this.#drainEmbeddings(store);
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
        !scopesOverlap(newer.scope, related.scope)
      ) {
        throw new NmgProtocolError(
          "INVALID_PARAMS",
          `${params.relationJudgement} requires non-conflicting scope; use distinct for different entities or retain both memories`,
        );
      }
      if (params.relationJudgement === "conflict" && !validityIntervalsOverlap(newer, related)) {
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
      ? this.#projectionParts(params.activeGraphId, params.sessionId)
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
      graphHops: options.graphHops ?? configuredGraphHops(1, this.#environment),
      expandChains: options.expandChains ?? true,
      progressiveWarmDisclosure: options.progressiveWarmDisclosure ?? true,
    };
    const raws = [query, ...(queries ?? [])];
    const embedding = this.#configuredEmbeddingClient();
    // Tessera (bookmark) source: independent of projectDir — tesserae live in the
    // shared store and are searched alongside memory. Snippet relocation to a
    // line needs the project root (to read the current file), so the resolver
    // is applied here, not in the store. The root also unlocks the one-time
    // legacy-fingerprint backfill.
    this.#backfillTesseraSimhashes(projectDir);
    const tesseraHits = this.#resolveTesseraLines(
      this.#searchTesseraSource(query, options.limit ?? 8),
      projectDir,
    );
    const withTesserae = <T extends MemoryContext>(context: T): T => {
      if (tesseraHits.length > 0) context.tesserae = tesseraHits;
      return context;
    };
    const runOne = async (store: NmgStore, raw: string): Promise<MemoryContext> => {
      const { semantic, filters } = parseAdvancedQuery(raw);
      const ctx = await searchMemoryContext(
        store,
        embedding,
        semantic,
        searchOptions,
        this.#embeddingDegradedReason(),
      );
      ctx.results = applyAdvancedFilters(ctx.results, filters);
      return ctx;
    };
    const searchAcross = async (store: NmgStore, raw: string) => {
      this.#syncStgWorkingSet(store, options.scope);
      const local = await runOne(store, raw);
      if (local.results.length > 0 && local.activeGraph?.qpp?.trigger === false) {
        return withTesserae(
          this.#registerSearchProjection(local, activeGraphPartsFor(store, local)),
        );
      }
      const sharedStore = this.#getStore();
      const shared = await runOne(sharedStore, raw);
      if (local.results.length === 0) {
        return withTesserae(
          this.#registerSearchProjection(shared, activeGraphPartsFor(sharedStore, shared)),
        );
      }
      const merged = mergeStgLtgContexts(local, shared);
      return withTesserae(
        this.#registerSearchProjection(
          merged,
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
          ].filter(isActiveGraphStorePart),
        ),
      );
    };

    if (raws.length === 1) {
      if (!projectDir) {
        const store = this.#getStore();
        const context = await runOne(store, raws[0]!);
        return withTesserae(
          this.#registerSearchProjection(context, activeGraphPartsFor(store, context)),
        );
      }
      return searchAcross(this.#getStgStore(projectDir, sessionId), raws[0]!);
    }

    // Multi-query fusion: primary keeps rank, extra clauses append unique
    // hits (their own order), then the hard limit is applied once.
    const sharedStore = this.#getStore();
    const primary = await runOne(sharedStore, raws[0]!);
    const parts = activeGraphPartsFor(sharedStore, primary);
    const seen = new Set(primary.results.map((result) => result.memory.id));
    for (let i = 1; i < raws.length; i += 1) {
      const extra = await runOne(this.#getStore(), raws[i]!);
      parts.push(...activeGraphPartsFor(sharedStore, extra));
      for (const result of extra.results) {
        if (seen.has(result.memory.id)) continue;
        seen.add(result.memory.id);
        primary.results.push(result);
      }
    }
    if (searchOptions.limit) primary.results = primary.results.slice(0, searchOptions.limit);
    return withTesserae(this.#registerSearchProjection(primary, parts));
  }

  #syncStgWorkingSet(store: NmgStore, scope: MemoryScope | undefined): void {
    const policy = configuredStgSyncPolicy(this.#environment);
    if (!policy.enabled || !scope || Object.keys(scope).length === 0) return;
    const scopeKey = JSON.stringify(
      Object.entries(scope).sort(([left], [right]) => left.localeCompare(right)),
    );
    const syncTimes = this.#stgSyncTimes.get(store) ?? new Map<string, number>();
    const now = Date.now();
    if (now - (syncTimes.get(scopeKey) ?? 0) < policy.minimumIntervalMs) return;
    // Mark the attempt before copying so repeated searches do not hot-loop on a
    // malformed or empty scope. This cache is advisory and resets with daemon restart.
    syncTimes.set(scopeKey, now);
    this.#stgSyncTimes.set(store, syncTimes);
    try {
      copyLtgSubsetToStg(this.#getStore(), store, { scope, limit: policy.limit });
    } catch {
      // Read-through caching is optional. LTG fallback remains authoritative.
    }
  }

  /** Search the tessera (bookmark) source across stores. Tessera rows are in the
   *  store (independent of any project index), so this does not need a
   *  projectDir; snippet relocation to a line is applied when a project root
   *  is available at call time. */
  #searchTesseraSource(query: string, limit: number): TesseraHit[] {
    const tesseraLimit = Math.max(1, Math.min(limit, 10));
    const rows = this.#getStore().searchTesserae(query, tesseraLimit);
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      label: row.label,
      kind: row.kind,
      memoryId: row.memoryId,
      snippet: row.snippet,
      fileSimhash: row.fileSimhash,
    }));
  }

  /** One batched SimHash backfill pass per project root: stamp the drift
   *  fingerprint onto tesserae written before it existed (or whose file was
   *  unreadable at write time). Runs on searches that know the project root,
   *  so legacy bookmarks converge to drift tolerance without a manual
   *  migration; update-at-most-once in the store means a re-run can never
   *  overwrite a stamped fingerprint. Per-row failures (file gone, transient
   *  writer contention) skip that row only; the root is marked done once a
   *  pass has nothing left to stamp, so an interrupted pass is retried by a
   *  later search instead of being lost for the process lifetime. */
  #backfillTesseraSimhashes(projectDir: string | undefined): void {
    if (!projectDir) return;
    const root = resolve(projectDir);
    if (this.#tesseraBackfillRoots.has(root)) return;
    try {
      const store = this.#getStore();
      const missing = store.tesseraeMissingSimhash();
      let unstamped = 0;
      for (const row of missing) {
        try {
          const content = readFileSafe(resolve(root, row.path));
          if (content === null) {
            unstamped += 1;
            continue;
          }
          if (!store.updateTesseraSimhash(row.id, simhashToHex(simhash64(content)))) {
            unstamped += 1;
          }
        } catch {
          unstamped += 1; // file vanished mid-pass, or a transient writer conflict
        }
      }
      // Done only when this pass had nothing stampable left (all rows already
      // stamped, or every remaining row is unreadable). A pass cut short by
      // contention stays pending and retries on the next search.
      if (missing.length === 0 || missing.length === unstamped) {
        this.#tesseraBackfillRoots.add(root);
      }
    } catch {
      // backfill is pure drift-tolerance maintenance, never a search failure
    }
  }

  /** Resolve tessera snippets to current line numbers against a project root.
   *  Best-effort: file missing/unreadable or snippet absent marks stale. */
  #resolveTesseraLines(tesserae: TesseraHit[], projectRoot?: string): TesseraHit[] {
    if (!projectRoot || tesserae.length === 0) return tesserae;
    const cache = new Map<string, string[] | null>(); // absPath -> lines | null
    const linesFor = (path: string): string[] | null => {
      const abs = resolve(projectRoot, path);
      if (cache.has(abs)) return cache.get(abs)!;
      const lines = readLinesSafe(abs);
      cache.set(abs, lines);
      return lines;
    };
    return tesserae.map((tessera) => {
      if (!tessera.snippet) return { ...tessera, stale: true };
      const target = tessera.snippet.trim();
      const pathLines = linesFor(tessera.path);
      if (pathLines) {
        // Stage 1 — exact relocation against the stored path.
        const found = pathLines.findIndex((line) => line.includes(target));
        if (found !== -1) return { ...tessera, line: found + 1 };
      }
      // Stage 2 — SimHash drift fallback. The stored path no longer relocates
      // (edited or moved). Compare the stored file fingerprint against current
      // files; a near-identical document (Hamming ≤ 6) elsewhere is the same
      // file after a move — locate the snippet there. Never auto-rewrites the
      // row; a stored file that still matches but lost the snippet is stale.
      const relocated = this.#relocateTesseraViaSimhash(tessera, target, projectRoot);
      return relocated ?? { ...tessera, stale: true };
    });
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
      const parts = this.#projectionParts(activeGraphId, params.sessionId);
      if (parts) {
        for (const part of parts) {
          const disclosedMemoryIds = [...found].filter((id) => part.memoryIds.has(id));
          part.store.recordActiveGraphDisclosure(
            part.traceId,
            disclosedMemoryIds,
            params.sessionId,
          );
          if (disclosedMemoryIds.length > 0) {
            this.#signalMaintenance(part.store, "access", false, disclosedMemoryIds.length);
          }
        }
        return {
          ...context,
          missingMemoryIds: params.memoryIds.filter((id) => !found.has(id)),
        };
      }
      const projectionOwner = this.#sessionActiveGraphs.projectionOwner(activeGraphId);
      if (projectionOwner && projectionOwner !== (params.sessionId?.trim() || "__anonymous__")) {
        throw new NmgProtocolError(
          "NOT_FOUND",
          `active graph ${activeGraphId} belongs to another session`,
        );
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
      traceStore.recordActiveGraphDisclosure(activeGraphId, [...found], params.sessionId);
      if (found.size > 0) this.#signalMaintenance(traceStore, "access", false, found.size);
    }
    return {
      ...context,
      missingMemoryIds: params.memoryIds.filter((id) => !found.has(id)),
    };
  }

  #registerSearchProjection(context: MemoryContext, parts: ActiveGraphStorePart[]): MemoryContext {
    if (!context.activeGraph) return context;
    const graph = {
      ...context.activeGraph,
      memoryIds: context.results.map((result) => result.memory.id),
      nodeIds: [...new Set(context.results.map((result) => result.node.id))],
    };
    const projection = this.#sessionActiveGraphs.registerProjection(
      graph,
      parts.map((part): ActiveGraphProjectionPart<NmgStore> => ({
        traceId: part.traceId,
        memoryIds: part.memoryIds,
        value: part.store,
      })),
    );
    return { ...context, activeGraph: projection.graph };
  }

  #projectionParts(activeGraphId: string, sessionId?: string): ActiveGraphStorePart[] | undefined {
    const projection = this.#sessionActiveGraphs.projection(activeGraphId, sessionId);
    if (!projection) return undefined;
    return projection.parts.map((part) => ({
      store: part.value,
      traceId: part.traceId,
      memoryIds: new Set(part.memoryIds),
    }));
  }

  #recordActiveGraphAttribution(
    params: NmgRecordActiveGraphAttributionParams,
  ): NmgMethodResult["recordActiveGraphAttribution"] {
    // Agent-end answer-overlap attribution. This is diagnostic telemetry,
    // not QPP supervision or proof of causal model reliance.
    const sharedStore = this.#getStore();
    const localStore = params.projectDir
      ? this.#getStgStore(params.projectDir, params.sessionId)
      : undefined;
    // isTraceOwned never throws on a foreign trace (vs retrievalTrace which
    // does), so a foreign-session trace in the STG cannot abort the search
    // for the real owner in the LTG. Record on EVERY owning store, not just
    // the first match: in a merged STG+LTG retrieval the same activeGraphId
    // can carry a trace in both stores, and the LTG (authoritative) side must
    // not lose its diagnostic trace.
    const projectionParts = this.#projectionParts(params.activeGraphId, params.sessionId);
    if (projectionParts?.length) {
      const attributed = new Set(params.attributedMemoryIds);
      for (const part of projectionParts) {
        part.store.recordActiveGraphAttribution(
          part.traceId,
          {
            method: "answer_overlap",
            attributedMemoryIds: [...attributed].filter((id) => part.memoryIds.has(id)),
          },
          params.sessionId,
        );
      }
      return {
        activeGraphId: params.activeGraphId,
        attributedMemoryIds: params.attributedMemoryIds,
      };
    }
    const projectionOwner = this.#sessionActiveGraphs.projectionOwner(params.activeGraphId);
    if (projectionOwner && projectionOwner !== (params.sessionId?.trim() || "__anonymous__")) {
      throw new NmgProtocolError(
        "NOT_FOUND",
        `active graph ${params.activeGraphId} belongs to another session`,
      );
    }
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
      store.recordActiveGraphAttribution(
        params.activeGraphId,
        {
          method: "answer_overlap",
          attributedMemoryIds: params.attributedMemoryIds,
        },
        params.sessionId,
      );
    }
    return {
      activeGraphId: params.activeGraphId,
      attributedMemoryIds: params.attributedMemoryIds,
    };
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

  /** Incrementally fills record, leaf-summary and node-summary indexes after
   * writes. Disabled by default so embedding traffic remains an explicit
   * deployment choice. Summary vectors may become pending after this pass;
   * their timestamps make the next bounded pass refresh them safely. */
  /** Bounded per-operation embedding drain: tops up at most one batch per
   *  target (records → leaves → nodes) so a remember/search always converges
   *  toward a complete external index without hammering a rate-limited
   *  provider. Provider presence (+key) implies auto-sync; the old
   *  NMG_EMBED_AUTO_SYNC env is no longer required to enable it. Concurrent
   *  drains per store are serialized; a 429/transient failure lands on
   *  #embeddingError and the SQLite missing-vector queue keeps the rest for
   *  the next operation. */
  #drainEmbeddings(store: NmgStore): void {
    if (this.#embeddingDrains.has(store)) return;
    const client = this.#configuredEmbeddingClient();
    if (!client) return;
    this.#embeddingDrains.add(store);
    const bounded = { maxBatches: 1 };
    void syncRecordEmbeddings(store, client, 64, bounded)
      .then(() => syncLeafEmbeddings(store, client, 64, bounded))
      .then(() => syncNodeEmbeddings(store, client, 64, bounded))
      .then(() => {
        // Full drain success clears any prior cooldown.
        this.#embeddingCooldownUntil = 0;
        this.#embeddingError = null;
      })
      .catch((error) => {
        this.#embeddingError = error instanceof Error ? error.message : String(error);
        // Provider failure starts a cooldown so search stops attempting
        // provider calls until it elapses; the bounded drain keeps retrying
        // on later operations and lifts the cooldown on success.
        this.#embeddingCooldownUntil = Date.now() + this.#embeddingCooldownMs;
      })
      .finally(() => this.#embeddingDrains.delete(store));
  }

  /** Reason to report when the embedding provider is degraded, or undefined
   *  when provider calls may proceed (or no provider was ever configured —
   *  plain lexical is then the normal mode, not a degradation). Two failure
   *  shapes are covered: a construction failure (provider configured but
   *  unusable — e.g. a missing API key, no client object exists) is a
   *  persistent state with no cooldown, so it must be reported directly or
   *  every search would silently claim a healthy lexical mode; a runtime
   *  provider failure (429, network) arms the cooldown and is reported until
   *  it elapses. */
  #embeddingDegradedReason(): string | undefined {
    if (this.#embeddingClient === null && this.#configuredProvider() !== null) {
      return this.#embeddingError ?? "embedding provider configured but unavailable (missing key?)";
    }
    if (this.#embeddingCooldownUntil <= Date.now()) return undefined;
    return this.#embeddingError ?? "embedding provider unavailable (cooling down)";
  }

  #configuredSummaryProvider(): LeafSummaryProvider | undefined {
    if (this.#summaryProvider !== undefined) return this.#summaryProvider ?? undefined;
    try {
      this.#summaryProvider = createLeafSummaryProviderFromEnv(this.#environment) ?? null;
    } catch {
      // Summaries are opportunistic: a misconfigured endpoint must not break
      // the daemon; the store simply keeps the structural fallback text.
      this.#summaryProvider = null;
    }
    return this.#summaryProvider ?? undefined;
  }

  /** Post-maintenance, remember-triggered leaf summary drain: bounded per
   *  pass and serialized per store. The store side is sync and LLM-free; the
   *  async LLM calls live here, outside the maintenance transaction. */
  #drainLeafSummaries(store: NmgStore): void {
    const provider = this.#configuredSummaryProvider();
    if (!provider || this.#summaryDrains.has(store)) return;
    this.#summaryDrains.add(store);
    void drainLeafSummaries(store, provider, { batch: 16, maxCalls: 16 })
      .catch(() => undefined)
      .finally(() => this.#summaryDrains.delete(store));
  }

  #configuredNodeSummaryProvider(): NodeSummaryProvider | undefined {
    if (this.#nodeSummaryProvider !== undefined) return this.#nodeSummaryProvider ?? undefined;
    try {
      this.#nodeSummaryProvider = createNodeSummaryProviderFromEnv(this.#environment) ?? null;
    } catch {
      // Summaries are opportunistic: a misconfigured endpoint must not break
      // the daemon; the store simply keeps the structural fallback text.
      this.#nodeSummaryProvider = null;
    }
    return this.#nodeSummaryProvider ?? undefined;
  }

  /** Post-maintenance node summary drain: coarser tier above leaf blocks, also
   *  bounded per pass and serialized per store. Same env as leaf summaries. */
  #drainNodeSummaries(store: NmgStore): void {
    const provider = this.#configuredNodeSummaryProvider();
    if (!provider || this.#nodeSummaryDrains.has(store)) return;
    this.#nodeSummaryDrains.add(store);
    void drainNodeSummaries(store, provider, { batch: 8, maxCalls: 8 })
      .catch(() => undefined)
      .finally(() => this.#nodeSummaryDrains.delete(store));
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
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

/** Read a file's lines, or null when unreadable/missing. Used by tessera
 *  snippet relocation. */
function readLinesSafe(absPath: string): string[] | null {
  try {
    const content = readFileSync(absPath, "utf8");
    return content.split(/\r?\n/);
  } catch {
    return null;
  }
}

function parseExportMemoriesParams(value: unknown): NmgExportMemoriesParams {
  const params = objectParams(value);
  return {
    sourceActor: optionalEnum(params, "sourceActor", MEMORY_ACTORS),
    includeDeleted: optionalBoolean(params, "includeDeleted"),
  };
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
    "disclose",
    "clearDisclosures",
  ] as const);
  const sessionId = requiredString(params, "sessionId");
  if (
    action === "beginDisclosureTurn" ||
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

function parseChainRemoveParams(value: unknown): NmgChainRemoveParams {
  const params = objectParams(value);
  return {
    chainId: requiredString(params, "chainId"),
    memoryId: requiredString(params, "memoryId"),
    projectDir: optionalString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
  };
}

function parseChainEdgeAddParams(value: unknown): NmgChainEdgeAddParams {
  const params = objectParams(value);
  const edgeType = params.edgeType;
  if (edgeType !== undefined && edgeType !== "order") {
    throw new NmgProtocolError("INVALID_PARAMS", "edgeType must be 'order'");
  }
  return {
    chainId: requiredString(params, "chainId"),
    sourceMemoryId: requiredString(params, "sourceMemoryId"),
    targetMemoryId: requiredString(params, "targetMemoryId"),
    edgeType: edgeType as "order" | undefined,
    projectDir: optionalString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
  };
}

function parseChainEdgeRemoveParams(value: unknown): NmgChainEdgeRemoveParams {
  const params = objectParams(value);
  return {
    chainId: requiredString(params, "chainId"),
    sourceMemoryId: requiredString(params, "sourceMemoryId"),
    targetMemoryId: requiredString(params, "targetMemoryId"),
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

function parseRecordActiveGraphAttributionParams(
  value: unknown,
): NmgRecordActiveGraphAttributionParams {
  const params = objectParams(value);
  return {
    activeGraphId: requiredString(params, "activeGraphId"),
    // An empty list is meaningful diagnostic coverage: recall happened, but
    // no candidate wording overlapped the final answer. It is not a negative label.
    attributedMemoryIds: requiredStringArray(params, "attributedMemoryIds", 0, 10_000),
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

function parseTopologyProposalParams(value: unknown): NmgTopologyProposalParams {
  const params = objectParams(value);
  const action = requiredEnum(params, "action", ["list", "assess", "review", "actuate"] as const);
  if (action === "list") {
    return {
      action,
      status: optionalEnum(params, "status", ["accepted", "pending", "rejected"] as const),
    };
  }
  const proposalId = requiredString(params, "proposalId");
  if (action === "assess") {
    return {
      action,
      proposalId,
      minimumObservations: optionalInteger(params, "minimumObservations", 1, 1_000_000),
      minimumEstimatedGain: optionalNumber(params, "minimumEstimatedGain", 0, 1),
      minimumEvidenceMemories: optionalInteger(params, "minimumEvidenceMemories", 1, 1_000_000),
    };
  }
  if (action === "review") {
    return {
      action,
      proposalId,
      decision: requiredEnum(params, "decision", ["accept", "reject"] as const),
    };
  }
  return { action, proposalId };
}

function parseMemoryMaintenanceProposalParams(value: unknown): NmgMemoryMaintenanceProposalParams {
  const params = objectParams(value);
  const action = requiredEnum(params, "action", ["list", "propose", "review"] as const);
  if (action === "list") {
    return {
      action,
      status: optionalEnum(params, "status", ["accepted", "pending", "rejected"] as const),
    };
  }
  if (action === "review") {
    return {
      action,
      proposalId: requiredString(params, "proposalId"),
      decision: requiredEnum(params, "decision", ["accept", "reject"] as const),
      reason: requiredString(params, "reason"),
    };
  }
  const policy = objectParams(params.policy);
  return {
    action,
    defectType: requiredEnum(params, "defectType", ["content", "retrieval", "scope"] as const),
    maintenanceAction: requiredEnum(params, "maintenanceAction", [
      "merge",
      "observe",
      "rescope",
      "rewrite",
      "split",
      "supersede",
    ] as const),
    targetMemoryIds: requiredStringArray(params, "targetMemoryIds", 1, 10_000),
    evidenceMemoryIds: optionalStringArray(params, "evidenceMemoryIds"),
    evidenceTraceIds: optionalStringArray(params, "evidenceTraceIds"),
    proposedStatement: optionalString(params, "proposedStatement"),
    proposedScope: optionalScope(params, "proposedScope"),
    policy: {
      id: requiredString(policy, "id"),
      revision: requiredString(policy, "revision"),
      sourceHash: requiredString(policy, "sourceHash"),
      minimumLongHorizonScore: requiredNumber(policy, "minimumLongHorizonScore", 0, 1),
    },
    longHorizonScore: requiredNumber(params, "longHorizonScore", 0, 1),
    evaluationKind: requiredEnum(params, "evaluationKind", ["held_out", "matched_replay"] as const),
    evaluationRef: requiredString(params, "evaluationRef"),
  };
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

function activeGraphPartsFor(store: NmgStore, context: MemoryContext): ActiveGraphStorePart[] {
  return context.activeGraph
    ? [
        {
          store,
          traceId: context.activeGraph.id,
          memoryIds: new Set(context.activeGraph.memoryIds),
        },
      ]
    : [];
}

function isActiveGraphStorePart(
  value: ActiveGraphStorePart | undefined,
): value is ActiveGraphStorePart {
  return value !== undefined;
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
