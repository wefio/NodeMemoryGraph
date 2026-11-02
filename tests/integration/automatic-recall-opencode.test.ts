import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import plugin from "../../opencode-plugin/index.ts";
import { dropCompatibleLease } from "../../src/integration/lease-transport.ts";
import { searchResultFixture } from "../helpers/search-result.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

function context(id: string, count = 1) {
  return {
    results: Array.from({ length: count }, (_, i) =>
      searchResultFixture(`${id}-${i}`, `${id} SQLite storage. `.repeat(30)),
    ),
    relations: [],
    activeGraph: { id: `graph-${id}` },
  };
}

async function host(t: TestContext, search: (query: string) => Promise<unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "nmg-auto-opencode-"));
  const oldDir = process.env.NMG_DATA_DIR;
  const oldCoordination = process.env.NMG_ENABLE_COORDINATION;
  process.env.NMG_DATA_DIR = dir;
  process.env.NMG_ENABLE_COORDINATION = "0";
  writeFileSync(
    join(dir, "nmg.sqlite.server.json"),
    JSON.stringify({
      transport: "http",
      host: "127.0.0.1",
      port: 12345,
      pid: process.pid,
      token: "fixture-not-a-secret",
    }),
  );
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    const result =
      request.method === "hello"
        ? {
            protocol: "nmg.v9",
            service: "node-memory-graph",
            version: "test",
            capabilities: ["session-active-graph"],
          }
        : request.method === "search"
          ? await search(request.params.query)
          : {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
  const hooks = new Map<string, (event: unknown) => unknown>();
  const dispose = await plugin.setup({
    session: {
      async hook(name, handler) {
        hooks.set(name, (event) => handler(event as never));
      },
    },
    tool: { async hook() {}, async transform() {} },
    event: { async *subscribe() {} },
  });
  t.after(async () => {
    await dispose?.();
    dropCompatibleLease(dir);
    if (oldDir === undefined) delete process.env.NMG_DATA_DIR;
    else process.env.NMG_DATA_DIR = oldDir;
    if (oldCoordination === undefined) delete process.env.NMG_ENABLE_COORDINATION;
    else process.env.NMG_ENABLE_COORDINATION = oldCoordination;
    removeTempDirectory(dir);
  });
  const prompt = (key: string) =>
    hooks.get("prompt")!({
      sessionID: "s",
      messageID: key,
      prompt: { text: `What did we previously decide about ${key} SQLite storage?` },
    });
  const inject = (sessionID = "s", messages: Array<{ role: string; content: unknown }> = []) => {
    hooks.get("context")!({ sessionID, messages });
    return messages;
  };
  return { prompt, inject, hooks, requests };
}

test("OpenCode budgets final injection, retries exact text, and never discloses preparation", async (t) => {
  const h = await host(t, async (query) => context("Atlas", query.includes("empty") ? 0 : 80));
  await h.prompt("Atlas");
  assert.equal(
    h.requests.some((r) => r.params.action === "disclose"),
    false,
  );
  const messages = h.inject();
  const text = (messages[0].content as Array<{ text: string }>)[0].text;
  assert.ok(text.length <= 16_000 && text.includes("Atlas-0"));
  assert.equal(h.inject("s", messages).length, 1);
  assert.deepEqual(h.inject(), messages, "provider retry receives the same prepared output");
  assert.equal(
    h.inject("s", [{ role: "system", content: "[NMG automatic recall] unrelated old fragment" }])
      .length,
    2,
  );
  assert.deepEqual(h.inject("another-session"), []);
  await h.prompt("empty");
  assert.deepEqual(h.inject(), [], "a new empty turn cannot inherit the previous injection");
  assert.equal(
    h.requests.some((r) => r.params.action === "disclose"),
    false,
  );
});

test("OpenCode rejects late preparation after deadline, replacement or compaction", async (t) => {
  let resolveSearch!: (result: unknown) => void;
  let started!: () => void;
  let reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  const h = await host(t, async (query) => {
    if (query.split("\n")[0].includes("new")) return context("new");
    const pending = new Promise((resolve) => {
      resolveSearch = resolve;
    });
    started();
    return pending;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const reason of ["deadline", "replacement", "compaction"]) {
    reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = h.prompt(reason);
    await reached;
    if (reason === "deadline") t.mock.timers.tick(1_500);
    else if (reason === "replacement") await h.prompt("new");
    else await h.hooks.get("compaction")!({ sessionID: "s" });
    await pending;
    resolveSearch(context("stale"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const injection = JSON.stringify(h.inject());
    assert.ok(!injection.includes("stale"));
    if (reason === "replacement") assert.match(injection, /new-0/);
    else assert.deepEqual(h.inject(), []);
  }
  assert.equal(
    h.requests.some((r) => r.params.action === "disclose"),
    false,
  );
});
