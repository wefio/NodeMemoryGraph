import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  configuredProvider,
  createEmbeddingClientFromEnv,
  type EmbeddingClient,
} from "../core/embedding-provider.ts";
import { NmgStore } from "../core/store.ts";
import type {
  EvidenceRole,
  MemoryActor,
  MemoryResidence,
  MemoryScope,
  MemoryTier,
  MemoryType,
  SearchOptions,
  TruthStatus,
} from "../core/types.ts";
import { assessMemoryWrite } from "../core/write-policy.ts";
import { searchMemoryContext } from "../integration/search.ts";
import {
  NMG_CAPABILITIES,
  NMG_PROTOCOL_VERSION,
  NmgProtocolError,
  type NmgGetParams,
  type NmgHelloResult,
  type NmgDeleteMemoryParams,
  type NmgMethod,
  type NmgMethodResult,
  type NmgMergeNodesParams,
  type NmgRememberParams,
  type NmgRetentionCandidatesParams,
  type NmgSearchParams,
  type NmgSetStorageStateParams,
  type NmgSplitNodeParams,
  type NmgStatusResult,
} from "./protocol.ts";

const SERVICE_VERSION = "0.1.0";
const MEMORY_TYPES = [
  "constraint",
  "conversation_evidence",
  "derived",
  "event",
  "fact",
  "preference",
  "state",
  "strategy",
] as const;
const ACTORS = ["assistant", "system", "tool", "user"] as const;
const TRUTH_STATUSES = ["asserted", "inferred", "unverified", "verified"] as const;
const EVIDENCE_ROLES = [
  "contradict",
  "example",
  "exception",
  "origin",
  "support",
  "update",
] as const;
const RESIDENCES = ["ltg", "stg"] as const;
const RETRIEVAL_MODES = ["legacy", "fts5", "hashing", "qwen3", "hybrid"] as const;
const VECTOR_GRANULARITIES = ["hierarchy", "records", "union"] as const;
const STORAGE_STATES = ["indexed", "dormant", "quarantine"] as const;
const NODE_KINDS = [
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

export interface NmgServiceOptions {
  dataDirectory?: string;
  databasePath?: string;
  environment?: NodeJS.ProcessEnv;
}

export class NmgService {
  readonly databasePath: string;
  readonly #environment: NodeJS.ProcessEnv;
  #store: NmgStore | undefined;
  #embeddingClient: EmbeddingClient | undefined | null;
  #embeddingError: string | null = null;
  #shutdownRequested = false;

  constructor(options: NmgServiceOptions = {}) {
    const dataDirectory = resolve(
      options.dataDirectory ??
        options.environment?.NMG_DATA_DIR ??
        process.env.NMG_DATA_DIR ??
        ".nmg",
    );
    this.databasePath = resolve(options.databasePath ?? join(dataDirectory, "nmg.sqlite"));
    this.#environment = options.environment ?? process.env;
  }

  get shutdownRequested(): boolean {
    return this.#shutdownRequested;
  }

  async invoke<M extends NmgMethod>(method: M, params?: unknown): Promise<NmgMethodResult[M]> {
    switch (method) {
      case "hello":
        return this.#hello() as NmgMethodResult[M];
      case "status":
        return this.#status() as NmgMethodResult[M];
      case "remember":
        return this.#remember(parseRememberParams(params)) as NmgMethodResult[M];
      case "search":
        return (await this.#search(parseSearchParams(params))) as NmgMethodResult[M];
      case "get":
        return this.#get(parseGetParams(params)) as NmgMethodResult[M];
      case "retentionCandidates":
        return {
          candidates: this.#getStore().retentionCandidates(parseRetentionCandidatesParams(params)),
        } as NmgMethodResult[M];
      case "setStorageState": {
        const parsed = parseSetStorageStateParams(params);
        return {
          memoryId: parsed.memoryId,
          storageState: this.#getStore().setMemoryStorageState(
            parsed.memoryId,
            parsed.storageState,
            parsed.recoveryDays,
          ),
        } as NmgMethodResult[M];
      }
      case "deleteMemory": {
        const parsed = parseDeleteMemoryParams(params);
        const memory = this.#getStore().deleteMemory(parsed.memoryId);
        return { deleted: memory !== null, memory } as NmgMethodResult[M];
      }
      case "mergeNodes":
        return this.#getStore().mergeNodes(parseMergeNodesParams(params)) as NmgMethodResult[M];
      case "splitNode":
        return this.#getStore().splitNode(parseSplitNodeParams(params)) as NmgMethodResult[M];
      case "shutdown":
        this.#shutdownRequested = true;
        return { shuttingDown: true } as NmgMethodResult[M];
      default:
        throw new NmgProtocolError("METHOD_NOT_FOUND", `unknown method: ${String(method)}`);
    }
  }

  close(): void {
    this.#store?.close();
    this.#store = undefined;
  }

  #hello(): NmgHelloResult {
    return {
      protocol: NMG_PROTOCOL_VERSION,
      service: "node-memory-graph",
      version: SERVICE_VERSION,
      capabilities: NMG_CAPABILITIES,
    };
  }

  #status(): NmgStatusResult {
    const exists = existsSync(this.databasePath);
    const embeddingClient = this.#configuredEmbeddingClient();
    const provider = this.#configuredProvider();
    return {
      ...this.#hello(),
      process: { pid: process.pid, node: process.version },
      storage: {
        databasePath: this.databasePath,
        exists,
        bytes: exists ? statSync(this.databasePath).size : 0,
        loaded: this.#store !== undefined,
      },
      embedding: {
        configured: provider !== null,
        provider,
        indexId: embeddingClient?.indexId ?? null,
        health:
          embeddingClient && this.#store
            ? this.#store.embeddingIndexHealth(embeddingClient.indexId)
            : null,
        reason: this.#embeddingError,
      },
    };
  }

  #remember(params: NmgRememberParams): NmgMethodResult["remember"] {
    const assessment = assessMemoryWrite({
      statement: params.statement,
      evidence: params.evidence,
      memoryType: params.memoryType,
    });
    if (!assessment.allowed) {
      this.#getStore().recordRejectedWrite({
        policyReason: assessment.reason,
        writeReason: params.writeReason ?? `cli_rejected_${params.memoryType ?? "fact"}`,
        writeSource: "user",
        memoryType: params.memoryType,
        requestedResidence: params.residence,
        sessionId: params.sessionId,
      });
      throw new NmgProtocolError("WRITE_REJECTED", assessment.reason);
    }
    return this.#getStore().remember({
      ...params,
      writeReason: params.writeReason ?? `cli_confirmed_${params.memoryType ?? "fact"}`,
      writeSource: "user",
    });
  }

  async #search(params: NmgSearchParams): Promise<NmgMethodResult["search"]> {
    const { query, ...options } = params;
    return searchMemoryContext(
      this.#getStore(),
      this.#configuredEmbeddingClient(),
      query,
      options as SearchOptions,
    );
  }

  #get(params: NmgGetParams): NmgMethodResult["get"] {
    const context = this.#getStore().getContext(params.memoryIds, params.graphHops ?? 0);
    const found = new Set(context.results.map((result) => result.memory.id));
    return {
      ...context,
      missingMemoryIds: params.memoryIds.filter((id) => !found.has(id)),
    };
  }

  #getStore(): NmgStore {
    return (this.#store ??= new NmgStore(this.databasePath));
  }

  #configuredEmbeddingClient(): EmbeddingClient | undefined {
    if (this.#embeddingClient !== undefined) return this.#embeddingClient ?? undefined;
    try {
      this.#embeddingClient = createEmbeddingClientFromEnv(this.#environment) ?? null;
    } catch (error) {
      this.#embeddingClient = null;
      this.#embeddingError = error instanceof Error ? error.message : String(error);
    }
    return this.#embeddingClient ?? undefined;
  }

  #configuredProvider(): string | null {
    try {
      return configuredProvider(this.#environment) ?? null;
    } catch (error) {
      this.#embeddingError ??= error instanceof Error ? error.message : String(error);
      return this.#environment.NMG_EMBED_PROVIDER?.trim() || null;
    }
  }
}

function parseRememberParams(value: unknown): NmgRememberParams {
  const params = objectParams(value);
  const parsed: NmgRememberParams = {
    statement: requiredString(params, "statement"),
    nodeName: requiredString(params, "nodeName"),
    memoryType: optionalEnum(params, "memoryType", MEMORY_TYPES) as MemoryType | undefined,
    stateKey: optionalString(params, "stateKey"),
    eventTime: optionalString(params, "eventTime"),
    sourceActor: optionalEnum(params, "sourceActor", ACTORS) as MemoryActor | undefined,
    truthStatus: optionalEnum(params, "truthStatus", TRUTH_STATUSES) as TruthStatus | undefined,
    evidence: optionalString(params, "evidence"),
    tier: optionalInteger(params, "tier", 0, 3) as MemoryTier | undefined,
    importance: optionalNumber(params, "importance", 0, 1),
    scope: optionalScope(params, "scope"),
    validFrom: optionalString(params, "validFrom"),
    validUntil: optionalString(params, "validUntil"),
    evidenceRole: optionalEnum(params, "evidenceRole", EVIDENCE_ROLES) as EvidenceRole | undefined,
    supersedesId: optionalString(params, "supersedesId"),
    residence: optionalEnum(params, "residence", RESIDENCES) as MemoryResidence | undefined,
    expiresAt: optionalString(params, "expiresAt"),
    writeReason: optionalString(params, "writeReason"),
    sessionId: optionalString(params, "sessionId"),
    sourceRef: optionalString(params, "sourceRef"),
  };
  if (parsed.memoryType === "state" && !parsed.stateKey) {
    throw new NmgProtocolError("INVALID_PARAMS", "state memories require stateKey");
  }
  return parsed;
}

function parseSearchParams(value: unknown): NmgSearchParams {
  const params = objectParams(value);
  return {
    query: requiredString(params, "query"),
    nodeName: optionalString(params, "nodeName"),
    scope: optionalScope(params, "scope"),
    sourceActor: optionalEnum(params, "sourceActor", ACTORS) as MemoryActor | undefined,
    includeHistorical: optionalBoolean(params, "includeHistorical"),
    maxTier: optionalInteger(params, "maxTier", 0, 3) as MemoryTier | undefined,
    limit: optionalInteger(params, "limit", 1, 50),
    graphHops: optionalInteger(params, "graphHops", 0, 3),
    retrievalMode: optionalEnum(params, "retrievalMode", RETRIEVAL_MODES),
    vectorGranularity: optionalEnum(params, "vectorGranularity", VECTOR_GRANULARITIES),
    secondPass: optionalBoolean(params, "secondPass"),
  };
}

function parseGetParams(value: unknown): NmgGetParams {
  const params = objectParams(value);
  const ids = params.memoryIds;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 50 ||
    ids.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      "memoryIds must contain between 1 and 50 non-empty strings",
    );
  }
  return {
    memoryIds: ids.map((id) => String(id).trim()),
    graphHops: optionalInteger(params, "graphHops", 0, 3),
  };
}

function parseRetentionCandidatesParams(value: unknown): NmgRetentionCandidatesParams {
  const params = objectParams(value);
  return {
    dormantAfterDays: optionalInteger(params, "dormantAfterDays", 1, 36500),
    quarantineAfterDays: optionalInteger(params, "quarantineAfterDays", 1, 36500),
    maximumImportance: optionalNumber(params, "maximumImportance", 0, 1),
    maximumAccessCount: optionalInteger(params, "maximumAccessCount", 0, 1_000_000_000),
  };
}

function parseSetStorageStateParams(value: unknown): NmgSetStorageStateParams {
  const params = objectParams(value);
  return {
    memoryId: requiredString(params, "memoryId"),
    storageState: optionalEnum(params, "storageState", STORAGE_STATES) ?? "indexed",
    recoveryDays: optionalInteger(params, "recoveryDays", 0, 36500),
  };
}

function parseDeleteMemoryParams(value: unknown): NmgDeleteMemoryParams {
  return { memoryId: requiredString(objectParams(value), "memoryId") };
}

function parseMergeNodesParams(value: unknown): NmgMergeNodesParams {
  const params = objectParams(value);
  return {
    sourceNodeIds: requiredStringArray(params, "sourceNodeIds", 2, 100),
    targetName: requiredString(params, "targetName"),
    targetKind: optionalEnum(params, "targetKind", NODE_KINDS),
    summary: optionalString(params, "summary"),
  };
}

function parseSplitNodeParams(value: unknown): NmgSplitNodeParams {
  const params = objectParams(value);
  if (!Array.isArray(params.partitions) || params.partitions.length < 2) {
    throw new NmgProtocolError("INVALID_PARAMS", "partitions must contain at least two entries");
  }
  return {
    sourceNodeId: requiredString(params, "sourceNodeId"),
    partitions: params.partitions.map((value) => {
      const partition = objectParams(value);
      return {
        nodeName: requiredString(partition, "nodeName"),
        memoryIds: requiredStringArray(partition, "memoryIds", 1, 10_000),
        nodeKind: optionalEnum(partition, "nodeKind", NODE_KINDS),
        summary: optionalString(partition, "summary"),
      };
    }),
  };
}

function objectParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NmgProtocolError("INVALID_PARAMS", "params must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key);
  if (!value) throw new NmgProtocolError("INVALID_PARAMS", `${key} is required`);
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be a non-empty string`);
  }
  return value.trim();
}

function requiredStringArray(
  params: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): string[] {
  const value = params[key];
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      `${key} must contain between ${minimum} and ${maximum} non-empty strings`,
    );
  }
  return value.map((entry) => String(entry).trim());
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be a boolean`);
  }
  return value;
}

function optionalNumber(
  params: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new NmgProtocolError(
      "INVALID_PARAMS",
      `${key} must be a number from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function optionalInteger(
  params: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = optionalNumber(params, key, minimum, maximum);
  if (value !== undefined && !Number.isInteger(value)) {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be an integer`);
  }
  return value;
}

function optionalEnum<const T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function optionalScope(params: Record<string, unknown>, key: string): MemoryScope | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((entry) => typeof entry !== "string")
  ) {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be a string map`);
  }
  return value as MemoryScope;
}
