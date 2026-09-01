/**
 * OpenAI-compatible fake chat endpoint for measuring serialized prompt-prefix
 * reuse. It never calls a model and stores only chained prefix hashes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import {
  buildPrefixCheckpoints,
  DEFAULT_CACHE_ENVIRONMENTS,
  DEFAULT_PREFIX_BLOCK_BYTES,
  simulateCacheEnvironment,
  type CacheEnvironment,
  type PromptTraceRequest,
} from "./cache-environment-simulator.ts";

export type FakeCacheApi = {
  server: Server;
  traces: PromptTraceRequest[];
};

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function environmentFromUrl(url: URL): CacheEnvironment {
  const profile = url.searchParams.get("profile") ?? "normal-cloud";
  const environment = DEFAULT_CACHE_ENVIRONMENTS[profile];
  if (!environment) throw new Error(`unknown cache environment profile: ${profile}`);
  return environment;
}

export function createFakeCacheApi(options: { blockBytes?: number } = {}): FakeCacheApi {
  const blockBytes = options.blockBytes ?? DEFAULT_PREFIX_BLOCK_BYTES;
  const traces: PromptTraceRequest[] = [];
  const startedAtMs = Date.now();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", requests: traces.length, blockBytes });
        return;
      }
      if (request.method === "GET" && url.pathname === "/__cache/report") {
        sendJson(response, 200, {
          blockBytes,
          ...simulateCacheEnvironment(traces, environmentFromUrl(url)),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/__cache/reset") {
        traces.length = 0;
        sendJson(response, 200, { status: "reset" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await readBody(request);
        JSON.parse(body.toString("utf8"));
        const id = `fake-${traces.length + 1}`;
        traces.push({
          id,
          arrivalMs: Date.now() - startedAtMs,
          ...buildPrefixCheckpoints(body, blockBytes),
        });
        sendJson(response, 200, {
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "nmg-fake-cache-api",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "CACHE_TRACE_ONLY" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
        return;
      }
      sendJson(response, 404, { error: { message: "not found" } });
    } catch (error) {
      sendJson(response, 400, {
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  });
  return { server, traces };
}

function runCli(): void {
  const port = Number.parseInt(process.env.PORT ?? "8788", 10);
  const blockBytes = Number.parseInt(
    process.env.CACHE_PREFIX_BLOCK_BYTES ?? String(DEFAULT_PREFIX_BLOCK_BYTES),
    10,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be 1..65535");
  const { server } = createFakeCacheApi({ blockBytes });
  server.listen(port, "127.0.0.1", () => {
    console.log(`fake cache API listening on http://127.0.0.1:${port}/v1`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
