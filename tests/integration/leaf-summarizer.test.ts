import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import {
  createLeafSummaryProviderFromEnv,
  drainLeafSummaries,
  OpenAiLeafSummaryProvider,
} from "../../src/integration/leaf-summarizer.ts";
import type { LeafSummaryProvider } from "../../src/core/types.ts";

function captureFetch(
  body: unknown,
  impl?: (init: Record<string, unknown>) => { ok: boolean; payload?: unknown },
): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      Object.assign(body as Record<string, unknown>, parsed);
    }
    const outcome = impl?.(parsed) ?? { ok: true, payload: { choices: [{ message: { content: "summary text" } }] } };
    return new Response(outcome.ok ? JSON.stringify(outcome.payload) : "boom", {
      status: outcome.ok ? 200 : 500,
    });
  }) as typeof fetch;
}

test("OpenAiLeafSummaryProvider: request shape and content extraction", async () => {
  const body: Record<string, unknown> = {};
  const provider = new OpenAiLeafSummaryProvider({
    baseUrl: "https://example.test/",
    model: "test-model",
    fetch: captureFetch(body),
  });
  const text = await provider.summarize({
    nodeName: "cluster a",
    statements: ["first memory", "second memory"],
  });
  assert.equal(text, "summary text");
  assert.equal(body.model, "test-model");
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 600);
  assert.equal(body.stream, false);
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 2);
  assert.ok(messages[0]!.content.includes("retrieval index"));
  assert.ok(messages[1]!.content.includes("cluster a"));
  assert.ok(messages[1]!.content.includes("- first memory"));
});

test("OpenAiLeafSummaryProvider: HTTP errors and empty content throw", async () => {
  const failing = new OpenAiLeafSummaryProvider({
    baseUrl: "https://example.test",
    model: "m",
    fetch: captureFetch(null, () => ({ ok: false })),
  });
  await assert.rejects(() => failing.summarize({ nodeName: "n", statements: ["s"] }));
  const empty = new OpenAiLeafSummaryProvider({
    baseUrl: "https://example.test",
    model: "m",
    fetch: captureFetch(null, () => ({ ok: true, payload: { choices: [{ message: { content: "" } }] } })),
  });
  await assert.rejects(() => empty.summarize({ nodeName: "n", statements: ["s"] }));
});

test("OpenAiLeafSummaryProvider: deepseek endpoints get thinking disabled", async () => {
  const body: Record<string, unknown> = {};
  const provider = new OpenAiLeafSummaryProvider({
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    fetch: captureFetch(body),
  });
  await provider.summarize({ nodeName: "n", statements: ["s"] });
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("createLeafSummaryProviderFromEnv: own env, judge fallback, disabled", () => {
  assert.equal(createLeafSummaryProviderFromEnv({}), undefined);
  assert.equal(
    createLeafSummaryProviderFromEnv({
      NMG_SUMMARY_BASE_URL: "https://x.test",
      NMG_SUMMARY_MODEL: "s-model",
      NMG_SUMMARY_DISABLED: "1",
    }),
    undefined,
  );
  const own = createLeafSummaryProviderFromEnv({
    NMG_SUMMARY_BASE_URL: "https://x.test",
    NMG_SUMMARY_MODEL: "s-model",
  });
  assert.equal(own?.model, "s-model");
  const fallback = createLeafSummaryProviderFromEnv({
    NMG_JUDGE_BASE_URL: "https://j.test",
    NMG_JUDGE_MODEL: "j-model",
  });
  assert.equal(fallback?.model, "j-model");
});

test("drainLeafSummaries: summarizes all pending blocks, then idles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-leaf-drain-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    store.remember({ statement: "alpha memory", nodeName: "drain node", sourceActor: "user" });
    store.remember({ statement: "beta memory", nodeName: "drain node", sourceActor: "user" });
    store.rebuildLeafBlocks();
    const seen: string[][] = [];
    const provider: LeafSummaryProvider = {
      model: "fake-model",
      summarize: (input) => {
        seen.push([...input.statements]);
        return Promise.resolve(`summary of ${input.statements.length}`);
      },
    };
    const first = await drainLeafSummaries(store, provider);
    assert.equal(first.summarized, 1);
    assert.equal(first.failed, 0);
    assert.equal(first.truncated, false);
    assert.equal(seen.length, 1);
    assert.deepEqual([...seen[0]!].sort(), ["alpha memory", "beta memory"]);
    assert.equal(store.pendingLeafSummaries().length, 0);
    const second = await drainLeafSummaries(store, provider);
    assert.equal(second.summarized, 0);
    assert.equal(second.truncated, false);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("drainLeafSummaries: systematic provider failure stops without hot-looping", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-leaf-drain-fail-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    store.remember({ statement: "only memory", nodeName: "fail node", sourceActor: "user" });
    store.rebuildLeafBlocks();
    let calls = 0;
    const provider: LeafSummaryProvider = {
      model: "fake-model",
      summarize: () => {
        calls += 1;
        return Promise.reject(new Error("endpoint down"));
      },
    };
    const result = await drainLeafSummaries(store, provider);
    assert.equal(result.summarized, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.truncated, true);
    assert.equal(calls, 1);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
