import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import nmgExtension, {
  composeNmgSystemPrompt,
  formatMemoryContext,
  formatSearchHeaders,
  MEMORY_POLICY,
  SessionInjectionWindow,
} from "../../../.pi/extensions/nmg/index.ts";
import { isProcessAlive, readServerState, serverStatePath } from "../../../src/cli/lifecycle.ts";
import { NmgStore } from "../../../src/core/store.ts";
import type { MemoryContext } from "../../../src/core/types.ts";

function extensionHarness() {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  nmgExtension({
    on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
      handlers.set(event, handler);
    },
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      tools.set(tool.name, tool);
    },
  } as never);
  return { handlers, tools };
}

test("Pi adapter exposes only the stable tool surface", () => {
  assert.deepEqual([...extensionHarness().tools.keys()], ["nmg_remember", "nmg_get", "nmg_search"]);
});

test("NMG prompt keeps its policy prefix stable and dynamic recall last", () => {
  const first = composeNmgSystemPrompt("base", "first candidate");
  const second = composeNmgSystemPrompt("base", "second candidate");
  const stablePrefix = `base\n\n${MEMORY_POLICY}\n\n<nmg_automatic_recall>\n`;

  assert.ok(first.startsWith(stablePrefix));
  assert.ok(second.startsWith(stablePrefix));
  assert.match(first, /first candidate\n<\/nmg_automatic_recall>$/);
  assert.match(second, /second candidate\n<\/nmg_automatic_recall>$/);
  assert.match(MEMORY_POLICY, /does not decide answer truth or evidence completeness/);
  assert.match(MEMORY_POLICY, /No useful memory is a valid result/);
  assert.match(MEMORY_POLICY, /unconfirmed assistant proposals/);
});

test("Pi adapter connects, recalls through, and closes its owned HTTP daemon", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-http-"));
  const previous = process.env.NMG_DATA_DIR;
  const previousProject = process.env.NMG_PROJECT_DIR;
  process.env.NMG_DATA_DIR = directory;
  process.env.NMG_PROJECT_DIR = directory;
  const sessionManager = { getSessionId: () => "http-test-session" };
  try {
    const { handlers, tools } = extensionHarness();
    const remember = await tools.get("nmg_remember")!.execute(
      "remember",
      {
        statement: "Atlas must use SQLite for offline operation.",
        nodeName: "Atlas storage",
        memoryType: "constraint",
        sourceActor: "user",
        evidence: "Atlas must use SQLite for offline operation.",
        writeReason: "Durable project constraint",
      },
      undefined,
      undefined,
      { sessionManager },
    );
    assert.match(remember.content[0].text, /saved/i);

    const started = readServerState(serverStatePath(join(directory, "nmg.sqlite")));
    assert.equal(started?.transport, "http");
    assert.equal(isProcessAlive(started!.pid), true);

    const recalled = await handlers.get("before_agent_start")!(
      { prompt: "What storage did we decide last time for Atlas?", systemPrompt: "base" },
      { sessionManager },
    );
    assert.match(recalled.systemPrompt, /Atlas must use SQLite/);
    assert.match(recalled.systemPrompt, /NMG SEARCH HEADERS/);
    assert.match(recalled.systemPrompt, /matches=storage/);
    assert.doesNotMatch(recalled.systemPrompt, /tier=L\d/);
    assert.doesNotMatch(recalled.systemPrompt, /deepestTier/);
    assert.doesNotMatch(recalled.systemPrompt, /SOURCE=/);
    const recalledAgain = await handlers.get("before_agent_start")!(
      { prompt: "What storage did we decide last time for Atlas?", systemPrompt: "base" },
      { sessionManager },
    );
    assert.match(recalledAgain.systemPrompt, /already_in_context=true/);
    assert.doesNotMatch(recalledAgain.systemPrompt, /Atlas must use SQLite/);
    await handlers.get("session_before_compact")!({}, { sessionManager });
    const recalledAfterCompaction = await handlers.get("before_agent_start")!(
      { prompt: "What storage did we decide last time for Atlas?", systemPrompt: "base" },
      { sessionManager },
    );
    assert.match(recalledAfterCompaction.systemPrompt, /Atlas must use SQLite/);

    const searched = await tools
      .get("nmg_search")!
      .execute("search", { query: "Atlas database" }, undefined, undefined, { sessionManager });
    assert.match(searched.content[0].text, /already_in_context=true/);
    const activeGraphId = searched.details.activeGraph.id;
    assert.match(searched.content[0].text, new RegExp(activeGraphId));
    await tools
      .get("nmg_get")!
      .execute(
        "get",
        { memoryIds: [remember.details.memory.id], activeGraphId },
        undefined,
        undefined,
        { sessionManager },
      );

    await tools.get("nmg_remember")!.execute(
      "remember-stg",
      {
        statement: "This session scratch color is cobalt.",
        nodeName: "Session scratch",
        residence: "stg",
      },
      undefined,
      undefined,
      { sessionManager },
    );
    const sameSession = await tools
      .get("nmg_search")!
      .execute("search-stg", { query: "scratch color cobalt" }, undefined, undefined, {
        sessionManager,
      });
    const otherSession = await tools
      .get("nmg_search")!
      .execute("search-stg-other", { query: "scratch color cobalt" }, undefined, undefined, {
        sessionManager: { getSessionId: () => "other-session" },
      });
    assert.match(sameSession.content[0].text, /Session scratch/);
    assert.doesNotMatch(otherSession.content[0].text, /Session scratch/);

    await handlers.get("session_shutdown")!({}, { sessionManager });
    assert.equal(isProcessAlive(started!.pid), false);
    const store = new NmgStore(join(directory, "nmg.sqlite"));
    try {
      assert.deepEqual(store.retrievalTrace(activeGraphId, "http-test-session")?.usefulMemoryIds, [
        remember.details.memory.id,
      ]);
    } finally {
      // Close the in-process store first so the daemon's SQLite close (WAL
      // checkpoint) is not blocked by our own connection; then shut the owned
      // daemon down before the temp dir is removed.
      store.close();
      await handlers
        .get("session_shutdown")!({}, { sessionManager })
        .catch((error) => console.error("session_shutdown error:", error));
    }
  } finally {
    if (previous === undefined) delete process.env.NMG_DATA_DIR;
    else process.env.NMG_DATA_DIR = previous;
    if (previousProject === undefined) delete process.env.NMG_PROJECT_DIR;
    else process.env.NMG_PROJECT_DIR = previousProject;
    // Windows can hold the SQLite handle a moment after the daemon exits;
    // retry, and tolerate a final failure (temp dirs are reclaimed by the OS).
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        rmSync(directory, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 59) {
          console.error(`rmSync left temp dir (Windows handle release): ${directory}`);
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      }
    }
  }
});

test("formatters keep search headers compact and exact evidence separate", () => {
  const context = {
    results: [
      {
        memory: {
          id: "memory-1",
          statement: "Use SQLite.",
          memoryType: "constraint",
          tier: 1,
          truthStatus: "asserted",
          scope: { project: "atlas" },
        },
        node: { canonicalName: "Atlas storage" },
        evidence: { content: "The Atlas project must use SQLite because it works offline." },
      },
    ],
    progressiveDisclosure: {
      strategy: "warm_halves",
      rankedWarmCandidates: 2,
      initiallyVisible: 1,
      deferredMemoryIds: ["memory-2"],
    },
  } as never;
  const headers = formatSearchHeaders(context);
  assert.doesNotMatch(headers, /works offline/);
  assert.match(headers, /L1 continuation/);
  assert.match(headers, /memory-2/);
  assert.match(headers, /do not repeat nmg_search/);
  assert.match(formatMemoryContext(context), /works offline/);
  assert.match(formatMemoryContext(context), /L1 continuation/);
});

test("formatters visibly mark external provenance and trust", () => {
  const context = {
    results: [
      {
        memory: {
          id: "memory-external",
          statement: "A web page reports a release date.",
          memoryType: "fact",
          tier: 1,
          truthStatus: "unverified",
          scope: {},
          markers: [
            {
              kind: "external_source",
              attributes: { source: "web:https://example.com", retrievedAt: "2026-08-01" },
            },
          ],
        },
        node: { canonicalName: "Release date" },
        evidence: { content: "A web page reports a release date." },
      },
    ],
  } as never;
  assert.match(formatSearchHeaders(context), /\[external\]/);
  assert.match(formatMemoryContext(context), /\[external, unverified\]/);
  assert.match(formatMemoryContext(context), /web:https:\/\/example\.com/);
});

test("session injection window folds duplicates but permits deeper disclosure", () => {
  const window = new SessionInjectionWindow();
  const context = memoryContext("memory-1", "Use SQLite.", "SQLite works offline.");
  window.beginTurn("session-a");

  assert.match(window.format("session-a", context, "header"), /Use SQLite/);
  assert.match(window.format("session-a", context, "header"), /already_in_context=true/);
  assert.match(window.format("session-a", context, "evidence"), /SQLite works offline/);
  assert.match(window.format("session-a", context, "exact"), /already_in_context=true/);
  assert.match(window.format("session-b", context, "header"), /Use SQLite/);
});

test("session injection window reinjects changed and expired content", () => {
  const window = new SessionInjectionWindow(2);
  const original = memoryContext("memory-1", "Use SQLite.", "SQLite works offline.");
  window.beginTurn("session-a");
  window.format("session-a", original, "evidence");

  const changed = memoryContext("memory-1", "Use SQLite.", "SQLite also supports local tests.");
  assert.match(window.format("session-a", changed, "evidence"), /local tests/);
  window.beginTurn("session-a");
  window.beginTurn("session-a");
  assert.match(window.format("session-a", changed, "evidence"), /local tests/);
});

function memoryContext(id: string, statement: string, evidence: string): MemoryContext {
  return {
    results: [
      {
        memory: {
          id,
          statement,
          memoryType: "constraint",
          tier: 1,
          truthStatus: "asserted",
          scope: {},
          markers: [],
        },
        node: { canonicalName: "Atlas storage" },
        evidence: { content: evidence },
      },
    ],
  } as MemoryContext;
}
