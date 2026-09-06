import assert from "node:assert/strict";
import { test } from "node:test";
import {
  summarizeContextGroups,
  type ContextGroupSummary,
} from "../../evals/controller-shadow/context-report.ts";
import type {
  ContextDatasetRow,
  ContextSplit,
} from "../../evals/controller-shadow/context-dataset.ts";
import type { ContextIntervention } from "../../src/lab/context-intervention.ts";

function sample(decisionId: string): ContextIntervention {
  return {
    schemaVersion: 1,
    decisionId,
    taskId: "t",
    sessionId: "s",
    taskFrameId: "f",
    acceptanceVersion: "a",
    featureVersion: "v",
    policyVersion: "p",
    origin: "benchmark",
    mode: "executed",
    decidedAt: 0,
    features: [],
    allowed: ["retrieve"],
    selected: "retrieve",
    probability: 1,
  };
}

function row(groupId: string, split: ContextSplit, decisionId: string): ContextDatasetRow {
  return { groupId, split, sample: sample(decisionId) };
}

test("research: duplicate rows do not inflate the independent group count", () => {
  const dup = row("source-A", "train", "d1");
  const summary = summarizeContextGroups([dup, dup, dup]);
  assert.equal(summary.splits.train.groups, 1);
  assert.equal(summary.splits.train.rows, 3);
  // A genuinely distinct group is counted separately.
  const two = summarizeContextGroups([
    dup,
    row("source-B", "train", "d2"),
    row("source-C", "train", "d3"),
  ]);
  assert.equal(two.splits.train.groups, 3);
});

test("research: special object-property names remain ordinary source groups", () => {
  const summary = summarizeContextGroups([row("__proto__", "train", "d1")]);
  assert.equal(summary.splits.train.rowsByGroup["__proto__"], 1);
  assert.equal(Object.hasOwn(summary.splits.train.rowsByGroup, "__proto__"), true);
});

test("research: per-group row counts are reported exactly", () => {
  const summary = summarizeContextGroups([
    row("A", "train", "d1"),
    row("A", "train", "d2"),
    row("B", "train", "d3"),
    row("A", "train", "d4"),
  ]);
  assert.deepEqual(summary.splits.train, {
    groups: 2,
    rows: 4,
    rowsByGroup: { A: 3, B: 1 },
  });
});

test("research: empty partitions are reported, not hidden", () => {
  const summary = summarizeContextGroups([row("A", "train", "d1"), row("B", "test", "d2")]);
  assert.deepEqual(summary.splits.validation, { groups: 0, rows: 0, rowsByGroup: {} });
  assert.equal(summary.splits.train.groups, 1);
  assert.equal(summary.splits.test.groups, 1);
});

test("research: one source group spanning two splits is rejected", () => {
  assert.throws(
    () => summarizeContextGroups([row("A", "train", "d1"), row("A", "test", "d2")]),
    /spans splits train and test/,
  );
});

test("research: rowsByGroup keys are deterministically sorted regardless of input order", () => {
  const summary = summarizeContextGroups([
    row("zeta", "train", "d1"),
    row("alpha", "train", "d2"),
    row("mid", "train", "d3"),
  ]);
  assert.deepEqual(Object.keys(summary.splits.train.rowsByGroup), ["alpha", "mid", "zeta"]);
  // Stable across repeated calls on reversed input.
  const reversed = summarizeContextGroups([
    row("mid", "train", "d3"),
    row("alpha", "train", "d2"),
    row("zeta", "train", "d1"),
  ]);
  assert.deepEqual(reversed.splits.train.rowsByGroup, summary.splits.train.rowsByGroup);
});

test("research: all three splits are always present with the full shape", () => {
  const summary = summarizeContextGroups([]);
  for (const split of ["train", "validation", "test"] as const) {
    assert.equal(summary.splits[split].groups, 0);
    assert.equal(summary.splits[split].rows, 0);
    assert.deepEqual(summary.splits[split].rowsByGroup, {});
  }
});

test("research: sparse independent groups emit a transparency-only warning", () => {
  const summary = summarizeContextGroups([row("only", "train", "d1")]);
  assert.ok(summary.warnings.some((w) => w.startsWith("train: 1 independent source group")));
  assert.ok(
    summary.warnings.some((w) => /transparency only.*not an efficacy or activation gate/u.test(w)),
  );
});

test("research: no warning for a split with at least five independent groups", () => {
  const rows: ContextDatasetRow[] = [];
  for (let i = 0; i < 5; i += 1) rows.push(row(`g${i}`, "train", `d${i}`));
  const summary: ContextGroupSummary = summarizeContextGroups(rows);
  assert.ok(!summary.warnings.some((w) => w.startsWith("train:")));
});
