import type {
  HistoryRecord,
  MemoryNode,
  MemoryRecord,
  MemoryScope,
  NodeRelation,
} from "../types.ts";

export type MemoryEntity =
  | { kind: "memory"; value: MemoryRecord }
  | { kind: "history"; value: HistoryRecord }
  | { kind: "node"; value: MemoryNode }
  | { kind: "edge"; value: NodeRelation };

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
  resultIds: readonly string[];
  result?: unknown;
}

export type MemoryCommitOutcome =
  | { status: "committed" | "replayed"; receipt: MemoryCommitReceipt }
  | { status: "conflict"; revision: number };

export interface MemoryBackend {
  readonly namespace: string;
  readonly kind: "sqlite" | "lancedb";
  openRead(): Promise<MemoryReadView>;
  scan(view: MemoryReadView, query: MemoryEntityQuery): Promise<MemoryEntity[]>;
  receipt(view: MemoryReadView, operationId: string): Promise<MemoryCommitReceipt | null>;
  closeRead(view: MemoryReadView): Promise<void>;
  commit(request: MemoryCommitRequest): Promise<MemoryCommitOutcome>;
  close(): Promise<void>;
}

export class MemoryOperationConflict extends Error {
  constructor(operationId: string) {
    super(`Memory operation ${operationId} already has different content`);
    this.name = "MemoryOperationConflict";
  }
}
