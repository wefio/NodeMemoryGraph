import { createHash } from "node:crypto";

import type {
  ActiveGraphBudget,
  ClaimOutcomeEvent,
  ClaimPosterior,
  MemoryActor,
  MemoryChain,
  MemoryChainEdge,
  MemoryChainEdgeType,
  MemoryChainMember,
  MemoryChainType,
  MemoryContext,
  MemoryMarker,
  MemoryMaintenanceAction,
  MemoryMaintenanceDefect,
  MemoryMaintenancePolicyArtifact,
  MemoryMaintenanceProposal,
  MemoryExportBundle,
  MemoryNodeKind,
  MemoryRecord,
  MemoryResolution,
  MemoryResidence,
  MemoryScope,
  MemoryStorageState,
  MemoryTier,
  MemoryType,
  MemoryWriteSource,
  NodeTransform,
  PerfAggregate,
  RememberResult,
  RecordClaimOutcomesInput,
  RetentionCandidate,
  TopologyAutomationAssessment,
  TopologyProposal,
  TaskBoardEntry,
  TaskBoardKind,
  TruthStatus,
} from "../core/types.ts";
import type {
  SessionDisclosureLevel,
  SessionActiveGraphItem,
  SessionActiveGraphItemKind,
  SessionActiveGraphSnapshot,
} from "../core/session-active-graph.ts";
import type {
  LabActivation,
  LabCapability,
  LabCapabilityDescriptor,
  LabScope,
} from "../integration/lab-capabilities.ts";

// This is a compatibility epoch, not a feature revision. Additive RPCs,
// optional fields, and capabilities remain within the same epoch and are
// negotiated through hello.capabilities. Bump only when a live daemon from
// the previous epoch cannot faithfully implement the current client contract.
// v5 replaced the ambiguous
// recordActiveGraphUse RPC with diagnostic-only recordActiveGraphAttribution;
// a v4 daemon would otherwise accept the connection and reject that method at
// agent_end. v6 preserves natural/controlled provenance on claim outcomes;
// a v5 daemon would silently discard the optional field and contaminate audits.
// v7 completes the chain contract (DAG edges, member removal, and structured
// reads); a v6 daemon only implements the earlier partial chain surface. v8
// adds daemon-owned Lab capability leases and invocation; a v7 daemon cannot
// honor those agent-visible operations. v9 moves the session Active Graph into
// the daemon and makes returned Active Graph ids immutable projection ids; a v8
// daemon would silently keep Pi's working state in a separate local cache.
export const NMG_PROTOCOL_VERSION = "nmg.v9" as const;

export const NMG_CAPABILITIES = [
  "hello",
  "status",
  "remember",
  "batch-remember",
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
  "topology-proposals",
  "memory-maintenance-proposals",
  "sync-stg",
  "task-board",
  "directed-task-board-inbox",
  "shutdown",
  "http",
  "json-rpc",
  "lexical-retrieval",
  "optional-embedding-retrieval",
  "diagnostic-answer-attribution",
  "claim-outcome-origin-provenance",
  "memory-chains",
  "lab-capabilities",
  "session-active-graph",
] as const;

export type NmgCapability = (typeof NMG_CAPABILITIES)[number];

export interface NmgRpcDescriptor {
  /** Additive same-epoch methods are callable only when hello advertises this. */
  optionalCapability?: NmgCapability;
}

/**
 * Runtime source of truth for RPC existence and additive capability gates.
 * Parsers, handlers, transactions, and host exposure remain explicit because
 * their semantics cannot be inferred safely from a wire descriptor.
 */
const RPC_DESCRIPTOR_SOURCE = {
  get: {},
  recordActiveGraphAttribution: {},
  hello: {},
  perfAggregates: {},
  pruneRetrievalTraces: {},
  remember: {},
  rememberBatch: { optionalCapability: "batch-remember" },
  resolveRemember: {},
  recordClaimOutcomes: {},
  search: {},
  retentionCandidates: {},
  setStorageState: {},
  deleteMemory: {},
  exportMemories: {},
  mergeNodes: {},
  rollbackNodeTransform: {},
  splitNode: {},
  topologyProposal: {},
  memoryMaintenanceProposal: {},
  syncStg: {},
  stgPurgeSession: {},
  taskBoard: {},
  chainCreate: {},
  chainAdd: {},
  chainRemove: {},
  chainEdgeAdd: {},
  chainEdgeRemove: {},
  chainGet: {},
  chainList: {},
  lab: {},
  sessionActiveGraph: { optionalCapability: "session-active-graph" },
  shutdown: {},
  status: {},
} as const satisfies Record<string, NmgRpcDescriptor>;

for (const descriptor of Object.values(RPC_DESCRIPTOR_SOURCE)) Object.freeze(descriptor);

/** Process-lifetime catalog. Runtime registration and hot reload are intentionally unsupported. */
export const NMG_RPC_DESCRIPTORS = Object.freeze(RPC_DESCRIPTOR_SOURCE);

export type NmgMethod = keyof typeof NMG_RPC_DESCRIPTORS;

export const NMG_METHODS = Object.freeze(Object.keys(NMG_RPC_DESCRIPTORS) as NmgMethod[]);

/** Stable discovery/cache identity. A mismatch is not an epoch compatibility verdict. */
export function fingerprintRpcCatalog(
  descriptors: Readonly<Record<string, Readonly<NmgRpcDescriptor>>>,
): string {
  const normalized = Object.entries(descriptors)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([method, descriptor]) => ({
      method,
      ...(descriptor.optionalCapability
        ? { optionalCapability: descriptor.optionalCapability }
        : {}),
    }));
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

export const NMG_RPC_CATALOG_FINGERPRINT = fingerprintRpcCatalog(NMG_RPC_DESCRIPTORS);

/** Derived gate table; never maintain a second method list by hand. */
export const NMG_OPTIONAL_METHOD_CAPABILITIES = Object.freeze(
  Object.fromEntries(
    Object.entries(NMG_RPC_DESCRIPTORS).flatMap(([method, descriptor]) =>
      "optionalCapability" in descriptor ? [[method, descriptor.optionalCapability] as const] : [],
    ),
  ) as Partial<Record<NmgMethod, NmgCapability>>,
);

export interface NmgHelloResult {
  /** Wire value is open; assertDaemonProtocol narrows it to this client epoch. */
  protocol: string;
  service: "node-memory-graph";
  version: string;
  capabilities: readonly string[];
  /** Runtime discovery surface; optional so earlier same-epoch daemons remain compatible. */
  methods?: readonly string[];
  /** Optional same-epoch catalog identity used only for cache invalidation and diagnostics. */
  catalogFingerprint?: string;
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
  /** Rust-unsafe-style escape hatch (docs §3.6): explicit opt-out of the
   *  transient/instruction write policy. Secrets are never bypassable. */
  unsafe?: boolean;
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
  /** Submission channel; distinct from sourceActor content attribution. */
  writeSource?: MemoryWriteSource;
  sessionId?: string;
  sourceRef?: string;
  markers?: MemoryMarker[];
  /** Short aliases or likely query phrases used only for recall routing. */
  recallTriggers?: string[];
  projectDir?: string;
}

/** Additive daemon transport for natural bulk boundaries. One batch targets one
 * physical LTG or session-owned STG store and commits atomically in input order. */
export interface NmgRememberBatchParams {
  items: NmgRememberParams[];
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
  expandChains?: boolean;
  chainExpansionMaxMembers?: number;
  chainExpansionMaxChains?: number;
  chainExpansionMaxHops?: number;
  chainExpansionMaxMemoryHops?: number;
  chainExpansionMaxEdges?: number;
  appendedMaxChars?: number;
  appendedMaxRatio?: number;
  retrievalMode?: "legacy" | "fts5" | "hashing" | "qwen3" | "hybrid";
  vectorGranularity?: "hierarchy" | "records" | "union";
  secondPass?: boolean;
  initialEvidenceTarget?: number;
  strongHitTopGap?: number;
  strongHitInitialTarget?: number;
  progressiveWarmDisclosure?: boolean;
  tieredDisclosure?: boolean;
  /** Internal planning probes are not eligible for feedback and must not persist a trace. */
  persistTrace?: boolean;
  /** Hard Active Graph envelope selected by a caller-side controller. */
  activeGraphBudget?: Partial<ActiveGraphBudget>;
  perf?: boolean;
  projectDir?: string;
  sessionId?: string;
}

export interface NmgGetParams {
  memoryIds: string[];
  /** Active Graph that recommended these IDs; enables session-owned disclosure tracking. */
  activeGraphId?: string;
  graphHops?: number;
  projectDir?: string;
  sessionId?: string;
}

export type NmgSessionActiveGraphParams =
  | {
      action: "observe";
      sessionId: string;
      statement: string;
      sourceId?: string;
      nodeId?: string;
      taskFrameId?: string;
      kind?: Exclude<SessionActiveGraphItemKind, "semantic_memory">;
      activation?: number;
    }
  | { action: "snapshot" | "activate" | "release" | "clearDisclosures"; sessionId: string }
  | { action: "beginDisclosureTurn"; sessionId: string }
  | {
      action: "disclose";
      sessionId: string;
      projectionId?: string;
      disclosure: SessionDisclosureLevel;
      entries: Array<{ memoryId: string; contentHash: string }>;
    };

export type NmgSessionActiveGraphResult =
  | { action: "observe"; added: boolean; item: SessionActiveGraphItem }
  | { action: "snapshot" | "activate"; snapshot: SessionActiveGraphSnapshot | null }
  | { action: "release"; released: boolean }
  | { action: "clearDisclosures"; cleared: boolean }
  | { action: "beginDisclosureTurn"; turn: number }
  | { action: "disclose"; freshMemoryIds: string[]; foldedMemoryIds: string[] };

export interface NmgChainCreateParams {
  chainType: MemoryChainType;
  topic: string;
  ownerSessionId?: string;
  projectDir?: string;
  sessionId?: string;
}

export interface NmgChainAddParams {
  chainId: string;
  memoryId: string;
  position?: number;
  note?: string;
  projectDir?: string;
  sessionId?: string;
}

export interface NmgChainRemoveParams {
  chainId: string;
  memoryId: string;
  projectDir?: string;
  sessionId?: string;
}

export interface NmgChainEdgeAddParams {
  chainId: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  edgeType?: MemoryChainEdgeType;
  projectDir?: string;
  sessionId?: string;
}

export interface NmgChainEdgeRemoveParams {
  chainId: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  projectDir?: string;
  sessionId?: string;
}

export interface NmgChainGetParams {
  chainId: string;
  projectDir?: string;
  sessionId?: string;
}

export interface NmgChainListParams {
  chainType?: MemoryChainType;
  ownerSessionId?: string;
  projectDir?: string;
  sessionId?: string;
}

/**
 * Agent-end diagnostic attribution: the harness derives which recalled memories
 * visibly surfaced in the final answer (deriveAnswerOverlapMemoryIds) and records
 * them as attributed_memory_ids. Provider/model behaviour may drift; this RPC
 * cannot create useful evidence, train routing, or alter graph stability.
 */
export interface NmgRecordActiveGraphAttributionParams {
  activeGraphId: string;
  /** Memories whose statement tokens appeared in the final agent answer (diagnostic only). */
  attributedMemoryIds: string[];
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
  /** Opaque continuation cursor: the id of the last entry already seen.
   * Clients must treat it as an opaque string, never parse it. */
  afterCursor?: string;
  limit?: number;
  includeResolved?: boolean;
}

/** Wake-loop internal: open entries addressed to either the stable routing id
 * or current display name, across all named channels. */
export interface NmgTaskBoardReadDirectedParams {
  action: "readDirected";
  agentId: string;
  agentName: string;
  limit?: number;
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
 * Topic-based membership controls broadcast wake notices: a session receives
 * them only for the world channel plus channels it subscribed to. Explicit
 * point-to-point entries use the separate directed inbox. */
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
 * AgentCard so a future external-agent gateway maps with zero model change.
 * id = stable unique routing key (A2A AgentCard id field); agentName = mutable
 * display label, runtime-renamable without changing the id. */
export interface NmgTaskBoardRegisterAgentParams {
  action: "registerAgent";
  id: string;
  agentName: string;
  description?: string;
  version?: string;
  url?: string;
  capabilities?: string;
  skills?: string;
  supportedInterfaces?: string;
}

/** System-layer heartbeat: refresh last_seen_at for a stable id. */
export interface NmgTaskBoardHeartbeatParams {
  action: "heartbeat";
  id: string;
}

/** Runtime rename: change the display agent_name for a stable id (routing key
 * unchanged). Industry practice: names are not unique/stable, so only the
 * human-readable label is mutable. */
export interface NmgTaskBoardRenameParams {
  action: "rename";
  id: string;
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
  | NmgTaskBoardReadDirectedParams
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
  | NmgTaskBoardRenameParams
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

export type NmgTopologyProposalParams =
  | { action: "list"; status?: TopologyProposal["status"] }
  | {
      action: "assess";
      proposalId: string;
      minimumObservations?: number;
      minimumEstimatedGain?: number;
      minimumEvidenceMemories?: number;
    }
  | { action: "review"; proposalId: string; decision: "accept" | "reject" }
  | { action: "actuate"; proposalId: string };

export type NmgMemoryMaintenanceProposalParams =
  | { action: "list"; status?: MemoryMaintenanceProposal["status"] }
  | {
      action: "propose";
      defectType: MemoryMaintenanceDefect;
      maintenanceAction: MemoryMaintenanceAction;
      targetMemoryIds: string[];
      evidenceMemoryIds?: string[];
      evidenceTraceIds?: string[];
      proposedStatement?: string;
      proposedScope?: MemoryScope;
      policy: MemoryMaintenancePolicyArtifact;
      longHorizonScore: number;
      evaluationKind: "held_out" | "matched_replay";
      evaluationRef: string;
    }
  | {
      action: "review";
      proposalId: string;
      decision: "accept" | "reject";
      reason: string;
    };

export type NmgLabParams =
  | { action: "list" }
  | { action: "status"; capability: LabCapability; sessionId: string }
  | {
      action: "enable";
      capability: LabCapability;
      scope?: LabScope;
      sessionId: string;
      requester: string;
      reason: string;
      ttlSeconds?: number;
    }
  | { action: "disable"; capability: LabCapability; sessionId: string }
  | {
      action: "invoke";
      capability: LabCapability;
      sessionId: string;
      operation: string;
      input?: unknown;
    };

export type NmgLabResult =
  | { action: "list"; capabilities: LabCapabilityDescriptor[] }
  | { action: "status" | "enable" | "disable"; activation: LabActivation | null }
  | { action: "invoke"; capability: LabCapability; operation: string; output: unknown };

export type NmgMethodResult = {
  hello: NmgHelloResult;
  status: NmgStatusResult;
  remember: RememberResult;
  rememberBatch: { results: RememberResult[] };
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
  chainCreate: MemoryChain;
  chainAdd: MemoryChainMember;
  chainRemove: { removed: boolean };
  chainEdgeAdd: MemoryChainEdge;
  chainEdgeRemove: { removed: boolean };
  chainGet: {
    chain: MemoryChain;
    members: MemoryChainMember[];
    edges: MemoryChainEdge[];
    topologicalOrder: string[];
  } | null;
  chainList: MemoryChain[];
  lab: NmgLabResult;
  sessionActiveGraph: NmgSessionActiveGraphResult;
  recordActiveGraphAttribution: { activeGraphId: string; attributedMemoryIds: string[] };
  retentionCandidates: { candidates: RetentionCandidate[] };
  setStorageState: { memoryId: string; storageState: MemoryStorageState };
  perfAggregates: PerfAggregate[];
  pruneRetrievalTraces: { pruned: number };
  deleteMemory: { deleted: boolean; memory: MemoryRecord | null };
  exportMemories: MemoryExportBundle;
  mergeNodes: NodeTransform;
  rollbackNodeTransform: NodeTransform;
  splitNode: NodeTransform;
  topologyProposal:
    | { action: "list"; proposals: TopologyProposal[] }
    | { action: "assess"; assessment: TopologyAutomationAssessment }
    | { action: "review"; proposal: TopologyProposal }
    | { action: "actuate"; transform: NodeTransform };
  memoryMaintenanceProposal:
    | { action: "list"; proposals: MemoryMaintenanceProposal[] }
    | { action: "propose" | "review"; proposal: MemoryMaintenanceProposal };
  syncStg: { copied: number; projectDir: string };
  stgPurgeSession: { purged: number; projectDir: string };
  taskBoard:
    | { action: "put" | "resolve" | "claim" | "release" | "acknowledge"; entry: TaskBoardEntry }
    | { action: "read"; entries: TaskBoardEntry[]; nextCursor: string | null }
    | { action: "readDirected"; entries: TaskBoardEntry[] }
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
    | { action: "registerAgent" | "heartbeat" | "rename"; agentName: string; id: string }
    | {
        action: "discover";
        agents: Array<{
          id: string;
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
