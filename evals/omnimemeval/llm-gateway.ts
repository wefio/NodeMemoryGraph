/** OpenAI-compatible pass-through that owns NMG's answer and judge policy.
 *
 * The OmniMemEval harness is pinned as a git-ignored external checkout
 * (`evals/official/upstreams.json`), so editing its `utils/llm_client.py` would
 * put benchmark policy outside the repository: the numbers stop being
 * reproducible on a fresh checkout, and nothing records what was actually run.
 * Its readers and judges only speak OpenAI-compatible HTTP, so the policy lives
 * here instead and the harness stays untouched — `ANSWER_BASE_URL` and
 * `EVAL_BASE_URL` point at this gateway.
 *
 * Three decisions are made per request, all of them things the pinned client
 * cannot express through configuration:
 *
 * - an output-token cap per module (answer and judge need different budgets, and
 *   two suites send no `max_tokens` at all);
 * - a `thinking: {type: "disabled"}` control for suites whose answer path never
 *   disables provider reasoning — without it a small answer budget is consumed
 *   by hidden reasoning and the visible answer comes back empty;
 * - a stable `x-opencode-session` header, which opencode's Go endpoint requires
 *   and rejects with 400 `MissingSessionID` when absent.
 *
 * Everything else is forwarded verbatim, and every call is logged as one JSONL
 * line so a run states which policy it actually used and what each call cost.
 */

import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type GatewayModule = "answer" | "eval";

export type GatewayPolicy = {
  /** Output-token ceiling for this module, or undefined to forward as sent. */
  maxTokens?: number;
  /** Inject `thinking: {type: "disabled"}` when the caller sent no control. */
  disableThinking: boolean;
};

export type GatewayConfig = {
  host: string;
  port: number;
  /** Upstream root, e.g. `https://opencode.ai/zen/go/v1`. */
  upstream: string;
  /** Value for `x-opencode-session`; omitted when unset. */
  sessionId?: string;
  policies: Record<GatewayModule, GatewayPolicy>;
  /** JSONL request log; omitted to disable logging. */
  logPath?: string;
  /** Per-request upstream timeout in milliseconds. */
  timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS = 600_000;

/** Split `/{module}/[v1/]chat/completions`. Returns undefined for anything else,
 *  so an unexpected path is rejected instead of silently forwarded. */
export function routeFor(url: string | undefined): { module: GatewayModule } | undefined {
  const path = (url ?? "").split("?")[0] ?? "";
  const match = /^\/(answer|eval)\/(?:v1\/)?chat\/completions$/u.exec(path);
  return match ? { module: match[1] as GatewayModule } : undefined;
}

/** Apply one module's policy to a chat-completions body without mutating it.
 *
 * The cap only ever lowers a budget: a caller asking for less than the ceiling
 * keeps its own value, and a caller sending nothing inherits the ceiling. That
 * keeps a deliberately small probe small while making an unset budget bounded.
 */
export function applyPolicy(
  body: Record<string, unknown>,
  policy: GatewayPolicy,
): {
  body: Record<string, unknown>;
  maxTokens?: { requested?: number; applied: number };
  thinkingInjected: boolean;
} {
  const out: Record<string, unknown> = { ...body };
  let maxTokens: { requested?: number; applied: number } | undefined;
  const requestedRaw = out.max_tokens ?? out.max_completion_tokens;
  const requested = typeof requestedRaw === "number" ? requestedRaw : undefined;
  if (policy.maxTokens !== undefined) {
    if (requested === undefined || requested > policy.maxTokens) {
      out.max_tokens = policy.maxTokens;
      delete out.max_completion_tokens;
      maxTokens = { ...(requested === undefined ? {} : { requested }), applied: policy.maxTokens };
    }
  }
  const hasThinking = out.thinking !== undefined || out.enable_thinking !== undefined;
  const thinkingInjected = policy.disableThinking && !hasThinking;
  if (thinkingInjected) out.thinking = { type: "disabled" };
  return { body: out, ...(maxTokens ? { maxTokens } : {}), thinkingInjected };
}

function policyFrom(value: string | undefined): GatewayPolicy {
  return {
    ...(value ? { maxTokens: Math.max(1, Number(value)) } : {}),
    disableThinking: false,
  };
}

export function configFrom(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const upstream = environment.LLM_GATEWAY_UPSTREAM?.trim().replace(/\/$/u, "");
  if (!upstream) {
    throw new Error(
      "LLM_GATEWAY_UPSTREAM is required, e.g. https://opencode.ai/zen/go/v1 — the gateway forwards to it",
    );
  }
  const disableThinking = ["1", "true", "yes", "on"].includes(
    (environment.LLM_GATEWAY_DISABLE_THINKING ?? "").trim().toLowerCase(),
  );
  return {
    host: environment.LLM_GATEWAY_HOST?.trim() || "127.0.0.1",
    port: Number(environment.LLM_GATEWAY_PORT ?? 8020),
    upstream,
    ...(environment.LLM_GATEWAY_SESSION?.trim()
      ? { sessionId: environment.LLM_GATEWAY_SESSION.trim() }
      : {}),
    policies: {
      answer: { ...policyFrom(environment.LLM_GATEWAY_ANSWER_MAX_TOKENS), disableThinking },
      eval: { ...policyFrom(environment.LLM_GATEWAY_EVAL_MAX_TOKENS), disableThinking },
    },
    ...(environment.LLM_GATEWAY_LOG?.trim()
      ? { logPath: resolve(environment.LLM_GATEWAY_LOG.trim()) }
      : {}),
    timeoutMs: Number(environment.LLM_GATEWAY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

type ForwardResult = { status: number; payload: unknown; failure?: string };

/** Forward one prepared request, turning a transport failure into a 502 with a
 *  machine-readable body. A provider that is unreachable must look like an error
 *  to the caller, never like an empty answer. */
async function forwardToUpstream(
  config: GatewayConfig,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<ForwardResult> {
  try {
    const response = await fetch(`${config.upstream}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: { message: text.slice(0, 2_000), type: "upstream_non_json" } };
    }
    return { status: response.status, payload };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    return {
      status: 502,
      payload: {
        error: { message: `upstream request failed: ${failure}`, type: "gateway_upstream" },
      },
      failure,
    };
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

/** Build the gateway without listening, so tests can drive the same code the CLI runs. */
export function createGatewayServer(config: GatewayConfig): Server {
  return createServer((request, response) => {
    void handleRequest(config, request, response);
  });
}

/** One place where the gateway decides what a request is. */
async function handleRequest(
  config: GatewayConfig,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, {
      status: "ok",
      upstream: config.upstream,
      sessionHeader: config.sessionId ? "configured" : "absent",
      policies: config.policies,
    });
    return;
  }
  const route = routeFor(request.url);
  if (request.method !== "POST" || !route) {
    sendJson(response, 404, {
      error: `POST /{answer|eval}/chat/completions is the only supported route; got ${request.method} ${request.url}`,
    });
    return;
  }
  await handleCompletion(config, route.module, request, response);
}

async function readJsonObject(
  request: IncomingMessage,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readBody(request)) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function upstreamHeaders(config: GatewayConfig, request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (request.headers.authorization) headers.authorization = String(request.headers.authorization);
  if (config.sessionId) headers["x-opencode-session"] = config.sessionId;
  return headers;
}

function logCall(
  config: GatewayConfig,
  module: GatewayModule,
  started: number,
  status: number,
  applied: ReturnType<typeof applyPolicy>,
  payload: unknown,
  failure: string | undefined,
): void {
  if (!config.logPath) return;
  const usage = (
    payload as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | undefined
  )?.usage;
  appendFileSync(
    config.logPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      module,
      status,
      durationMs: Date.now() - started,
      model: applied.body.model,
      maxTokens: applied.maxTokens ?? null,
      thinkingInjected: applied.thinkingInjected,
      sessionHeader: config.sessionId ? "configured" : "absent",
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      ...(failure ? { failure } : {}),
    })}\n`,
    "utf8",
  );
}

/** Apply the module policy, forward once, log the call, return the provider's
 *  own status and body so the harness sees what the provider said. */
async function handleCompletion(
  config: GatewayConfig,
  module: GatewayModule,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const parsed = await readJsonObject(request);
  if (!parsed) {
    sendJson(response, 400, { error: "request body is not JSON" });
    return;
  }
  if (parsed.stream === true) {
    sendJson(response, 400, {
      error: "the gateway does not proxy streaming responses; benchmark suites do not stream",
    });
    return;
  }
  const applied = applyPolicy(parsed, config.policies[module]);
  const started = Date.now();
  const { status, payload, failure } = await forwardToUpstream(
    config,
    upstreamHeaders(config, request),
    applied.body,
  );
  logCall(config, module, started, status, applied, payload, failure);
  sendJson(response, status, payload);
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  try {
    const config = configFrom();
    const server = createGatewayServer(config);
    server.listen(config.port, config.host, () => {
      process.stdout.write(
        `[llm-gateway] ${config.host}:${config.port} -> ${config.upstream} | answer max_tokens=${config.policies.answer.maxTokens ?? "forwarded"} eval max_tokens=${config.policies.eval.maxTokens ?? "forwarded"} thinking=${config.policies.answer.disableThinking ? "disabled" : "forwarded"} session=${config.sessionId ? "configured" : "absent"}\n`,
      );
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
