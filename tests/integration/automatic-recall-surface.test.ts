import assert from "node:assert/strict";
import test from "node:test";
import { prepareAutomaticRecallSurface } from "../../src/integration/agent-surface.ts";
import { compactSearchContext } from "../../src/integration/search-projection.ts";
import {
  confirmInformationOutput,
  prepareInformationOutput,
} from "../../src/integration/information-output.ts";
import { searchResultFixture } from "../helpers/search-result.ts";

test("automatic recall budgets wrappers and admits only whole source-bound previews", () => {
  const context = compactSearchContext({
    results: Array.from({ length: 80 }, (_, i) =>
      searchResultFixture(`memory-${i}`, "Exact private detail. ".repeat(40)),
    ),
    relations: [],
    activeGraph: { id: "graph" },
    retrieval: {
      mode: "lexical",
      degraded: true,
      reason: "automatic_recall_embedding_deadline",
    },
  } as never);
  const output = prepareAutomaticRecallSurface(context, {
    preamble: "Automatic candidates; retrieve exact evidence before use.",
    postamble: "Follow-up guidance ".repeat(40),
    maxCharacters: 2_000,
  });
  assert.ok(output.text.length <= 2_000);
  assert.ok(output.included.length > 0 && output.included.length < 80);
  assert.ok(output.omitted.length > 0);
  for (const entry of output.included) {
    assert.equal(entry.disclosure, "preview");
    assert.equal(entry.source.kind, "memory");
    if (entry.source.kind === "memory") {
      assert.equal(entry.source.activeGraphId, "graph");
      assert.match(output.text, new RegExp(`\`${entry.source.memoryId}\``));
    }
  }
  for (const view of output.omitted) {
    if (view.source?.kind === "memory") assert.ok(!output.text.includes(view.body));
  }
  assert.match(output.text, /candidate preview; not exact evidence/);
  assert.equal(
    output.text.match(
      /degraded retrieval: mode=lexical; reason=automatic_recall_embedding_deadline/gu,
    )?.length,
    1,
  );
  assert.deepEqual(
    confirmInformationOutput(output, { sessionId: "s", text: output.text.slice(1) }).entries,
    [],
  );
});

test("combined recall rendering retains prior admissions and opens more slots as budget grows", () => {
  const context = compactSearchContext({
    recallDisplayMode: "full",
    results: Array.from({ length: 60 }, (_, i) =>
      searchResultFixture(String(i).padStart(2, "0"), "short note"),
    ),
    relations: [],
  });
  const prepared = prepareAutomaticRecallSurface(context);
  const state = [{ purpose: "state" as const, body: "Current task: " + "x".repeat(300) }];
  const stateChars = prepareInformationOutput(state, { format: "context" }).text.length;
  const views = [...state, ...prepared.views];
  let previous: typeof prepared.included = [];
  for (const [budget, count] of [
    [2_500, 20],
    [4_000, 32],
    [6_000, 48],
  ] as const) {
    const output = prepareInformationOutput(views, {
      format: "context",
      maxCharacters: stateChars + budget,
    });
    assert.equal(output.included.length, count);
    assert.deepEqual(output.included.slice(0, previous.length), previous);
    assert.ok(output.text.includes(state[0]!.body));
    assert.ok(output.text.length <= stateChars + budget);
    assert.match(output.text, new RegExp(`omitted=${60 - count}$`));
    assert.equal(output.omitted.length + output.included.length, 60);
    previous = output.included;
  }
});

test("compact recall uses a five-candidate economy default and supports 3, 5 and 10", () => {
  const context = compactSearchContext({
    results: Array.from({ length: 20 }, (_, i) =>
      searchResultFixture(String(i), "日常召回 ".repeat(30)),
    ),
    relations: [],
  });
  assert.equal(prepareAutomaticRecallSurface(context).included.length, 5);
  let previous: ReturnType<typeof prepareAutomaticRecallSurface>["included"] = [];
  for (const [economyLimit, budget] of [
    [3, 1_000],
    [5, 1_500],
    [10, 2_500],
  ] as const) {
    const prepared = prepareAutomaticRecallSurface(context, { economyLimit });
    const composite = prepareInformationOutput(prepared.views, {
      format: "context",
      maxCharacters: 16_000,
    });
    assert.equal(composite.included.length, economyLimit);
    assert.deepEqual(composite.included.slice(0, previous.length), previous);
    assert.ok(composite.text.length <= budget);
    assert.equal(composite.omitted.length, 20 - economyLimit);
    previous = composite.included;
  }
  const tight = prepareAutomaticRecallSurface(context, { maxCharacters: 1_000 });
  assert.equal(tight.included.length, 3);
  assert.ok(tight.text.length <= 1_000);
});

test("economy displays common labels once while keeping each candidate receipt source-bound", () => {
  const fixture = searchResultFixture("memory", "Original context");
  const context = compactSearchContext({ results: [fixture], relations: [] });
  const sameGraph = { ...context, activeGraphId: "graph-one" };
  const rows = prepareAutomaticRecallSurface({
    ...sameGraph,
    candidates: [
      ...context.candidates,
      ...context.candidates.map((row) => ({ ...row, id: "other" })),
    ],
  });
  const plain = prepareInformationOutput(
    rows.views.map((view) => ({ ...view, automaticRecall: undefined })),
    { format: "context" },
  );
  assert.equal(rows.text.match(/activeGraphId=graph-one/gu)?.length, 1);
  assert.doesNotMatch(rows.text, /node=|type=|memory=|preview=/u);
  assert.match(rows.text, /- `memory` Original context/u);
  assert.deepEqual(rows.included, plain.included);
  const mixed = prepareInformationOutput(
    [
      ...rows.views,
      ...prepareAutomaticRecallSurface({ ...context, activeGraphId: "graph-two" }).views,
    ],
    { format: "context" },
  );
  assert.match(mixed.text, /activeGraphId=graph-one [^\n]*`other`/u);
  assert.match(mixed.text, /activeGraphId=graph-two [^\n]*`memory`/u);
  const tiny = prepareAutomaticRecallSurface(sameGraph, { maxCharacters: 16 });
  assert.doesNotMatch(tiny.text, /activeGraphId=/u);
});

test("a higher-ranked long recall preview can join a later stage without evicting short previews", () => {
  const context = compactSearchContext({
    recallDisplayMode: "full",
    relations: [],
    results: [
      searchResultFixture("long", "start " + "😀".repeat(900) + " end"),
      searchResultFixture("short", "short " + "x".repeat(900)),
      searchResultFixture("tail", "concise detail"),
    ],
  });
  const small = prepareAutomaticRecallSurface(context, { maxCharacters: 2_500 });
  const large = prepareAutomaticRecallSurface(context, { maxCharacters: 4_000 });
  assert.equal(small.included.length, 2);
  assert.equal(large.included.length, 3);
  assert.deepEqual(large.included.slice(0, 2), small.included);
  assert.match(small.text, /omitted=1$/u);
  assert.ok(large.text.includes(context.candidates[0]!.preview));
  assert.ok(large.included.every((entry) => entry.disclosure === "preview"));
});

test("full-mode floor-guarded knapsack preserves short-record order and penalizes oversized records", () => {
  const shortContext = compactSearchContext({
    recallDisplayMode: "full",
    relations: [],
    results: [
      searchResultFixture("longer-short", "Detailed user preference " + "a".repeat(220)),
      searchResultFixture("tiny-short", "Short greeting"),
    ],
  });
  const shortOut = prepareAutomaticRecallSurface(shortContext, { maxCharacters: 4_000 });
  assert.deepEqual(
    shortOut.included.map((e) => (e.source.kind === "memory" ? e.source.memoryId : "")),
    ["longer-short", "tiny-short"],
  );

  const mixedContext = compactSearchContext({
    recallDisplayMode: "full",
    relations: [],
    results: [
      searchResultFixture("giant", "Huge transcript " + "g".repeat(2_000)),
      searchResultFixture("concise-1", "Key decision one " + "c".repeat(120)),
      searchResultFixture("concise-2", "Key decision two " + "d".repeat(120)),
    ],
  });
  const tight = prepareAutomaticRecallSurface(mixedContext, { maxCharacters: 2_300 });
  assert.deepEqual(
    tight.included.map((e) => (e.source.kind === "memory" ? e.source.memoryId : "")),
    ["concise-1", "concise-2"],
  );
  const wide = prepareAutomaticRecallSurface(mixedContext, { maxCharacters: 4_000 });
  assert.deepEqual(
    wide.included.map((e) => (e.source.kind === "memory" ? e.source.memoryId : "")),
    ["concise-1", "concise-2", "giant"],
  );
});
