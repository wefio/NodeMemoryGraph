import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import nmgExtension, {
  applyLearnedFold,
  composeNmgContextMessage,
  composeNmgSystemPrompt,
  controllerBudgetEnvelopes,
  formatMemoryContext,
  formatSearchRecommendation,
  formatSearchHeaders,
  isMemorableToolResult,
  isSuccessfulCommit,
  maybeBroadcastToWorld,
  isBoardWakeCandidate,
  MEMORY_POLICY,
  PI_BRANCH_SHAPE_VERSION,
  projectPiBranch,
  resolvePiEvidenceSource,
  selectPiEvidenceSource,
  SessionInjectionWindow,
  SessionRecallFlow,
  SessionRuntimeAg,
  SessionTaskWindow,
  SKILLOPT_POLICY_CHANNELS,
  summarizeToolResult,
} from "../../../.pi/extensions/nmg/index.ts";
import { loadPrompts } from "../../../src/prompts/load.ts";
import { isProcessAlive, readServerState, serverStatePath } from "../../../src/cli/lifecycle.ts";
import { NmgStore } from "../../../src/core/store.ts";
import type { MemoryContext } from "../../../src/core/types.ts";
import { ControllerRuntime } from "../../../src/lab/controller-runtime.ts";
import { CONTROLLER_FEATURE_PROTOCOL_VERSION } from "../../../src/lab/controller-protocol.ts";
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
  const messageRenderers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
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
    registerMessageRenderer(customType: string, renderer: unknown) {
      messageRenderers.set(customType, renderer);
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
  } as never);
  return { handlers, tools, messageRenderers, commands };
}

test("Pi adapter exposes only the stable tool surface", () => {
  const previous = process.env.NMG_ENABLE_LAB_TOOLS;
  delete process.env.NMG_ENABLE_LAB_TOOLS;
  try {
    assert.deepEqual(
      [...extensionHarness().tools.keys()],
      ["nmg_remember", "nmg_get", "nmg_search", "nmg_board"],
    );
  } finally {
    if (previous === undefined) delete process.env.NMG_ENABLE_LAB_TOOLS;
    else process.env.NMG_ENABLE_LAB_TOOLS = previous;
  }
});

test("Lab reasoning tool persists scratch state and injects it only after compaction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-reasoning-tool-"));
  const previousData = process.env.NMG_DATA_DIR;
  const previousLab = process.env.NMG_ENABLE_LAB_TOOLS;
  process.env.NMG_DATA_DIR = directory;
  process.env.NMG_ENABLE_LAB_TOOLS = "1";
  try {
    const { handlers, tools } = extensionHarness();
    assert.deepEqual(
      [...tools.keys()],
      ["nmg_reason", "nmg_remember", "nmg_get", "nmg_search", "nmg_board"],
    );
    const sessionManager = {
      getSessionId: () => "reasoning-session",
      getSessionFile: () => "reasoning-session.jsonl",
    };
    const added = (await tools.get("nmg_reason")!.execute(
      "reason-add",
      {
        action: "add",
        kind: "hypothesis",
        content: "The cache key may omit the project scope.",
        importance: 0.8,
      },
      undefined,
      undefined,
      { sessionManager },
    )) as { details: { node: { id: string } }; content: Array<{ text: string }> };
    assert.match(added.details.node.id, /^reason_/u);
    assert.match(added.content[0]!.text, /not verified fact/u);
    assert.equal(existsSync(join(directory, "nmg.sqlite")), false);

    const ordinary = (await handlers.get("before_agent_start")!(
      { prompt: "continue", systemPrompt: "base" },
      { sessionManager },
    )) as { message?: { content: string } };
    assert.doesNotMatch(ordinary.message?.content ?? "", /cache key may omit/u);

    await handlers.get("session_before_compact")!({}, { sessionManager });
    const afterCompaction = (await handlers.get("before_agent_start")!(
      { prompt: "continue", systemPrompt: "base" },
      { sessionManager },
    )) as { message?: { content: string } };
    assert.match(afterCompaction.message?.content ?? "", /cache key may omit/u);
    assert.match(
      afterCompaction.message?.content ?? "",
      /auditable scratchpad, not verified fact/u,
    );
    assert.match(
      afterCompaction.message?.content ?? "",
      /hypothesis\/active\/support=unsupported/u,
    );

    const consumed = (await handlers.get("before_agent_start")!(
      { prompt: "continue", systemPrompt: "base" },
      { sessionManager },
    )) as { message?: { content: string } };
    assert.doesNotMatch(consumed.message?.content ?? "", /cache key may omit/u);
    await handlers.get("session_shutdown")!({}, { sessionManager });
  } finally {
    if (previousData === undefined) delete process.env.NMG_DATA_DIR;
    else process.env.NMG_DATA_DIR = previousData;
    if (previousLab === undefined) delete process.env.NMG_ENABLE_LAB_TOOLS;
    else process.env.NMG_ENABLE_LAB_TOOLS = previousLab;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("QPP actuation keeps hard envelopes and learned folds lossless in the Active Graph", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-qpp-actuation-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    for (const [name, statement] of [
      ["alpha", "Project alpha uses SQLite"],
      ["beta", "Project beta uses PostgreSQL"],
      ["gamma", "Project gamma uses files"],
    ] as const) {
      store.remember({ statement, nodeName: name });
    }
    const context = store.searchContext("project storage", {
      limit: 3,
      maxTier: 3,
      persistTrace: false,
    });
    assert.equal(context.results.length, 3);
    const envelopes = controllerBudgetEnvelopes(context);
    assert.equal(envelopes.normalMaximum.maxEvidence, 20);
    assert.equal(envelopes.normalMaximum.maxTokens, 6_000);
    assert.equal(envelopes.expandedMaximum.maxEvidence, 50);
    assert.equal(envelopes.expandedMaximum.maxTokens, 10_000);

    const visibleId = context.results[0]!.memory.id;
    const deferredIds = context.results.slice(1).map((result) => result.memory.id);
    const folded = await applyLearnedFold(
      context,
      {
        fold: async () => ({
          visibleMemoryIds: [visibleId],
          foldedMemoryIds: deferredIds,
          trainingSteps: 1,
        }),
      },
      0.98,
      false,
    );
    assert.deepEqual(
      folded.results.map((result) => result.memory.id),
      [visibleId],
    );
    assert.deepEqual(folded.progressiveDisclosure?.deferredMemoryIds, deferredIds);
    assert.deepEqual(folded.activeGraph?.memoryIds, context.activeGraph?.memoryIds);
    assert.equal(
      (await applyLearnedFold(context, { fold: async () => null }, 0.98, true)).results.length,
      3,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("search recommendation distinguishes advisory from hard guardrails", () => {
  const context = {
    results: [],
    relations: [],
    activeGraph: {
      qpp: {
        trigger: true,
        reason: "below_threshold",
        qpp: 0.42,
      },
    },
  } as unknown as MemoryContext;
  assert.equal(formatSearchRecommendation(context, "off"), "");
  assert.equal(formatSearchRecommendation(context, "guardrail"), "");
  assert.match(formatSearchRecommendation(context, "advisory"), /below_threshold/u);
  context.activeGraph!.qpp!.reason = "guardrail_empty";
  assert.match(formatSearchRecommendation(context, "guardrail"), /guardrail_empty/u);
});

test("TUI registers the nmg-context renderer and the /nmg menu command", () => {
  const { messageRenderers, commands } = extensionHarness();
  assert.ok(
    messageRenderers.has("nmg-context"),
    "nmg-context message renderer should be registered",
  );
  assert.ok(commands.has("nmg"), "/nmg menu command should be registered");
  assert.ok(
    !commands.has("nmg-recall"),
    "standalone nmg-recall command should be folded into /nmg",
  );
});

test("runtime tool-state capture registers on tool_result, not pre-execution tool_call", () => {
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
      .execute(
        "feedback-empty",
        { action: "feedback", activeGraphId: "graph-a" },
        undefined,
        undefined,
        {
          sessionManager,
        },
      ),
    /at least one label/u,
  );
  const result = (await tools.get("nmg_remember")!.execute(
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
  )) as { details: { recorded: boolean }; content: Array<{ text: string }> };
  assert.equal(result.details.recorded, false);
  assert.match(result.content[0].text, /not recorded/u);
});

test("remember cannot attribute an unbound Assistant inference to the user", async () => {
  const { tools } = extensionHarness();
  const sessionManager = {
    getSessionId: () => "session-attribution",
    getBranch: () => [
      {
        type: "message",
        id: "user-question",
        message: { role: "user", content: "Why does this design use an append-only history?" },
      },
    ],
  };
  await assert.rejects(
    tools.get("nmg_remember")!.execute(
      "misattributed-memory",
      {
        statement: "The user requires append-only history for auditability.",
        nodeName: "history policy",
        sourceActor: "user",
        truthStatus: "inferred",
      },
      undefined,
      undefined,
      { sessionManager },
    ),
    /sourceActor=user requires an exact matching evidence excerpt/u,
  );
});

test("controller shadow bridge logs answer attribution without learning from it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-controller-shadow-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  // Isolate the ambient NMG_CONTROLLER_SHADOW: running tests under the
  // sample-collection env (NMG_CONTROLLER_SHADOW=1) must not flip the
  // shadowEnabled(undefined) default assertion.
  const previousShadow = process.env.NMG_CONTROLLER_SHADOW;
  delete process.env.NMG_CONTROLLER_SHADOW;
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
    const envelopes = controllerBudgetEnvelopes(context);
    assert.equal(
      await enabled.allocate(
        context,
        envelopes.minimum,
        envelopes.normalMaximum,
        envelopes.expandedMaximum,
      ),
      null,
      "an untrained controller must not actuate",
    );
    await enabled.retrieval(context, "session-a", "tool", "injected header");
    await enabled.searchSuppressed("wrong-session", "ignored query");
    await enabled.searchSuppressed("session-a", "same query again");
    await enabled.attribution(
      context.activeGraph!.id,
      "wrong-session",
      [saved.memory.id],
      [saved.memory.id],
    );
    assert.equal(existsSync(join(directory, "controller-shadow-state.json")), false);
    await enabled.disclosure(
      context.activeGraph!.id,
      "session-a",
      [saved.memory.id],
      [saved.memory.id],
    );
    assert.equal(
      existsSync(join(directory, "controller-shadow-state.json")),
      false,
      "disclosure alone must not train the controller",
    );
    await enabled.attribution(
      context.activeGraph!.id,
      "session-a",
      [saved.memory.id],
      [saved.memory.id],
    );
    assert.equal(
      existsSync(join(directory, "controller-shadow-state.json")),
      false,
      "answer overlap is diagnostic and must not persist controller state",
    );
    assert.equal(
      await enabled.allocate(
        context,
        envelopes.minimum,
        envelopes.normalMaximum,
        envelopes.expandedMaximum,
      ),
      null,
      "answer overlap must not unlock active allocation",
    );
    assert.equal(
      await enabled.verifiedClaimOutcome(
        context.activeGraph!.id,
        "wrong-session",
        saved.memory.id,
        "supported",
      ),
      false,
    );
    assert.equal(
      await enabled.verifiedClaimOutcome(
        context.activeGraph!.id,
        "session-a",
        saved.memory.id,
        "supported",
      ),
      true,
    );
    assert.equal(
      await enabled.verifiedClaimOutcome(
        context.activeGraph!.id,
        "session-a",
        saved.memory.id,
        "contradicted",
      ),
      true,
    );
    await enabled.outcome("session-a", [
      { role: "assistant", usage: { input: 120, output: 30 } },
      { role: "toolResult" },
    ]);
    assert.equal(enabled.latestActiveGraphId("session-a"), context.activeGraph!.id);
    assert.equal(enabled.latestActiveGraphId("wrong-session"), null);
    assert.deepEqual(enabled.pendingFeedback("session-a"), {
      activeGraphId: context.activeGraph!.id,
      semanticTaskId: context.activeGraph!.taskId,
    });
    assert.equal(enabled.pendingFeedback("session-a"), null, "feedback nudge is one-shot");
    assert.equal(
      enabled.pendingClaimOutcome("session-a"),
      null,
      "an already verified claim outcome must suppress the advisory claim reminder",
    );
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
    // A repeated agent_end must not duplicate the same graph outcome.
    await enabled.outcome("session-a", []);
    const events = readFileSync(join(directory, "controller-shadow-events.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(events.length, 8);
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
    assert.equal(JSON.parse(events[2]!).type, "disclosure");
    assert.equal(JSON.parse(events[3]!).type, "attribution");
    const verifiedPositive = JSON.parse(events[4]!) as {
      type: string;
      method: string;
      attributedMemoryIds: string[];
    };
    assert.equal(verifiedPositive.type, "attribution");
    assert.equal(verifiedPositive.method, "verified_claim_support");
    assert.deepEqual(verifiedPositive.attributedMemoryIds, [saved.memory.id]);
    const verifiedNegative = JSON.parse(events[5]!) as {
      method: string;
      attributedMemoryIds: string[];
    };
    assert.equal(verifiedNegative.method, "verified_claim_support");
    assert.deepEqual(verifiedNegative.attributedMemoryIds, []);
    const outcome = JSON.parse(events[6]!) as {
      type: string;
      toolRounds: number;
      inputTokens: number;
      outputTokens: number;
    };
    assert.equal(outcome.type, "outcome");
    assert.equal(outcome.toolRounds, 1);
    assert.equal(outcome.inputTokens, 120);
    assert.equal(outcome.outputTokens, 30);
    const feedback = JSON.parse(events[7]!) as {
      type: string;
      collectionOrigin: string;
      semanticTaskId: string;
      taskSuccess: boolean;
      evidenceSufficient: boolean;
    };
    assert.equal(feedback.type, "feedback");
    assert.equal(feedback.collectionOrigin, "natural");
    assert.equal(feedback.semanticTaskId, context.activeGraph!.taskId);
    assert.equal(feedback.taskSuccess, true);
    assert.equal(feedback.evidenceSufficient, true);
  } finally {
    if (previousShadow === undefined) delete process.env.NMG_CONTROLLER_SHADOW;
    else process.env.NMG_CONTROLLER_SHADOW = previousShadow;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("trained controller actuation is explicit, bounded, and auditable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-controller-actuation-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    const memories = [
      store.remember({ statement: "Atlas uses SQLite", nodeName: "Atlas" }),
      store.remember({ statement: "Borealis uses PostgreSQL", nodeName: "Borealis" }),
      store.remember({ statement: "Cygnus uses object storage", nodeName: "Cygnus" }),
    ];
    const context = store.searchContext("project storage database", {
      sessionId: "candidate-session",
      limit: 3,
      persistTrace: false,
    });
    const runtime = new ControllerRuntime(join(directory, "controller-shadow-state.json"));
    assert.equal(runtime.observeVerifiedEvidence(context, [memories[2]!.memory.id]), true);

    const bridge = new ControllerShadowBridge(directory, true, 128, "controlled", {
      mode: "controlled",
    });
    const envelopes = controllerBudgetEnvelopes(context);
    assert.ok(
      await bridge.allocate(
        context,
        envelopes.minimum,
        envelopes.normalMaximum,
        envelopes.expandedMaximum,
      ),
    );
    await bridge.rerank(context);

    const actuations = readFileSync(join(directory, "controller-shadow-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            action: string;
            changed: boolean;
            controllerMode: string;
            candidateSha256: string;
            featureProtocolVersion: number;
          },
      );
    assert.deepEqual(
      actuations.map((event) => event.action),
      ["allocate", "rerank"],
    );
    assert.ok(actuations.every((event) => event.type === "actuation"));
    assert.ok(actuations.every((event) => event.controllerMode === "controlled"));
    assert.ok(actuations.every((event) => event.candidateSha256.length === 64));
    assert.ok(
      actuations.every(
        (event) => event.featureProtocolVersion === CONTROLLER_FEATURE_PROTOCOL_VERSION,
      ),
    );
    assert.ok(actuations.some((event) => event.changed));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shadow feedback review selects a disclosed graph instead of a newer header-only graph", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-feedback-selection-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    const bridge = new ControllerShadowBridge(directory, true);
    const saved = store.remember({ statement: "Atlas uses SQLite", nodeName: "Atlas" });
    const used = store.searchContext("Atlas database", {
      sessionId: "session-a",
      persistTrace: false,
    });
    const headerOnly = store.searchContext("Atlas unrelated follow-up", {
      sessionId: "session-a",
      persistTrace: false,
    });
    await bridge.retrieval(used, "session-a", "tool");
    await bridge.disclosure(
      used.activeGraph!.id,
      "session-a",
      [saved.memory.id],
      [saved.memory.id],
    );
    await bridge.retrieval(headerOnly, "session-a", "automatic");
    await bridge.outcome("session-a", []);

    const reminder = bridge.pendingFeedback("session-a");
    assert.deepEqual(reminder, {
      activeGraphId: used.activeGraph!.id,
      semanticTaskId: used.activeGraph!.taskId,
    });
    await bridge.feedbackNudgeShown("session-a", reminder!);
    const claimReminder = bridge.pendingClaimOutcome("session-a");
    assert.deepEqual(claimReminder, {
      activeGraphId: used.activeGraph!.id,
      semanticTaskId: used.activeGraph!.taskId,
      memoryIds: [saved.memory.id],
    });
    assert.equal(bridge.pendingClaimOutcome("session-a"), null, "claim reminder is one-shot");
    await bridge.claimOutcomeNudgeShown("session-a", claimReminder!);
    const events = readFileSync(join(directory, "controller-shadow-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            action?: string;
            reason?: string;
            graphId: string;
          },
      );
    assert.equal(events.at(-2)?.type, "tool_flow");
    assert.equal(events.at(-2)?.graphId, used.activeGraph!.id);
    assert.equal(events.at(-2)?.action, "feedback_nudge_shown");
    assert.equal(events.at(-2)?.reason, "next_user_turn_review");
    assert.equal(events.at(-1)?.type, "tool_flow");
    assert.equal(events.at(-1)?.graphId, used.activeGraph!.id);
    assert.equal(events.at(-1)?.action, "claim_outcome_nudge_shown");
    assert.equal(events.at(-1)?.reason, "next_user_turn_claim_review");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("claim-outcome review requires exact get disclosure, not a search preview", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-exact-disclosure-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    const bridge = new ControllerShadowBridge(directory, true);
    store.remember({ statement: "Atlas uses SQLite", nodeName: "Atlas" });
    const previewOnly = store.searchContext("Atlas database", {
      sessionId: "session-a",
      persistTrace: false,
    });
    await bridge.retrieval(previewOnly, "session-a", "tool", "search preview text");
    await bridge.outcome("session-a", []);

    assert.equal(bridge.pendingClaimOutcome("session-a"), null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Pi injects the advisory claim-outcome review only on the next user turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-claim-review-"));
  const previousData = process.env.NMG_DATA_DIR;
  const previousProject = process.env.NMG_PROJECT_DIR;
  const previousShadow = process.env.NMG_CONTROLLER_SHADOW;
  process.env.NMG_DATA_DIR = directory;
  process.env.NMG_PROJECT_DIR = directory;
  process.env.NMG_CONTROLLER_SHADOW = "1";
  const sessionManager = {
    getSessionId: () => "claim-review-session",
    getSessionFile: () => "session.jsonl",
    getBranch: () => [],
  };
  try {
    const { handlers, tools } = extensionHarness();
    await tools.get("nmg_remember")!.execute(
      "remember-claim-review",
      {
        statement: "Atlas stores durable metadata in SQLite.",
        nodeName: "Atlas storage",
        memoryType: "fact",
        sourceActor: "tool",
        externalSource: { source: "file:test-fixture" },
      },
      undefined,
      undefined,
      { sessionManager },
    );
    const searched = (await tools
      .get("nmg_search")!
      .execute(
        "search-claim-review",
        { query: "Atlas durable metadata SQLite", limit: 5 },
        undefined,
        undefined,
        { sessionManager },
      )) as {
      content: Array<{ text: string }>;
      details: { activeGraph?: { id: string }; results: Array<{ memory: { id: string } }> };
    };
    assert.match(searched.content[0]?.text ?? "", /Atlas stores durable metadata in SQLite/u);
    const disclosedMemoryId = searched.details.results[0]!.memory.id;
    await tools.get("nmg_get")!.execute(
      "get-claim-review",
      { memoryIds: [disclosedMemoryId] },
      undefined,
      undefined,
      { sessionManager },
    );
    await handlers.get("agent_end")!(
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "What database stores Atlas metadata?" }],
          },
          { role: "assistant", content: [{ type: "text", text: "Atlas uses SQLite." }] },
        ],
      },
      { sessionManager },
    );

    const nextTurn = (await handlers.get("before_agent_start")!(
      { prompt: "I have a new observation about Atlas.", systemPrompt: "base" },
      { sessionManager },
    )) as { message?: { content: string } };
    assert.match(nextTurn.message?.content ?? "", /action=claim_outcome/u);
    assert.match(nextTurn.message?.content ?? "", new RegExp(disclosedMemoryId));
    assert.match(nextTurn.message?.content ?? "", /successful tool result/u);
    assert.match(nextTurn.message?.content ?? "", /failed tool output are not claim evidence/u);

    const sameTurnReentry = (await handlers.get("before_agent_start")!(
      { prompt: "I have a new observation about Atlas.", systemPrompt: "base" },
      { sessionManager },
    )) as { message?: { content: string } };
    assert.doesNotMatch(
      sameTurnReentry.message?.content ?? "",
      /previous NMG retrieval.*action=claim_outcome/su,
    );
    await handlers.get("session_shutdown")!({}, { sessionManager });
  } finally {
    process.env.NMG_DATA_DIR = previousData;
    process.env.NMG_PROJECT_DIR = previousProject;
    process.env.NMG_CONTROLLER_SHADOW = previousShadow;
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows can briefly retain daemon handles after shutdown.
    }
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
      {
        type: "message",
        id: "tool-failed",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "The failed probe reported PostgreSQL." }],
          isError: true,
        },
      },
      {
        type: "message",
        id: "tool-success",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "Verified that Atlas uses SQLite offline." }],
          isError: false,
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
  assert.equal(
    selectPiEvidenceSource(sessionManager, "failed probe reported PostgreSQL", "tool"),
    undefined,
    "failed tool output is not attributable claim evidence",
  );
  assert.deepEqual(selectPiEvidenceSource(sessionManager, "Atlas uses SQLite offline", "tool"), {
    actor: "tool",
    content: "Atlas uses SQLite offline",
    sourceMessageId: "tool-success",
    sourceRef: `pi-session:session-a;shape=${PI_BRANCH_SHAPE_VERSION}`,
  });
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

test("Pi evidence resolution versions references and explains degraded provenance", () => {
  const sessionManager = {
    getSessionId: () => "session-a",
    getBranch: () => [{ type: "message", id: 42, message: { role: "user", content: "x" } }],
  };
  assert.deepEqual(resolvePiEvidenceSource(sessionManager, "x", "user"), {
    version: PI_BRANCH_SHAPE_VERSION,
    reason: "incompatible_branch_shape",
  });
  assert.deepEqual(
    resolvePiEvidenceSource(
      { getSessionId: () => "session-a" },
      "model supplied evidence",
      "assistant",
    ),
    {
      version: PI_BRANCH_SHAPE_VERSION,
      reason: "branch_api_unavailable",
    },
  );
});

test("tool descriptions come from the prompt source of truth", () => {
  const { tools } = extensionHarness();
  const prompts = loadPrompts();
  assert.equal(tools.get("nmg_search")?.description, prompts.search_description);
  assert.equal(tools.get("nmg_get")?.description, prompts.get_description);
  assert.equal(tools.get("nmg_remember")?.description, prompts.remember_description);
  assert.equal(tools.get("nmg_board")?.description, prompts.board_description);
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
    tools.get("nmg_remember")?.parameters?.properties?.sourceActor?.description,
    prompts.source_actor_parameter_description,
  );
  assert.equal(
    tools.get("nmg_remember")?.parameters?.properties?.memoryId?.description,
    prompts.remember_memory_id_parameter_description,
  );
  assert.equal(
    tools.get("nmg_board")?.parameters?.properties?.taskId?.description,
    prompts.board_task_id_parameter_description,
  );
});

test("NMG prompt keeps a stable policy prefix; dynamic recall goes to the trailing message", () => {
  const canonical = loadPrompts().memory_policy;
  const first = composeNmgSystemPrompt("base");
  const second = composeNmgSystemPrompt("base");
  const stablePrefix = `base\n\n${MEMORY_POLICY}`;

  assert.equal(first, stablePrefix);
  assert.equal(second, stablePrefix);
  assert.equal(SKILLOPT_POLICY_CHANNELS.agent.text, canonical);
  assert.equal(MEMORY_POLICY, `<nmg_policy>\n${canonical}\n</nmg_policy>`);
  assert.match(MEMORY_POLICY, /does not decide answer truth or evidence completeness/);
  assert.match(MEMORY_POLICY, /No useful memory is a valid result/);
  assert.match(MEMORY_POLICY, /Semantic or topical relevance does not prove/);
  assert.match(MEMORY_POLICY, /unconfirmed assistant proposals/);

  const dynamic = composeNmgContextMessage("first candidate");
  assert.match(dynamic, /<nmg_automatic_recall>\nfirst candidate\n<\/nmg_automatic_recall>$/);
  assert.equal(composeNmgContextMessage(), "");
  // Ordering: recall (head) then runtime AG then nudge, stable prefix untouched.
  const full = composeNmgContextMessage("recall", "", "nudge", "runtime");
  assert.match(full, /<nmg_automatic_recall>\nrecall\n<\/nmg_automatic_recall>/);
  assert.match(full, /<nmg_runtime_ag>\nruntime\n<\/nmg_runtime_ag>/);
  assert.match(full, /<nmg_nudge>\nnudge\n<\/nmg_nudge>/);
});

test("Pi adapter connects, recalls through, and closes its owned HTTP daemon", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-http-"));
  const previous = process.env.NMG_DATA_DIR;
  const previousProject = process.env.NMG_PROJECT_DIR;
  const previousAgent = process.env.NMG_AGENT_ID;
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
    const remember = (await tools.get("nmg_remember")!.execute(
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
    )) as {
      content: Array<{ text: string }>;
      details: {
        history: { sourceMessageId: string; content: string };
        memory: { id: string; writeSource: string };
      };
    };
    assert.match(remember.content[0].text, /saved/i);
    assert.equal(remember.details.history.sourceMessageId, "user-atlas-storage");
    assert.equal(remember.details.history.content, "Atlas must use SQLite for offline operation.");
    assert.equal(remember.details.memory.writeSource, "agent");
    const claimOutcome = (await tools.get("nmg_remember")!.execute(
      "claim-user-evidence",
      {
        action: "claim_outcome",
        memoryId: remember.details.memory.id,
        claimOutcome: "supported",
        claimOutcomeSource: "user",
        semanticTaskId: "task:atlas-storage-confirmation",
        evidence: "Atlas must use SQLite for offline operation.",
      },
      undefined,
      undefined,
      { sessionManager },
    )) as { details: { events: Array<{ evidenceId: string | null }> } };
    assert.ok(claimOutcome.details.events[0]?.evidenceId);

    const degraded = (await tools.get("nmg_remember")!.execute(
      "remember-degraded-provenance",
      {
        statement: "Atlas may benefit from periodic vacuuming.",
        nodeName: "Atlas maintenance",
        sourceActor: "assistant",
        evidence: "Atlas may benefit from periodic vacuuming.",
      },
      undefined,
      undefined,
      { sessionManager },
    )) as {
      details: {
        memory: { markers: Array<{ kind: string; attributes?: Record<string, unknown> }> };
      };
    };
    const degradedMarker = degraded.details.memory.markers.find(
      (marker) => marker.kind === "provenance_degraded",
    );
    assert.deepEqual(degradedMarker?.attributes, {
      historyReferenceVersion: PI_BRANCH_SHAPE_VERSION,
      provider: "pi",
      reason: "exact_excerpt_not_found",
    });

    const oldDatabase = (await tools.get("nmg_remember")!.execute(
      "remember-old-database",
      {
        statement: "Atlas uses PostgreSQL as its database.",
        nodeName: "Atlas database",
        scope: { project: "atlas" },
      },
      undefined,
      undefined,
      { sessionManager },
    )) as { details: { memory: { id: string } } };
    const newDatabase = (await tools.get("nmg_remember")!.execute(
      "remember-new-database",
      {
        statement: "Atlas now uses SQLite as its database.",
        nodeName: "Atlas database",
        scope: { project: "atlas" },
      },
      undefined,
      undefined,
      { sessionManager },
    )) as { content: Array<{ text: string }>; details: { memory: { id: string } } };
    assert.match(newDatabase.content[0].text, /possible older values/i);
    assert.match(newDatabase.content[0].text, /action=supersede/i);
    const resolvedDatabase = (await tools.get("nmg_remember")!.execute(
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
    )) as { details: { applied: boolean } };
    assert.equal(resolvedDatabase.details.applied, true);

    const openDecision = (await tools.get("nmg_remember")!.execute(
      "remember-open-decision",
      {
        statement: "Re-evaluate Atlas storage after the portability test.",
        nodeName: "Atlas storage follow-up",
        resolution: "open",
        relatedMemoryIds: [newDatabase.details.memory.id],
      },
      undefined,
      undefined,
      { sessionManager },
    )) as { details: { memory: { id: string; resolution: string } } };
    assert.equal(openDecision.details.memory.resolution, "open");
    const closedDecision = (await tools.get("nmg_remember")!.execute(
      "resolve-open-decision",
      {
        action: "resolve",
        memoryId: openDecision.details.memory.id,
        resolutionReason: "The portability test passed.",
      },
      undefined,
      undefined,
      { sessionManager },
    )) as { details: { resolution: string } };
    assert.equal(closedDecision.details.resolution, "resolved");
    const reopenedDecision = (await tools.get("nmg_remember")!.execute(
      "reopen-decision",
      {
        action: "reopen",
        memoryId: openDecision.details.memory.id,
        relatedMemoryIds: [newDatabase.details.memory.id],
        resolutionReason: "A new platform requirement appeared.",
      },
      undefined,
      undefined,
      { sessionManager },
    )) as { details: { resolution: string; relatedMemoryIds: string[] } };
    assert.equal(reopenedDecision.details.resolution, "reopened");
    assert.deepEqual(reopenedDecision.details.relatedMemoryIds, [newDatabase.details.memory.id]);

    const started = readServerState(serverStatePath(join(directory, "nmg.sqlite")));
    assert.equal(started?.transport, "http");
    assert.equal(isProcessAlive(started!.pid), true);

    // Identity chain fallback: with no NMG_AGENT_ID, the entry is attributed to
    // the session id (stable within a session) rather than the volatile pid.
    const fallbackAgent = process.env.NMG_AGENT_ID;
    delete process.env.NMG_AGENT_ID;
    const boardPutSession = (await tools.get("nmg_board")!.execute(
      "board-put-session",
      {
        action: "put",
        kind: "note",
        content: "Written with the session-id fallback identity.",
      },
      undefined,
      undefined,
      { sessionManager },
    )) as { details: { entry: { agentId: string; taskId: string } } };
    // No explicit NMG_AGENT_ID and no taskId: the entry is attributed to the
    // session id (fallback identity) and lands on the shared world channel.
    assert.equal(boardPutSession.details.entry.agentId, "http-test-session");
    assert.equal(boardPutSession.details.entry.taskId, "default");
    if (fallbackAgent === undefined) delete process.env.NMG_AGENT_ID;
    else process.env.NMG_AGENT_ID = fallbackAgent;

    process.env.NMG_AGENT_ID = "agent-a";
    const boardPut = (await tools.get("nmg_board")!.execute(
      "board-put",
      {
        action: "put",
        taskId: "atlas-review",
        kind: "handoff",
        content: "Agent B should verify the parser tests.",
      },
      undefined,
      undefined,
      { sessionManager },
    )) as { details: { entry: { id: string; agentId: string } } };
    assert.equal(boardPut.details.entry.agentId, "agent-a");

    process.env.NMG_AGENT_ID = "agent-b";
    const secondSessionManager = {
      ...sessionManager,
      getSessionId: () => "http-test-session-b",
    };
    const boardRead = (await tools
      .get("nmg_board")!
      .execute("board-read", { action: "read", taskId: "atlas-review" }, undefined, undefined, {
        sessionManager: secondSessionManager,
      })) as { content: Array<{ text: string }>; details: { entries: Array<{ id: string }> } };
    assert.deepEqual(
      boardRead.details.entries.map((entry) => entry.id),
      [boardPut.details.entry.id],
    );
    assert.match(boardRead.content[0].text, /Agent B should verify the parser tests/u);
    // Reading writes a delivery receipt for open, non-own-echo entries: session
    // B has now 'read' the handoff, so the wake loop will not re-push it.
    // (Cross-agent feedback, world #9: already-read entries must not re-wake.)
    {
      const store = new NmgStore(join(directory, "nmg.sqlite"));
      try {
        assert.equal(
          store.hasTaskBoardDelivery({
            entryId: boardPut.details.entry.id,
            sessionId: "http-test-session-b",
          }),
          true,
        );
      } finally {
        store.close();
      }
    }
    // Reading the world channel (no taskId) surfaces the lobby directory of
    // active named channels.
    const worldRead = (await tools
      .get("nmg_board")!
      .execute("board-world-read", { action: "read" }, undefined, undefined, {
        sessionManager: secondSessionManager,
      })) as { content: Array<{ text: string }> };
    assert.match(worldRead.content[0].text, /Active named channels/u);
    assert.match(worldRead.content[0].text, /atlas-review/u);
    // Lease-based claiming: agent-b claims the open handoff, a third agent is
    // refused (diagnosed as already claimed), then agent-b releases it back.
    const boardClaim = (await tools
      .get("nmg_board")!
      .execute(
        "board-claim",
        { action: "claim", taskId: "atlas-review", entryId: boardPut.details.entry.id },
        undefined,
        undefined,
        { sessionManager: secondSessionManager },
      )) as { details: { entry: { claimedBy: string | null; claimExpiresAt: string | null } } };
    assert.equal(boardClaim.details.entry.claimedBy, "agent-b");
    assert.ok(boardClaim.details.entry.claimExpiresAt);
    // A third agent is refused (diagnosed as already claimed). Override the
    // env identity so the conflict is not read as the holder heartbeating.
    const wakeAgent = process.env.NMG_AGENT_ID;
    process.env.NMG_AGENT_ID = "agent-c";
    await assert.rejects(
      tools
        .get("nmg_board")!
        .execute(
          "board-claim-conflict",
          { action: "claim", taskId: "atlas-review", entryId: boardPut.details.entry.id },
          undefined,
          undefined,
          {
            sessionManager: { ...secondSessionManager, getSessionId: () => "http-test-session-c" },
          },
        ),
      /already claimed/u,
    );
    if (wakeAgent === undefined) delete process.env.NMG_AGENT_ID;
    else process.env.NMG_AGENT_ID = wakeAgent;
    const boardRelease = (await tools
      .get("nmg_board")!
      .execute(
        "board-release",
        { action: "release", taskId: "atlas-review", entryId: boardPut.details.entry.id },
        undefined,
        undefined,
        { sessionManager: secondSessionManager },
      )) as { details: { entry: { claimedBy: string | null } } };
    assert.equal(boardRelease.details.entry.claimedBy, null);
    // Session-scoped unsubscribe: agent-b opts out of wake notices for the
    // channel (suppression registry, do-not-send).
    const boardUnsubscribe = (await tools
      .get("nmg_board")!
      .execute(
        "board-unsubscribe",
        { action: "unsubscribe", taskId: "atlas-review" },
        undefined,
        undefined,
        { sessionManager: secondSessionManager },
      )) as { content: Array<{ text: string }> };
    assert.match(boardUnsubscribe.content[0].text, /已退出频道 atlas-review/u);
    const boardSubscribe = (await tools
      .get("nmg_board")!
      .execute(
        "board-subscribe",
        { action: "subscribe", taskId: "atlas-review" },
        undefined,
        undefined,
        { sessionManager: secondSessionManager },
      )) as { content: Array<{ text: string }> };
    assert.match(boardSubscribe.content[0].text, /已加入频道 atlas-review/u);
    const boardProjection = (await handlers.get("before_agent_start")!(
      { prompt: "Continue the assigned review.", systemPrompt: "base" },
      { sessionManager: secondSessionManager },
    )) as { message?: { content: string } };
    assert.match(boardProjection.message?.content ?? "", /<nmg_runtime_ag>/u);
    assert.match(boardProjection.message?.content ?? "", /Agent B should verify the parser tests/u);

    const recalled = (await handlers.get("before_agent_start")!(
      { prompt: "What storage did we decide last time for Atlas?", systemPrompt: "base" },
      { sessionManager },
    )) as { systemPrompt: string; message?: { content: string } };
    // Stable prefix: dynamic recall must NOT leak into the system prompt.
    assert.match(recalled.systemPrompt, /^base\n\n<nmg_policy>/);
    assert.doesNotMatch(recalled.systemPrompt, /Atlas must use SQLite/);
    assert.doesNotMatch(recalled.systemPrompt, /NMG SEARCH HEADERS/);
    const recallContent = recalled.message?.content ?? "";
    assert.match(recallContent, /Atlas must use SQLite/);
    assert.match(recallContent, /NMG SEARCH HEADERS/);
    assert.match(recallContent, /fields: memory=id/);
    assert.match(recallContent, /matches=storage/);
    assert.doesNotMatch(recallContent, /tier=L\d/);
    assert.doesNotMatch(recallContent, /deepestTier/);
    assert.doesNotMatch(recallContent, /SOURCE=/);
    const recalledAgain = (await handlers.get("before_agent_start")!(
      { prompt: "What storage did we decide last time for Atlas?", systemPrompt: "base" },
      { sessionManager },
    )) as { systemPrompt: string; message?: { content: string } };
    assert.doesNotMatch(recalledAgain.systemPrompt, /Atlas must use SQLite/);
    assert.match(recalledAgain.message?.content ?? "", /already_in_context=true/);
    assert.doesNotMatch(recalledAgain.message?.content ?? "", /Atlas must use SQLite/);
    await handlers.get("session_before_compact")!({}, { sessionManager });
    const recalledAfterCompaction = (await handlers.get("before_agent_start")!(
      { prompt: "What storage did we decide last time for Atlas?", systemPrompt: "base" },
      { sessionManager },
    )) as { systemPrompt: string; message?: { content: string } };
    assert.match(recalledAfterCompaction.message?.content ?? "", /Atlas must use SQLite/);

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
    const nudged = (await handlers.get("before_agent_start")!(
      { prompt: "continue", systemPrompt: "base" },
      { sessionManager },
    )) as { systemPrompt: string; message?: { content: string } };
    assert.doesNotMatch(nudged.systemPrompt, /<nmg_nudge>/);
    assert.match(nudged.message?.content ?? "", /<nmg_nudge>/);
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
    await handlers.get("tool_result")!(
      {
        toolName: "edit",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        input: { path: "src/storage.ts" },
      },
      { sessionManager },
    );
    const withRuntimeAg = (await handlers.get("before_agent_start")!(
      { prompt: "continue", systemPrompt: "base" },
      { sessionManager },
    )) as { systemPrompt: string; message?: { content: string } };
    assert.doesNotMatch(withRuntimeAg.systemPrompt, /<nmg_runtime_ag>/);
    assert.match(withRuntimeAg.message?.content ?? "", /<nmg_runtime_ag>/);
    assert.match(withRuntimeAg.message?.content ?? "", /Edited src\/storage\.ts/);

    const searched = (await tools
      .get("nmg_search")!
      .execute("search", { query: "Atlas database" }, undefined, undefined, {
        sessionManager,
      })) as {
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
        { memoryIds: [remember.details.memory.id] },
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
    const deepSearch = (await tools
      .get("nmg_search")!
      .execute("search-deep", { query: "Atlas archive checksum" }, undefined, undefined, {
        sessionManager,
      })) as { content: Array<{ text: string }> };
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
    const sameSession = (await tools
      .get("nmg_search")!
      .execute("search-stg", { query: "scratch color cobalt" }, undefined, undefined, {
        sessionManager,
      })) as { content: Array<{ text: string }> };
    const otherSession = (await tools
      .get("nmg_search")!
      .execute("search-stg-other", { query: "scratch color cobalt" }, undefined, undefined, {
        sessionManager: {
          getSessionId: () => "other-session",
          getSessionFile: () => "other.jsonl",
        },
      })) as { content: Array<{ text: string }> };
    assert.match(sameSession.content[0].text, /Session scratch/);
    assert.doesNotMatch(otherSession.content[0].text, /Session scratch/);

    await handlers.get("session_shutdown")!({}, { sessionManager });
    assert.equal(isProcessAlive(started!.pid), false);
    const remaining = readServerState(serverStatePath(join(directory, "nmg.sqlite")));
    assert.equal(remaining ? isProcessAlive(remaining.pid) : false, false);
    const store = new NmgStore(join(directory, "nmg.sqlite"));
    assert.equal(store.getMemory(oldDatabase.details.memory.id)?.status, "superseded");
    assert.equal(
      store
        .exportMemories({ sourceActor: "system" })
        .items.some((item) => item.memory.statement.includes("Edited src/storage.ts")),
      false,
    );
    try {
      const trace = store.retrievalTrace(activeGraphId, "http-test-session");
      assert.deepEqual(trace?.disclosedMemoryIds, [remember.details.memory.id]);
      assert.deepEqual(trace?.usefulMemoryIds, []);
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
    if (previousAgent === undefined) delete process.env.NMG_AGENT_ID;
    else process.env.NMG_AGENT_ID = previousAgent;
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

test("remember from a board source attaches a board_origin marker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-board-origin-"));
  const previous = process.env.NMG_DATA_DIR;
  const previousProject = process.env.NMG_PROJECT_DIR;
  process.env.NMG_DATA_DIR = directory;
  process.env.NMG_PROJECT_DIR = directory;
  const sessionManager = {
    getSessionId: () => "board-test-session",
    getSessionFile: () => "session.jsonl",
    getBranch: () => [],
  };
  try {
    const { handlers, tools } = extensionHarness();
    const saved = (await tools.get("nmg_remember")!.execute(
      "remember-board-sourced",
      {
        statement: "Atlas pins SQLite for offline operation (board decision).",
        nodeName: "Atlas storage",
        memoryType: "constraint",
        boardSource: { taskId: "board-origin-test-2026-08-12", entryId: "entry-42" },
      },
      undefined,
      undefined,
      { sessionManager },
    )) as { details: { memory: { id: string } } };
    const store = new NmgStore(join(directory, "nmg.sqlite"));
    try {
      const memory = store.getMemory(saved.details.memory.id);
      assert.ok(memory, "board-sourced memory persisted");
      const marker = memory.markers.find((candidate) => candidate.kind === "board_origin");
      assert.ok(marker, "board_origin marker attached");
      assert.equal(marker.attributes?.taskId, "board-origin-test-2026-08-12");
      assert.equal(marker.attributes?.entryId, "entry-42");
    } finally {
      store.close();
    }
    await handlers.get("session_shutdown")!({}, { sessionManager });
  } finally {
    process.env.NMG_DATA_DIR = previous;
    process.env.NMG_PROJECT_DIR = previousProject;
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test("agent_end derives and persists answer-overlap attribution on the trace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-agent-end-use-"));
  const previous = process.env.NMG_DATA_DIR;
  const previousProject = process.env.NMG_PROJECT_DIR;
  process.env.NMG_DATA_DIR = directory;
  process.env.NMG_PROJECT_DIR = directory;
  const sessionManager = {
    getSessionId: () => "agent-end-session",
    getSessionFile: () => "session.jsonl",
    getBranch: () => [],
  };
  try {
    const { handlers, tools } = extensionHarness();
    await tools.get("nmg_remember")!.execute(
      "remember-qpp",
      {
        statement: "Atlas pins SQLite for offline operation.",
        nodeName: "Atlas storage",
        memoryType: "constraint",
      },
      undefined,
      undefined,
      { sessionManager },
    );
    const searched = (await tools
      .get("nmg_search")!
      .execute("search-qpp", { query: "Atlas offline storage" }, undefined, undefined, {
        sessionManager,
      })) as {
      details: {
        results: Array<{ memory: { id: string } }>;
        activeGraph?: { id: string };
      };
    };
    assert.ok(searched.details.activeGraph, "search built an active graph");
    // The final answer restates the memory's content -> deriveAnswerOverlapMemoryIds
    // should attribute that memory by answer overlap when agent_end fires.
    await handlers.get("agent_end")!(
      {
        messages: [
          { role: "user", content: "Which storage does Atlas use offline?" },
          { role: "assistant", content: "Atlas pins SQLite for offline operation." },
        ],
      },
      { sessionManager },
    );
    const store = new NmgStore(join(directory, "nmg.sqlite"));
    try {
      const trace = store.retrievalTrace(searched.details.activeGraph!.id, "agent-end-session");
      assert.ok(trace, "trace exists");
      assert.ok(
        trace.attributedMemoryIds.includes(searched.details.results[0].memory.id),
        "memory surfaced in the answer is recorded as heuristic attribution",
      );
      assert.deepEqual(trace.usefulMemoryIds, [], "answer overlap is not verified evidence");
    } finally {
      store.close();
    }
    await handlers.get("session_shutdown")!({}, { sessionManager });
  } finally {
    process.env.NMG_DATA_DIR = previous;
    process.env.NMG_PROJECT_DIR = previousProject;
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test("Chinese automatic recall reaches diagnostic answer attribution and the shadow log", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-auto-use-"));
  const previousData = process.env.NMG_DATA_DIR;
  const previousProject = process.env.NMG_PROJECT_DIR;
  const previousShadow = process.env.NMG_CONTROLLER_SHADOW;
  process.env.NMG_DATA_DIR = directory;
  process.env.NMG_PROJECT_DIR = directory;
  process.env.NMG_CONTROLLER_SHADOW = "1";
  const sessionManager = {
    getSessionId: () => "automatic-use-session",
    getSessionFile: () => "session.jsonl",
    getBranch: () => [
      {
        type: "message",
        id: "user-chinese-preference",
        message: {
          role: "user",
          content: "我偏好中文解释，并希望保留精确的技术细节。",
        },
      },
    ],
  };
  try {
    const { handlers, tools } = extensionHarness();
    const saved = (await tools.get("nmg_remember")!.execute(
      "remember-auto-use",
      {
        statement: "用户偏好中文解释，并希望保留精确的技术细节。",
        nodeName: "用户讲解偏好",
        memoryType: "constraint",
        sourceActor: "user",
        externalSource: { source: "file:test-fixture" },
      },
      undefined,
      undefined,
      { sessionManager },
    )) as { details: { memory: { id: string } } };
    const recalled = (await handlers.get("before_agent_start")!(
      {
        prompt: "你还记得我偏好中文解释吗？",
        systemPrompt: "base",
      },
      { sessionManager },
    )) as { message?: { content: string } };
    assert.match(recalled.message?.content ?? "", /用户偏好中文解释/u);

    const claimOutcome = (await tools.get("nmg_remember")!.execute(
      "claim-outcome-latest",
      {
        action: "claim_outcome",
        memoryId: saved.details.memory.id,
        claimOutcome: "supported",
        claimOutcomeSource: "user",
        semanticTaskId: "task:user-pref-confirmation",
        evidence: "我偏好中文解释，并希望保留精确的技术细节。",
      },
      undefined,
      undefined,
      { sessionManager },
    )) as {
      details: {
        events: Array<{ memoryId: string; outcome: string; sourceLineage: string }>;
        posteriors: Array<{ memoryId: string; independentVoteCount: number }>;
      };
    };
    assert.deepEqual(
      claimOutcome.details.events.map((event) => ({
        memoryId: event.memoryId,
        outcome: event.outcome,
        sourceLineage: event.sourceLineage,
      })),
      [
        {
          memoryId: saved.details.memory.id,
          outcome: "supported",
          sourceLineage: "user-chinese-preference",
        },
      ],
    );
    assert.equal(claimOutcome.details.posteriors[0]?.independentVoteCount, 1);
    await tools.get("nmg_remember")!.execute(
      "claim-outcome-task-only",
      {
        action: "claim_outcome",
        memoryId: saved.details.memory.id,
        claimOutcome: "supported",
        claimOutcomeSource: "task",
        claimSourceLineage: "task:model-authored-observation",
        semanticTaskId: "task:model-authored-observation",
      },
      undefined,
      undefined,
      { sessionManager },
    );
    await assert.rejects(
      tools.get("nmg_remember")!.execute(
        "claim-outcome-unbound-user",
        {
          action: "claim_outcome",
          memoryId: saved.details.memory.id,
          claimOutcome: "supported",
          claimOutcomeSource: "user",
          claimSourceLineage: "invented-message-id",
          semanticTaskId: "task:unbound-user-vote",
        },
        undefined,
        undefined,
        { sessionManager },
      ),
      /exact matching evidence excerpt/u,
    );

    await handlers.get("agent_end")!(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "你还记得我偏好中文解释吗？",
              },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "我会使用中文解释，并保留精确的技术细节。" }],
          },
        ],
      },
      { sessionManager },
    );

    const feedback = (await tools.get("nmg_remember")!.execute(
      "feedback-latest",
      {
        action: "feedback",
        evidenceSufficient: true,
        expansionUseful: false,
        excessiveNoise: false,
        noMemoryNeeded: false,
      },
      undefined,
      undefined,
      { sessionManager },
    )) as { details: { recorded: boolean; activeGraphId: string } };
    assert.equal(feedback.details.recorded, true);
    assert.ok(feedback.details.activeGraphId);

    const events = readFileSync(join(directory, "controller-shadow-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            origin?: string;
            method?: string;
            attributedMemoryIds?: string[];
          },
      );
    assert.ok(events.some((event) => event.type === "retrieval" && event.origin === "automatic"));
    assert.ok(
      events.some(
        (event) =>
          event.type === "attribution" &&
          event.method === "verified_claim_support" &&
          event.attributedMemoryIds?.includes(saved.details.memory.id),
      ),
      "an attributable user outcome supervises the exact automatically recalled memory",
    );
    assert.equal(
      events.filter(
        (event) => event.type === "attribution" && event.method === "verified_claim_support",
      ).length,
      1,
      "a model-authored task outcome does not silently create another verified target",
    );
    assert.ok(
      events.some((event) => event.type === "attribution" && event.method === "answer_overlap"),
      "agent-end answer overlap remains a separate diagnostic event",
    );
    assert.equal(
      existsSync(join(directory, "controller-shadow-state.json")),
      false,
      "API answer overlap must not train or persist the differentiable controller",
    );
    await handlers.get("session_shutdown")!({}, { sessionManager });
  } finally {
    process.env.NMG_DATA_DIR = previousData;
    process.env.NMG_PROJECT_DIR = previousProject;
    process.env.NMG_CONTROLLER_SHADOW = previousShadow;
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows can briefly retain daemon handles after shutdown.
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

test("formatters mark unresolved and reopened memories as open", () => {
  const context = {
    results: [
      {
        memory: {
          id: "memory-open",
          statement: "Verify Atlas portability.",
          memoryType: "event",
          tier: 1,
          truthStatus: "asserted",
          resolution: "reopened",
          scope: { project: "atlas" },
        },
        node: { canonicalName: "Atlas portability" },
        evidence: { content: "Verify Atlas portability." },
      },
    ],
  } as never;
  assert.match(formatSearchHeaders(context), /\[open\].*memory=memory-open/);
  assert.match(formatMemoryContext(context), /\[open\] Verify Atlas portability/);
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
  assert.equal(flow.beginTurn("session-a", "first request"), true);
  assert.equal(flow.allowSearch("session-a"), true);
  flow.recordSearch("session-a", ["memory-1"]);
  assert.equal(flow.allowSearch("session-a"), true);
  flow.recordSearch("session-a", ["memory-2"]);
  assert.equal(flow.allowSearch("session-a"), false);
  assert.equal(flow.searchBlockReason("session-a"), "evidence_progression_required");

  // Pi emits before_agent_start again after each tool result. The same user
  // prompt must not reset the guard during those internal agent loops.
  assert.equal(flow.beginTurn("session-a", "first request"), false);
  assert.equal(flow.allowSearch("session-a"), false);

  assert.equal(flow.allowGet("session-a"), true);
  flow.recordGet("session-a", ["memory-1"]);
  assert.equal(flow.allowSearch("session-a"), true);
  assert.equal(flow.beginTurn("session-a", "second request"), true);
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

test("session recall flow stops repeated candidates and enforces a hard tool budget", () => {
  const noGain = new SessionRecallFlow(2, 5, 6, 2);
  noGain.beginTurn("session-a", "request");
  assert.equal(noGain.allowSearch("session-a"), true);
  noGain.recordSearch("session-a", ["memory-1"]);
  assert.equal(noGain.allowGet("session-a"), true);
  noGain.recordGet("session-a", ["memory-1"]);
  assert.equal(noGain.allowSearch("session-a"), true);
  noGain.recordSearch("session-a", ["memory-1"]);
  assert.equal(noGain.allowSearch("session-a"), true);
  noGain.recordSearch("session-a", ["memory-1"]);
  assert.equal(noGain.allowSearch("session-a"), false);
  assert.equal(noGain.searchBlockReason("session-a"), "no_new_evidence");

  const hardCap = new SessionRecallFlow(3, 4, 4, 4);
  hardCap.beginTurn("session-b", "request");
  assert.equal(hardCap.allowGet("session-b"), true);
  hardCap.recordGet("session-b", ["memory-1"]);
  assert.equal(hardCap.allowGet("session-b"), true);
  hardCap.recordGet("session-b", ["memory-2"]);
  assert.equal(hardCap.allowSearch("session-b"), true);
  hardCap.recordSearch("session-b", ["memory-3"]);
  assert.equal(hardCap.allowGet("session-b"), true);
  hardCap.recordGet("session-b", ["memory-3"]);
  assert.equal(hardCap.allowGet("session-b"), false);
  assert.equal(hardCap.searchBlockReason("session-b"), "recall_tool_budget_exhausted");
});

test("session task window carries bounded task context into terse continuations", () => {
  const window = new SessionTaskWindow();
  const first = window.prepare(
    "session-a",
    "Configure the pi-lsp extension to use the vendored language server implementation.",
  );
  assert.equal(first, null, "ordinary implementation work does not preload long-term memory");

  const continuation = window.prepare("session-a", "我 reload 了，你试试");
  assert.match(continuation!.query, /reload/u);
  assert.match(continuation!.query, /Recent task context:/u);
  assert.match(continuation!.query, /vendored language server/u);
  assert.equal(continuation!.reason, "task_continuation");

  const switched = window.prepare(
    "session-a",
    "Implement and test the unrelated billing export pipeline.",
  );
  assert.equal(switched, null);

  assert.equal(window.prepare("session-b", "好的"), null);
});

test("session task window keeps explicit recall and clears session context", () => {
  const window = new SessionTaskWindow();
  window.prepare("session-a", "Implement and test the Atlas SQLite storage adapter.");
  assert.match(
    window.prepare("session-a", "What did we decide last time?")!.query,
    /Atlas SQLite/u,
  );
  window.clear("session-a");
  assert.doesNotMatch(
    window.prepare("session-a", "What did we decide last time?")!.query,
    /Atlas/u,
  );
});

test("session task window applies the memory gate to ordinary, cue, and recall prompts", () => {
  const window = new SessionTaskWindow();
  assert.equal(window.prepare("session-a", "Explain how acquireFileLock works."), null);

  const cue = window.prepare("session-a", "How should we plan the next release?");
  assert.equal(cue?.mode, "cue");
  assert.equal(cue?.limit, 5);
  assert.equal(cue?.graphHops, 0);

  const recall = window.prepare("session-a", "What did we decide last time?");
  assert.equal(recall?.mode, "retrieve");
  assert.equal(recall?.limit, 12);
  assert.equal(recall?.graphHops, 1);
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

test("composeNmgContextMessage: injects a completion nudge block when provided", async () => {
  const { composeNmgContextMessage, composeNmgSystemPrompt } =
    await import("../../../.pi/extensions/nmg/index.ts");
  const out = composeNmgContextMessage("", "", "nudge text");
  assert.match(out, /<nmg_nudge>/);
  assert.match(out, /nudge text/);
  // no nudge -> no block
  const plain = composeNmgContextMessage("");
  assert.doesNotMatch(plain, /<nmg_nudge>/);
  // the stable system prompt never carries the nudge
  const sys = composeNmgSystemPrompt("base");
  assert.match(sys, /<nmg_policy>/);
  assert.doesNotMatch(sys, /<nmg_nudge>/);
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

test("runtime AG dedupes, bounds, isolates, and clears session tool state", () => {
  const runtime = new SessionRuntimeAg(2, 80);
  assert.equal(runtime.note("session-a", "bash", "Tool bash: first failure"), true);
  assert.equal(runtime.note("session-a", "bash", "Tool bash: first failure"), false);
  assert.equal(runtime.note("session-a", "edit", "Edited src/a.ts."), true);
  assert.equal(runtime.format("session-a"), "");
  runtime.activateProjection("session-a");
  assert.match(runtime.format("session-a"), /first failure/);
  assert.match(runtime.format("session-a"), /Edited src\/a\.ts/);

  runtime.note("session-a", "bash", "Tool bash: latest test passed");
  assert.doesNotMatch(runtime.format("session-a"), /first failure/);
  assert.match(runtime.format("session-a"), /latest test passed/);
  assert.equal(runtime.format("session-b"), "");

  runtime.clear("session-a");
  assert.equal(runtime.format("session-a"), "");
});

test("runtime AG is presented as temporary state after durable recall", () => {
  const output = composeNmgContextMessage(
    "durable recall",
    "",
    "",
    "Session-local tool state (temporary; not durable memory):\n- tests passed",
  );
  assert.match(output, /<nmg_automatic_recall>\ndurable recall/);
  assert.match(output, /<nmg_runtime_ag>/);
  assert.match(output, /temporary; not durable memory/);
  assert.ok(output.indexOf("durable recall") < output.indexOf("Session-local tool state"));
});

test("/nmg with no arguments opens the interactive select menu", async () => {
  const { commands } = extensionHarness();
  const nmgCommand = commands.get("nmg") as {
    handler: (
      args: string,
      ctx: {
        hasUI: boolean;
        ui: {
          select: (...args: unknown[]) => Promise<unknown>;
          input: (...args: unknown[]) => Promise<unknown>;
          notify: (...args: unknown[]) => void;
        };
      },
    ) => Promise<void>;
  };
  assert.ok(nmgCommand, "/nmg command should be registered");
  const selectedTitles: string[] = [];
  const notified: string[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      select: async (title: string) => {
        selectedTitles.push(title);
        return "召回：折叠/展开";
      },
      input: async () => "5",
      notify: (message: string) => {
        notified.push(message);
      },
    },
  };
  await nmgCommand.handler("", ctx);
  assert.deepEqual(selectedTitles, ["NMG 控制台"]);
  assert.ok(
    notified.some((message) => /召回/.test(message)),
    "recall toggle should notify",
  );
});

test("/nmg wake parameter flow writes the config file via the menu", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "nmg-wake-menu-"));
  const previous = process.env.NMG_DATA_DIR;
  process.env.NMG_DATA_DIR = dataDir;
  try {
    const { commands } = extensionHarness();
    const nmgCommand = commands.get("nmg") as {
      handler: (
        args: string,
        ctx: {
          hasUI: boolean;
          ui: {
            select: (title: string, options: string[]) => Promise<unknown>;
            input: () => Promise<unknown>;
            notify: (...args: unknown[]) => void;
          };
        },
      ) => Promise<void>;
    };
    const ctx = {
      hasUI: true,
      ui: {
        select: async (title: string, options: string[]) => {
          if (title === "NMG 控制台") return "唤醒：参数设置";
          if (title === "唤醒参数") return "每日上限";
          if (title === "每日唤醒上限") return "3/天";
          return options[0];
        },
        input: async () => "5",
        notify: () => {},
      },
    };
    await nmgCommand.handler("", ctx);
    const config = JSON.parse(readFileSync(join(dataDir, "board-wake.json"), "utf8")) as {
      budget: number;
    };
    assert.equal(config.budget, 3);
  } finally {
    if (previous === undefined) delete process.env.NMG_DATA_DIR;
    else process.env.NMG_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("world-channel pull broadcast posts once and dedups per entry", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let delivered = false;
  const mockInvoke = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (params.action === "deliveryCheck") {
      return {
        action: "deliveryCheck",
        delivered: delivered ? ["entry-1"] : [],
        suppressed: false,
      };
    }
    if (params.action === "put") {
      return { action: "put", entry: { id: "broadcast-1" } };
    }
    if (params.action === "recordDelivery") {
      delivered = true;
      return { action: "recordDelivery", recorded: true };
    }
    throw new Error(`unexpected invoke ${method} ${JSON.stringify(params)}`);
  };
  const entry = {
    id: "entry-1",
    sequence: 3,
    agentId: "other-agent",
    kind: "question",
    status: "open",
    content: "谁能帮忙？",
    createdAt: "2026-01-01T00:00:00.000Z",
    taskId: "task-x",
  };
  const posted = await maybeBroadcastToWorld({
    invoke: mockInvoke as (method: string, params: unknown) => Promise<unknown>,
    entry,
    agentId: "me",
    sessionId: "sess-1",
  });
  assert.equal(posted, true);
  const put = calls.find((call) => call.params.action === "put")!;
  assert.equal(put.params.kind, "handoff");
  assert.match(String(put.params.content), /协作广播/u);
  assert.equal(put.params.sourceSessionId, "sess-1");
  assert.equal(put.params.ttlSeconds, 86_400, "broadcast is transient (RAII TTL)");
  const recorded = calls.find((call) => call.params.action === "recordDelivery")!;
  assert.equal(recorded.params.sessionId, "world-broadcast");
  assert.equal(recorded.params.entryId, "entry-1");
  // Already broadcast (deliveryCheck reports the sentinel receipt) → no second post.
  const again = await maybeBroadcastToWorld({
    invoke: mockInvoke as (method: string, params: unknown) => Promise<unknown>,
    entry,
    agentId: "me",
    sessionId: "sess-1",
  });
  assert.equal(again, false);
  assert.equal(calls.filter((call) => call.params.action === "put").length, 1);
});

test("a broadcast entry is never re-broadcast (no broadcast storm)", async () => {
  let invoked = 0;
  const mockInvoke = async () => {
    invoked += 1;
    return { delivered: [] };
  };
  const broadcastEntry = {
    id: "broadcast-1",
    sequence: 12,
    agentId: "other-agent",
    kind: "handoff",
    status: "open",
    content: "[NMG board 协作广播] 频道 task-x 有 #1 未认领的交接（open）：…",
    createdAt: "2026-01-01T00:00:00.000Z",
    taskId: "default",
  };
  const posted = await maybeBroadcastToWorld({
    invoke: mockInvoke as (method: string, params: unknown) => Promise<unknown>,
    entry: broadcastEntry,
    agentId: "me",
    sessionId: "sess-1",
  });
  assert.equal(posted, false);
  assert.equal(invoked, 0, "no daemon calls for a broadcast entry");
});

test("/nmg wake world toggle is reachable from the interactive menu", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "nmg-wake-world-"));
  const previous = process.env.NMG_DATA_DIR;
  process.env.NMG_DATA_DIR = dataDir;
  try {
    const { commands } = extensionHarness();
    const nmgCommand = commands.get("nmg") as {
      handler: (
        args: string,
        ctx: {
          hasUI: boolean;
          ui: {
            select: (title: string, options: string[]) => Promise<unknown>;
            input: () => Promise<unknown>;
            notify: (...args: unknown[]) => void;
          };
        },
      ) => Promise<void>;
    };
    const ctx = {
      hasUI: true,
      ui: {
        select: async (title: string, options: string[]) => {
          if (title === "NMG 控制台") return "唤醒：世界广播（当前 关）";
          if (title === "世界频道协作广播") return "开启";
          return options[0];
        },
        input: async () => "",
        notify: () => {},
      },
    };
    await nmgCommand.handler("", ctx);
    const config = JSON.parse(readFileSync(join(dataDir, "board-wake.json"), "utf8")) as {
      worldBroadcast: boolean;
    };
    assert.equal(config.worldBroadcast, true);
  } finally {
    if (previous === undefined) delete process.env.NMG_DATA_DIR;
    else process.env.NMG_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("isBoardWakeCandidate: live claim suppresses nudges, lapsed claim returns to pool (no starvation)", () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const base = {
    id: "entry-1",
    sequence: 1,
    agentId: "other",
    sourceSessionId: "other-sess",
    kind: "handoff",
    status: "open",
    content: "Any taker?",
  };
  const wake = (overrides: Record<string, unknown>) =>
    isBoardWakeCandidate({ ...base, ...overrides } as Parameters<typeof isBoardWakeCandidate>[0], {
      sessionId: "me-sess",
      agentId: "me",
      now,
    });
  // Unclaimed open entry from another session: wake.
  assert.equal(wake({}), true);
  // Notify-only kinds are silent: a note/result/decision/goal records a fact
  // and owes no reply — waking on it is the acknowledgement storm (four
  // agents confirming one fact each emit a note, and every note wakes every
  // subscriber). Read on demand, never pushed.
  for (const kind of ["note", "result", "decision", "goal"]) {
    assert.equal(wake({ kind }), false, `${kind} must be silent`);
  }
  // Actionable kinds wake: question/blocker/handoff ask for a response.
  for (const kind of ["question", "blocker", "handoff"]) {
    assert.equal(wake({ kind }), true, `${kind} must wake`);
  }
  // Own echo: never wake yourself.
  assert.equal(wake({ sourceSessionId: "me-sess" }), false);
  // Resolved: no wake.
  assert.equal(wake({ status: "resolved" }), false);
  // Broadcast pull announcement: meta, no wake (subscription-leak fix).
  assert.equal(
    wake({ content: "[NMG board 协作广播] 频道 x 有 #1 未认领的交接（open）：…" }),
    false,
  );
  // Live claim by someone else: they are working it — no nudge for anyone.
  assert.equal(wake({ claimedBy: "other", claimExpiresAt: "2026-08-13T13:00:00.000Z" }), false);
  // Live claim by THIS agent: holder knows, no self-nudge.
  assert.equal(wake({ claimedBy: "me", claimExpiresAt: "2026-08-13T13:00:00.000Z" }), false);
  // Lapsed claim by someone else: lease expired, entry returns to the pool — wake.
  assert.equal(wake({ claimedBy: "other", claimExpiresAt: "2026-08-13T11:00:00.000Z" }), true);
  // Lapsed claim by THIS agent (the starvation case from the audit): the holder
  // crashed/stopped and the lease lapsed; without liveness the entry would be
  // permanently hidden from its former holder until TTL. Must wake.
  assert.equal(wake({ claimedBy: "me", claimExpiresAt: "2026-08-13T11:00:00.000Z" }), true);
  // Legacy row with no claim expiry (claim fields absent): treat as unclaimed.
  assert.equal(wake({ claimedBy: "me", claimExpiresAt: null }), true);
  // Directed delivery (find→direct): addressed to another stable agent_name —
  // never wake me; I read-but-stay-silent.
  assert.equal(wake({ to: "other" }), false);
  // Directed to me: I am the addressee — wake.
  assert.equal(wake({ to: "me" }), true);
  // Reply-gated serial handoff: a pending actionable is queued behind the
  // outstanding one ("回复=接手" — it promotes on claim/resolve) — no wake.
  assert.equal(wake({ serialState: "pending" }), false);
  // The outstanding actionable is the serial slot being worked — wake.
  assert.equal(wake({ serialState: "outstanding" }), true);
  // Directed entries are exempt from serial queuing (serialState null) — wake
  // as ordinary actionable (point-to-point, parallel-safe).
  assert.equal(wake({ to: "me", serialState: null }), true);
});
