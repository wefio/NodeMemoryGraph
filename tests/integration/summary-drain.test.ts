import assert from "node:assert/strict";
import test from "node:test";

import { OpenAiNodeSummaryProvider } from "../../src/integration/node-summarizer.ts";
import { drainSummaryTasks } from "../../src/integration/summary-drain.ts";

test("OpenAiNodeSummaryProvider keeps the node domain prompt over the shared transport", async () => {
  let body: Record<string, unknown> = {};
  const provider = new OpenAiNodeSummaryProvider({
    baseUrl: "https://example.test/",
    model: "node-model",
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "node summary" } }] }));
    }) as typeof fetch,
  });

  assert.equal(
    await provider.summarize({ nodeName: "runtime", statements: ["leaf one", "leaf two"] }),
    "node summary",
  );
  assert.equal(provider.baseUrl, "https://example.test");
  assert.equal(body.model, "node-model");
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.ok(messages[0]!.content.includes("node-level index summary"));
  assert.ok(messages[1]!.content.includes("Block summaries:"));
  assert.ok(messages[1]!.content.includes("- leaf two"));
});

test("shared summary drain treats stale commits separately from provider failures", async () => {
  const pending = [1, 2];
  const result = await drainSummaryTasks({
    maxCalls: 2,
    pull: (limit) => pending.splice(0, limit),
    summarize: async (task) => `summary ${task}`,
    commit: (task) => task === 2,
  });

  assert.deepEqual(result, { summarized: 1, failed: 0, truncated: true });
});

test("shared summary drain bounds concurrent provider calls", async () => {
  const pending = [1, 2, 3, 4];
  let active = 0;
  let peak = 0;
  const result = await drainSummaryTasks({
    maxCalls: 4,
    concurrency: 2,
    pull: (limit) => pending.splice(0, limit),
    summarize: async (task) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return `summary ${task}`;
    },
    commit: () => true,
  });

  assert.equal(result.summarized, 4);
  assert.equal(peak, 2);
});

test("OpenAiNodeSummaryProvider batches several summaries into one request", async () => {
  let requests = 0;
  let body: Record<string, unknown> = {};
  const provider = new OpenAiNodeSummaryProvider({
    baseUrl: "https://example.test",
    model: "batch-model",
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"summaries":["one","two"]}' } }] }),
      );
    }) as typeof fetch,
  });

  const summaries = await provider.summarizeMany!([
    { nodeName: "one", statements: ["alpha"] },
    { nodeName: "two", statements: ["beta"] },
  ]);
  assert.deepEqual(summaries, ["one", "two"]);
  assert.equal(requests, 1);
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.ok(messages[0]!.content.startsWith("You are building a retrieval index"));
  assert.deepEqual(
    (JSON.parse(messages[1]!.content) as Array<{ id: number }>).map((entry) => entry.id),
    [0, 1],
  );
});

test("shared summary drain prefers one provider batch per concurrency slice", async () => {
  const pending = [1, 2, 3, 4];
  let individualCalls = 0;
  let batchCalls = 0;
  const result = await drainSummaryTasks({
    maxCalls: 4,
    concurrency: 4,
    pull: (limit) => pending.splice(0, limit),
    summarize: async () => {
      individualCalls += 1;
      return "unexpected";
    },
    summarizeMany: async (tasks) => {
      batchCalls += 1;
      return tasks.map((task) => `summary ${task}`);
    },
    commit: () => true,
  });
  assert.deepEqual(result, { summarized: 4, failed: 0, truncated: true });
  assert.equal(batchCalls, 1);
  assert.equal(individualCalls, 0);
});
