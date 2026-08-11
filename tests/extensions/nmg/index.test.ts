import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import nmgExtension, {
  compactRescueRememberParams,
  compactRescueStatement,
  composeNmgSystemPrompt,
  formatMemoryContext,
  formatSearchHeaders,
  isMemorableToolResult,
  isSuccessfulCommit,
  MEMORY_POLICY,
  PI_BRANCH_SHAPE_VERSION,
  projectPiBranch,
  selectPiEvidenceSource,
  SessionInjectionWindow,
  SessionRecallFlow,
  SessionTaskWindow,
  SessionToolTraceCapture,
  summarizeSessionFragment,
  summarizeToolResult,
  toolTraceRememberParams,
} from "../../../.pi/extensions/nmg/index.ts";
import { loadPrompts } from "../../../src/prompts/load.ts";
import { isProcessAlive, readServerState, serverStatePath } from "../../../src/cli/lifecycle.ts";
import { NmgStore } from "../../../src/core/store.ts";
import type { MemoryContext } from "../../../src/core/types.ts";
import {
  ControllerShadowBridge,
  shadowEnabled,
} from "../../../.pi/extensions/nmg/controller-shadow.ts";

function extensionHarness() {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const tools = new Map<
    string,
    {
      description?: string;
      parameters?: { properties?: Record<string, { description?: string }> };
      execute: (...args: unknown[]) => Promise<unknown>;
    }
  >();
  nmgExtension({
    on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
      handlers.set(event, handler);
    },
    registerTool(tool: {
      name: string;
      description?: string;
      parameters?: { properties?: Record<string, { description?: string }> };
      execute: (...args: unknown[]) => Promise<unknown>;
    }) {
      tools.set(tool.name, tool);
    },
  } as never);
  return { handlers, tools };
}

test("Pi adapter exposes only the stable tool surface", () => {
  assert.deepEqual([...extensionHarness().tools.keys()], ["nmg_remember", "nmg_get", "nmg_search"]);
});

test("PostToolUse registers on tool_result, not the old pre-execution tool_call", () => {
  const { handlers } = extensionHarness();
  assert.equal(handlers.has("tool_result"), true);
  assert.equal(handlers.has("tool_call"), false);
});

test("remember feedback action stays on the stable tool surface and fails closed", async () => {
  const { tools } = extensionHarness();
  const sessionManager = { getSessionId: () => "session-a" };
  await assert.rejects(
    tools
      .get("nmg_remember")!
      .execute("feedback-empty", { action: "feedback", activeGraphId: "graph-a" }, undefined, undefined, {
        sessionManager,
      }),
    /at least one label/u,
  );
  const result = await tools.get("nmg_remember")!.execute(
    "feedback-disabled",
    {
      action: "feedback",
      activeGraphId: "graph-a",
      evidenceSufficient: false,
      semanticTaskId: "task-a",
    },
    undefined,
    undefined,
    { sessionManager },
  ) as { details: { recorded: boolean }; content: Array<{ text: string }> };
  assert.equal(result.details.recorded, false);
  assert.match(result.content[0].text, /not recorded/u);
});

test("controller shadow bridge is opt-in and learns only from explicit get use", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-controller-shadow-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    assert.equal(shadowEnabled(undefined), false);
    assert.equal(shadowEnabled("true"), true);
    const disabled = new ControllerShadowBridge(directory, false);
    const saved = store.remember({ statement: "Atlas uses SQLite", nodeName: "Atlas" });
    const context = store.searchContext("Atlas database", {
      sessionId: "session-a",
      persistTrace: false,
    });
    await disabled.retrieval(context, "session-a", "tool");
    assert.equal(existsSync(join(directory, "controller-shadow-events.jsonl")), false);

    const enabled = new ControllerShadowBridge(directory, true);
    await enabled.retrieval(context, "session-a", "tool", "injected header");
    await enabled.searchSuppressed("wrong-session", "ignored query");
    await enabled.searchSuppressed("session-a", "same query again");
    await enabled.use(
      context.activeGraph!.id,
      "wrong-session",
      [saved.memory.id],
      [saved.memory.id],
    );
    assert.equal(existsSync(join(directory, "controller-shadow-state.json")), false);
    await enabled.use(context.activeGraph!.id, "session-a", [saved.memory.id], [saved.memory.id]);
    const state = JSON.parse(
      readFileSync(join(directory, "controller-shadow-state.json"), "utf8"),
    ) as { observations: number };
    assert.equal(state.observations, 1);
    assert.equal(
      await enabled.feedback(context.activeGraph!.id, "wrong-session", {
        evidenceSufficient: true,
      }),
      false,
    );
    assert.equal(
      await enabled.feedback(context.activeGraph!.id, "session-a", {
        taskSuccess: true,
        evidenceSufficient: true,
        expansionUseful: false,
        excessiveNoise: false,
        noMemoryNeeded: false,
        note: "explicit test label",
      }),
      true,
    );
    await enabled.outcome("session-a", [
      { role: "assistant", usage: { input: 120, output: 30 } },
      { role: "toolResult" },
    ]);
    // A repeated agent_end must not duplicate the same graph outcome.
    await enabled.outcome("session-a", []);
    const events = readFileSync(join(directory, "controller-shadow-events.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(events.length, 5);
    const retrieval = JSON.parse(events[0]!) as {
      type: string;
      costs: { injectedCharacters: number; injectedEstimatedTokens: number };
    };
    assert.equal(retrieval.type, "retrieval");
    assert.equal(retrieval.costs.injectedCharacters, "injected header".length);
    assert.equal(retrieval.costs.injectedEstimatedTokens, 4);
    const flow = JSON.parse(events[1]!) as { type: string; action: string; query: string };
    assert.equal(flow.type, "tool_flow");
    assert.equal(flow.action, "search_suppressed");
    assert.equal(flow.query, "same query again");
    assert.equal(JSON.parse(events[2]!).type, "use");
    const feedback = JSON.parse(events[3]!) as {
      type: string;
      taskSuccess: boolean;
      evidenceSufficient: boolean;
    };
    assert.equal(feedback.type, "feedback");
    assert.equal(feedback.taskSuccess, true);
    assert.equal(feedback.evidenceSufficient, true);
    const outcome = JSON.parse(events[4]!) as {
      type: string;
      toolRounds: number;
      inputTokens: number;
      outputTokens: number;
    };
    assert.equal(outcome.type, "outcome");
    assert.equal(outcome.toolRounds, 1);
    assert.equal(outcome.inputTokens, 120);
    assert.equal(outcome.outputTokens, 30);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Pi evidence projection retains only an exact bounded source excerpt", () => {
  const sessionManager = {
    getSessionId: () => "session-a",
    getBranch: () => [
      {
        type: "message",
        id: "assistant-1",
        message: { role: "assistant", content: "A routine assistant explanation." },
      },
      {
        type: "message",
        id: "user-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "Please remember that Atlas uses SQLite offline." }],
        },
      },
    ],
  };
  assert.deepEqual(selectPiEvidenceSource(sessionManager, "Atlas uses SQLite", "user"), {
    actor: "user",
    content: "Atlas uses SQLite",
    sourceMessageId: "user-1",
    sourceRef: `pi-session:session-a;shape=${PI_BRANCH_SHAPE_VERSION}`,
  });
  assert.equal(selectPiEvidenceSource(sessionManager, "routine assistant", "user"), undefined);
});

test("Pi branch projection fails closed on an incompatible message shape", () => {
  assert.deepEqual(projectPiBranch({ messages: [] }), {
    version: PI_BRANCH_SHAPE_VERSION,
    supported: false,
    messages: [],
  });
  assert.equal(
    projectPiBranch([{ type: "message", id: 42, message: { role: "user", content: "x" } }])
      .supported,
    false,
  );
});

test("tool descriptions come from the prompt source of truth", () => {
  const { tools } = extensionHarness();
  const prompts = loadPrompts();
  assert.equal(tools.get("nmg_search")?.description, prompts.search_description);
  assert.equal(tools.get("nmg_get")?.description, prompts.get_description);
  assert.equal(tools.get("nmg_remember")?.description, prompts.remember_description);
});

test("tool parameter descriptions come from the prompt source of truth", () => {
  const { tools } = extensionHarness();
  const prompts = loadPrompts();
  assert.equal(
    tools.get("nmg_remember")?.parameters?.properties?.stateKey?.description,
    prompts.state_key_parameter_description,
  );
  assert.equal(
    tools.get("nmg_get")?.parameters?.properties?.activeGraphId?.description,
    prompts.active_graph_id_parameter_description,
  );
  assert.equal(
    tools.get("nmg_search")?.parameters?.properties?.query?.description,
    prompts.search_query_parameter_description,
  );
  assert.equal(
    tools.get("nmg_remember")?.parameters?.properties?.evidence?.description,
    prompts.evidence_parameter_description,
  );
  assert.equal(
    tools.get("nmg_remember")?.parameters?.properties?.memoryId?.description,
    prompts.remember_memory_id_parameter_description,
  );
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
  const sessionManager = {
    getSessionId: () => "http-test-session",
    getSessionFile: () => "session.jsonl",
    getBranch: () => [
      {
        type: "message",
        id: "user-atlas-storage",
        message: {
          role: "user",
          content: "Please remember: Atlas must use SQLite for offline operation.",
        },
      },
    ],
  };
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
    ) as {
      content: Array<{ text: string }>;
      details: {
        history: { sourceMessageId: string; content: string };
        memory: { id: string };
      };
    };
    assert.match(remember.content[0].text, /saved/i);
    assert.equal(remember.details.history.sourceMessageId, "user-atlas-storage");
    assert.equal(remember.details.history.content, "Atlas must use SQLite for offline operation.");

    const oldDatabase = await tools.get("nmg_remember")!.execute(
      "remember-old-database",
      {
        statement: "Atlas uses PostgreSQL as its database.",
        nodeName: "Atlas database",
        scope: { project: "atlas" },
      },
      undefined,
      undefined,
      { sessionManager },
    ) as { details: { memory: { id: string } } };
    const newDatabase = await tools.get("nmg_remember")!.execute(
      "remember-new-database",
      {
        statement: "Atlas now uses SQLite as its database.",
        nodeName: "Atlas database",
        scope: { project: "atlas" },
      },
      undefined,
      undefined,
      { sessionManager },
    ) as { content: Array<{ text: string }>; details: { memory: { id: string } } };
    assert.match(newDatabase.content[0].text, /possible older values/i);
    assert.match(newDatabase.content[0].text, /action=supersede/i);
    const resolvedDatabase = await tools.get("nmg_remember")!.execute(
      "resolve-database",
      {
        action: "supersede",
        newMemoryId: newDatabase.details.memory.id,
        supersededMemoryId: oldDatabase.details.memory.id,
        resolutionReason: "The user changed the project database.",
      },
      undefined,
      undefined,
      { sessionManager },
    ) as { details: { applied: boolean } };
    assert.equal(resolvedDatabase.details.applied, true);

    const started = readServerState(serverStatePath(join(directory, "nmg.sqlite")));
    assert.equal(started?.transport, "http");
    assert.equal(isProcessAlive(started!.pid), true);

    const recalled = await handlers.get("before_agent_start")!(
      { prompt: "What storage did we decide last time for Atlas?", systemPrompt: "base" },
      { sessionManager },
    ) as { systemPrompt: string };
    assert.match(recalled.systemPrompt, /Atlas must use SQLite/);
    assert.match(recalled.systemPrompt, /NMG SEARCH HEADERS/);
    assert.match(recalled.systemPrompt, /fields: memory=id/);
    assert.match(recalled.systemPrompt, /matches=storage/);
    assert.doesNotMatch(recalled.systemPrompt, /tier=L\d/);
    assert.doesNotMatch(recalled.systemPrompt, /deepestTier/);
    assert.doesNotMatch(recalled.systemPrompt, /SOURCE=/);
    const recalledAgain = await handlers.get("before_agent_start")!(
      { prompt: "What storage did we decide last time for Atlas?", systemPrompt: "base" },
      { sessionManager },
    ) as { systemPrompt: string };
    assert.match(recalledAgain.systemPrompt, /already_in_context=true/);
    assert.doesNotMatch(recalledAgain.systemPrompt, /Atlas must use SQLite/);
    await handlers.get("session_before_compact")!({}, { sessionManager });
    const recalledAfterCompaction = await handlers.get("before_agent_start")!(
      { prompt: "What storage did we decide last time for Atlas?", systemPrompt: "base" },
      { sessionManager },
    ) as { systemPrompt: string };
    assert.match(recalledAfterCompaction.systemPrompt, /Atlas must use SQLite/);

    // A successful git commit raises the completion nudge for the next turn;
    // a no-op commit (nothing to commit) must not.
    await handlers.get("tool_result")!(
      {
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "[main a1b2c3d] feat: wire SQLite" }],
        input: { command: "git commit -m 'feat' && git push" },
      },
      { sessionManager },
    );
    const nudged = await handlers.get("before_agent_start")!(
      { prompt: "continue", systemPrompt: "base" },
      { sessionManager },
    ) as { systemPrompt: string };
    assert.match(nudged.systemPrompt, /<nmg_nudge>/);
    const noOp = await handlers.get("tool_result")!(
      {
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "nothing to commit, working tree clean" }],
        input: { command: "git commit -am x" },
      },
      { sessionManager },
    );
    assert.equal(noOp, undefined);

    const searched = await tools
      .get("nmg_search")!
      .execute("search", { query: "Atlas database" }, undefined, undefined, { sessionManager }) as {
      content: Array<{ text: string }>;
      details: { activeGraph: { id: string } };
    };
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
      "remember-deep",
      {
        statement: "Atlas archive checksum uses BLAKE3.",
        nodeName: "Atlas archive",
        memoryType: "fact",
        tier: 2,
      },
      undefined,
      undefined,
      { sessionManager },
    );
    const deepSearch = await tools
      .get("nmg_search")!
      .execute("search-deep", { query: "Atlas archive checksum" }, undefined, undefined, {
        sessionManager,
      }) as { content: Array<{ text: string }> };
    assert.match(deepSearch.content[0].text, /BLAKE3/);

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
      }) as { content: Array<{ text: string }> };
    const otherSession = await tools
      .get("nmg_search")!
      .execute("search-stg-other", { query: "scratch color cobalt" }, undefined, undefined, {
        sessionManager: {
          getSessionId: () => "other-session",
          getSessionFile: () => "other.jsonl",
        },
      }) as { content: Array<{ text: string }> };
    assert.match(sameSession.content[0].text, /Session scratch/);
    assert.doesNotMatch(otherSession.content[0].text, /Session scratch/);

    await handlers.get("session_shutdown")!({}, { sessionManager });
    assert.equal(isProcessAlive(started!.pid), false);
    const remaining = readServerState(serverStatePath(join(directory, "nmg.sqlite")));
    assert.equal(remaining ? isProcessAlive(remaining.pid) : false, false);
    const store = new NmgStore(join(directory, "nmg.sqlite"));
    assert.equal(store.getMemory(oldDatabase.details.memory.id)?.status, "superseded");
    try {
      assert.deepEqual(store.retrievalTrace(activeGraphId, "http-test-session")?.usefulMemoryIds, [
        remember.details.memory.id,
      ]);
    } finally {
      // Close the in-process store first so the daemon's SQLite close (WAL
      // checkpoint) is not blocked by our own connection; then shut the owned
      // daemon down before the temp dir is removed.
      store.close();
      await handlers.get("session_shutdown")!({}, { sessionManager }).catch((error) =>
        console.error("session_shutdown error:", error),
      );
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
  assert.match(headers, /NMG memory search results: 1 candidate record/);
  assert.match(headers, /order is not a guarantee of relevance/);
  assert.match(headers, /More ranked records are folded/);
  assert.match(headers, /memory-2/);
  assert.match(headers, /do not repeat nmg_search/);
  assert.match(formatMemoryContext(context), /works offline/);
  assert.match(formatMemoryContext(context), /NMG evidence for 1 selected record/);
  assert.match(formatMemoryContext(context), /More ranked records are folded/);
});

test("search headers close with the nmg_get hint when nothing is deferred", () => {
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
        evidence: { content: "Use SQLite." },
      },
    ],
    progressiveDisclosure: undefined,
  } as never;
  const headers = formatSearchHeaders(context);
  assert.match(headers, /Use nmg_get with selected memory IDs and the activeGraphId/);
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

test("revoked records show metadata but withhold the statement", () => {
  const context = {
    results: [
      {
        memory: {
          id: "memory-revoked",
          statement: "I enjoy modern electronic music festivals.",
          memoryType: "preference",
          tier: 1,
          truthStatus: "asserted",
          scope: {},
          markers: [{ kind: "forget", attributes: { effect: "revoke" } }],
        },
        node: { canonicalName: "Event preferences" },
        evidence: { content: "I enjoy modern electronic music festivals." },
      },
    ],
  } as never;
  const headers = formatSearchHeaders(context);
  // Metadata stays visible (id, node, type, matches); the statement is
  // withheld so the model cannot cite the revoked content.
  assert.match(headers, /memory=memory-revoked/);
  assert.match(headers, /node=Event preferences/);
  assert.match(headers, /type=preference/);
  assert.match(headers, /\(content withdrawn\)/);
  assert.doesNotMatch(headers, /modern electronic music festivals/);
  assert.match(headers, /revocation boundary/);
  // An explicit nmg_get still returns the exact record.
  assert.match(formatMemoryContext(context), /I enjoy modern electronic music festivals/);
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

test("session recall flow requires evidence progression after two searches", () => {
  const flow = new SessionRecallFlow();
  flow.beginTurn("session-a", "first request");
  assert.equal(flow.allowSearch("session-a"), true);
  assert.equal(flow.allowSearch("session-a"), true);
  assert.equal(flow.allowSearch("session-a"), false);

  // Pi emits before_agent_start again after each tool result. The same user
  // prompt must not reset the guard during those internal agent loops.
  flow.beginTurn("session-a", "first request");
  assert.equal(flow.allowSearch("session-a"), false);

  flow.recordGet("session-a");
  assert.equal(flow.allowSearch("session-a"), true);
  flow.beginTurn("session-a", "second request");
  assert.equal(flow.allowSearch("session-a"), true);
});

test("session recall flow isolates and clears session state", () => {
  const flow = new SessionRecallFlow(1);
  flow.beginTurn("session-a", "request");
  flow.beginTurn("session-b", "request");
  assert.equal(flow.allowSearch("session-a"), true);
  assert.equal(flow.allowSearch("session-a"), false);
  assert.equal(flow.allowSearch("session-b"), true);

  flow.clear("session-a");
  assert.equal(flow.allowSearch("session-a"), true);
});

test("session task window carries bounded task context into terse continuations", () => {
  const window = new SessionTaskWindow();
  const first = window.prepare(
    "session-a",
    "Configure the pi-lsp extension to use the vendored language server implementation.",
  );
  assert.match(first!, /pi-lsp extension/u);

  const continuation = window.prepare("session-a", "我 reload 了，你试试");
  assert.match(continuation!, /reload/u);
  assert.match(continuation!, /Recent task context:/u);
  assert.match(continuation!, /vendored language server/u);

  const switched = window.prepare(
    "session-a",
    "Implement and test the unrelated billing export pipeline.",
  );
  assert.doesNotMatch(switched!, /pi-lsp|vendored language server/u);

  assert.equal(window.prepare("session-b", "好的"), null);
});

test("session task window keeps explicit recall and clears session context", () => {
  const window = new SessionTaskWindow();
  window.prepare("session-a", "Implement and test the Atlas SQLite storage adapter.");
  assert.match(window.prepare("session-a", "What did we decide last time?")!, /Atlas SQLite/u);
  window.clear("session-a");
  assert.doesNotMatch(window.prepare("session-a", "What did we decide last time?")!, /Atlas/u);
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
  } as unknown as MemoryContext;
}

test("composeNmgSystemPrompt: injects a completion nudge block when provided", async () => {
  const { composeNmgSystemPrompt } = await import("../../../.pi/extensions/nmg/index.ts");
  const out = composeNmgSystemPrompt("base", "", "", "nudge text");
  assert.match(out, /<nmg_nudge>/);
  assert.match(out, /nudge text/);
  assert.match(out, /<nmg_policy>/);
  // no nudge -> no block
  const plain = composeNmgSystemPrompt("base");
  assert.doesNotMatch(plain, /<nmg_nudge>/);
});

test("git commit nudge is success-aware on tool_result", () => {
  assert.equal(
    isSuccessfulCommit({
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "[main a1b2c3d] feat: wire SQLite" }],
      input: { command: "git commit -m 'feat' && git push" },
    }),
    true,
  );
  // Exit 0 but nothing actually committed: no nudge.
  assert.equal(
    isSuccessfulCommit({
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "nothing to commit, working tree clean" }],
      input: { command: "git commit -am x" },
    }),
    false,
  );
  // A failed commit is not a milestone.
  assert.equal(
    isSuccessfulCommit({
      toolName: "bash",
      isError: true,
      content: [],
      input: { command: "git commit -m x" },
    }),
    false,
  );
  // Non-commit commands never nudge.
  assert.equal(
    isSuccessfulCommit({
      toolName: "bash",
      isError: false,
      content: [],
      input: { command: "npm test" },
    }),
    false,
  );
});

test("tool result filter keeps only memorable outcomes", () => {
  assert.equal(
    isMemorableToolResult({
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "error: cannot find module" }],
      input: { command: "npm run build" },
    }),
    true,
  );
  assert.equal(
    isMemorableToolResult({
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "ok" }],
      input: { command: "ls" },
    }),
    false,
  );
  assert.equal(
    isMemorableToolResult({
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "1 passed, 0 failed" }],
      input: { command: "npm test" },
    }),
    true,
  );
  assert.equal(
    isMemorableToolResult({
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "lots of file content" }],
      input: { path: "src/a.ts" },
    }),
    false,
  );
  assert.equal(
    isMemorableToolResult({
      toolName: "edit",
      isError: false,
      content: [{ type: "text", text: "ok" }],
      input: { path: "src/a.ts" },
    }),
    true,
  );
  assert.equal(
    isMemorableToolResult({
      toolName: "grep",
      isError: false,
      content: [{ type: "text", text: "src/a.ts:1: match" }],
      input: { query: "x" },
    }),
    true,
  );
  assert.equal(
    isMemorableToolResult({
      toolName: "grep",
      isError: false,
      content: [{ type: "text", text: "" }],
      input: { query: "x" },
    }),
    false,
  );
});

test("tool trace statement carries the path and tool node", () => {
  const edit = summarizeToolResult({
    toolName: "edit",
    isError: false,
    content: [],
    input: { path: "src/a.ts" },
  });
  assert.equal(edit.nodeName, "src/a.ts");
  assert.match(edit.statement, /Edited src\/a\.ts/);
  const bash = summarizeToolResult({
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "fatal: boom" }],
    input: { command: "git commit" },
  });
  assert.equal(bash.nodeName, "tool:bash");
  assert.match(bash.statement, /\[error\]/);
});

test("tool trace remember params are low-tier session events with markers", () => {
  const params = toolTraceRememberParams(
    { toolName: "edit", isError: false, content: [], input: { path: "src/a.ts" } },
    "session-a",
    "/project",
  );
  assert.equal(params?.tier, 3);
  assert.equal(params?.importance, 0.1);
  assert.equal(params?.writeReason, "post_tool_use");
  assert.equal(params?.memoryType, "event");
  assert.equal(params?.sourceActor, "system");
  assert.equal(params?.sessionId, "session-a");
  assert.deepEqual(params?.markers, [{ kind: "tool_trace", attributes: { tool: "edit" } }]);
  assert.equal(
    toolTraceRememberParams(
      { toolName: "read", isError: false, content: [], input: {} },
      "s",
      "/p",
    ),
    null,
  );
});

test("tool trace capture dedupes identical statements per session", () => {
  const capture = new SessionToolTraceCapture();
  assert.equal(capture.note("session-a", "bash", "Tool bash: npm test 1 failed"), true);
  assert.equal(capture.note("session-a", "bash", "Tool bash: npm test 1 failed"), false);
  assert.equal(capture.note("session-a", "bash", "Tool bash: npm test 2 passed"), true);
  assert.equal(capture.note("session-b", "bash", "Tool bash: npm test 1 failed"), true);
  capture.clear("session-a");
  assert.equal(capture.note("session-a", "bash", "Tool bash: npm test 1 failed"), true);
});

test("compact rescue statement concatenates doomed messages and truncates", () => {
  const fragment = summarizeSessionFragment([
    { role: "assistant", content: "We decided Atlas uses SQLite with WAL mode." },
    { role: "toolResult", content: [{ type: "text", text: "tests passed" }] },
  ]);
  assert.match(fragment, /assistant: We decided Atlas uses SQLite with WAL mode\./);
  assert.match(fragment, /toolResult: tests passed/);

  const long = compactRescueStatement([{ role: "user", content: "x".repeat(6000) }], 100);
  assert.ok(long.length <= 100);
  assert.match(long, /…$/);
});

test("compact rescue remember params mark the session node and reason", () => {
  const params = compactRescueRememberParams(
    [{ role: "assistant", content: "Decision: use SQLite." }],
    "session-a",
    "/project",
    "threshold",
  );
  assert.equal(params?.nodeName, "session:session-a");
  assert.equal(params?.tier, 2);
  assert.equal(params?.importance, 0.3);
  assert.equal(params?.writeReason, "pre_compact_rescue");
  assert.deepEqual(params?.markers, [
    { kind: "compact_rescue", attributes: { sessionId: "session-a", reason: "threshold" } },
  ]);
  assert.equal(compactRescueRememberParams([], "s", "/p", "manual"), null);
});
