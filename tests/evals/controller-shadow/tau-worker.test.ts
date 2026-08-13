import assert from "node:assert/strict";
import test from "node:test";

import type { ShadowDatasetRow } from "../../../evals/controller-shadow/dataset.ts";
import { calibrateRollingTau } from "../../../evals/controller-shadow/tau-worker.ts";

function row(index: number, split: "train" | "validation", qpp: number, useful: boolean) {
  return {
    split,
    semanticTaskId: `task-${index}`,
    graphId: `graph-${index}`,
    sessionId: `session-${index}`,
    recordedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    retrieval: { qpp: { qpp } },
    feedback: { expansionUseful: useful },
  } as ShadowDatasetRow;
}

test("rolling tau remains shadow-only and fails closed on sparse data", () => {
  const artifact = calibrateRollingTau([
    row(0, "train", 0.2, true),
    row(1, "validation", 0.8, false),
  ], { generatedAt: "2026-08-13T00:00:00.000Z" });
  assert.equal(artifact.eligibleForShadow, false);
  assert.equal(artifact.eligibleForActivation, false);
  assert.ok(artifact.blockers.some((blocker) => blocker.includes("50")));
  assert.deepEqual(artifact.rollback, { threshold: 0.55 });
});

test("rolling tau learns a bounded candidate on chronological held-out data", () => {
  const rows: ShadowDatasetRow[] = [];
  for (let index = 0; index < 40; index += 1) {
    rows.push(row(index, "train", index % 2 === 0 ? 0.3 : 0.7, index % 2 === 0));
  }
  for (let index = 40; index < 50; index += 1) {
    rows.push(row(index, "validation", index % 2 === 0 ? 0.3 : 0.7, index % 2 === 0));
  }
  const artifact = calibrateRollingTau(rows, {
    previousThreshold: 0.55,
    generatedAt: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(artifact.eligibleForShadow, true);
  assert.equal(artifact.eligibleForActivation, false);
  assert.ok(Math.abs(artifact.candidateThreshold - artifact.previousThreshold) <= 0.05);
  assert.equal(artifact.candidate.balancedAccuracy, 1);
  assert.equal(artifact.rows.validation, 10);
  assert.equal(artifact.dataWindow.to, rows.at(-1)?.recordedAt);
});
