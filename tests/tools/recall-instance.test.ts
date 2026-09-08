import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendRecallInstance,
  appendRecallLabel,
  applyRecallLabels,
  boundCandidates,
  instancesSurfacing,
  readRecallInstances,
  readRecallLabels,
  recallInstancesPath,
  recallLabelsPath,
  summarizeLabels,
  type RecallInstance,
} from "../../src/lab/recall-instance.ts";
import { parseLabel } from "../../tools/recall-instance-judge.ts";

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "recall-inst-"));
  return dir;
}

function instance(activeGraphId: string, label?: RecallInstance["label"]): RecallInstance {
  return {
    at: "2026-09-07T00:00:00.000Z",
    kind: "auto",
    trigger: "how do i check the weather",
    activeGraphId,
    candidates: [
      { memoryId: "m1", statement: "curl wttr.in reports the weather", combinedScore: 0.9 },
    ],
    label,
  };
}

test("append then read round-trips unlabeled instances as JSONL", () => {
  const dir = makeDir();
  try {
    appendRecallInstance(dir, instance("g1"));
    appendRecallInstance(dir, instance("g2"));
    const raw = readFileSync(recallInstancesPath(dir), "utf8");
    assert.equal(raw.trim().split("\n").length, 2);
    const instances = readRecallInstances(recallInstancesPath(dir));
    assert.equal(instances.length, 2);
    assert.equal(instances[0]!.activeGraphId, "g1");
    assert.equal(instances[0]!.label, undefined); // collector writes unlabeled
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read skips malformed lines without dropping the corpus", () => {
  const dir = makeDir();
  try {
    appendRecallInstance(dir, instance("g1"));
    appendFileSync(recallInstancesPath(dir), "not-json\n");
    appendRecallInstance(dir, instance("g2"));
    const instances = readRecallInstances(recallInstancesPath(dir));
    assert.equal(instances.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("boundCandidates caps count and truncates long statements", () => {
  const long = "x".repeat(5_000);
  const bounded = boundCandidates(
    Array.from({ length: 20 }, (_, index) => ({
      memoryId: `m${index}`,
      statement: long,
      combinedScore: 1 - index / 20,
    })),
  );
  assert.equal(bounded.length, 8);
  assert.ok(bounded[0]!.statement.length <= 2_001);
  assert.match(bounded[0]!.statement, /…$/u);
});

test("summarizeLabels computes precision and gapRate over judged instances", () => {
  const summary = summarizeLabels([
    instance("g1", "on_target"),
    instance("g2", "partial"),
    instance("g3", "noise"),
    instance("g4", "gap"),
    instance("g5"), // unlabeled -> not judged
  ]);
  assert.equal(summary.total, 5);
  assert.equal(summary.labeled, 4);
  assert.equal(summary.perLabel.on_target, 1);
  assert.equal(summary.perLabel.partial, 1);
  assert.equal(summary.perLabel.noise, 1);
  assert.equal(summary.perLabel.gap, 1);
  assert.equal(summary.precision, 2 / 3); // gap excluded from candidate denominator
  assert.equal(summary.gapRate, 1 / 4);
});

test("summarizeLabels precision is null when nothing judged", () => {
  const summary = summarizeLabels([instance("g1")]);
  assert.equal(summary.precision, null);
  assert.equal(summary.gapRate, null);
});

test("parseLabel accepts a label value and rejects anything else", () => {
  assert.equal(parseLabel('{"label":"noise"}'), "noise");
  assert.equal(parseLabel("partial"), "partial");
  assert.equal(parseLabel('{"label":"unknown"}'), null);
  assert.equal(parseLabel("not json"), null);
});

test("label ledger round-trips and does not touch the capture file", () => {
  const dir = makeDir();
  try {
    appendRecallInstance(dir, instance("g1"));
    appendRecallLabel(dir, {
      activeGraphId: "g1",
      label: "on_target",
      source: "remember",
      at: "2026-09-07T00:00:00.000Z",
    });
    const labels = readRecallLabels(recallLabelsPath(dir));
    assert.equal(labels.length, 1);
    assert.equal(labels[0]!.source, "remember");
    // Capture file remains immutable: its instance is still unlabeled.
    const instances = readRecallInstances(recallInstancesPath(dir));
    assert.equal(instances[0]!.label, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyRecallLabels overlays ledger labels onto instances by graph", () => {
  const instances = [instance("g1"), instance("g2")];
  const applied = applyRecallLabels(instances, [
    { activeGraphId: "g2", label: "noise", source: "judge", at: "2026-09-07T00:00:00.000Z" },
  ]);
  assert.equal(applied[0]!.label, undefined);
  assert.equal(applied[1]!.label, "noise");
});

test("instancesSurfacing finds recalls whose retrieval surfaced a memory", () => {
  const withM2 = {
    ...instance("g1"),
    candidates: [
      { memoryId: "m1", statement: "a" },
      { memoryId: "m2", statement: "b" },
    ],
  };
  const matches = instancesSurfacing([withM2, instance("g2")], "m2");
  assert.deepEqual(matches.map((match) => match.activeGraphId), ["g1"]);
});

test("summarizeLabels counts remember-settled labels like any label", () => {
  const labeled = applyRecallLabels([instance("g1")], [
    { activeGraphId: "g1", label: "on_target", source: "remember", at: "2026-09-07T00:00:00.000Z" },
  ]);
  const summary = summarizeLabels(labeled);
  assert.equal(summary.labeled, 1);
  assert.equal(summary.precision, 1);
});
