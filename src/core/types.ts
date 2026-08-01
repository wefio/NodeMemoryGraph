import type { PerfSnapshot } from "./perf.ts";

export type { PerfSnapshot } from "./perf.ts";

export type HistoryRole = "user" | "assistant" | "tool" | "system" | "explicit" | "session";

export interface HistoryRecord {
  id: string;
  sessionId: string | null;
  sourceMessageId: string | null;
  role: HistoryRole;
  content: string;
  sourceRef: string | null;
  createdAt: string;
}

export type MemoryNodeKind =
  | "concept"
  | "constraint"
  | "entity"
  | "preference"
  | "procedure"
  | "project"
  | "state"
  | "strategy"
  | "topic";

export interface MemoryNode {
  id: string;
  canonicalName: string;
  kind: MemoryNodeKind;
  summary: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "merged" | "split";
  residence: MemoryResidence;
}

export type MemoryTier = 0 | 1 | 2 | 3;
export type MemoryStorageState = "dormant" | "indexed" | "quarantine";
export type MemoryResidence = "ltg" | "stg";
export type MemoryWriteSource = "agent" | "automatic" | "core" | "derived" | "import" | "user";
export type MemoryType =
  | "constraint"
  | "conversation_evidence"
  | "derived"
  | "event"
  | "fact"
  | "preference"
  | "state"
  | "strategy";
export type MemoryActor = "assistant" | "system" | "tool" | "user";
export type TruthStatus = "asserted" | "inferred" | "unverified" | "verified";
/** Logical polarity of a statement, extracted at write time from text. */
export type Polarity = "affirmative" | "negative" | "neutral";

/** Provenance of polarity/predicate/confidence extraction. */
export type ExtractMethod = "rule" | "llm";

/** One atomic claim extracted from a memory statement. A record is the
 * evidence unit; claims are the metadata unit (chat.completions parts
 * model: one message, many typed parts). */
export interface MemoryClaim {
  text: string;
  polarity: Polarity | null;
  predicateKey: string | null;
  confidence: number | null;
  extractMethod: ExtractMethod;
}
export type MemoryStatus = "active" | "deleted" | "disputed" | "inactive" | "superseded";
export type EvidenceRole = "contradict" | "example" | "exception" | "origin" | "support" | "update";
export type MemoryScope = Record<string, string>;
export type NodeRelationType =
  | "applies_to"
  | "causes"
  | "contradicts"
  | "depends_on"
  | "derived_from"
  | "exception_to"
  | "is_a"
  | "part_of"
  | "related_to"
  | "supports"
  | "supersedes";

export interface NodeRelation {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: NodeRelationType;
  evidenceIds: string[];
  residence: "ltg";
  status: "consolidated" | "demoted";
  stability: number;
  /** Slowly learned retrieval weight. Query-local activation is never stored here. */
  strength: number;
  direction: "both" | "source->target" | "target->source";
  fanBudget: boolean;
  activationRule: "conductive" | "regulatory";
  consolidationSource: "explicit" | "stability";
  consolidatedAt: string;
  createdAt: string;
}

export type MemoryMarkerValue = string | number | boolean | null;

/**
 * Typed control metadata attached to a memory without becoming part of its
 * factual statement. Marker kinds are intentionally open so integrations can
 * add labels such as `forget`, `sensitive`, `pinned`, or `exception` without a
 * schema migration.
 */
export interface MemoryMarker {
  kind: string;
  attributes?: Record<string, MemoryMarkerValue>;
}

export interface MemoryRecord {
  id: string;
  nodeId: string;
  evidenceId: string;
  evidenceIds: string[];
  statement: string;
  memoryType: MemoryType;
  stateKey: string | null;
  eventTime: string | null;
  sourceActor: MemoryActor;
  truthStatus: TruthStatus;
  /** Extraction confidence in (0,1); null when never assessed. */
  confidence: number | null;
  /** Logical polarity; null when the statement has no polarity cue. */
  polarity: Polarity | null;
  /** Normalized predicate used to group affirm/negate pairs; null if unset. */
  predicateKey: string | null;
  /** Which extractor filled polarity/predicateKey/confidence; null if manual or never extracted. */
  extractMethod: ExtractMethod | null;
  /** Atomic claims extracted from the statement; source of truth for the
   *  polarity/predicateKey/confidence rollup columns above. */
  claims: MemoryClaim[] | null;
  markers: MemoryMarker[];
  scope: MemoryScope;
  validFrom: string | null;
  validUntil: string | null;
  status: MemoryStatus;
  residence: MemoryResidence;
  promotedAt: string | null;
  expiresAt: string | null;
  evidenceRole: EvidenceRole;
  supersedesId: string | null;
  tier: MemoryTier;
  importance: number;
  accessCount: number;
  lastAccessedAt: string | null;
  writeReason: string;
  writeSource: MemoryWriteSource;
  createdAt: string;
}

export interface RetentionCandidate {
  memoryId: string;
  nodeId: string;
  statement: string;
  storageState: MemoryStorageState;
  recommendedState: Exclude<MemoryStorageState, "indexed">;
  ageDays: number;
  idleDays: number;
  importance: number;
  accessCount: number;
}

export interface RetentionPolicy {
  dormantAfterDays?: number;
  quarantineAfterDays?: number;
  maximumImportance?: number;
  maximumAccessCount?: number;
  now?: Date;
}

export interface RememberInput {
  statement: string;
  nodeName: string;
  nodeSummary?: string;
  nodeKind?: MemoryNodeKind;
  memoryType?: MemoryType;
  stateKey?: string;
  eventTime?: string;
  sourceActor?: MemoryActor;
  truthStatus?: TruthStatus;
  confidence?: number;
  polarity?: Polarity;
  predicateKey?: string;
  extractMethod?: ExtractMethod;
  claims?: MemoryClaim[];
  markers?: MemoryMarker[];
  evidence?: string;
  evidenceHistoryId?: string;
  sessionId?: string;
  sourceRef?: string;
  tier?: MemoryTier;
  importance?: number;
  scope?: MemoryScope;
  validFrom?: string;
  validUntil?: string;
  evidenceRole?: EvidenceRole;
  supersedesId?: string;
  residence?: MemoryResidence;
  expiresAt?: string;
  writeReason?: string;
  writeSource?: MemoryWriteSource;
  /** Disable per-phase timing for this write (default: enabled). */
  perf?: boolean;
}

export interface RememberResult {
  history: HistoryRecord;
  node: MemoryNode;
  memory: MemoryRecord;
  /** Per-phase timings, present unless disabled via RememberInput.perf. */
  timings?: PerfSnapshot;
}

export interface SearchOptions {
  /** Harness session that owns the resulting Active Graph and retrieval trace. */
  sessionId?: string;
  nodeName?: string;
  scope?: MemoryScope;
  /** Restrict retrieval to memories attributed to one actor. */
  sourceActor?: MemoryActor;
  includeHistorical?: boolean;
  maxTier?: MemoryTier;
  limit?: number;
  graphHops?: number;
  retrievalMode?: "legacy" | "fts5" | "hashing" | "qwen3" | "hybrid";
  taskId?: string;
  activeGraphBudget?: Partial<ActiveGraphBudget>;
  /** Maximum semantic nodes considered by hierarchical vector routing. */
  nodeCandidateLimit?: number;
  /** Maximum leaf blocks considered by hierarchical vector routing. */
  leafCandidateLimit?: number;
  /** Selects compressed node/leaf routing or a full record-vector diagnostic path. */
  vectorGranularity?: "hierarchy" | "records" | "union";
  /**
   * Internal two-stage retrieval can inspect a disposable candidate graph before
   * committing the final Active Graph. The probe must not become a feedback trace.
   */
  persistTrace?: boolean;
  /** Override the QPP trigger threshold (Stage 1 calibration / experiments). */
  qppThreshold?: number;
  /** Enable progressive Fibonacci re-selection from the same over-sampled pool.
   *  Each cumulative tier (1, 2, 3, 5, ...) recomputes QPP; no re-search occurs. */
  secondPass?: boolean;
  /** Rank the complete pool once, then initially expose only the hotter half of
   * tier-1 records. Deferred IDs can be fetched without repeating retrieval.
   * Core retrieval defaults to false; harnesses may opt in at their boundary. */
  progressiveWarmDisclosure?: boolean;
  /** Open memory tiers sequentially and stop when QPP says evidence is sufficient. */
  tieredDisclosure?: boolean;
  /** Learned first-pass Fibonacci tier. QPP may continue to later tiers. */
  initialEvidenceTarget?: number;
  /** Disable per-phase timing for this operation (default: enabled). */
  perf?: boolean;
}

export interface EmbeddingDocument {
  memoryId: string;
  text: string;
}

export interface NodeEmbeddingDocument {
  nodeId: string;
  text: string;
}

export interface ExternalNodeEmbedding {
  nodeId: string;
  vector: readonly number[];
}

export interface LeafBlock {
  id: string;
  nodeId: string;
  tier: MemoryTier;
  summary: string;
  memoryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LeafEmbeddingDocument {
  blockId: string;
  nodeId: string;
  text: string;
}

export interface ExternalLeafEmbedding {
  blockId: string;
  vector: readonly number[];
}

export interface ExternalEmbedding {
  memoryId: string;
  vector: readonly number[];
}

export interface StoredEmbedding extends ExternalEmbedding {
  model: string;
}

export interface EmbeddingIndexHealth {
  indexId: string;
  model: string;
  profile: string;
  targets: Array<"leaves" | "nodes" | "records">;
  status: "failed" | "ready" | "running";
  pending: {
    nodes: number;
    leaves: number;
    records: number;
    dirtyNodes: number;
  };
  indexed: {
    nodes: number;
    leaves: number;
    records: number;
  };
  lastStartedAt: string | null;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
}

export interface SessionArchive {
  sessionId: string;
  historyId: string;
  createdAt: string;
}

export interface MemorySearchResult {
  memory: MemoryRecord;
  node: MemoryNode;
  evidence: HistoryRecord;
  evidenceRecords: HistoryRecord[];
  lexicalScore: number;
  vectorScore: number;
  routeScore: number;
  combinedScore: number;
}

export interface DeriveMemoryInput extends Omit<RememberInput, "evidence"> {
  sourceMemoryIds: string[];
  derivation: string;
}

/** Which retrieval filters were effective on a query and what they cost.
 *  Captured in every trace so downstream consumers (index-decision, budget
 *  projection, QPP calibration, retention, agent feedback) share one record. */
export interface RetrievalFilterUsage {
  /** Filter dimensions actually applied, e.g. ["scope.project", "node", "sourceActor"]. */
  dimensions: string[];
  /** Candidate rows scanned by SQL (before post-filter). */
  candidatesBefore: number;
  /** Candidates surviving the filter (after post-filter, before sort). */
  candidatesAfter: number;
  /** selectiveness = 1 − after/before; 0 = no reduction, 1 = everything filtered. */
  selectivity: number;
}

export interface MemoryContext {
  results: MemorySearchResult[];
  relations: NodeRelation[];
  progressiveDisclosure?: {
    strategy: "warm_halves";
    rankedWarmCandidates: number;
    initiallyVisible: number;
    deferredMemoryIds: string[];
  };
  activeGraph?: ActiveGraph;
  retrieval?: {
    mode: "hybrid" | "lexical";
    degraded: boolean;
    reason?:
      "embedding_index_missing_targets" | "embedding_index_not_ready" | "embedding_unavailable";
  };
  /** Per-phase timings, present unless timing was disabled via SearchOptions.perf. */
  timings?: PerfSnapshot;
  /** Effective filters and their candidate reduction, when filtering was applied. */
  filterUsage?: RetrievalFilterUsage;
}

export interface ActiveGraphBudget {
  maxNodes: number;
  maxEdges: number;
  maxEvidence: number;
  maxTokens: number;
  maxGraphHops: number;
  maxLocalTier: MemoryTier;
  maxTierBudget: number;
  maxLatencyMs: number;
}

export interface ActiveGraphBudgetUsage {
  nodes: number;
  edges: number;
  evidence: number;
  estimatedTokens: number;
  graphHops: number;
  deepestTier: MemoryTier;
  tiersOpened: number;
  deepEvidence: number;
  latencyMs: number;
  exhausted: Array<"deepEvidence" | "edges" | "evidence" | "latency" | "nodes" | "tokens">;
}

export type ActiveGraphBudgetDimension =
  | "deepEvidence"
  | "edges"
  | "evidence"
  | "graphHops"
  | "latencyMs"
  | "localTier"
  | "nodes"
  | "tiersOpened"
  | "tokens";

export interface ActiveGraphBudgetLedgerEntry {
  dimension: ActiveGraphBudgetDimension;
  limit: number;
  used: number;
  exhausted: boolean;
}

export interface ActiveGraphSelection {
  memoryId: string;
  nodeId: string;
  source: "direct" | "graph_expansion";
  reason: RecallCue["reason"];
  rank: number;
  tier: MemoryTier;
  estimatedTokens: number;
  scores: {
    lexical: number;
    vector: number;
    route: number;
    combined: number;
    usefulness: number;
  };
}

export interface ActiveGraphExpansion {
  relationId: string;
  sourceNodeId: string;
  targetNodeId: string;
  hop: number;
}

export interface ActiveGraphEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: NodeRelationType | "query_association";
  persistence: "persistent" | "temporary";
  stability: number;
  /** Query-local derived value captured only for trace/debug output. */
  activation?: number;
  activationChannel?: "conductive" | "regulatory";
}

export interface ActiveGraph {
  id: string;
  sessionId: string | null;
  query: string;
  taskId: string;
  nodeIds: string[];
  memoryIds: string[];
  edges: ActiveGraphEdge[];
  selections: ActiveGraphSelection[];
  expansions: ActiveGraphExpansion[];
  budgetLedger: ActiveGraphBudgetLedgerEntry[];
  budget: ActiveGraphBudget;
  usage: ActiveGraphBudgetUsage;
  /** Shadow QPP decision (Stage 0): computed, not yet acted on by searchContext. */
  qpp?: QppTriggerDecision;
  createdAt: string;
}

export interface RecallCue {
  nodeId: string;
  canonicalName: string;
  memoryTypes: MemoryType[];
  activeCount: number;
  newestAt: string | null;
  deepestTier: MemoryTier;
  hasConflicts: boolean;
  hasDeepMemory: boolean;
  score: number;
  reason: "hybrid_match" | "learned_route" | "lexical_match" | "vector_match";
}

export interface RecallIndex {
  cues: RecallCue[];
}

export type MemoryLoadMode = "none" | "cue" | "retrieve";

export interface MemoryGateDecision {
  mode: MemoryLoadMode;
  confidence: number;
  reason: "explicit_recall" | "memory_may_help" | "memory_not_needed";
  maxTier: MemoryTier;
  limit: number;
  graphHops: number;
}

export interface NodeRoute {
  node: MemoryNode;
  score: number;
}

export interface NodeTransform {
  id: string;
  type: "merge" | "split";
  sourceNodeIds: string[];
  targetNodeIds: string[];
  movedMemoryIds: string[];
  createdAt: string;
}

/** Learned weights for the QPP score composition (see qpp.ts). */
export interface QppWeights {
  /** weight on the score-variance (NQC-family) term. */
  tauV: number;
  /** weight on intent coverage. */
  wIc: number;
  /** weight on reason health. */
  wRh: number;
}

/** A retrieval candidate projected to exactly the fields QPP needs. */
export interface QppCandidate {
  /** Match strength = hybridScore(lexical, vector, route). Bounded [0,1] and
   *  path-consistent (unlike combinedScore, which is lexical-scale on some paths). */
  strength: number;
  reason: RecallCue["reason"];
  memoryType: MemoryType;
  isDirect: boolean;
}

export interface QppComponents {
  /** clamp(max usefulness among direct candidates, 0, 1). */
  top1: number;
  /** bounded standard deviation of direct usefulness in [0,1] (NQC-family). */
  variance: number;
  /** [0,1]; 0.5 neutral when the query matches no intent family. */
  intentCoverage: number;
  /** [0,1]; share of direct candidates whose reason is not hybrid_match. */
  reasonHealth: number;
  /** number of direct candidates used for the score-based signals. */
  directCount: number;
  /** total candidate count (direct + graph_expansion). */
  totalCount: number;
}

export type QppTriggerReason =
  "ok" | "below_threshold" | "guardrail_empty" | "guardrail_all_fallback" | "guardrail_low_top1";

export interface QppExpansionStage {
  /** Cumulative evidence budget for this stage (1, 2, 3, 5, 8, ...). */
  targetEvidence: number;
  selectedEvidence: number;
  estimatedTokens: number;
  qpp: number;
  trigger: boolean;
  reason: QppTriggerReason;
}

/** Stage 0 trigger decision; recorded on the trace as shadow observation. */
export interface QppTriggerDecision {
  trigger: boolean;
  reason: QppTriggerReason;
  qpp: number;
  threshold: number;
  components: QppComponents;
  /** Present when progressive Fibonacci recall was enabled for this query. */
  expansion?: {
    strategy: "fibonacci";
    stages: QppExpansionStage[];
    stoppedBecause: "budget_exhausted" | "candidate_pool_exhausted" | "sufficient";
  };
}

export interface RetrievalTraceInput {
  /** Harness session allowed to read or attribute use to this trace. */
  sessionId?: string | null;
  query: string;
  taskId?: string;
  resultMemoryIds: string[];
  resultNodeIds: string[];
  expandedNodeIds?: string[];
  relationIds?: string[];
  ambiguity?: number;
  fallbackUsed?: boolean;
  conflictObserved?: boolean;
  usefulMemoryIds?: string[];
  contradictedMemoryIds?: string[];
  rejectedMemoryIds?: string[];
  /** Precomputed node IDs for the useful/contradicted memories. The retrieval
   *  path already knows these (it selected the nodes); passing them avoids
   *  the `nodeIdsForMemories` re-lookup in recordRetrievalTrace. Optional:
   *  when omitted, recordRetrievalTrace falls back to mapping the memory IDs.
   *  When present, must be the node-IDs corresponding to usefulMemoryIds /
   *  contradictedMemoryIds respectively. */
  usefulNodeIds?: string[];
  contradictedNodeIds?: string[];
  activeGraphBudget?: ActiveGraphBudget;
  activeGraphUsage?: ActiveGraphBudgetUsage;
  selections?: ActiveGraphSelection[];
  expansions?: ActiveGraphExpansion[];
  budgetLedger?: ActiveGraphBudgetLedgerEntry[];
  /** Shadow QPP observation (Stage 0): computed, not yet acted on. */
  qpp?: QppTriggerDecision;
  /** Per-phase timing captured on the search pass, persisted for aggregate
   *  performance profiling (retrieval_traces.timings_json). */
  timings?: PerfSnapshot;
  /** Effective filter dimensions and candidate reduction (multi-consumer). */
  filterUsage?: RetrievalFilterUsage;
}

/** Long-term per-section performance aggregate (Welford online statistics).
 *  Independent of retrieval_traces pruning: rows live as long as the schema,
 *  so averages survive raw-trace expiry. */
export interface PerfAggregate {
  section: string;
  count: number;
  /** Sum of observed section ms. */
  sum: number;
  /** Sum of squared section ms (Welford M2); avg = sum/count,
   *  variance = (sumSq − sum²/count)/count. */
  sumSq: number;
  /** Log-scale histogram counts (fixed length) for percentile estimation. */
  buckets: number[];
  updatedAt: string;
}

export interface RetrievalTrace extends RetrievalTraceInput {
  id: string;
  sessionId: string | null;
  taskId: string;
  expandedNodeIds: string[];
  relationIds: string[];
  usefulMemoryIds: string[];
  contradictedMemoryIds: string[];
  rejectedMemoryIds: string[];
  ambiguity: number;
  fallbackUsed: boolean;
  conflictObserved: boolean;
  activeGraphBudget: ActiveGraphBudget;
  activeGraphUsage: ActiveGraphBudgetUsage;
  selections: ActiveGraphSelection[];
  expansions: ActiveGraphExpansion[];
  budgetLedger: ActiveGraphBudgetLedgerEntry[];
  createdAt: string;
}

export interface EdgeStability {
  leftNodeId: string;
  rightNodeId: string;
  independentTasks: number;
  usefulTasks: number;
  contradictedTasks: number;
  score: number;
  updatedAt: string;
}

export interface ActivationSignal {
  selectedCount: number;
  expandedCount: number;
  usedCount: number;
  contradictedCount: number;
  rejectedCount: number;
  score: number;
  updatedAt: string;
}

export interface MemoryWriteEvent {
  id: string;
  memoryId: string | null;
  historyId: string | null;
  sessionId: string | null;
  decision: "accepted" | "rejected";
  policyReason: string;
  writeReason: string;
  writeSource: MemoryWriteSource;
  memoryType: MemoryType;
  requestedResidence: MemoryResidence;
  createdAt: string;
}

export interface ConsolidationEvent {
  id: string;
  action: "consolidate" | "demote" | "promote_memory" | "demote_memory" | "expire_memory";
  targetId: string;
  previousState: string;
  nextState: string;
  reason: string;
  evidenceTraceIds: string[];
  createdAt: string;
}

export interface ConsolidationResult {
  consolidatedRelations: NodeRelation[];
  demotedRelations: NodeRelation[];
  events: ConsolidationEvent[];
}

export interface TopologyProposal {
  id: string;
  proposalKey: string;
  type: "link" | "split";
  sourceNodeIds: string[];
  relationType: NodeRelationType | null;
  partitions: Array<{ label: string; memoryIds: string[] }>;
  evidenceTraceIds: string[];
  observations: number;
  estimatedGain: number;
  status: "accepted" | "pending" | "rejected";
  createdAt: string;
}

export interface RebalanceResult {
  nodeId: string;
  changedMemoryIds: string[];
  expectedDepth: number;
  pendingAccesses: number;
}

export interface VectorEmbedder {
  readonly dimensions: number;
  readonly model: string;
  embed(text: string): readonly number[];
}
