import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createEmbeddingClientFromEnv, type EmbeddingClient } from "../core/embedding-provider.ts";
import { MemoryOperationConflict, type MemoryBackend } from "../core/memory/backend.ts";
import { MemoryEngine } from "../core/memory/engine.ts";
import { openMemoryBackend } from "../core/memory/open.ts";
import { MemoryWriteRejected } from "../core/write-policy.ts";
import { renderSearchSurface } from "../integration/agent-surface.ts";
import { fitExplicitSearchPage } from "../integration/explicit-search-page.ts";
import {
  HttpError,
  httpAddReceipt,
  httpHash,
  memoryHttpOperation,
  readHttpAdd,
  readHttpClauses,
  readHttpJson,
  readHttpNow,
  readHttpTopK,
  requireHttpApiKey,
  sourceHttpMessageId,
  textField,
  type JsonObject,
} from "../integration/memory-http-protocol.ts";
import { HttpMemoryService, projectHttpMemory } from "../integration/memory-http-service.ts";
import { describeContent } from "../integration/multimodal-content.ts";
import {
  readLocalMemoryHttpConfig,
  type LocalMemoryHttpConfig,
} from "./local-memory-http-config.ts";

const BODY_TIMEOUT_MS = 30_000;
const DEFAULT_BACKEND_POOL_SIZE = 64;

type PoolEntry = {
  promise: Promise<MemoryBackend>;
  active: number;
  closing: boolean;
  closed: boolean;
};

/** Bounded per-namespace SQLite backend pool shared across local HTTP requests. */
export class LocalBackendPool {
  private readonly databasePath: string;
  private readonly maxSize: number;
  private readonly entries = new Map<string, PoolEntry>();
  private readonly draining = new Set<Promise<void>>();

  constructor(databasePath: string, maxSize = DEFAULT_BACKEND_POOL_SIZE) {
    this.databasePath = databasePath;
    this.maxSize = Math.max(1, Math.floor(maxSize));
  }

  async withBackend<T>(namespace: string, fn: (backend: MemoryBackend) => Promise<T>): Promise<T> {
    const entry = this.acquire(namespace);
    entry.active += 1;
    try {
      const backend = await entry.promise;
      return await fn(backend);
    } finally {
      entry.active -= 1;
      if (entry.closing && entry.active === 0) await this.trackClose(entry);
    }
  }

  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      all.map(async (entry) => {
        entry.closing = true;
        if (entry.active === 0) await this.closeEntry(entry);
      }),
    );
    await Promise.all([...this.draining]);
  }

  private acquire(namespace: string): PoolEntry {
    const existing = this.entries.get(namespace);
    if (existing) {
      this.entries.delete(namespace);
      this.entries.set(namespace, existing);
      return existing;
    }
    const entry: PoolEntry = {
      promise: Promise.resolve(undefined as unknown as MemoryBackend),
      active: 0,
      closing: false,
      closed: false,
    };
    entry.promise = openMemoryBackend({
      kind: "sqlite",
      path: this.databasePath,
      namespace,
    }).catch((error: unknown) => {
      if (this.entries.get(namespace) === entry) this.entries.delete(namespace);
      throw error;
    });
    this.entries.set(namespace, entry);
    this.evictOldest(namespace);
    return entry;
  }

  private evictOldest(keepKey: string): void {
    for (const [key, oldest] of this.entries) {
      if (this.entries.size <= this.maxSize) break;
      if (key === keepKey) continue;
      this.entries.delete(key);
      oldest.closing = true;
      if (oldest.active === 0) void this.trackClose(oldest);
    }
  }

  private async trackClose(entry: PoolEntry): Promise<void> {
    const done = this.closeEntry(entry);
    this.draining.add(done);
    try {
      await done;
    } finally {
      this.draining.delete(done);
    }
  }

  private async closeEntry(entry: PoolEntry): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    try {
      const backend = await entry.promise;
      await backend.close();
    } catch {
      // Open failed; no backend handle to close.
    }
  }
}

export async function serveLocalMemoryHttp(
  configPath: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<void> {
  const config = await readLocalMemoryHttpConfig(configPath);
  const embeddingClient = createEmbeddingClientFromEnv();
  const pool = new LocalBackendPool(config.databasePath);
  const server = createServer({ requestTimeout: BODY_TIMEOUT_MS }, (incoming, outgoing) => {
    void respond(incoming, outgoing, config, pool, embeddingClient);
  });
  const stop = () => server.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    server.listen(config.port, config.host);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP listener has no TCP address");
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
    stdout.write(`NMG HTTP listening at http://${host}:${address.port}\n`);
    await once(server, "close");
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (server.listening) server.close();
    await pool.closeAll();
  }
}

async function respond(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  config: LocalMemoryHttpConfig,
  pool: LocalBackendPool,
  embeddingClient?: EmbeddingClient,
) {
  const method = incoming.method ?? "GET";
  try {
    const url = new URL(`http://localhost${incoming.url ?? "/"}`);
    const path = url.pathname.replace(/\/$/u, "") || "/";
    const operation = memoryHttpOperation(method, path);
    if (!operation) throw new HttpError(404, "not_found", "Unknown API route");
    if (operation === "health") {
      send(outgoing, 200, { status: "ok", storage: "sqlite" }, method === "HEAD");
      return;
    }
    const headers = new Headers();
    for (const [key, values] of Object.entries(incoming.headersDistinct)) {
      for (const value of values ?? []) headers.append(key, value);
    }
    const init: RequestInit & { duplex: "half" } = {
      method,
      headers,
      duplex: "half",
      body: requestBody(incoming),
    };
    const request = new Request(url, init);
    if (config.apiKey) requireHttpApiKey(request, config.apiKey);
    const input = await readHttpJson(request, config.maxRequestBytes, BODY_TIMEOUT_MS);
    const userId = textField(input.user_id ?? input.userId, "user_id");
    const result = await pool.withBackend(`http:${httpHash(userId)}`, async (backend) => {
      const service = new HttpMemoryService(new MemoryEngine(backend), embeddingClient, {
        preprocessMessages: config.preprocessMessages,
      });
      return operation === "add" ? addMemory(service, input) : searchMemory(service, input, config);
    });
    send(outgoing, 200, result);
  } catch (error) {
    if (!outgoing.headersSent) sendError(outgoing, error);
  }
}

function requestBody(incoming: IncomingMessage): ReadableStream<Uint8Array> {
  // A rejected upload can still receive a 4xx on this socket.
  const chunks = incoming.iterator({ destroyOnReturn: false });
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel() {
        await chunks.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}

async function addMemory(service: HttpMemoryService, input: JsonObject) {
  const { userId, sessionId, requestId, requestHash, messages } = readHttpAdd(input, 128);
  const batch = await Promise.all(
    messages.map(async (message, index) => ({
      ...message,
      source_message_id: sourceHttpMessageId(requestHash, index),
      indexText: await describeContent(message.content),
    })),
  );
  const operationId = httpHash(JSON.stringify([userId, requestId]));
  const result = await service.rememberBatch(userId, sessionId, requestId, batch, operationId);
  return httpAddReceipt({ userId, sessionId, requestId }, operationId, result.added);
}

async function searchMemory(
  service: HttpMemoryService,
  input: JsonObject,
  config: LocalMemoryHttpConfig,
) {
  const limit = readHttpTopK(input, config.defaultTopK);
  const now = readHttpNow(input);
  const clauses = await readHttpClauses(input);
  if (clauses.length === 1 && !clauses[0]!.appendOnly) {
    const query = clauses[0]!.text;
    const result = await service.searchFeature(query, limit, { now });
    const page = fitExplicitSearchPage(
      result,
      { query, limit, persistTrace: false },
      {
        maxCharacters: config.searchMaxCharacters,
        previewCodePoints: config.searchPreviewCodePoints,
      },
    );
    const surface = renderSearchSurface(page, {
      emptyText: "No NMG match.",
      includeGetHint: false,
    });
    const profile = config.preprocessMessages ? await service.profileSummary(query, now) : "";
    return {
      data: result.results.slice(0, limit).map((row) => projectHttpMemory(row, query)),
      retrieval_mode: result.retrieval?.mode ?? "lexical",
      rendered: profile ? `${surface}\n\n${profile}` : surface,
    };
  }
  const searchResult = await service.search(
    clauses.map((clause) => clause.text),
    limit,
    clauses.map((clause) => clause.appendOnly === true),
    undefined,
    { now },
  );
  return {
    data: searchResult.memories,
    retrieval_mode: searchResult.retrievalMode === "records" ? "hybrid" : "lexical",
    ...(searchResult.appended.length ? { appended: searchResult.appended } : {}),
  };
}

function sendError(outgoing: ServerResponse, error: unknown): void {
  const failure =
    error instanceof HttpError
      ? error
      : error instanceof MemoryOperationConflict
        ? new HttpError(
            409,
            "request_id_reused",
            "request_id was already used for different content",
          )
        : error instanceof MemoryWriteRejected
          ? new HttpError(422, "memory_write_rejected", error.message)
          : new HttpError(500, "internal_error", "Memory HTTP request failed");
  send(outgoing, failure.status, { error: { code: failure.code, message: failure.message } });
}

function send(outgoing: ServerResponse, status: number, body: object, head = false): void {
  outgoing.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  outgoing.end(head ? undefined : JSON.stringify(body));
}
