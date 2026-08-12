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

export interface NmgSyncStgParams {
  projectDir: string;
  sessionId?: string;
  scope: MemoryScope;
  limit?: number;
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

export type NmgTaskBoardParams =
  | NmgTaskBoardPutParams
  | NmgTaskBoardReadParams
  | NmgTaskBoardResolveParams
  | NmgTaskBoardClaimParams
  | NmgTaskBoardReleaseParams
  | NmgTaskBoardListParams;

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
  taskBoard:
    | { action: "put" | "resolve" | "claim" | "release"; entry: TaskBoardEntry }
    | { action: "read"; entries: TaskBoardEntry[]; nextCursor: number }
    | { action: "list"; boards: Array<{ taskId: string; entryCount: number; lastUpdatedAt: string }> };
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
