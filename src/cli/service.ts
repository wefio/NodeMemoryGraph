import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  configuredProvider,
  createEmbeddingClientFromEnv,
  type EmbeddingClient,
} from "../core/embedding-provider.ts";
import { NmgStore } from "../core/store.ts";
import { copyLtgSubsetToStg, createStgStore, mergeStgLtgContexts } from "../core/stg.ts";
import {
  EVIDENCE_ROLES,
  MEMORY_ACTORS,
  MEMORY_NODE_KINDS,
  MEMORY_RESIDENCES,
  MEMORY_STORAGE_STATES,
  MEMORY_TYPES,
  RETRIEVAL_MODES,
  TRUTH_STATUSES,
  VECTOR_GRANULARITIES,
  type MemoryContext,
  type MemoryScope,
  type MemoryMarker,
  type MemoryTier,
  type SearchOptions,
} from "../core/types.ts";
import { assessMemoryWrite } from "../core/write-policy.ts";
import { searchMemoryContext } from "../integration/search.ts";
import { applyAdvancedFilters, parseAdvancedQuery } from "../core/store/advanced-query.ts";
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
  type NmgSyncStgParams,
} from "./protocol.ts";

const SERVICE_VERSION = "0.1.0";
export interface NmgServiceOptions {
  dataDirectory?: string;
  databasePath?: string;
  environment?: NodeJS.ProcessEnv;
}

export class NmgService {
  readonly databasePath: string;
  readonly #environment: NodeJS.ProcessEnv;
  #store: NmgStore | undefined;
  readonly #stgStores = new Map<string, NmgStore>();
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
      case "perfAggregates":
        return this.#getStore().perfAggregates() as NmgMethodResult[M];
      case "pruneRetrievalTraces":
        return {
          pruned: this.#getStore().pruneRetrievalTraces(parsePerfPruneParams(params)),
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
      case "syncStg": {
        const parsed = parseSyncStgParams(params);
        return {
          copied: copyLtgSubsetToStg(
            this.#getStore(),
            this.#getStgStore(parsed.projectDir, parsed.sessionId),
            parsed,
          ),
          projectDir: parsed.projectDir,
        } as NmgMethodResult[M];
      }
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
    for (const store of this.#stgStores.values()) store.close();
    this.#stgStores.clear();
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
    const external = params.markers?.some((marker) => marker.kind === "external_source") ?? false;
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
    const { projectDir, ...memory } = params;
    const store =
      memory.residence === "stg" && projectDir
        ? this.#getStgStore(projectDir, memory.sessionId)
        : this.#getStore();
    return store.remember({
      ...memory,
      truthStatus: memory.truthStatus ?? (external ? "unverified" : undefined),
      writeReason: params.writeReason ?? `cli_confirmed_${params.memoryType ?? "fact"}`,
      writeSource: "user",
    });
  }

  async #search(params: NmgSearchParams): Promise<NmgMethodResult["search"]> {
    const { query, queries, projectDir, sessionId, ...options } = params;
    const searchOptions: SearchOptions = {
      ...options,
      sessionId,
      progressiveWarmDisclosure: options.progressiveWarmDisclosure ?? true,
    };
    const raws = [query, ...(queries ?? [])];
    const embedding = this.#configuredEmbeddingClient();
    const runOne = async (store: NmgStore, raw: string): Promise<MemoryContext> => {
      const { semantic, filters } = parseAdvancedQuery(raw);
      const ctx = await searchMemoryContext(store, embedding, semantic, searchOptions);
      ctx.results = applyAdvancedFilters(ctx.results, filters);
      return ctx;
    };
    const searchAcross = async (store: NmgStore, raw: string) => {
      const local = await runOne(store, raw);
      if (local.results.length > 0 && local.activeGraph?.qpp?.trigger === false) return local;
      const shared = await runOne(this.#getStore(), raw);
      return local.results.length === 0 ? shared : mergeStgLtgContexts(local, shared);
    };

    if (raws.length === 1) {
      if (!projectDir) return runOne(this.#getStore(), raws[0]!);
      return searchAcross(this.#getStgStore(projectDir, sessionId), raws[0]!);
    }

    // Multi-query fusion: primary keeps rank, extra clauses append unique
    // hits (their own order), then the hard limit is applied once.
    const primary = await runOne(this.#getStore(), raws[0]!);
    const seen = new Set(primary.results.map((result) => result.memory.id));
    for (let i = 1; i < raws.length; i += 1) {
      const extra = await runOne(this.#getStore(), raws[i]!);
      for (const result of extra.results) {
        if (seen.has(result.memory.id)) continue;
        seen.add(result.memory.id);
        primary.results.push(result);
      }
    }
    if (searchOptions.limit) primary.results = primary.results.slice(0, searchOptions.limit);
    return primary;
  }

  #get(params: NmgGetParams): NmgMethodResult["get"] {
    const sharedStore = this.#getStore();
    const localStore = params.projectDir
      ? this.#getStgStore(params.projectDir, params.sessionId)
      : undefined;
    const shared = sharedStore.getContext(params.memoryIds, params.graphHops ?? 0);
    const local = localStore
      ? localStore.getContext(params.memoryIds, params.graphHops ?? 0)
      : undefined;
    const context = local ? mergeStgLtgContexts(local, shared) : shared;
    const found = new Set(context.results.map((result) => result.memory.id));
    if (params.activeGraphId) {
      const activeGraphId = params.activeGraphId;
      const traceStore = [localStore, sharedStore]
        .filter((store): store is NmgStore => store !== undefined)
        .find((store) => store.retrievalTrace(activeGraphId, params.sessionId) !== null);
      if (!traceStore) {
        throw new NmgProtocolError("NOT_FOUND", `active graph ${activeGraphId} does not exist`);
      }
      traceStore.recordActiveGraphUse(
        activeGraphId,
        { usedMemoryIds: [...found] },
        params.sessionId,
      );
    }
    return {
      ...context,
      missingMemoryIds: params.memoryIds.filter((id) => !found.has(id)),
    };
  }

  #getStore(): NmgStore {
    return (this.#store ??= new NmgStore(this.databasePath));
  }

  #getStgStore(projectDir: string, sessionId = "cli"): NmgStore {
    const resolved = resolve(projectDir);
    const key = `${resolved}\0${sessionId}`;
    let store = this.#stgStores.get(key);
    if (!store) {
      store = createStgStore(resolved, undefined, sessionId);
      this.#stgStores.set(key, store);
    }
    return store;
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
    memoryType: optionalEnum(params, "memoryType", MEMORY_TYPES),
    stateKey: optionalString(params, "stateKey"),
    eventTime: optionalString(params, "eventTime"),
    sourceActor: optionalEnum(params, "sourceActor", MEMORY_ACTORS),
    truthStatus: optionalEnum(params, "truthStatus", TRUTH_STATUSES),
    evidence: optionalString(params, "evidence"),
    tier: optionalInteger(params, "tier", 0, 3) as MemoryTier | undefined,
    importance: optionalNumber(params, "importance", 0, 1),
    scope: optionalScope(params, "scope"),
    validFrom: optionalString(params, "validFrom"),
    validUntil: optionalString(params, "validUntil"),
    evidenceRole: optionalEnum(params, "evidenceRole", EVIDENCE_ROLES),
    supersedesId: optionalString(params, "supersedesId"),
    residence: optionalEnum(params, "residence", MEMORY_RESIDENCES),
    expiresAt: optionalString(params, "expiresAt"),
    writeReason: optionalString(params, "writeReason"),
    sessionId: optionalString(params, "sessionId"),
    sourceRef: optionalString(params, "sourceRef"),
    markers: optionalMarkers(params, "markers"),
    projectDir: optionalString(params, "projectDir"),
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
    queries: optionalStringArray(params, "queries"),
    nodeName: optionalString(params, "nodeName"),
    scope: optionalScope(params, "scope"),
    sourceActor: optionalEnum(params, "sourceActor", MEMORY_ACTORS),
    includeHistorical: optionalBoolean(params, "includeHistorical"),
    maxTier: optionalInteger(params, "maxTier", 0, 3) as MemoryTier | undefined,
    limit: optionalInteger(params, "limit", 1, 50),
    graphHops: optionalInteger(params, "graphHops", 0, 3),
    retrievalMode: optionalEnum(params, "retrievalMode", RETRIEVAL_MODES),
    vectorGranularity: optionalEnum(params, "vectorGranularity", VECTOR_GRANULARITIES),
    secondPass: optionalBoolean(params, "secondPass"),
    progressiveWarmDisclosure: optionalBoolean(params, "progressiveWarmDisclosure"),
    tieredDisclosure: optionalBoolean(params, "tieredDisclosure"),
    perf: optionalBoolean(params, "perf"),
    projectDir: optionalString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
  };
}

function parsePerfPruneParams(value: unknown): { maxDays?: number; maxRows?: number } {
  const params = objectParams(value);
  return {
    maxDays: optionalInteger(params, "maxDays", 1, 3650),
    maxRows: optionalInteger(params, "maxRows", 100, 1_000_000),
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
    activeGraphId: optionalString(params, "activeGraphId"),
    graphHops: optionalInteger(params, "graphHops", 0, 3),
    projectDir: optionalString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
  };
}

function parseSyncStgParams(value: unknown): NmgSyncStgParams {
  const params = objectParams(value);
  const scope = optionalScope(params, "scope");
  if (!scope || Object.keys(scope).length === 0) {
    throw new NmgProtocolError("INVALID_PARAMS", "scope is required");
  }
  return {
    projectDir: requiredString(params, "projectDir"),
    sessionId: optionalString(params, "sessionId"),
    scope,
    limit: optionalInteger(params, "limit", 1, 200),
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
    storageState: optionalEnum(params, "storageState", MEMORY_STORAGE_STATES) ?? "indexed",
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
    targetKind: optionalEnum(params, "targetKind", MEMORY_NODE_KINDS),
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
        nodeKind: optionalEnum(partition, "nodeKind", MEMORY_NODE_KINDS),
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

function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be an array of non-empty strings`);
  }
  return value.map((entry) => String(entry).trim());
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

function optionalMarkers(params: Record<string, unknown>, key: string): MemoryMarker[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw new NmgProtocolError("INVALID_PARAMS", `${key} must be an array of at most 20 markers`);
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new NmgProtocolError("INVALID_PARAMS", `${key} entries must be objects`);
    }
    const marker = entry as Record<string, unknown>;
    const kind = requiredString(marker, "kind");
    const attributes = marker.attributes;
    if (
      attributes !== undefined &&
      (!attributes ||
        typeof attributes !== "object" ||
        Array.isArray(attributes) ||
        Object.values(attributes).some(
          (item) =>
            item !== null &&
            typeof item !== "string" &&
            typeof item !== "number" &&
            typeof item !== "boolean",
        ))
    ) {
      throw new NmgProtocolError("INVALID_PARAMS", `${key} attributes must contain scalar values`);
    }
    return { kind, attributes: attributes as MemoryMarker["attributes"] };
  });
}
