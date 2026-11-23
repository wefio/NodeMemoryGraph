import type {
  ClaimOutcomeEvent,
  ClaimPosterior,
  HistoryRecord,
  MemoryActor,
  MemoryNode,
  MemoryRecord,
  MemoryRelationRecord,
  MemoryResolution,
  MemoryScope,
  MemoryContext,
  MemorySearchResult,
  MemoryType,
  MemoryWriteEvent,
  NodeRelation,
  TesseraRecord,
  TopologyProposal,
} from "../types.ts";

export const MAX_MEMORY_COMMIT_ENTITIES = 512;

export interface MemoryStateAlias {
  id: string;
  aliasKey: string;
  canonicalKey: string;
  scope: MemoryScope;
  createdAt: string;
}

export type MemoryEntity =
  | { kind: "memory"; value: MemoryRecord }
  | { kind: "history"; value: HistoryRecord }
  | { kind: "node"; value: MemoryNode }
  | { kind: "edge"; value: NodeRelation }
  | { kind: "memoryRelation"; value: MemoryRelationRecord }
  | { kind: "stateAlias"; value: MemoryStateAlias }
  | { kind: "writeEvent"; value: MemoryWriteEvent }
  | { kind: "relationProposal"; value: TopologyProposal & { sessionId: string | null } }
  | {
      kind: "claimPosterior";
      value: { id: string; sessionId: string | null; posterior: ClaimPosterior };
    }
  | { kind: "claimOutcome"; value: ClaimOutcomeEvent & { sessionId: string | null } }
  | {
      kind: "resolutionEvent";
      value: {
        id: string;
        memoryId: string;
        fromResolution: MemoryResolution;
        toResolution: MemoryResolution;
        openedAt: string | null;
        relatedMemoryIds: string[];
        reason: string | null;
        sessionId: string | null;
        createdAt: string;
      };
    }
  | { kind: "tessera"; value: TesseraRecord };

/** A service authenticates the namespace before opening a backend. */
export function sessionScopedEntity(kind: MemoryEntity["kind"]): boolean {
  return (
    kind === "memory" ||
    kind === "relationProposal" ||
    kind === "resolutionEvent" ||
    kind === "claimPosterior" ||
    kind === "claimOutcome"
  );
}

export interface MemoryReadView {
  readonly revision: number;
}

export interface MemoryEntityQuery {
  kind: MemoryEntity["kind"];
  ids?: readonly string[];
  nodeId?: string;
  nodeIds?: readonly string[];
  nodeName?: string;
  scope?: MemoryScope;
  excludeScope?: MemoryScope;
  /** Shared rows plus this session's provisional rows. Omit for shared rows only. */
  sessionId?: string;
  text?: string;
  exactText?: string;
  stateKey?: string;
  sourceMessageId?: string;
  supersedesId?: string;
  claimMemoryId?: string;
  consolidatedFrom?: string;
  eventTimeFrom?: string;
  eventTimeTo?: string;
  connectedTo?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryChanges {
  upsert: readonly MemoryEntity[];
}

export interface MemoryCommitReceipt {
  operationId: string;
  requestHash: string;
  revision: number;
  /** Domain identities let the engine recover a result after a lost reply. */
  resultIds: string[];
  result?: unknown;
}

export interface MemoryCommitRequest {
  operationId: string;
  /** Hash of the trusted engine's canonical logical request, not a model field. */
  requestHash: string;
  expectedRevision: number;
  changes: MemoryChanges;
  audit?: readonly MemoryWriteEvent[];
  resultIds: readonly string[];
  result?: unknown;
}

export type MemoryCommitOutcome =
  | { status: "committed" | "replayed"; receipt: MemoryCommitReceipt }
  | { status: "conflict"; revision: number };

export interface MemoryRelationalProjectionQuery {
  scope?: MemoryScope;
  excludeScope?: MemoryScope;
  sessionId?: string;
  sourceSessionId?: string;
  nodeId?: string;
  nodeIds?: readonly string[];
  stateKey?: string;
  memoryType?: MemoryType;
  sourceActor?: MemoryActor;
  eventTimeFrom?: string;
  eventTimeTo?: string;
  includeHistorical?: boolean;
  maxTier?: 0 | 1 | 2 | 3;
  text?: string;
  now: string;
  limit: number;
  offset: number;
}

export interface MemoryRelationalProjectionPage {
  memories: MemoryRecord[];
  relations: MemoryRelationRecord[];
  hasMore: boolean;
}

export interface RelationalMemoryNeighbor {
  entity: Extract<MemoryEntity, { kind: "memory" }>;
  reason: "memory_relation" | "same_state" | "same_event_day";
}

export interface MemoryBackend {
  readonly namespace: string;
  readonly kind: "sqlite" | "lancedb";
  readonly vectorIndex?: MemoryVectorIndex;
  adjacentSources?(
    view: MemoryReadView,
    source: HistoryRecord,
    query: MemoryEntityQuery,
  ): SourceNeighbor[];
  projectMemories?(
    view: MemoryReadView,
    query: MemoryRelationalProjectionQuery,
  ): MemoryRelationalProjectionPage;
  relationalNeighbors?(
    view: MemoryReadView,
    anchor: MemoryRecord,
    query: MemoryEntityQuery,
  ): RelationalMemoryNeighbor[];
  leafPeers?(
    view: MemoryReadView,
    seedIds: readonly string[],
    excluded: readonly string[],
    query: MemoryEntityQuery,
  ): Promise<MemoryEntity[]>;
  chainProjection?(
    view: MemoryReadView,
    ids: readonly string[],
    sessionId?: string,
  ): MemoryChainProjection;
  openRead(): Promise<MemoryReadView>;
  counts?(view: MemoryReadView): Promise<{ memories: number; nodes: number }>;
  scan(view: MemoryReadView, query: MemoryEntityQuery): Promise<MemoryEntity[]>;
  /** Ranked lexical and vector admissions plus their available cross-scores from the same snapshot. */
  hybridCandidates?(
    view: MemoryReadView,
    query: MemoryEntityQuery & { text: string },
    semantic: MemoryVectorQuery,
  ): MemoryHybridPage;
  /** Read the requested pages in order from the same snapshot. */
  scanBatch?(
    view: MemoryReadView,
    queries: readonly MemoryEntityQuery[],
  ): Promise<MemoryEntity[][]>;
  receipt(view: MemoryReadView, operationId: string): Promise<MemoryCommitReceipt | null>;
  closeRead(view: MemoryReadView): Promise<void>;
  commit(request: MemoryCommitRequest): Promise<MemoryCommitOutcome>;
  close(): Promise<void>;
}

export interface SourceNeighbor {
  entity: Extract<MemoryEntity, { kind: "memory" }>;
  relation: "previous_turn" | "next_turn";
}

export interface MemoryChainProjection {
  memberships: Map<string, NonNullable<MemorySearchResult["chainMemberships"]>>;
  edges: NonNullable<MemoryContext["chainEdges"]>;
}

export interface MemoryVectorQuery {
  indexId: string;
  vector: readonly number[];
  mode: "vector" | "hybrid";
}

export interface MemoryVectorDocument {
  id: string;
  statement: string;
  text: string;
}

export interface MemoryVectorCursor {
  createdAt: string;
  id: string;
}

export interface MemoryVectorCandidate {
  entity: Extract<MemoryEntity, { kind: "memory" }>;
  recordScore: number;
}

export interface MemoryHybridPage {
  candidates: Array<
    MemoryVectorCandidate & {
      bm25: number;
      sourceSessionId?: string | null;
      turnOrdinal?: number | null;
    }
  >;
  vectorIds: string[];
  lexicalIds: string[];
}

export interface MemoryVectorIndex {
  has(indexId: string, dimensions?: number): boolean;
  stats(indexId: string): { indexed: number; pending: number };
  pending(
    indexId: string,
    limit: number,
    after?: MemoryVectorCursor,
  ): (MemoryVectorDocument & MemoryVectorCursor)[];
  save(
    indexId: string,
    documents: readonly MemoryVectorDocument[],
    vectors: readonly (number[] | Float32Array)[],
  ): void;
  candidates(
    view: MemoryReadView,
    query: MemoryEntityQuery,
    semantic: MemoryVectorQuery,
  ): MemoryVectorCandidate[];
}

export class MemoryOperationConflict extends Error {
  constructor(operationId: string) {
    super(`Memory operation ${operationId} already has different content`);
    this.name = "MemoryOperationConflict";
  }
}
