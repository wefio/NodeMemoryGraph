import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

import type { ServerLease } from "./lifecycle.ts";
import type { NmgMethod } from "./protocol.ts";
import { NmgProtocolError } from "./protocol.ts";
import { NmgService } from "./service.ts";

const MAX_REQUEST_BYTES = 1_048_576;

/**
 * The NMG daemon's JSON-RPC-over-HTTP transport (Node built-in http).
 *
 * Endpoint: `POST /` with a JSON-RPC 2.0 body `{ jsonrpc, method, params, id }`,
 * protected by a per-launch bearer token. Responds `{ jsonrpc, result, id }` on
 * success or `{ jsonrpc, error, id }` on failure.
 *
 * This module imports `service.ts` (and, via it, the core store) and therefore
 * must only ever be loaded by the daemon process — never by the Pi extension.
 * Clients use the thin `http-client.ts` (built-in fetch, no deps).
 */
export async function serveHttp(service: NmgService, lease: ServerLease): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer(
    httpHandler(service, token, () => {
      server.close(resolveClosed);
      server.closeIdleConnections?.();
    }),
  );
  await listen(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  lease.update({ transport: "http", host: "127.0.0.1", port, token });

  await closed;
  lease.release();
}

export function httpHandler(
  service: NmgService,
  token: string,
  onShutdown: () => void = () => {},
): (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void {
  return (req, res) => {
    void handle(service, token, req, res, onShutdown);
  };
}

async function handle(
  service: NmgService,
  token: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  onShutdown: () => void,
): Promise<void> {
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  if (req.method !== "POST") {
    send(405, jsonRpcError(undefined, -32600, "method not allowed"));
    return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    send(401, jsonRpcError(undefined, -32001, "unauthenticated"));
    return;
  }

  let raw = "";
  let bytes = 0;
  try {
    for await (const chunk of req) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_REQUEST_BYTES) {
        req.resume();
        send(413, jsonRpcError(undefined, -32600, "request too large"));
        return;
      }
      raw += text;
    }
  } catch {
    send(400, jsonRpcError(undefined, -32700, "parse error"));
    return;
  }

  let request: { method?: unknown; params?: unknown; id?: unknown };
  try {
    request = JSON.parse(raw) as { method?: unknown; params?: unknown; id?: unknown };
  } catch {
    send(400, jsonRpcError(undefined, -32700, "parse error"));
    return;
  }
  const method = request.method;
  if (typeof method !== "string" || !isKnownMethod(method)) {
    send(400, jsonRpcError(request.id, -32601, `method not found: ${String(method)}`));
    return;
  }

  try {
    const result = await service.invoke(method as NmgMethod, request.params);
    if (method === "shutdown") {
      send(200, { jsonrpc: "2.0", result, id: request.id ?? null });
      setImmediate(onShutdown);
      return;
    }
    send(200, { jsonrpc: "2.0", result, id: request.id ?? null });
  } catch (error) {
    const protocol = error instanceof NmgProtocolError;
    send(
      protocol ? 400 : 500,
      jsonRpcError(request.id, protocol ? -32602 : -32603, errorMessage(error)),
    );
  }
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: id ?? null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isKnownMethod(value: string): boolean {
  return (
    [
      "hello",
      "status",
      "remember",
      "search",
      "get",
      "retentionCandidates",
      "setStorageState",
      "deleteMemory",
      "mergeNodes",
      "splitNode",
      "perfAggregates",
      "pruneRetrievalTraces",
      "shutdown",
    ] as const
  ).includes(value as never);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}
