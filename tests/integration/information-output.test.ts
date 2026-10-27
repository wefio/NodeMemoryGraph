import assert from "node:assert/strict";
import test from "node:test";

import type { InformationView } from "../../src/core/information-view.ts";

import {
  confirmInformationOutput,
  prepareInformationOutput,
} from "../../src/integration/information-output.ts";

test("a short information body is emitted without an identity or reference wrapper", () => {
  const output = prepareInformationOutput([
    {
      source: { kind: "board", taskId: "parser", entryId: "entry-1" },
      body: "Keep the public API unchanged.",
    },
  ]);

  assert.equal(output.text, "Keep the public API unchanged.");
  assert.equal(output.included.length, 1);
  assert.deepEqual(output.omitted, []);
});

test("budget omission keeps admitted bodies and labels intact and reports the gap", () => {
  const output = prepareInformationOutput(
    [
      {
        source: { kind: "board", taskId: "parser", entryId: "entry-1" },
        body: "Check parser.",
        requiredLabels: ["[temporary]"],
      },
      {
        source: { kind: "board", taskId: "parser", entryId: "entry-2" },
        body: `${"A long necessary condition. ".repeat(24)}Do not change public API.`,
      },
    ],
    { maxCharacters: 50 },
  );

  assert.equal(output.text, "[temporary] Check parser.\nomitted=1");
  assert.equal(output.included.length, 1);
  assert.equal(output.omitted[0]?.source?.kind, "board");
  assert.equal(output.omitted[0]?.body.endsWith("Do not change public API."), true);
  assert.ok(output.text.length <= 50);
});

test("output confirmation rejects clipped or rewritten text instead of inferring disclosure", () => {
  const output = prepareInformationOutput([
    {
      source: { kind: "board", taskId: "parser", entryId: "e1" },
      body: "First condition.",
    },
    {
      source: { kind: "board", taskId: "parser", entryId: "e2" },
      body: "Second condition.",
    },
  ]);

  assert.deepEqual(
    confirmInformationOutput(output, {
      sessionId: "reader-a",
      text: "First condition.",
    }).entries,
    [],
  );
  assert.deepEqual(
    confirmInformationOutput(output, {
      sessionId: "reader-a",
      text: `${output.text} modified`,
    }).entries,
    [],
  );
  assert.equal(
    confirmInformationOutput(output, {
      sessionId: "reader-a",
      text: output.text,
    }).entries.length,
    2,
  );
});

test("deduplication binds source identity and preserves independent scopes", () => {
  const repeated: InformationView = {
    source: { kind: "board", taskId: "parser", entryId: "e1" },
    body: "Check parser.",
  };
  const output = prepareInformationOutput([
    repeated,
    { ...repeated, source: { entryId: "e1", taskId: "parser", kind: "board" } },
    {
      ...repeated,
      source: { kind: "board", taskId: "other-task", entryId: "e1" },
    },
  ]);

  assert.equal(output.text, "Check parser.\nCheck parser.");
  assert.equal(output.included.length, 2);
});

test("a status or disclosure-level change changes the source fingerprint", () => {
  const view: InformationView = {
    source: { kind: "board", taskId: "parser", entryId: "e1" },
    body: "Check parser.",
    requiredLabels: ["[open]"],
  };
  const initial = prepareInformationOutput([view]).included[0]!;
  const resolved = prepareInformationOutput([{ ...view, requiredLabels: ["[resolved]"] }]);
  const preview = prepareInformationOutput([{ ...view, preview: true }]);

  assert.notEqual(resolved.included[0]?.contentHash, initial.contentHash);
  assert.notEqual(preview.included[0]?.contentHash, initial.contentHash);
  assert.equal(preview.included[0]?.disclosure, "preview");
});

test("confirmation is caller-local and cannot attribute another session's AG", () => {
  const output = prepareInformationOutput([
    {
      source: {
        kind: "ag",
        sessionId: "owner-a",
        taskFrameId: "parser",
        itemId: "state",
      },
      body: "Keep the API unchanged.",
    },
  ]);
  assert.deepEqual(
    confirmInformationOutput(output, {
      sessionId: "owner-b",
      text: output.text,
    }).entries,
    [],
  );
  assert.equal(
    confirmInformationOutput(output, {
      sessionId: "owner-a",
      text: output.text,
    }).entries.length,
    1,
  );

  const shared = prepareInformationOutput([
    {
      source: { kind: "board", taskId: "parser", entryId: "e1" },
      body: "Review parser.",
    },
  ]);
  assert.equal(
    confirmInformationOutput(shared, {
      sessionId: "owner-a",
      text: shared.text,
    }).sessionId,
    "owner-a",
  );
  assert.equal(
    confirmInformationOutput(shared, {
      sessionId: "owner-b",
      text: shared.text,
    }).sessionId,
    "owner-b",
  );
});

test("zero and tiny budgets keep omissions explicit without clipping or raising the caller's cap", () => {
  for (const maxCharacters of [0, 1, 9, 10]) {
    const output = prepareInformationOutput([{ body: "Do not change the public API." }], {
      maxCharacters,
    });
    assert.ok(output.text.length <= maxCharacters);
    assert.equal(output.omitted.length, 1);
    assert.equal(output.included.length, 0);
  }
  for (const maxCharacters of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => prepareInformationOutput([], { maxCharacters }), RangeError);
  }
});

test("preparation copies only the admitted source-handle fields", () => {
  const source = {
    kind: "board" as const,
    taskId: "parser",
    entryId: "e1",
    internalScore: 42,
  };
  const output = prepareInformationOutput([{ source, body: "Review parser." }]);
  assert.doesNotMatch(JSON.stringify(output), /internalScore/u);
  assert.deepEqual(output.included[0]?.source, {
    kind: "board",
    taskId: "parser",
    entryId: "e1",
  });
});

test("ordinary library consumers can use JSON data and text without a host executor", async () => {
  const api = await import("../../src/index.ts");
  const output = api.prepareInformationOutput([
    {
      source: { kind: "board", taskId: "parser", entryId: "e1" },
      body: "Review parser.",
    },
  ]);
  assert.equal(JSON.parse(JSON.stringify(output)).text, output.text);
  assert.equal(
    api.confirmInformationOutput(output, {
      sessionId: "reader-a",
      text: output.text,
    }).entries.length,
    1,
  );
  assert.equal(typeof api.prepareSessionActiveGraphSurface, "function");
  assert.equal(typeof api.prepareTaskBoardSurface, "function");
});

test("prepared content and source binding do not follow later caller mutations", () => {
  const source = { kind: "board" as const, taskId: "parser", entryId: "e1" };
  const labels = ["[open]"];
  const view = {
    source,
    body: "Review parser.",
    requiredLabels: labels,
  } satisfies InformationView;
  const output = prepareInformationOutput([view]);
  view.body = "Unrelated replacement.";
  source.taskId = "other-task";
  labels[0] = "[accepted]";

  assert.equal(output.views[0]?.body, "Review parser.");
  assert.deepEqual(output.views[0]?.requiredLabels, ["[open]"]);
  assert.deepEqual(output.included[0]?.source, {
    kind: "board",
    taskId: "parser",
    entryId: "e1",
  });
  assert.equal(output.text, "[open] Review parser.");
});

test("deferred source metadata uses the prepared snapshot and is reusable as plain JSON", () => {
  const source = { kind: "memory" as const, memoryId: "m", activeGraphId: "graph" };
  const view = { source, body: "Original value", requiredLabels: ["[preview]"], preview: true };
  const output = prepareInformationOutput([view, view]);
  assert.equal(output.text, "[preview] Original value");
  source.memoryId = "different";
  view.body = "Changed value";
  view.requiredLabels[0] = "[verified]";
  const entries = output.included;
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].source, { kind: "memory", memoryId: "m", activeGraphId: "graph" });
  assert.equal(entries[0].disclosure, "preview");
  assert.equal(output.included, entries);
  assert.ok(Object.isFrozen(entries) && Object.isFrozen(entries[0]));
  assert.deepEqual(JSON.parse(JSON.stringify(output)).included, entries);
  const again = prepareInformationOutput([
    {
      source: { kind: "memory", memoryId: "m", activeGraphId: "graph" },
      body: "Original value",
      requiredLabels: ["[preview]"],
      preview: true,
    },
  ]);
  assert.deepEqual(again.included, entries);
  assert.deepEqual(
    confirmInformationOutput(output, { sessionId: "reader", text: "changed" }).entries,
    [],
  );
});

test("context cost follows the all-AG envelope transition, including a rejected transition", () => {
  const ag: InformationView = {
    purpose: "state",
    source: { kind: "ag", sessionId: "s", taskFrameId: "t", itemId: "i" },
    body: "AG",
  };
  const board: InformationView = {
    purpose: "state",
    source: { kind: "board", taskId: "t", entryId: "e" },
    body: "Board",
  };
  const agText =
    '<nmg_state space="ag">\n<nmg_working_state>\nAG\n</nmg_working_state>\n</nmg_state>';
  // Adding a board state shrinks the wrapper; charging only positive deltas is wrong.
  const mixed = prepareInformationOutput([ag, board], {
    format: "context",
    maxCharacters: agText.length,
  });
  assert.equal(mixed.text, "<nmg_state>\nAG\nBoard\n</nmg_state>");
  assert.equal(mixed.omitted.length, 0);
  const rejected = prepareInformationOutput([ag, { ...board, body: "x".repeat(200) }], {
    format: "context",
    maxCharacters: agText.length,
  });
  assert.equal(rejected.text, agText);
  assert.equal(rejected.omitted.length, 1);
});

test("flat cost counts UTF-16, labels and separators and skips duplicates even after omission", () => {
  const item: InformationView = {
    source: { kind: "memory", memoryId: "m" },
    body: "😀",
    requiredLabels: ["[x]"],
  };
  assert.equal(prepareInformationOutput([item], { maxCharacters: 6 }).text, "[x] 😀");
  assert.equal(prepareInformationOutput([item], { maxCharacters: 5 }).text, "");
  const large = { ...item, body: "x".repeat(100) };
  const output = prepareInformationOutput([large, large, item], { maxCharacters: 16 });
  assert.equal(output.text, "[x] 😀\nomitted=1");
  assert.equal(output.omitted.length, 1);
  assert.equal(output.included.length, 1);
});

test("context notice removal accounts for disappearing groups", () => {
  const output = prepareInformationOutput(
    [
      { purpose: "material", body: "M" },
      { purpose: "guidance", body: "G" },
      { purpose: "material", body: "x".repeat(300) },
    ],
    { format: "context", maxCharacters: 70 },
  );
  assert.equal(output.text, "<nmg_material>\nM\n</nmg_material>\n\nomitted=2");
  assert.deepEqual(
    output.omitted.map((view) => view.body),
    ["G", "x".repeat(300)],
  );
});
