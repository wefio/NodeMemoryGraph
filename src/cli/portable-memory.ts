import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryEngine } from "../core/memory/engine.ts";
import type { MemoryBackend } from "../core/memory/backend.ts";
import { openMemoryBackend } from "../core/memory/open.ts";
import type { MemoryBackendOptions } from "../core/memory/open.ts";
import type {
  NmgGetParams,
  NmgHelloResult,
  NmgMethod,
  NmgRememberParams,
  NmgSearchParams,
} from "./protocol.ts";
import { NmgProtocolError } from "./protocol.ts";
import { mergeStgLtgContexts, stgStorePath } from "../core/stg.ts";
import type { MemoryContext } from "../core/types.ts";
import { LocalMemoryEmbeddings } from "./local-memory-embeddings.ts";
import type { EmbeddingClient } from "../core/embedding-provider.ts";

const METHODS = new Set<NmgMethod>(["remember", "rememberBatch", "search", "get", "deleteMemory"]);
const LOCAL_METHODS = new Set<NmgMethod>(["hello", "status", "taskBoard", "taskRun", "shutdown"]);
const SESSION_METHODS = new Set<NmgMethod>([
  "state",
  "sessionActiveGraph",
  "recordActiveGraphAttribution",
]);
const SEARCH_FIELDS = [
  "query",
  "scope",
  "sessionId",
  "maxTier",
  "limit",
  "graphHops",
  "includeHistorical",
  "sourceActor",
  "nodeName",
];

/** Application-level memory owner. Coordination continues through the local service. */
export class PortableMemoryService {
  private readonly options: MemoryBackendOptions;
  private pending: Promise<MemoryEngine> | undefined;
  private backend: MemoryBackend | undefined;
  private readonly projects = new Map<string, Promise<MemoryEngine>>();
  private readonly embeddings: LocalMemoryEmbeddings;
  readonly local: boolean;

  constructor(
    options: MemoryBackendOptions,
    local = false,
    embedding: () => EmbeddingClient | undefined = () => undefined,
  ) {
    // Do not retain a caller-mutable credentials/options object.
    this.options = structuredClone(options);
    this.local = local;
    this.embeddings = new LocalMemoryEmbeddings(embedding);
  }

  static handles(method: NmgMethod): boolean {
    return METHODS.has(method);
  }

  requireLocalMethod(method: NmgMethod): void {
    if (!LOCAL_METHODS.has(method) && !(this.local && SESSION_METHODS.has(method)))
      throw new NmgProtocolError(
        "METHOD_NOT_FOUND",
        `${method} is not supported by portable memory`,
      );
  }

  hello(base: NmgHelloResult): NmgHelloResult {
    return {
      ...base,
      methods: [...METHODS, ...LOCAL_METHODS, ...(this.local ? SESSION_METHODS : [])],
      capabilities: [
        "hello",
        "status",
        "remember",
        "event-time-reference",
        "batch-remember",
        "search",
        "get",
        "delete-memory",
        "task-board",
        "http",
        "json-rpc",
        "lexical-retrieval",
        "portable-memory",
        ...(this.local
          ? ([
              "session-active-graph",
              "optional-embedding-retrieval",
              "state-spaces",
              "diagnostic-answer-attribution",
              "versioned-answer-attribution",
              "board-events",
              "board-wake-batches",
              "board-agent-activity",
              "board-agent-presence",
              "directed-task-board-inbox",
              "controlled-reload",
            ] as const)
          : []),
      ],
    };
  }

  get storageStatus() {
    const path = this.options.kind === "sqlite" ? this.options.path : undefined;
    const file = path && existsSync(path) ? statSync(path) : undefined;
    return {
      databasePath: this.options.kind === "sqlite" ? this.options.path : this.options.uri,
      exists: file !== undefined || this.backend !== undefined,
      loaded: this.backend !== undefined,
      bytes: file?.size ?? 0,
    };
  }

  async remember(input: NmgRememberParams, operationId?: string) {
    if (this.local) {
      const engine = await this.writer(input);
      const result = await engine.remember(input, operationId);
      this.embeddings.afterWrite(engine.backend.vectorIndex);
      return result;
    }
    rejectOptions(input, ["projectDir"]);
    return (await this.engine()).remember(input, operationId);
  }

  async rememberMany(inputs: readonly NmgRememberParams[], operationId?: string) {
    if (this.local) {
      const paths = new Set(inputs.map(projectForWrite));
      if (paths.size !== 1)
        throw new NmgProtocolError(
          "INVALID_PARAMS",
          "rememberBatch items must target one physical memory store",
        );
      const engine = await this.writer(inputs[0]!);
      const results = await engine.rememberMany(inputs, operationId);
      this.embeddings.afterWrite(engine.backend.vectorIndex);
      return { results };
    }
    inputs.forEach((input) => rejectOptions(input, ["projectDir"]));
    return { results: await (await this.engine()).rememberMany(inputs, operationId) };
  }

  async search(input: NmgSearchParams) {
    if (!this.local) {
      allowOptions(input, SEARCH_FIELDS);
      return (await this.engine()).search(input.query, input);
    }
    allowOptions(input, [
      ...SEARCH_FIELDS,
      "projectDir",
      "autoRecall",
      "tieredDisclosure",
      "autoRecallBudgetMs",
      "persistTrace",
      "activeGraphBudget",
      "queries",
      "retrievalMode",
      "vectorGranularity",
    ]);
    const shared = await this.engine();
    const project = await this.project(input.projectDir);
    const results = await Promise.all(
      [input.query, ...(input.queries ?? [])].map(async (query) => {
        const indexes = [shared.backend.vectorIndex, project?.backend.vectorIndex].flatMap(
          (index) => (index ? [index] : []),
        );
        const { semantic, reason } = await this.embeddings.query(query, input, indexes);
        const search = async (engine: MemoryEngine) => {
          const useVector =
            semantic && engine.backend.vectorIndex?.has(semantic.indexId, semantic.vector.length);
          const context = await engine.search(query, input, useVector ? semantic : undefined);
          if (reason) context.retrieval = { mode: "lexical", degraded: true, reason };
          return context;
        };
        const main = await search(shared);
        return project ? mergeLocalContexts(await search(project), main) : main;
      }),
    );
    const primary = results[0]!;
    return {
      ...primary,
      results: [
        ...new Map(
          results.flatMap((context) =>
            context.results.map((item) => [item.memory.id, item] as const),
          ),
        ).values(),
      ].slice(0, input.limit ?? 20),
    };
  }

  async get(input: NmgGetParams) {
    allowOptions(input, [
      "memoryIds",
      "sessionId",
      ...(this.local ? ["projectDir", "graphHops", "activeGraphId"] : []),
    ]);
    const main = await (await this.engine()).get(input.memoryIds, input);
    const project = await this.project(input.projectDir);
    return project ? mergeLocalContexts(await project.get(input.memoryIds, input), main) : main;
  }

  async withdraw(memoryId: string, operationId: string = randomUUID(), sessionId?: string) {
    const result = await (await this.engine()).withdraw(memoryId, operationId, sessionId);
    return { deleted: true, memory: result.memory };
  }

  async close(): Promise<void> {
    await this.embeddings.close();
    const projects = await Promise.allSettled(this.projects.values());
    for (const project of projects)
      if (project.status === "fulfilled") await project.value.backend.close();
    this.projects.clear();
    await this.backend?.close();
  }

  embeddingHealth(indexId: string) {
    const stats = this.backend?.vectorIndex?.stats(indexId);
    return stats
      ? {
          indexId,
          targets: ["records"],
          indexed: { records: stats.indexed },
          pending: { records: stats.pending },
          status: stats.pending ? "running" : "ready",
        }
      : null;
  }

  private engine(): Promise<MemoryEngine> {
    return (this.pending ??= this.open(this.options)
      .then((backend) => {
        this.backend = backend;
        return new MemoryEngine(backend);
      })
      .catch((error: unknown) => {
        this.pending = undefined;
        throw error;
      }));
  }

  private async open(options: MemoryBackendOptions): Promise<MemoryBackend> {
    if (!this.local || options.kind !== "sqlite") return openMemoryBackend(options);
    const { SqliteMemoryBackend } = await import("../core/memory/sqlite-backend.ts");
    const backend = new SqliteMemoryBackend(options.path, options.namespace);
    try {
      backend.activateLocal();
      return backend;
    } catch (error) {
      await backend.close();
      throw error;
    }
  }

  private async writer(input: NmgRememberParams): Promise<MemoryEngine> {
    return (await this.project(projectForWrite(input), true)) ?? this.engine();
  }

  private project(
    projectDir: string | undefined,
    create = false,
  ): Promise<MemoryEngine> | undefined {
    if (!this.local || !projectDir || this.options.kind !== "sqlite") return undefined;
    const path = stgStorePath(resolve(projectDir));
    if (path === this.options.path) return undefined;
    const found = this.projects.get(path);
    if (found) return found;
    if (!create && !existsSync(path)) return undefined;
    const opened = this.open({ ...this.options, path })
      .then((backend) => new MemoryEngine(backend))
      .catch((error: unknown) => {
        this.projects.delete(path);
        throw error;
      });
    this.projects.set(path, opened);
    return opened;
  }
}

function projectForWrite(input: NmgRememberParams): string | undefined {
  return input.residence === "stg" && input.projectDir ? resolve(input.projectDir) : undefined;
}

function mergeLocalContexts(project: MemoryContext, main: MemoryContext): MemoryContext {
  return {
    ...mergeStgLtgContexts(project, main),
    tesserae: [
      ...new Map(
        [...(project.tesserae ?? []), ...(main.tesserae ?? [])].map((item) => [item.id, item]),
      ).values(),
    ],
  };
}

function rejectOptions(input: object, keys: string[]): void {
  const values = input as Record<string, unknown>;
  for (const key of keys)
    if (values[key] !== undefined)
      throw new NmgProtocolError("INVALID_PARAMS", `Portable memory does not support ${key}`);
}

function allowOptions(input: object, keys: string[]): void {
  rejectOptions(
    input,
    Object.keys(input).filter((key) => !keys.includes(key)),
  );
}
