import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyPolicy,
  configFrom,
  createGatewayServer,
  routeFor,
  type GatewayConfig,
} from "../../evals/omnimemeval/llm-gateway.ts";

type Captured = { headers: Record<string, unknown>; body: Record<string, unknown> };

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Stub provider that records what the gateway actually sent it. */
async function stubUpstream(captured: Captured[]): Promise<{ server: Server; url: string }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    captured.push({
      headers: { ...request.headers },
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
    });
    const payload = JSON.stringify({
      id: "stub",
      model: "stub-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 2 },
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(payload);
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}/v1` };
}

function gatewayConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    upstream: "http://127.0.0.1:1/v1",
    policies: {
      answer: { maxTokens: 300, disableThinking: true },
      eval: { maxTokens: 1_000, disableThinking: true },
    },
    timeoutMs: 5_000,
    ...overrides,
  };
}

test("only the two module routes are proxied", () => {
  assert.deepEqual(routeFor("/answer/v1/chat/completions"), { module: "answer" });
  assert.deepEqual(routeFor("/eval/chat/completions"), { module: "eval" });
  assert.deepEqual(routeFor("/answer/v1/chat/completions?x=1"), { module: "answer" });
  assert.equal(routeFor("/other/v1/chat/completions"), undefined);
  assert.equal(routeFor("/answer/v1/models"), undefined);
});

test("the cap lowers a budget and never raises one", () => {
  const policy = { maxTokens: 300, disableThinking: false };
  const absent = applyPolicy({ model: "m" }, policy);
  assert.equal(absent.body.max_tokens, 300);
  assert.deepEqual(absent.maxTokens, { applied: 300 });

  const large = applyPolicy({ model: "m", max_tokens: 1_000 }, policy);
  assert.equal(large.body.max_tokens, 300);
  assert.deepEqual(large.maxTokens, { requested: 1_000, applied: 300 });

  const small = applyPolicy({ model: "m", max_tokens: 24 }, policy);
  assert.equal(small.body.max_tokens, 24);
  assert.equal(small.maxTokens, undefined);

  const uncapped = applyPolicy({ model: "m", max_tokens: 1_000 }, { disableThinking: false });
  assert.equal(uncapped.body.max_tokens, 1_000);
});

test("thinking is disabled only when the caller sent no control", () => {
  const injected = applyPolicy({ model: "m" }, { disableThinking: true });
  assert.deepEqual(injected.body.thinking, { type: "disabled" });
  assert.equal(injected.thinkingInjected, true);

  const callerChose = applyPolicy(
    { model: "m", thinking: { type: "enabled" } },
    { disableThinking: true },
  );
  assert.deepEqual(callerChose.body.thinking, { type: "enabled" });
  assert.equal(callerChose.thinkingInjected, false);

  const off = applyPolicy({ model: "m" }, { disableThinking: false });
  assert.equal(off.body.thinking, undefined);
});

test("a request reaches the provider with the policy applied and the answer passes back", async () => {
  const captured: Captured[] = [];
  const upstream = await stubUpstream(captured);
  const directory = mkdtempSync(join(tmpdir(), "llm-gateway-"));
  const logPath = join(directory, "calls.jsonl");
  const gateway = createGatewayServer(
    gatewayConfig({ upstream: upstream.url, sessionId: "nmg-eval", logPath }),
  );
  const port = await listen(gateway);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/answer/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(payload.choices[0]!.message.content, "ok");

    assert.equal(captured.length, 1);
    const sent = captured[0]!;
    assert.equal(sent.headers["x-opencode-session"], "nmg-eval");
    assert.equal(sent.headers.authorization, "Bearer test-key");
    assert.equal(sent.body.max_tokens, 300);
    assert.deepEqual(sent.body.thinking, { type: "disabled" });

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(entry.module, "answer");
    assert.equal(entry.status, 200);
    assert.deepEqual(entry.maxTokens, { applied: 300 });
    assert.equal(entry.thinkingInjected, true);
    assert.equal(entry.promptTokens, 11);
  } finally {
    await close(gateway);
    await close(upstream.server);
  }
});

test("the eval module keeps its own budget from the answer module", async () => {
  const captured: Captured[] = [];
  const upstream = await stubUpstream(captured);
  const gateway = createGatewayServer(
    gatewayConfig({
      upstream: upstream.url,
      policies: {
        answer: { maxTokens: 300, disableThinking: true },
        eval: { maxTokens: 1_000, disableThinking: true },
      },
    }),
  );
  const port = await listen(gateway);
  try {
    for (const module of ["answer", "eval"] as const) {
      await fetch(`http://127.0.0.1:${port}/${module}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
    }
    assert.equal(captured[0]!.body.max_tokens, 300);
    assert.equal(captured[1]!.body.max_tokens, 1_000);
  } finally {
    await close(gateway);
    await close(upstream.server);
  }
});

test("an unsupported route and a stream request are refused instead of forwarded", async () => {
  const captured: Captured[] = [];
  const upstream = await stubUpstream(captured);
  const gateway = createGatewayServer(gatewayConfig({ upstream: upstream.url }));
  const port = await listen(gateway);
  try {
    const wrongRoute = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(wrongRoute.status, 404);
    const streamed = await fetch(`http://127.0.0.1:${port}/answer/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [], stream: true }),
    });
    assert.equal(streamed.status, 400);
    assert.equal(captured.length, 0);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const state = (await health.json()) as { status: string; policies: Record<string, unknown> };
    assert.equal(state.status, "ok");
    assert.equal((state.policies.answer as { maxTokens: number }).maxTokens, 300);
  } finally {
    await close(gateway);
    await close(upstream.server);
  }
});

test("a dead provider surfaces as a gateway error, not a silent empty answer", async () => {
  const gateway = createGatewayServer(gatewayConfig({ upstream: "http://127.0.0.1:1/v1" }));
  const port = await listen(gateway);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/answer/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    assert.equal(response.status, 502);
    const payload = (await response.json()) as { error: { type: string; message: string } };
    assert.equal(payload.error.type, "gateway_upstream");
    assert.match(payload.error.message, /upstream request failed/u);
  } finally {
    await close(gateway);
  }
});

test("configuration refuses to start without an upstream", () => {
  assert.throws(() => configFrom({}), /LLM_GATEWAY_UPSTREAM is required/u);
  const configured = configFrom({
    LLM_GATEWAY_UPSTREAM: "https://example.test/v1/",
    LLM_GATEWAY_SESSION: "s",
    LLM_GATEWAY_ANSWER_MAX_TOKENS: "300",
    LLM_GATEWAY_DISABLE_THINKING: "1",
  });
  assert.equal(configured.upstream, "https://example.test/v1");
  assert.equal(configured.port, 8020);
  assert.equal(configured.sessionId, "s");
  assert.deepEqual(configured.policies.answer, { maxTokens: 300, disableThinking: true });
  assert.deepEqual(configured.policies.eval, { disableThinking: true });
});
