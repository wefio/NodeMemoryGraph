import { randomUUID } from "node:crypto";
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

const METHODS = new Set<NmgMethod>(["remember", "rememberBatch", "search", "get", "deleteMemory"]);
const LOCAL_METHODS = new Set<NmgMethod>(["hello", "status", "taskBoard", "taskRun", "shutdown"]);

/** Application-level memory owner. Coordination continues through the local service. */
export class PortableMemoryService {
  private readonly options: MemoryBackendOptions;
  private pending: Promise<MemoryEngine> | undefined;
  private backend: MemoryBackend | undefined;

  constructor(options: MemoryBackendOptions) {
    // Do not retain a caller-mutable credentials/options object.
    this.options = structuredClone(options);
  }

  static handles(method: NmgMethod): boolean {
    return METHODS.has(method);
  }

  requireLocalMethod(method: NmgMethod): void {
    if (!LOCAL_METHODS.has(method))
      throw new NmgProtocolError(
        "METHOD_NOT_FOUND",
        `${method} is not supported by portable memory`,
      );
  }

  hello(base: NmgHelloResult): NmgHelloResult {
    return {
      ...base,
      methods: [...METHODS, ...LOCAL_METHODS],
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
      ],
    };
  }

  get storageStatus() {
    return {
      databasePath: this.options.kind === "sqlite" ? this.options.path : this.options.uri,
      exists: this.backend !== undefined,
      loaded: this.backend !== undefined,
      bytes: 0,
    };
  }

  async remember(input: NmgRememberParams, operationId?: string) {
    rejectOptions(input, ["projectDir"]);
    return (await this.engine()).remember(input, operationId);
  }

  async rememberMany(inputs: readonly NmgRememberParams[], operationId?: string) {
    inputs.forEach((input) => rejectOptions(input, ["projectDir"]));
    return { results: await (await this.engine()).rememberMany(inputs, operationId) };
  }

  async search(input: NmgSearchParams) {
    allowOptions(input, ["query", "scope", "sessionId", "maxTier", "limit", "graphHops"]);
    return (await this.engine()).search(input.query, input);
  }

  async get(input: NmgGetParams) {
    allowOptions(input, ["memoryIds", "sessionId"]);
    return (await this.engine()).get(input.memoryIds, input);
  }

  async withdraw(memoryId: string, operationId: string = randomUUID(), sessionId?: string) {
    const result = await (await this.engine()).withdraw(memoryId, operationId, sessionId);
    return { deleted: true, memory: result.memory };
  }

  close(): Promise<void> | undefined {
    return this.backend?.close();
  }

  private engine(): Promise<MemoryEngine> {
    return (this.pending ??= openMemoryBackend(this.options)
      .then((backend) => {
        this.backend = backend;
        return new MemoryEngine(backend);
      })
      .catch((error: unknown) => {
        this.pending = undefined;
        throw error;
      }));
  }
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
