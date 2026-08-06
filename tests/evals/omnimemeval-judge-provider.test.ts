import assert from "node:assert/strict";
import test from "node:test";

import { OpenAiCompatibleJudgeClient, createJudgeClientFromEnv } from "../../evals/omnimemeval/judge-provider.ts";
import type { DuplicateCandidate } from "../../src/core/types.ts";

function candidate(id: string, statement: string, eventTime = "2026-01-01T00:00:00Z"): DuplicateCandidate {
  return { memoryId: id, nodeId: "n", statement, eventTime, similarity: 0.3 };
}

test("createJudgeClientFromEnv: no base URL -> undefined", () => {
  assert.equal(createJudgeClientFromEnv({}), undefined);
  assert.ok(createJudgeClientFromEnv({ NMG_JUDGE_BASE_URL: "https://api.deepseek.com" }));
});

test("judge: no supersede candidates -> keep without a call", async () => {
  let called = 0;
  const client = new OpenAiCompatibleJudgeClient({
    baseUrl: "https://x.example",
    model: "m",
    fetch: (async () => {
      called += 1;
      throw new Error("should not be called");
    }) as typeof fetch,
  });
  const r = await client.judge({ statement: "s", candidates: [] });
  assert.equal(r.merge, false);
  assert.equal(called, 0);
});

test("judge: supersede decision parsed from model JSON", async () => {
  const client = new OpenAiCompatibleJudgeClient({
    baseUrl: "https://x.example",
    model: "m",
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.temperature, 0, "non-thinking mode uses temperature 0");
      assert.ok(!("thinking" in body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          action: "supersede",
          supersededMemoryId: "stale-1",
          reason: "newer value",
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const r = await client.judge({
    statement: "salary is now 30k",
    candidates: [],
    supersedeCandidates: [candidate("stale-1", "salary is 20k", "2025-01-01T00:00:00Z")],
  });
  assert.equal(r.supersede, true);
  assert.equal(r.supersededMemoryId, "stale-1");
});

test("judge: thinking mode sends DeepSeek reasoning fields, no temperature", async () => {
  let sentBody: Record<string, unknown> | undefined;
  const client = new OpenAiCompatibleJudgeClient({
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    thinking: true,
    reasoningEffort: "high",
    fetch: (async (_url, init) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ action: "keep", reason: "distinct" }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  await client.judge({
    statement: "s",
    candidates: [],
    supersedeCandidates: [candidate("c1", "t")],
  });
  assert.deepEqual(sentBody?.thinking, { type: "enabled" });
  assert.equal(sentBody?.reasoning_effort, "high");
  assert.equal(sentBody?.model, "deepseek-v4-pro");
  assert.ok(!("temperature" in (sentBody ?? {})));
});

test("judge: code-fenced / malformed model output degrades to keep", async () => {
  const client = new OpenAiCompatibleJudgeClient({
    baseUrl: "https://x.example",
    model: "m",
    fetch: (async (_url, init) => new Response(JSON.stringify({
      choices: [{ message: { content: "```json\n{\"action\":\"merge\",\"memoryId\":\"c1\"}\n```" } }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  const r = await client.judge({
    statement: "s",
    candidates: [],
    supersedeCandidates: [candidate("c1", "t")],
  });
  assert.equal(r.merge, true);

  const bad = new OpenAiCompatibleJudgeClient({
    baseUrl: "https://x.example",
    model: "m",
    fetch: (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "not json at all" } }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  const r2 = await bad.judge({
    statement: "s",
    candidates: [],
    supersedeCandidates: [candidate("c1", "t")],
  });
  assert.equal(r2.merge, false);
  assert.equal(r2.supersede, undefined);
});

test("createJudgeClientFromEnv: falls back to benchmark EVAL_* / ANSWER_* config", () => {
  const evalCfg = createJudgeClientFromEnv({
    EVAL_BASE_URL: "https://api.deepseek.com",
    EVAL_MODEL: "deepseek-chat",
    EVAL_API_KEY: "k",
  } as NodeJS.ProcessEnv);
  assert.ok(evalCfg);
  assert.equal(evalCfg?.baseUrl, "https://api.deepseek.com");
  assert.equal(evalCfg?.model, "deepseek-chat");

  const answerCfg = createJudgeClientFromEnv({
    ANSWER_BASE_URL: "https://api.deepseek.com",
    ANSWER_MODEL: "deepseek-chat",
    ANSWER_API_KEY: "k",
  } as NodeJS.ProcessEnv);
  assert.ok(answerCfg);

  const explicit = createJudgeClientFromEnv({
    EVAL_BASE_URL: "https://api.deepseek.com",
    NMG_JUDGE_BASE_URL: "https://override.example",
    NMG_JUDGE_MODEL: "m2",
    NMG_JUDGE_API_KEY: "k2",
  } as NodeJS.ProcessEnv);
  assert.equal(explicit?.baseUrl, "https://override.example");
  assert.equal(explicit?.model, "m2");
});

test("createJudgeClientFromEnv: NMG_JUDGE_DISABLED=1 disables even with eval config", () => {
  const disabled = createJudgeClientFromEnv({
    NMG_JUDGE_DISABLED: "1",
    EVAL_BASE_URL: "https://api.deepseek.com",
    EVAL_MODEL: "deepseek-chat",
    EVAL_API_KEY: "k",
  } as NodeJS.ProcessEnv);
  assert.equal(disabled, undefined);
});
