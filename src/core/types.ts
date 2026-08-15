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

export const MEMORY_NODE_KINDS = [
  "concept",
  "constraint",
  "entity",
  "preference",
  "procedure",
  "project",
  "state",
  "strategy",
  "topic",
] as const;
export type MemoryNodeKind = (typeof MEMORY_NODE_KINDS)[number];

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
export const MEMORY_STORAGE_STATES = ["dormant", "indexed", "quarantine"] as const;
export type MemoryStorageState = (typeof MEMORY_STORAGE_STATES)[number];
export const MEMORY_RESIDENCES = ["ltg", "stg"] as const;
export type MemoryResidence = (typeof MEMORY_RESIDENCES)[number];
export type MemoryWriteSource = "agent" | "automatic" | "core" | "derived" | "import" | "user";
export const MEMORY_TYPES = [
  "constraint",
  "conversation_evidence",
  "derived",
  "event",
  "fact",
  "preference",
  "state",
  "strategy",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export const MEMORY_ACTORS = ["assistant", "system", "tool", "user"] as const;
export type MemoryActor = (typeof MEMORY_ACTORS)[number];
export const MAX_EVIDENCE_SOURCE_CHARACTERS = 4_096;
export const TRUTH_STATUSES = ["asserted", "inferred", "unverified", "verified"] as const;
export type TruthStatus = (typeof TRUTH_STATUSES)[number];
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

export const CLAIM_OUTCOMES = ["supported", "contradicted"] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];
export const CLAIM_OUTCOME_SOURCES = ["benchmark", "task", "tool", "user"] as const;
export type ClaimOutcomeSource = (typeof CLAIM_OUTCOME_SOURCES)[number];

/** One independently attributable result applied to selected claims. */
export interface ClaimOutcomeVoteInput {
  memoryId: string;
  /** Omit to vote on every atomic claim, or on the record-level fallback claim. */
  claimIndexes?: number[];
  outcome: ClaimOutcome;
  source: ClaimOutcomeSource;
  /** Stable identity of the original user/tool/eval source, used for audit. */
  sourceLineage: string;
  /** Reliability in (0,1]. Defaults to 1 for explicit strong signals. */
  weight?: number;
}

export interface RecordClaimOutcomesInput {
  semanticTaskId: string;
  votes: ClaimOutcomeVoteInput[];
  activeGraphId?: string;
  sessionId?: string;
}

export interface ClaimPosterior {
  memoryId: string;
  claimIndex: number;
  claimText: string;
  priorConfidence: number;
  alpha: number;
  beta: number;
  mean: number;
  conservativeLowerBound: number;
  independentVoteCount: number;
  updatedAt: string;
}

export interface ClaimOutcomeEvent {
  id: string;
  memoryId: string;
  claimIndex: number;
  semanticTaskId: string;
  source: ClaimOutcomeSource;
  sourceLineage: string;
  outcome: ClaimOutcome;
  weight: number;
  activeGraphId: string | null;
  createdAt: string;
}
export type MemoryStatus = "active" | "deleted" | "disputed" | "inactive" | "superseded";
export const MEMORY_RESOLUTIONS = ["open", "resolved", "reopened"] as const;
export type MemoryResolution = (typeof MEMORY_RESOLUTIONS)[number];
export const EVIDENCE_ROLES = [
  "contradict",
  "example",
  "exception",
  "origin",
  "support",
  "update",
] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];
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
  | "refines"
  | "same_as"
  | "distinct_from"
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
  /** Whether this memory represents an unresolved structure or a closed result. */
  resolution: MemoryResolution;
  /** First/most-recent time the structure entered an open or reopened state. */
  openedAt: string | null;
  /** Stable memories whose neighbourhood should make this open item reachable. */
  relatedMemoryIds: string[];
  residence: MemoryResidence;
  promotedAt: string | null;
  expiresAt: string | null;
  evidenceRole: EvidenceRole;
  supersedesId: string | null;
  /** Owning session for STG-provisional rows; null = explicitly shared
   *  (cached_from_ltg copies or LTG rows). Never nulled accidentally: see
   *  stg-shared-store-v2 docs §3.6 escape-hatch rule. */
  sessionId: string | null;
  tier: MemoryTier;
  importance: number;
  accessCount: number;
  lastAccessedAt: string | null;
  writeReason: string;
  writeSource: MemoryWriteSource;
  createdAt: string;
}

export interface MemoryResolutionEvent {
  id: string;
  memoryId: string;
  fromResolution: MemoryResolution;
  toResolution: MemoryResolution;
  openedAt: string | null;
  relatedMemoryIds: string[];
  reason: string | null;
  createdAt: string;
}

export interface MemoryExportItem {
  memory: MemoryRecord;
  node: MemoryNode;
  evidence: HistoryRecord[];
}

export interface MemoryExportBundle {
  format: "nmg.memory-export.v1";
  exportedAt: string;
  items: MemoryExportItem[];
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
  /** Exact, bounded source excerpt selected from a harness-owned message. */
  evidenceSource?: {
    actor: MemoryActor;
    content: string;
    sourceMessageId: string;
    sourceRef?: string;
  };
  evidenceHistoryId?: string;
  /** Owning session. REQUIRED when residence='stg' and not a cached_from_ltg
   *  copy — a provisional write without an explicit sessionId is rejected
   *  (string = session-private; null = explicitly shared; undefined = error).
   *  docs/stg-shared-store-v2 §3.6. */
  sessionId?: string | null;
  sourceRef?: string;
  tier?: MemoryTier;
  /**
   * Optional external judge (LLM) consulted when the incoming statement looks
   * like a near-duplicate of an existing same-scope memory. NMG auto-skips
   * exact normalized duplicates regardless; this callback decides the
   * ambiguous (near) cases. Not consulted when there are no candidates.
   */
  judgeDuplicates?: DuplicateJudge;
  importance?: number;
  scope?: MemoryScope;
  validFrom?: string;
  validUntil?: string;
  resolution?: MemoryResolution;
  openedAt?: string;
  relatedMemoryIds?: string[];
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
  /**
   * Detected duplicates/near-duplicates in the same scope at write time.
   * Exact duplicates are auto-skipped (the existing record is returned);
   * near-duplicates are surfaced here for the caller (optionally via
   * RememberInput.judgeDuplicates) to decide whether to merge.
   */
  duplicates?: DuplicateCandidate[];
  /**
   * Same-scope memories that may hold an outdated value for the same topic as
   * the incoming statement (a "supersession" candidate: the new statement is
   * the current value and one of these may be its stale predecessor). NMG
   * never decides this itself — an external judge (LLM) does, then applies it
   * via applySupersession. Text-only heuristic: shared content token overlap.
   */
  supersedeCandidates?: DuplicateCandidate[];
  /** Per-phase timings, present unless disabled via RememberInput.perf. */
  timings?: PerfSnapshot;
}

/** A same-scope memory that looks like a duplicate of the incoming statement. */
export interface DuplicateCandidate {
  memoryId: string;
  nodeId: string;
  statement: string;
  eventTime: string | null;
  /** 1 = exact (normalized) match; 0..1 for near duplicates. */
  similarity: number;
  /**
   * Supersession signal strength: transition-name hit ("from X to Y"
   * from-side words) and polarity flip are deterministic high-confidence
   * predecessor signals; plain token overlap is weak (same topic ≠
   * replacement). Lets the caller throttle how many candidates to consult
   * an LLM judge on.
   */
  priority?: "transition" | "polarity" | "token";
}

export interface DuplicateJudgement {
  /** Merge the incoming statement into the candidate (do not write a new record). */
  merge: boolean;
  /**
   * The incoming statement is a newer value for the same topic and supersedes
   * supersededMemoryId (the stale predecessor). The caller then calls
   * store.applySupersession({ newMemoryId, supersededMemoryId }) to mark the
   * old record superseded (retrieval already filters status='superseded').
   */
  supersede?: boolean;
  /** memoryId of the same-scope candidate this statement supersedes. */
  supersededMemoryId?: string;
  reason?: string;
}

/**
 * Optional external judge (an LLM) consulted on near-duplicates and potential
 * supersessions. NMG itself only acts on exact normalized equality; ambiguous
 * cases are delegated here. NLG may also flag a candidate as superseded.
 */
export type DuplicateJudge = (input: {
  statement: string;
  candidates: DuplicateCandidate[];
  /** Same-scope memories sharing content tokens — possible stale predecessors. */
  supersedeCandidates?: DuplicateCandidate[];
}) => DuplicateJudgement;

/**
 * Feedback-driven write-path maintenance — "the LLM lives in the feedback
 * loop, not the ingest path". The caller (an agent LLM, or an eval harness
 * simulating one) supplies semantic judgements AFTER answering, so NMG needs
 * no polarity/claims annotation at ingest time (0-annotation ingest).
 */
export interface RecordFeedbackInput {
  sessionId?: string;
  /** Retrieval memories the caller's answer actually used (access signals). */
  usedMemoryIds?: string[];
  /**
   * Caller-judged supersession: supersededMemoryId is the stale predecessor.
   * With newMemoryId → full supersession (pointer to the new value); without
   * it → mark the predecessor disputed (stale, new value pending). NMG
   * validates targets and applies.
   */
  supersede?: {
    supersededMemoryId: string;
    newMemoryId?: string;
    reason?: string;
  };
  /**
   * Retrieval hints (aliases / expected trigger words / CN-EN equivalent
   * terms) for a memory — stored as retrieveHint markers so a query matching
   * a hint (or its CJK substring) can surface the memory even when the
   * statement itself does not contain the query term. LLM provides: only the
   * writer knows the retrieval intent.
   */
  retrieveHints?: Array<{ memoryId: string; hints: string[] }>;
}

export const RETRIEVAL_MODES = ["legacy", "fts5", "hashing", "qwen3", "hybrid"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];
export const VECTOR_GRANULARITIES = ["hierarchy", "records", "union"] as const;
export type VectorGranularity = (typeof VECTOR_GRANULARITIES)[number];

export interface SearchOptions {
  /** Harness session that owns the resulting Active Graph and retrieval trace. */
  sessionId?: string;
  nodeName?: string;
  scope?: MemoryScope;
  eventTimeFrom?: string;
  /** Inclusive upper bound (ISO day "2029-03-11") on memory event_time for
   *  candidate generation — enforced in the candidate SQL, not post-query. */
  eventTimeTo?: string;
  /** Restrict retrieval to memories attributed to one actor. */
  sourceActor?: MemoryActor;
  includeHistorical?: boolean;
  maxTier?: MemoryTier;
  limit?: number;
  graphHops?: number;
  retrievalMode?: RetrievalMode;
  /** Post-retrieval chain expansion: when a ranked result is a member of a
   *  memory chain, pull the chain's other members and append them to the
   *  context (in chain order). The retrieval ranking is left untouched — this
   *  only closes the recall gap on evolution/aggregation queries. */
  expandChains?: boolean;
  /** When expandChains is on, cap chain-member expansion to a window around
   *  the ranked hit(s): members with position in [minHit−window, maxHit+window]
   *  are appended. Omit for the whole chain. */
  chainExpansionWindow?: number;
  /** Optional, caller-chosen recency decay (docs §3.4): when set, ranking
   *  dampens each memory's combined score by 0.5^(age_days / half_life) based
   *  on its event_time, so stale facts stop dominating current-value queries.
   *  Default off — existing retrieval is unchanged; memories without an
   *  event_time are never dampened. This is an explicit opt-in, never a
   *  default re-rank (Mem0's knowledge-update regression is the cautionary
   *  tale for making recency a silent default). */
  recencyDecayHalfLifeDays?: number;
  taskId?: string;
  activeGraphBudget?: Partial<ActiveGraphBudget>;
  /** Maximum semantic nodes considered by hierarchical vector routing. */
  nodeCandidateLimit?: number;
  /** Maximum leaf blocks considered by hierarchical vector routing. */
  leafCandidateLimit?: number;
  /** Selects compressed node/leaf routing or a full record-vector diagnostic path. */
  vectorGranularity?: VectorGranularity;
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
  /** Override the strong-hit margin (relative top1→top2 gap). Default 0.05. */
  strongHitTopGap?: number;
  /** Override the strong-hit first-pass target. Default 3. */
  strongHitInitialTarget?: number;
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

/** Result of one bounded, threshold-triggered maintenance slice. */
export interface MaintenanceBatchResult {
  id: string;
  consideredNodes: number;
  rebalancedNodeIds: string[];
  compactedNodeIds: string[];
  changedMemoryIds: string[];
  rebuiltLeafBlocks: number;
  acknowledgedDeltas: number;
  rowsTouched: number;
  durationMs: number;
  createdAt: string;
}

export interface SemanticMaintenanceResult {
  id: string;
  expiredMemoryIds: string[];
  consolidatedRelationIds: string[];
  demotedRelationIds: string[];
  proposedTopologyIds: string[];
  autoMergedTransformIds: string[];
  rowsTouched: number;
  durationMs: number;
  createdAt: string;
}

export interface SessionArchive {
  sessionId: string;
  historyId: string;
  createdAt: string;
}

/** One edge on a multi-hop activation path (docs §7.1). Source is the node
 *  the activation propagated FROM, target is where it landed. hop is the
 *  distance from the retrieval seed. */
export interface EdgePathStep {
  relationId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationType: NodeRelationType;
  hop: number;
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
  /** Why this record surfaced: lexical/vector/graph route, populated by
   *  searchContext before the context is returned. Header formatters use it
   *  to tell the model why a candidate was recalled. */
  recallReason?: "hybrid_match" | "learned_route" | "lexical_match" | "vector_match";
  /** Multi-hop path traceability: when this result reached via graph
   *  activation propagation, the edge chain from a seed node to this record's
   *  node (best-activation path). Lets the presentation layer explain "why
   *  related" (docs §7.1 multi-hop path retrieval). Empty/absent for seed hits. */
  path?: EdgePathStep[];
  /** Query terms that literally appear in the candidate (lexical matches).
   *  Empty for pure-semantic/route recalls. */
  hitTerms?: string[];
  /** Set on retrieval-time near-duplicates: memoryId of the kept record
   *  (first/highest-ranked occurrence) this result duplicates. Callers may
   *  drop these for rendering or keep them for evidence. */
  duplicateOf?: string;
  /** Set on post-retrieval chain expansion: the chain this member was pulled
   *  from. The retrieval ranking is untouched; chain members are appended
   *  after the ranked results to close the recall gap on evolution/aggregation
   *  queries (see docs/temporal-logical-chains-design-2026-08-13.md §3.1). */
  chainId?: string;
  /** Position of this member within its chain (0-based, chain order). */
  chainPosition?: number;
  /** Chain type (temporal / logical) — how the member order should be read. */
  chainType?: MemoryChainType;
  /** Full chain memberships for this result — a memory can belong to several
   *  chains (e.g. a record in both a temporal and a logical chain). The first
   *  entry mirrors chainId/chainPosition/chainType for single-chain callers. */
  chainMemberships?: Array<{
    chainId: string;
    position: number;
    chainType: MemoryChainType;
    /** Chain topic/name so multiple chains of the same type stay distinguishable. */
    topic?: string;
  }>;
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
  /** Chain edges (DAG) collected during expandChains: the directed edges of
   *  every chain surfaced. Lets the presentation layer render a chain as a
   *  DAG (branching `A --> B & C`) instead of a linear position sequence.
   *  Absent when no chains were expanded. */
  chainEdges?: Array<{
    chainId: string;
    sourceMemoryId: string;
    targetMemoryId: string;
    edgeType: MemoryChainEdgeType;
  }>;
  relations: NodeRelation[];
  progressiveDisclosure?: {
    strategy: "learned_retained_mass" | "warm_halves";
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
  source: "direct" | "graph_expansion" | "open_attachment";
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

/** Memory chains: static ordered-reference DAG forests over memory_records.
 * A chain is a small, independent, internally-acyclic sequence of memory
 * references; node reuse gives cross-chain intersection (a memory may belong
 * to many chains). Chains store dependencies only — inference/reasoning is
 * the reasoner's job, not theirs. Time chains order by event_time (position
 * derived at write time); logical chains carry explicit write-time order.
 * Written explicitly (natural supervision), never inferred automatically. */
export const MEMORY_CHAIN_TYPES = ["temporal", "logical"] as const;
export type MemoryChainType = (typeof MEMORY_CHAIN_TYPES)[number];
export type MemoryChainStatus = "active" | "closed";

export interface MemoryChain {
  id: string;
  chainType: MemoryChainType;
  topic: string;
  ownerSessionId: string | null;
  status: MemoryChainStatus;
  createdAt: string;
}

export interface MemoryChainMember {
  chainId: string;
  memoryId: string;
  position: number;
  note: string | null;
  createdAt: string;
  /** Live-reference marker: when this member's memory has been superseded
   *  (status 'superseded'), the active successor id. The chain keeps the
   *  original snapshot (historical context) while pointing at the current
   *  value — callers may follow or ignore it. */
  successorId?: string;
}

export const MEMORY_CHAIN_EDGE_TYPES = ["order"] as const;
export type MemoryChainEdgeType = (typeof MEMORY_CHAIN_EDGE_TYPES)[number];

/** A directed edge in a memory chain (DAG). Edges are pointers (source →
 *  target). Temporal chains order by event time; logical chains carry explicit
 *  causal/ordering pointers. Branching = one source with several targets (a
 *  memory may fan out); merging = several sources into one target. Written
 *  explicitly (natural supervision), never inferred. The DAG invariant (no
 *  cycles) is enforced at write time. */
export interface MemoryChainEdge {
  chainId: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  edgeType: MemoryChainEdgeType;
  createdAt: string;
}

/** The default Task Board channel when no explicit taskId is given: the shared
 * world channel acts as a lobby, surfacing active named channels on read. */
export const WORLD_BOARD_ID = "default";
export const TASK_BOARD_KINDS = [
  "blocker",
  "decision",
  "goal",
  "handoff",
  "note",
  "question",
  "result",
] as const;
export type TaskBoardKind = (typeof TASK_BOARD_KINDS)[number];
export type TaskBoardStatus = "open" | "resolved";

/** Temporary, task-scoped coordination state. It is never an LTG memory. */
export interface TaskBoardEntry {
  id: string;
  taskId: string;
  sequence: number;
  agentId: string;
  sourceSessionId: string | null;
  kind: TaskBoardKind;
  content: string;
  status: TaskBoardStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
  /** Lease-based claim: the agent working this entry. A claim is live while
   * claimedBy is set and claimExpiresAt is in the future. */
  claimedBy: string | null;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  /** Directed delivery (A2A-compatible find→direct): stable agent_name that
   * should be woken for this entry. Others see it on read but stay silent.
   * Null = ordinary broadcast to subscribers. Uses stable agent name, never
   * sessionId. */
  to: string | null;
  /** Reply-gated serial handoff state: un-directed actionable entries are
   * 'outstanding' (the one being worked) or 'pending' (queued until the
   * outstanding one is replied/resolved); 'stale' after serial timeout.
   * Directed entries and notify-only kinds are null. */
  serialState: "outstanding" | "pending" | "stale" | null;
  /** Agent ids that have acknowledged (seen-and-accepted, no reply owed) this
   * entry. Populated by the store on read/put/claim/release/resolve.
   * Logical "N checkmarks" rendered from a physical row table. */
  ackedBy: string[];
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
  rolledBackAt: string | null;
}

/** Learned weights for the QPP score composition (see qpp.ts). */
export interface QppWeights {
  /** weight on the NQC normalised dispersion term (stdev/mean of top scores). */
  wNqc: number;
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
  /** NQC normalised dispersion: stdev(top-k) / mean(top-k), clamped [0,1].
   *  Replaces the absolute top1 anchor's cross-query baseline problem: a sharp
   *  top1 margin maps to a high NQC, a flat distribution to a low one. */
  nqc: number;
  /** Relative top1→top2 margin: (s1 − s2) / s1, clamped [0,1]. 0 when fewer
   *  than 2 direct candidates. A large margin is the only retrieval-side
   *  signal that reliably predicts a single-evidence query (measured: median
   *  K_need drops to ~3 when this exceeds ~0.05; top1 alone does not). */
  topGap: number;
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
  evidenceMemoryIds: string[];
  observations: number;
  estimatedGain: number;
  status: "accepted" | "pending" | "rejected";
  actuatedTransformId: string | null;
  actuationError: string | null;
  actuatedAt: string | null;
  createdAt: string;
}

export interface TopologyAutomationAssessment {
  proposalId: string;
  eligible: boolean;
  reasons: string[];
  targetName: string | null;
  policy: {
    minimumObservations: number;
    minimumEstimatedGain: number;
    minimumEvidenceMemories: number;
  };
}

export interface RebalanceResult {
  nodeId: string;
  changedMemoryIds: string[];
  processedMemoryCount: number;
  expectedDepth: number;
  pendingAccesses: number;
}

export interface VectorEmbedder {
  readonly dimensions: number;
  readonly model: string;
  embed(text: string): readonly number[];
}
