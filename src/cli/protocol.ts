import type {
  ActiveGraphBudget,
  ClaimOutcomeEvent,
  ClaimPosterior,
  MemoryActor,
  MemoryContext,
  MemoryMarker,
  MemoryExportBundle,
  MemoryNodeKind,
  MemoryRecord,
  MemoryResolution,
  MemoryResidence,
  MemoryScope,
  MemoryStorageState,
  MemoryTier,
  MemoryType,
  NodeTransform,
  PerfAggregate,
  RememberResult,
  RecordClaimOutcomesInput,
  RetentionCandidate,
  TopologyProposal,
  TaskBoardEntry,
  TaskBoardKind,
  TruthStatus,
} from "../core/types.ts";

export const NMG_PROTOCOL_VERSION = "nmg.v1" as const;

export const NMG_CAPABILITIES = [
  "hello",
  "status",
  "remember",
  "resolve-remember",
  "claim-outcome-posterior",
  "search",
  "get",
  "retention-candidates",
  "set-storage-state",
  "delete-memory",
  "export-memories",
  "merge-nodes",
  "rollback-node-transform",
  "split-node",
  "sync-stg",
  "task-board",
  "shutdown",
  "http",
  "json-rpc",
  "lexical-retrieval",
  "optional-embedding-retrieval",
] as const;

export const NMG_METHODS = [
  "get",
  "recordActiveGraphUse",
  "hello",
  "perfAggregates",
  "pruneRetrievalTraces",
  "remember",
  "resolveRemember",
  "recordClaimOutcomes",
  "search",
  "retentionCandidates",
  "setStorageState",
  "deleteMemory",
  "exportMemories",
  "mergeNodes",
  "rollbackNodeTransform",
  "splitNode",
  "syncStg",
  "stgPurgeSession",
  "taskBoard",
  "shutdown",
  "status",
] as const;

export type NmgMethod = (typeof NMG_METHODS)[number];

export interface NmgHelloResult {
  protocol: typeof NMG_PROTOCOL_VERSION;
  service: "node-memory-graph";
  version: string;
  capabilities: readonly string[];
}

export interface NmgStatusResult extends NmgHelloResult {
  process: {
    pid: number;
    node: string;
  };
  storage: {
    databasePath: string;
    exists: boolean;
    bytes: number;
    loaded: boolean;
  };
  embedding: {
    configured: boolean;
    provider: string | null;
    indexId: string | null;
    health: unknown;
    reason: string | null;
  };
}

export interface NmgRememberParams {
  statement: string;
  nodeName: string;
  memoryType?: MemoryType;
  stateKey?: string;
  eventTime?: string;
  sourceActor?: MemoryActor;
  truthStatus?: TruthStatus;
  evidence?: string;
  evidenceSource?: {
    actor: MemoryActor;
    content: string;
    sourceMessageId: string;
    sourceRef?: string;
  };
  tier?: MemoryTier;
  importance?: number;
  scope?: MemoryScope;
  validFrom?: string;
  validUntil?: string;
  resolution?: MemoryResolution;
  openedAt?: string;
  relatedMemoryIds?: string[];
  evidenceRole?: "contradict" | "example" | "exception" | "origin" | "support" | "update";
  supersedesId?: string;
  residence?: MemoryResidence;
  expiresAt?: string;
  writeReason?: string;
  sessionId?: string;
  sourceRef?: string;
  markers?: MemoryMarker[];
  projectDir?: string;
}

export interface NmgSupersedeRememberParams {
  action: "supersede";
  newMemoryId: string;
  supersededMemoryId: string;
  reason?: string;
  projectDir?: string;
  sessionId?: string;
}

export const MEMORY_RELATION_JUDGEMENTS = [
  "conflict",
  "distinct",
  "refines",
  "related",
  "same_entity",
] as const;
export type MemoryRelationJudgement = (typeof MEMORY_RELATION_JUDGEMENTS)[number];

export interface NmgRelateRememberParams {
  action: "relate";
  newMemoryId: string;
  relatedMemoryId: string;
  relationJudgement: MemoryRelationJudgement;
  confidence?: number;
  projectDir?: string;
  sessionId?: string;
}

export interface NmgForgetRememberParams {
  action: "forget";
  memoryId: string;
  projectDir?: string;
  sessionId?: string;
}

interface NmgResolutionRememberBase {
  memoryId: string;
  relatedMemoryIds?: string[];
  reason?: string;
  projectDir?: string;
  sessionId?: string;
}

export interface NmgResolveMemoryParams extends NmgResolutionRememberBase {
  action: "resolve";
}

export interface NmgReopenMemoryParams extends NmgResolutionRememberBase {
  action: "reopen";
}

export type NmgResolutionRememberParams = NmgResolveMemoryParams | NmgReopenMemoryParams;

export type NmgResolveRememberParams =
  | NmgSupersedeRememberParams
  | NmgRelateRememberParams
  | NmgForgetRememberParams
  | NmgResolutionRememberParams;

export interface NmgRecordClaimOutcomesParams extends RecordClaimOutcomesInput {
  projectDir?: string;
}

export interface NmgSearchParams {
  query: string;
  /** Extra retrieval clauses fused with the primary query (union of results). */
  queries?: string[];
  nodeName?: string;
  scope?: MemoryScope;
  sourceActor?: MemoryActor;
  includeHistorical?: boolean;
  maxTier?: MemoryTier;
  limit?: number;
  graphHops?: number;
  retrievalMode?: "legacy" | "fts5" | "hashing" | "qwen3" | "hybrid";
  vectorGranularity?: "hierarchy" | "records" | "union";
  secondPass?: boolean;
  initialEvidenceTarget?: number;
  strongHitTopGap?: number;
  strongHitInitialTarget?: number;
  progressiveWarmDisclosure?: boolean;
  tieredDisclosure?: boolean;
  /** Internal planning probes are not eligible for use feedback and must not persist a trace. */
  persistTrace?: boolean;
  /** Hard Active Graph envelope selected by a caller-side controller. */
  activeGraphBudget?: Partial<ActiveGraphBudget>;
  perf?: boolean;
  projectDir?: string;
  sessionId?: string;
}

export interface NmgGetParams {
  memoryIds: string[];
  /** Active Graph that recommended these IDs; enables owned actual-use feedback. */
  activeGraphId?: string;
  graphHops?: number;
  projectDir?: string;
  sessionId?: string;
}

/**
 * QPP agent-end implicit feedback: the harness derives which recalled memories
 * actually surfaced in the final answer (deriveUsedMemoryIds) and records them
 * on the trace as useful_memory_ids. This powers Stage 1 rolling tau
 * auto-calibration from production (qpp, useful) pairs (docs/retrieval-
 * confidence-controller.md).
 */
export interface NmgRecordActiveGraphUseParams {
  activeGraphId: string;
  /** Memories whose statement tokens appeared in the final agent answer. */
  usedMemoryIds: string[];
  projectDir?: string;
  sessionId?: string;
}

export interface NmgSyncStgParams {
  projectDir: string;
  sessionId?: string;
  scope: MemoryScope;
  limit?: number;
}

export interface NmgStgPurgeSessionParams {
  projectDir: string;
  /** Session whose provisional STG rows should be removed (kept: shared cached_from_ltg). */
  sessionId: string;
}

interface NmgTaskBoardBase {
  taskId: string;
  agentId: string;
}

export interface NmgTaskBoardPutParams extends NmgTaskBoardBase {
  action: "put";
  content: string;
  kind?: TaskBoardKind;
  sourceSessionId?: string;
  ttlSeconds?: number;
  expiresAt?: string;
  /** Directed delivery (A2A-compatible find→direct protocol): stable
   * agent_name that should be woken for this entry. Only that agent's LLM is
   * woken; everyone else sees it on read but stays silent. Uses the stable
   * agent name, never sessionId (session changes on reload). Omit = ordinary
   * broadcast to subscribers. */
  to?: string;
}

export interface NmgTaskBoardReadParams extends NmgTaskBoardBase {
  action: "read";
  afterCursor?: number;
  limit?: number;
  includeResolved?: boolean;
}

export interface NmgTaskBoardResolveParams extends NmgTaskBoardBase {
  action: "resolve";
  entryId: string;
  resolution?: string;
}

export interface NmgTaskBoardAcknowledgeParams extends NmgTaskBoardBase {
  action: "acknowledge";
  entryId: string;
  reason?: string;
}

export interface NmgTaskBoardClaimParams extends NmgTaskBoardBase {
  action: "claim";
  entryId: string;
  /** Lease duration in seconds (clamped 60..86400, default 3600). */
  leaseSeconds?: number;
}

export interface NmgTaskBoardReleaseParams extends NmgTaskBoardBase {
  action: "release";
  entryId: string;
}

export interface NmgTaskBoardListParams {
  action: "list";
  agentId: string;
}

/** Wake-loop internal: which entries are already delivered to this session and
 * whether the channel is suppressed for it. Kept out of the nmg_board tool. */
export interface NmgTaskBoardDeliveryCheckParams {
  action: "deliveryCheck";
  agentId: string;
  sessionId: string;
  taskId: string;
  entryIds: string[];
}

export interface NmgTaskBoardRecordDeliveryParams {
  action: "recordDelivery";
  agentId: string;
  sessionId: string;
  entryId: string;
  source?: string;
}

/** Agent-facing: join (subscribe) or leave (unsubscribe) a channel.
 * Topic-based membership: a session receives wake notices only for the
 * world channel (its default member channel) plus channels it subscribed to.
 * Named channels never notify non-members. */
export interface NmgTaskBoardUnsubscribeParams {
  action: "unsubscribe";
  agentId: string;
  sessionId: string;
  taskId: string;
}

export interface NmgTaskBoardSubscribeParams {
  action: "subscribe";
  agentId: string;
  sessionId: string;
  taskId: string;
}

/** Wake-loop internal: which named channels this session has joined, so the
 * loop scans only member channels (never every active board). */
export interface NmgTaskBoardListSubscriptionsParams {
  action: "listSubscriptions";
  agentId: string;
  sessionId: string;
}

/** System-layer agent registration (A2A AgentCard local edition). Called by
 * hooks/extensions on startup; never wakes an LLM. Fields aligned with A2A
 * AgentCard so a future external-agent gateway maps with zero model change. */
export interface NmgTaskBoardRegisterAgentParams {
  action: "registerAgent";
  agentName: string;
  description?: string;
  version?: string;
  url?: string;
  capabilities?: string;
  skills?: string;
  supportedInterfaces?: string;
}

/** System-layer heartbeat: refreshes last_seen_at so the agent stays online. */
export interface NmgTaskBoardHeartbeatParams {
  action: "heartbeat";
  agentName: string;
}

/** Find-and-direct: broadcast a need to the system layer (hooks auto-reply
 * identity, no LLM woken), optionally filtered by capabilities. Returns the
 * online agents that can help — the roster used to pick `to=` for a directed
 * put. A2A discovery semantics localised. */
export interface NmgTaskBoardDiscoverParams extends NmgTaskBoardBase {
  action: "discover";
  need?: string;
  capabilities?: string;
}

export type NmgTaskBoardParams =
  | NmgTaskBoardPutParams
  | NmgTaskBoardReadParams
  | NmgTaskBoardResolveParams
  | NmgTaskBoardAcknowledgeParams
  | NmgTaskBoardClaimParams
  | NmgTaskBoardReleaseParams
  | NmgTaskBoardListParams
  | NmgTaskBoardDeliveryCheckParams
  | NmgTaskBoardRecordDeliveryParams
  | NmgTaskBoardUnsubscribeParams
  | NmgTaskBoardSubscribeParams
  | NmgTaskBoardListSubscriptionsParams
  | NmgTaskBoardRegisterAgentParams
  | NmgTaskBoardHeartbeatParams
  | NmgTaskBoardDiscoverParams;

export interface NmgRetentionCandidatesParams {
  dormantAfterDays?: number;
  quarantineAfterDays?: number;
  maximumImportance?: number;
  maximumAccessCount?: number;
}

export interface NmgPerfParams {
  /** Prune raw traces beyond the retention window. */
  action?: "aggregates" | "prune";
  maxDays?: number;
  maxRows?: number;
}

export interface NmgSetStorageStateParams {
  memoryId: string;
  storageState: MemoryStorageState;
  recoveryDays?: number;
}

export interface NmgDeleteMemoryParams {
  memoryId: string;
}

export interface NmgExportMemoriesParams {
  sourceActor?: MemoryActor;
  includeDeleted?: boolean;
}

export interface NmgMergeNodesParams {
  sourceNodeIds: string[];
  targetName: string;
  targetKind?: MemoryNodeKind;
  summary?: string;
}

export interface NmgSplitNodeParams {
  sourceNodeId: string;
  partitions: Array<{
    nodeName: string;
    memoryIds: string[];
    nodeKind?: MemoryNodeKind;
    summary?: string;
  }>;
}

export interface NmgRollbackNodeTransformParams {
  transformId: string;
}

export type NmgMethodResult = {
  hello: NmgHelloResult;
  status: NmgStatusResult;
  remember: RememberResult;
  resolveRemember:
    | {
        action: "supersede";
        newMemoryId: string;
        supersededMemoryId: string;
        applied: boolean;
      }
    | {
        action: "relate";
        newMemoryId: string;
        relatedMemoryId: string;
        proposal: TopologyProposal;
      }
    | {
        action: "forget";
        memoryId: string;
        deleted: boolean;
      }
    | {
        action: "resolve" | "reopen";
        memoryId: string;
        resolution: MemoryResolution;
        openedAt: string | null;
        relatedMemoryIds: string[];
      };
  recordClaimOutcomes: {
    events: ClaimOutcomeEvent[];
    posteriors: ClaimPosterior[];
    consolidationCandidates: string[];
    consolidatedMemories: Array<{ sourceMemoryId: string; memoryId: string }>;
    retractedMemories: Array<{ sourceMemoryId: string; memoryId: string }>;
  };
  search: MemoryContext;
  get: MemoryContext & { missingMemoryIds: string[] };
  recordActiveGraphUse: { activeGraphId: string; usedMemoryIds: string[] };
  retentionCandidates: { candidates: RetentionCandidate[] };
  setStorageState: { memoryId: string; storageState: MemoryStorageState };
  perfAggregates: PerfAggregate[];
  pruneRetrievalTraces: { pruned: number };
  deleteMemory: { deleted: boolean; memory: MemoryRecord | null };
  exportMemories: MemoryExportBundle;
  mergeNodes: NodeTransform;
  rollbackNodeTransform: NodeTransform;
  splitNode: NodeTransform;
  syncStg: { copied: number; projectDir: string };
  stgPurgeSession: { purged: number; projectDir: string };
  taskBoard:
    | { action: "put" | "resolve" | "claim" | "release" | "acknowledge"; entry: TaskBoardEntry }
    | { action: "read"; entries: TaskBoardEntry[]; nextCursor: number }
    | {
        action: "list";
        boards: Array<{ taskId: string; entryCount: number; lastUpdatedAt: string }>;
      }
    | {
        action: "deliveryCheck";
        delivered: string[];
        acked: string[];
        suppressed: boolean;
      }
    | { action: "recordDelivery"; recorded: boolean }
    | { action: "unsubscribe" | "subscribe"; taskId: string }
    | {
        action: "listSubscriptions";
        subscriptions: Array<{ taskId: string; subscribedAt: string }>;
      }
    | { action: "registerAgent" | "heartbeat"; agentName: string }
    | {
        action: "discover";
        agents: Array<{
          agentName: string;
          description: string | null;
          capabilities: string | null;
          lastSeenAt: string;
        }>;
      };
  shutdown: { shuttingDown: true };
};

export class NmgProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "NmgProtocolError";
  }
}
