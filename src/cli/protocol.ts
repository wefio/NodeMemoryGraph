import type {
  MemoryActor,
  MemoryContext,
  MemoryMarker,
  MemoryNodeKind,
  MemoryRecord,
  MemoryResidence,
  MemoryScope,
  MemoryStorageState,
  MemoryTier,
  MemoryType,
  NodeTransform,
  PerfAggregate,
  RememberResult,
  RetentionCandidate,
  TruthStatus,
} from "../core/types.ts";

export const NMG_PROTOCOL_VERSION = "nmg.v1" as const;

export const NMG_CAPABILITIES = [
  "hello",
  "status",
  "remember",
  "search",
  "get",
  "retention-candidates",
  "set-storage-state",
  "delete-memory",
  "merge-nodes",
  "split-node",
  "sync-stg",
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
  "search",
  "retentionCandidates",
  "setStorageState",
  "deleteMemory",
  "mergeNodes",
  "splitNode",
  "syncStg",
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
  tier?: MemoryTier;
  importance?: number;
  scope?: MemoryScope;
  validFrom?: string;
  validUntil?: string;
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
  progressiveWarmDisclosure?: boolean;
  tieredDisclosure?: boolean;
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

export type NmgMethodResult = {
  hello: NmgHelloResult;
  status: NmgStatusResult;
  remember: RememberResult;
  search: MemoryContext;
  get: MemoryContext & { missingMemoryIds: string[] };
  retentionCandidates: { candidates: RetentionCandidate[] };
  setStorageState: { memoryId: string; storageState: MemoryStorageState };
  perfAggregates: PerfAggregate[];
  pruneRetrievalTraces: { pruned: number };
  deleteMemory: { deleted: boolean; memory: MemoryRecord | null };
  mergeNodes: NodeTransform;
  splitNode: NodeTransform;
  syncStg: { copied: number; projectDir: string };
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
