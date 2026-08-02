import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

import type { ServerLease } from "./lifecycle.ts";
import type { NmgMethod } from "./protocol.ts";
import { NmgProtocolError } from "./protocol.ts";
import { NmgService } from "./service.ts";

const MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

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
export async function serveHttp(
  service: NmgService,
  lease: ServerLease,
  options: { idleTimeoutMs?: number } = {},
): Promise<void> {
  const idleTimeoutMs = options.idleTimeoutMs ?? daemonIdleTimeoutMs();
  const token = randomBytes(32).toString("base64url");
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  let idleTimer: NodeJS.Timeout | undefined;
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    if (idleTimer) clearTimeout(idleTimer);
    server.close(resolveClosed);
    server.closeIdleConnections?.();
  };
  // 每次请求刷新 idle 计时器；超时后走与 shutdown 相同的关闭路径。
  // 启动即计时：即使从未收到请求（spawn 后客户端先死）也会超时退出。
  const touch = () => {
    if (closing) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = idleTimeoutMs > 0 ? setTimeout(close, idleTimeoutMs) : undefined;
  };

  const handler = httpHandler(service, token, close);
  const server = createServer((req, res) => {
    touch();
    handler(req, res);
  });
  touch();

  await listen(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  lease.update({ transport: "http", host: "127.0.0.1", port, token });

  await closed;
  lease.release();
}

/**
 * Idle 超时（毫秒）：无请求超过该值即自动退出；<= 0 表示禁用。
 * 默认 5 分钟；评测等短生命周期场景可调低以快速回收内存。
 */
function daemonIdleTimeoutMs(): number {
  const raw = process.env.NMG_DAEMON_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_IDLE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? DEFAULT_IDLE_TIMEOUT_MS : parsed;
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
      "syncStg",
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
