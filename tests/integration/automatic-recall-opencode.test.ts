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
import { SessionActiveGraphRuntime } from "../../src/core/session-active-graph.ts";
import type { SessionActiveGraphSnapshot } from "../../src/core/session-active-graph.ts";

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

async function host(
  t: TestContext,
  search: (query: string) => Promise<unknown>,
  options: {
    snapshot?: () => SessionActiveGraphSnapshot | null;
    directory?: string;
    lookup?: (input: {
      sessionID: string;
    }) => Promise<{ id: string; location: { directory: string } }>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "nmg-auto-opencode-"));
  const oldDir = process.env.NMG_DATA_DIR;
  const oldCoordination = process.env.NMG_ENABLE_COORDINATION;
  const oldProject = process.env.NMG_PROJECT_DIR;
  delete process.env.NMG_PROJECT_DIR;
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
          : request.method === "state"
            ? {
                space: "ag",
                result: { action: "snapshot", snapshot: options.snapshot?.() ?? null },
              }
            : {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
  const hooks = new Map<string, (event: unknown) => unknown>();
  const tools = new Map<string, unknown>();
  const dispose = await plugin.setup({
    location: options.directory ? { directory: options.directory } : undefined,
    session: {
      get: options.lookup,
      async hook(name, handler) {
        hooks.set(name, (event) => handler(event as never));
      },
    },
    tool: {
      async hook() {},
      async transform(edit) {
        edit({
          add(tool) {
            tools.set(tool.name, tool);
          },
        });
      },
    },
    event: { async *subscribe() {} },
  });
  t.after(async () => {
    await dispose?.();
    dropCompatibleLease(dir);
    if (oldDir === undefined) delete process.env.NMG_DATA_DIR;
    else process.env.NMG_DATA_DIR = oldDir;
    if (oldCoordination === undefined) delete process.env.NMG_ENABLE_COORDINATION;
    else process.env.NMG_ENABLE_COORDINATION = oldCoordination;
    if (oldProject === undefined) delete process.env.NMG_PROJECT_DIR;
    else process.env.NMG_PROJECT_DIR = oldProject;
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
  return { prompt, inject, hooks, requests, tools };
}

test("OpenCode carries complete owner state without recall, budgets it and excludes cleared/foreign state", async (t) => {
  const runtime = new SessionActiveGraphRuntime();
  const binding = runtime.bindWorkingState("s");
  runtime.replaceWorkingState(binding, "Native state is maintained.\nFinal invariant survives.");
  let snapshot = runtime.snapshot("s");
  const h = await host(t, async () => ({ results: [] }), { snapshot: () => snapshot });
  await h.prompt("state-only");
  const carried = JSON.stringify(h.inject());
  assert.match(carried, /<nmg_state\b/);
  assert.match(carried, /Final invariant survives/);
  assert.ok(carried.length < 17000);
  const messages = h.inject();
  assert.equal(h.inject("s", messages).length, messages.length);
  assert.equal(
    h.requests.some((r) => r.params.action === "disclose"),
    false,
  );
  snapshot = { ...snapshot!, sessionId: "foreign" };
  await h.prompt("foreign");
  assert.doesNotMatch(JSON.stringify(h.inject()), /Final invariant/);
  snapshot = null;
  await h.prompt("cleared");
  assert.doesNotMatch(JSON.stringify(h.inject()), /Final invariant/);
});

test("OpenCode uses native location before its first event and exposes the promised NMG tool names", async (t) => {
  const h = await host(t, async () => context("scope"), { directory: "C:/private/native-project" });
  await h.prompt("scope");
  const search = h.requests.find((request) => request.method === "search");
  assert.equal(search?.params.projectDir, "C:/private/native-project");
  assert.ok(h.tools.has("nmg_search"));
  assert.ok(h.tools.has("nmg_get"));
  assert.ok(h.tools.has("nmg_remember"));
  assert.ok(h.tools.has("nmg_state"));
});

test("OpenCode resolves session scope before fallback and rejects a lookup that finishes after its deadline", async (t) => {
  let finish!: (value: { id: string; location: { directory: string } }) => void;
  let started!: () => void;
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  let first = true;
  const h = await host(t, async () => context("native"), {
    directory: "C:/fallback",
    lookup: async () => {
      if (!first) return { id: "s", location: { directory: "C:/current-native" } };
      first = false;
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = h.prompt("late-scope");
  await reached;
  t.mock.timers.tick(1500);
  await pending;
  finish({ id: "s", location: { directory: "C:/late-native" } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(h.inject(), []);
  await h.prompt("current-scope");
  assert.equal(
    h.requests.find((request) => request.method === "search")?.params.projectDir,
    "C:/current-native",
  );
});

test("OpenCode retains admitted maintained state when optional recall exceeds its deadline", async (t) => {
  const runtime = new SessionActiveGraphRuntime();
  runtime.replaceWorkingState(
    runtime.bindWorkingState("s"),
    "State survives the optional search deadline.",
  );
  let started!: () => void;
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  const h = await host(
    t,
    async () => {
      started();
      return new Promise(() => {});
    },
    { snapshot: () => runtime.snapshot("s") },
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = h.prompt("state-deadline");
  await reached;
  t.mock.timers.tick(1500);
  await pending;
  assert.match(JSON.stringify(h.inject()), /State survives the optional search deadline/);
});

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
  let reached: Promise<void>;
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
