import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { MemoryOperationConflict } from "../core/memory/backend.ts";
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
  readHttpJson,
  readHttpQuery,
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

export async function serveLocalMemoryHttp(
  configPath: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<void> {
  const config = await readLocalMemoryHttpConfig(configPath);
  const server = createServer({ requestTimeout: BODY_TIMEOUT_MS }, (incoming, outgoing) => {
    void respond(incoming, outgoing, config);
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
  }
}

async function respond(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  config: LocalMemoryHttpConfig,
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
    const backend = await openMemoryBackend({
      kind: "sqlite",
      path: config.databasePath,
      namespace: `http:${httpHash(userId)}`,
    });
    try {
      const service = new HttpMemoryService(new MemoryEngine(backend));
      const result =
        operation === "add"
          ? await addMemory(service, input)
          : await searchMemory(service, input, config.defaultTopK);
      send(outgoing, 200, result);
    } finally {
      await backend.close();
    }
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

async function searchMemory(service: HttpMemoryService, input: JsonObject, defaultTopK: number) {
  if (input.queries !== undefined || input.options !== undefined)
    throw new HttpError(400, "invalid_request", "Local Search takes one query");
  const limit = readHttpTopK(input, defaultTopK);
  const query = await readHttpQuery(input.query);
  const result = await service.searchFeature(query, limit);
  const page = fitExplicitSearchPage(result, { query, limit, persistTrace: false });
  return {
    data: page.results.map((row) => projectHttpMemory(row, query)),
    retrieval_mode: page.retrieval?.mode ?? "lexical",
    rendered: renderSearchSurface(page, { emptyText: "No NMG match.", includeGetHint: false }),
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
