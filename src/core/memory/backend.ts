import type {
  HistoryRecord,
  MemoryNode,
  MemoryRecord,
  MemoryScope,
  MemoryWriteEvent,
  NodeRelation,
  TesseraRecord,
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
  | { kind: "stateAlias"; value: MemoryStateAlias }
  | { kind: "writeEvent"; value: MemoryWriteEvent }
  | { kind: "tessera"; value: TesseraRecord };

/** A service authenticates the namespace before opening a backend. */
export interface MemoryReadView {
  readonly revision: number;
}

export interface MemoryEntityQuery {
  kind: MemoryEntity["kind"];
  ids?: readonly string[];
  nodeId?: string;
  nodeName?: string;
  scope?: MemoryScope;
  /** Shared rows plus this session's provisional rows. Omit for shared rows only. */
  sessionId?: string;
  text?: string;
  exactText?: string;
  stateKey?: string;
  sourceMessageId?: string;
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

export interface MemoryBackend {
  readonly namespace: string;
  readonly kind: "sqlite" | "lancedb";
  readonly vectorIndex?: MemoryVectorIndex;
  openRead(): Promise<MemoryReadView>;
  scan(view: MemoryReadView, query: MemoryEntityQuery): Promise<MemoryEntity[]>;
  receipt(view: MemoryReadView, operationId: string): Promise<MemoryCommitReceipt | null>;
  closeRead(view: MemoryReadView): Promise<void>;
  commit(request: MemoryCommitRequest): Promise<MemoryCommitOutcome>;
  close(): Promise<void>;
}

export interface MemoryVectorQuery {
  indexId: string;
  vector: readonly number[];
  granularity: "records" | "hierarchy" | "union";
  mode: "vector" | "hybrid";
}

export interface MemoryVectorDocument {
  id: string;
  statement: string;
  text: string;
}

export interface MemoryVectorCandidate {
  entity: Extract<MemoryEntity, { kind: "memory" }>;
  recordScore: number;
  routeScore: number;
}

export interface MemoryVectorIndex {
  has(indexId: string, dimensions?: number): boolean;
  stats(indexId: string): { indexed: number; pending: number };
  pending(indexId: string, limit: number): MemoryVectorDocument[];
  save(
    indexId: string,
    documents: readonly MemoryVectorDocument[],
    vectors: readonly number[][],
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
