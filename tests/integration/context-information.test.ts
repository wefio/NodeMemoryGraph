import assert from "node:assert/strict";
import test from "node:test";

import type { InformationView } from "../../src/core/information-view.ts";
import { SessionActiveGraphRuntime } from "../../src/core/session-active-graph.ts";
import {
  prepareSessionActiveGraphSurface,
  searchInformationViews,
} from "../../src/integration/agent-surface.ts";
import {
  contextStateViews,
  contextBoardEntries,
  checkpointInformationViews,
  contextNotice,
} from "../../src/integration/context-information.ts";
import type { MemoryContext } from "../../src/core/types.ts";
import type { ReasoningCheckpoint } from "../../src/lab/reasoning-workspace.ts";
import { searchResultFixture } from "../helpers/search-result.ts";
import {
  confirmInformationOutput,
  prepareInformationOutput,
} from "../../src/integration/information-output.ts";

const state: InformationView = {
  purpose: "state",
  source: {
    kind: "ag",
    sessionId: "s",
    taskFrameId: "session",
    itemId: "state",
  },
  body: "Goal: preserve this complete state.\nBlocked: do not remove the final constraint.",
  requiredLabels: ["[temporary]"],
};

test("context presentation groups by purpose without creating source owners", () => {
  const output = prepareInformationOutput(
    [
      { purpose: "guidance", body: "Review attributable feedback only." },
      {
        purpose: "material",
        body: "A candidate is not evidence.",
        preview: true,
      },
      state,
      {
        purpose: "reasoning",
        body: "Hypothesis only.",
        requiredLabels: ["[hypothesis]"],
      },
      { purpose: "diagnostic", body: "Retrieval unavailable for this turn." },
    ],
    { format: "context" },
  );
  assert.match(output.text, /<nmg_state space="ag">\n<nmg_working_state>/u);
  assert.match(output.text, /<nmg_material>\nA candidate is not evidence\./u);
  assert.match(output.text, /<nmg_reasoning>\n\[hypothesis\]/u);
  assert.match(output.text, /<nmg_guidance>/u);
  assert.match(output.text, /<nmg_diagnostics>/u);
  assert.ok(output.text.indexOf(state.body) < output.text.indexOf("A candidate"));
  assert.ok(output.text.indexOf("Hypothesis only") < output.text.indexOf("Review attributable"));
  assert.equal(output.views[0]?.purpose, "guidance");
});

test("context budgets include wrappers and omit complete items, not final constraints", () => {
  const full = prepareInformationOutput([state], { format: "context" });
  const tooSmall = prepareInformationOutput([state], {
    format: "context",
    maxCharacters: full.text.length - 1,
  });
  assert.doesNotMatch(tooSmall.text, /Goal:/u);
  assert.equal(tooSmall.omitted.length, 1);
  assert.equal(tooSmall.omitted[0]?.body, state.body);
  assert.ok(tooSmall.text.length <= full.text.length - 1);
  for (const size of [0, 1, 8, 40, 120, 300]) {
    const output = prepareInformationOutput([state], {
      format: "context",
      maxCharacters: size,
    });
    assert.ok(output.text.length <= size);
    if (output.included.length > 0) assert.ok(output.text.includes(state.body));
  }
});

test("oversized material cannot evict fitting state or suppress later small entries", () => {
  const output = prepareInformationOutput(
    [
      { purpose: "material", body: "x".repeat(2_000) },
      { purpose: "material", body: "small material" },
      state,
    ],
    { format: "context", maxCharacters: 400 },
  );
  assert.ok(output.text.includes(state.body));
  assert.match(output.text, /small material/u);
  assert.match(output.text, /omitted=1/u);
  assert.equal(output.omitted.length, 1);
  assert.ok(output.text.length <= 400);
  assert.equal(output.text.match(/<nmg_material>/gu)?.length, 1);
});

test("context source fingerprints preserve memory graph scope and purpose", () => {
  const memory: InformationView = {
    purpose: "material",
    source: { kind: "memory", memoryId: "m", activeGraphId: "g1" },
    body: "memory=m; preview=possible prior constraint",
    requiredLabels: ["[candidate preview]", "activeGraphId=g1"],
    preview: true,
  };
  const output = prepareInformationOutput(
    [
      memory,
      { ...memory },
      {
        ...memory,
        source: { kind: "memory", memoryId: "m", activeGraphId: "g2" },
      },
    ],
    { format: "context" },
  );
  assert.equal(output.included.length, 2);
  assert.equal(output.included[0]?.disclosure, "preview");
  const guidance = prepareInformationOutput([{ ...memory, purpose: "guidance" }]);
  assert.notEqual(guidance.included[0]?.contentHash, output.included[0]?.contentHash);
});

test("private workspace views cannot be confirmed by a foreign session", () => {
  const output = prepareInformationOutput(
    [
      {
        purpose: "reasoning",
        source: {
          kind: "workspace",
          sessionId: "s",
          generatedAt: "2026-10-13T00:00:00Z",
        },
        body: "Auditable scratchpad, not verified fact.",
        requiredLabels: ["[temporary]", "[scratchpad]"],
      },
    ],
    { format: "context" },
  );
  assert.equal(
    confirmInformationOutput(output, {
      sessionId: "foreign",
      text: output.text,
    }).entries.length,
    0,
  );
  assert.equal(
    confirmInformationOutput(output, { sessionId: "s", text: output.text }).entries.length,
    1,
  );
  assert.equal(
    confirmInformationOutput(output, {
      sessionId: "s",
      text: output.text + "changed",
    }).entries.length,
    0,
  );
});

test("automatic observation continuity is owner-stamped and lasts one following user turn", () => {
  const runtime = new SessionActiveGraphRuntime();
  runtime.observe({
    sessionId: "s",
    statement: "temporary error",
    sourceKind: "tool_error",
  });
  runtime.activateTemporaryProjection("s");
  runtime.beginDisclosureTurn("s");
  let snapshot = runtime.snapshot("s")!;
  assert.equal(snapshot.items[0]?.observedTurn, 0);
  assert.equal(
    prepareSessionActiveGraphSurface(snapshot, undefined, { contextTurn: 1 }).views.length,
    1,
  );
  assert.equal(prepareSessionActiveGraphSurface(snapshot).views[0]?.purpose, "diagnostic");
  runtime.beginDisclosureTurn("s");
  snapshot = runtime.snapshot("s")!;
  assert.equal(
    prepareSessionActiveGraphSurface(snapshot, undefined, { contextTurn: 2 }).views.length,
    0,
  );
  assert.match(prepareSessionActiveGraphSurface(snapshot).text, /temporary error/u);
  runtime.observe({
    sessionId: "s",
    statement: "temporary error",
    sourceKind: "tool_error",
  });
  runtime.beginDisclosureTurn("s");
  snapshot = runtime.snapshot("s")!;
  assert.equal(
    prepareSessionActiveGraphSurface(snapshot, undefined, { contextTurn: 3 }).views.length,
    1,
  );
});

test("legacy unstamped observations remain explicitly readable but are not current context", () => {
  const runtime = new SessionActiveGraphRuntime();
  runtime.observe({
    sessionId: "s",
    statement: "old board read",
    kind: "board_projection",
  });
  runtime.activateTemporaryProjection("s");
  const snapshot = runtime.snapshot("s")!;
  delete snapshot.items[0]!.observedTurn;
  assert.equal(prepareSessionActiveGraphSurface(snapshot).views.length, 1);
  assert.equal(
    prepareSessionActiveGraphSurface(snapshot, undefined, { contextTurn: 1 }).views.length,
    0,
  );
});

test("an invalid purpose is rejected instead of silently routed", () => {
  assert.throws(
    () =>
      prepareInformationOutput(
        [{ body: "unknown", purpose: "other" as InformationView["purpose"] }],
        { format: "context" },
      ),
    /purpose/u,
  );
});

test("context state uses owner identity, retains final state and rejects malformed/foreign snapshots", () => {
  const runtime = new SessionActiveGraphRuntime();
  const binding = runtime.bindWorkingState("s");
  runtime.replaceWorkingState(binding, "Complete current state\nFinal constraint stays intact.");
  runtime.unbindWorkingState(binding);
  runtime.beginDisclosureTurn("s");
  runtime.beginDisclosureTurn("s");
  const snapshot = runtime.snapshot("s")!;
  const views = contextStateViews(snapshot, "s");
  assert.equal(views.length, 1);
  assert.equal(views[0]?.purpose, "state");
  assert.ok(views[0]?.body.endsWith("Final constraint stays intact."));
  assert.throws(() => contextStateViews(snapshot, "foreign"), /Foreign/u);
  assert.deepEqual(contextStateViews(null, "s"), []);
  delete snapshot.items[0]!.contentHash;
  assert.deepEqual(contextStateViews(snapshot, "s"), []);
});

test("workspace projection stays private, previewed and atomic instead of being labelled AG", () => {
  const checkpoint: ReasoningCheckpoint = {
    sessionId: "s",
    generatedAt: "2026-10-13T00:00:00Z",
    nodes: [],
    edges: [],
    omittedNodes: 1,
    text: "Temporary hypothesis\nDo not treat this checkpoint as verified evidence.",
  };
  const views = checkpointInformationViews(checkpoint, "s");
  const output = prepareInformationOutput(views, { format: "context" });
  assert.equal(output.included[0]?.source.kind, "workspace");
  assert.equal(output.included[0]?.disclosure, "preview");
  assert.match(output.text, /not verified fact/u);
  assert.ok(output.text.includes(checkpoint.text));
  assert.doesNotMatch(output.text, /nmg_runtime_ag/u);
  assert.throws(() => checkpointInformationViews(checkpoint, "foreign"), /Foreign/u);
  assert.deepEqual(checkpointInformationViews(null, "s"), []);
});

test("history board access never stages context and ordinary access stages only known open entries", () => {
  const entries = [
    { id: "active", status: "open" },
    { id: "closed", status: "resolved" },
    { id: "legacy" },
  ];
  assert.deepEqual(contextBoardEntries(entries, true), []);
  assert.deepEqual(contextBoardEntries(entries, false), [entries[0]]);
  assert.equal(entries.length, 3);
  assert.deepEqual(contextNotice(""), []);
  assert.deepEqual(contextNotice("Take one bounded action."), [
    { purpose: "guidance", body: "Take one bounded action." },
  ]);
});

test("candidate rows retain preview, degradation and graph references under independent omission", () => {
  const context: MemoryContext = {
    results: [
      searchResultFixture("a", "Short constraint."),
      searchResultFixture("b", "long detail ".repeat(100)),
    ],
    relations: [],
    memoryReferences: { a: "ref:a001|Short ", b: "ref:b001|long d" },
    retrieval: {
      mode: "lexical",
      degraded: true,
      reason: "embedding_unavailable",
    },
    activeGraph: {
      id: "graph",
      sessionId: "s",
      query: "constraint",
      taskId: "session",
      nodeIds: [],
      memoryIds: ["a", "b"],
      edges: [],
      selections: [],
      expansions: [],
      budgetLedger: [],
      budget: {
        maxNodes: 2,
        maxEdges: 0,
        maxEvidence: 0,
        maxTokens: 1_000,
        maxGraphHops: 0,
        maxLocalTier: 1,
        maxTierBudget: 0,
        maxLatencyMs: 100,
      },
      usage: {
        nodes: 0,
        edges: 0,
        evidence: 0,
        estimatedTokens: 0,
        graphHops: 0,
        deepestTier: 1,
        tiersOpened: 1,
        deepEvidence: 0,
        latencyMs: 1,
        exhausted: [],
      },
      createdAt: "2026-10-13T00:00:00Z",
    },
  };
  const original = structuredClone(context);
  const views = searchInformationViews(context);
  const first = prepareInformationOutput([views[0]!], { format: "context" });
  const output = prepareInformationOutput(views, {
    format: "context",
    maxCharacters: first.text.length + 20,
  });
  assert.equal(output.included.length, 1);
  assert.equal(output.omitted.length, 1);
  assert.equal(output.included[0]?.disclosure, "preview");
  assert.deepEqual(output.included[0]?.source, {
    kind: "memory",
    memoryId: "a",
    activeGraphId: "graph",
  });
  assert.match(output.text, /memory=ref:a001/u);
  assert.match(output.text, /activeGraphId=graph/u);
  assert.match(output.text, /embedding_unavailable/u);
  assert.match(output.text, /not exact evidence/u);
  assert.doesNotMatch(output.text, /memory=ref:b001|lexicalScore|combinedScore|SOURCE=/u);
  assert.deepEqual(context, original);
});

test("grouped budget stays bounded for many independent items and never clips labels", () => {
  const views: InformationView[] = Array.from({ length: 20 }, (_, i) => ({
    purpose: i % 2 === 0 ? "material" : "guidance",
    source: { kind: "board", taskId: "t", entryId: String(i) },
    body: `entry-${i}: 完整条目与尾部限制`,
    requiredLabels: ["[temporary]", "[preview]"],
    preview: true,
  }));
  for (const size of [0, 1, 10, 80, 130, 250, 500, 1_000]) {
    const output = prepareInformationOutput(views, {
      format: "context",
      maxCharacters: size,
    });
    assert.ok(output.text.length <= size);
    for (const item of output.included) {
      assert.equal(item.disclosure, "preview");
      if (item.source.kind === "board")
        assert.ok(output.text.includes(views[Number(item.source.entryId)]!.body));
    }
  }
});

test("state presentation does not relabel a board owner as private AG", () => {
  const output = prepareInformationOutput(
    [
      {
        purpose: "state",
        source: { kind: "board", taskId: "t", entryId: "e" },
        body: "Original board state.",
      },
    ],
    { format: "context" },
  );
  assert.match(output.text, /<nmg_state>/u);
  assert.doesNotMatch(output.text, /space="ag"|nmg_working_state/u);
  assert.equal(output.included[0]?.source.kind, "board");
});

test("bounded recovery precedes optional material without evicting complete state", () => {
  const checkpoint: InformationView = {
    purpose: "reasoning",
    source: { kind: "workspace", sessionId: "s", generatedAt: "now" },
    body: "Recovery checkpoint.".repeat(250),
    preview: true,
  };
  const state: InformationView = {
    purpose: "state",
    source: { kind: "ag", sessionId: "s", taskFrameId: "t", itemId: "state" },
    body: "s".repeat(8_000),
  };
  const optional: InformationView = {
    purpose: "material",
    body: "m".repeat(7_000),
  };
  const output = prepareInformationOutput([optional, checkpoint, state], {
    format: "context",
  });
  assert.ok(output.text.includes(state.body));
  assert.ok(output.text.includes(checkpoint.body));
  assert.deepEqual(
    output.omitted.map((view) => view.body),
    [optional.body],
  );
  assert.ok(output.text.length <= 16_000);
});

test("omission bookkeeping may remove optional material but not a fitting state", () => {
  const item: InformationView = { purpose: "material", body: "short" };
  const fitted = prepareInformationOutput([item], { format: "context" });
  const extra: InformationView = {
    purpose: "material",
    body: "x".repeat(1_000),
  };
  const output = prepareInformationOutput([item, extra], {
    format: "context",
    maxCharacters: fitted.text.length,
  });
  assert.match(output.text, /omitted=2/u);
  assert.equal(output.omitted.length, 2);
  const state = { ...item, purpose: "state" as const };
  const stateLength = prepareInformationOutput([state], { format: "context" }).text.length;
  const protectedOutput = prepareInformationOutput([state, extra], {
    format: "context",
    maxCharacters: stateLength,
  });
  assert.ok(protectedOutput.text.includes(state.body));
  assert.equal(protectedOutput.omitted.length, 1);
});
