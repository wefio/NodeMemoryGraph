import type {
  MemoryActor,
  MemoryContext,
  MemoryResidence,
  MemoryScope,
  MemoryTier,
  MemoryType,
  RememberResult,
  TruthStatus,
} from "../core/types.ts";

export const NMG_PROTOCOL_VERSION = "nmg.v1" as const;

export const NMG_CAPABILITIES = [
  "hello",
  "status",
  "remember",
  "search",
  "get",
  "shutdown",
  "grpc",
  "protobuf",
  "lexical-retrieval",
  "optional-embedding-retrieval",
] as const;

export type NmgMethod = "get" | "hello" | "remember" | "search" | "shutdown" | "status";

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
}

export interface NmgSearchParams {
  query: string;
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
}

export interface NmgGetParams {
  memoryIds: string[];
  graphHops?: number;
}

export type NmgMethodResult = {
  hello: NmgHelloResult;
  status: NmgStatusResult;
  remember: RememberResult;
  search: MemoryContext;
  get: MemoryContext & { missingMemoryIds: string[] };
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
