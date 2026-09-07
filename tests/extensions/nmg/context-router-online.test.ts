import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ContextRouterOnlineLearner,
  contextFeaturesFromMemory,
  contextOnlineLearningEnabled,
  loadOnlineRouter,
  onlineRouterStatePath,
  saveOnlineRouter,
} from "../../../.pi/extensions/nmg/context-router-online.ts";
import { ContextRouter } from "../../../src/lab/context-router.ts";

type MemoryResult = Parameters<typeof contextFeaturesFromMemory>[0]["results"][number];
function result(combinedScore: number): MemoryResult {
  return { combinedScore } as unknown as MemoryResult;
}

test("online learning is gated off by default", () => {
  assert.equal(contextOnlineLearningEnabled({}), false);
  assert.equal(contextOnlineLearningEnabled({ NMG_CONTEXT_ONLINE_LEARNING: "0" }), false);
  assert.equal(contextOnlineLearningEnabled({ NMG_CONTEXT_ONLINE_LEARNING: "1" }), true);
});

test("featuresFromMemory yields 32 normalized features and reflects the batch", () => {
  const features = contextFeaturesFromMemory({
    results: [result(30), result(20), result(10)],
    activeGraph: undefined,
  });
  assert.equal(features.length, 32);
  assert.ok(features.every((x) => Number.isFinite(x) && Math.abs(x) <= 1));
  // CONTEXT_FEATURE_KEYS order: ..., topCandidateScore(3), candidateScoreGap(4),
  // candidateCount(5). top = 30/max30 = 1; gap = (30-20)/30; count = 3/32.
  assert.equal(features[3], 1);
  assert.ok(Math.abs(features[4] - 1 / 3) < 1e-6);
  assert.ok(features[5] > 0);
});

test("an empty context produces valid missing-masked features (no fabrication)", () => {
  const features = contextFeaturesFromMemory({ results: [], activeGraph: undefined });
  assert.equal(features.length, 32);
  assert.ok(features.every((x) => Number.isFinite(x) && Math.abs(x) <= 1));
  assert.equal(features[5], 0); // candidateCount = 0
});

test("online learner: one staged decision + feedback runs one observed-action update", () => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-online-"));
  const path = onlineRouterStatePath(dir);
  const learner = new ContextRouterOnlineLearner(path);
  const features = contextFeaturesFromMemory({
    results: [result(40), result(10)],
    activeGraph: undefined,
  });
  const before = learner.parameters();
  learner.stage("graph-1", features, "retrieve");
  const out = learner.consumeFeedback("graph-1", { evidenceSufficient: true });
  assert.equal(out.trained, true);
  assert.equal(out.reward, 0.6); // verified for an injection action
  assert.ok(Number.isFinite(out.loss));
  learner.persistIfDirty();
  const after = learner.parameters();
  assert.notDeepEqual(before, after, "weights should move after the update");
  const reloaded = loadOnlineRouter(path);
  assert.deepEqual(reloaded.parameters(), after);
  rmSync(dir, { recursive: true, force: true });
});

test("consumeFeedback is a no-op without a staged decision or usable labels", () => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-online-"));
  const learner = new ContextRouterOnlineLearner(onlineRouterStatePath(dir));
  assert.equal(learner.consumeFeedback("graph-x", { evidenceSufficient: true }).trained, false);
  const features = contextFeaturesFromMemory({ results: [result(10)], activeGraph: undefined });
  learner.stage("graph-y", features, "retrieve");
  // Contradictory labels map to null -> skipped, never a silent vote.
  assert.equal(
    learner.consumeFeedback("graph-y", { evidenceSufficient: true, taskSuccess: false }).trained,
    false,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("persistence round-trips and corrupt state falls back to a fresh router", () => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-online-"));
  const path = onlineRouterStatePath(dir);
  const router = new ContextRouter();
  router.update(
    contextFeaturesFromMemory({ results: [result(20)], activeGraph: undefined }),
    "retrieve",
    0.5,
    0.05,
  );
  saveOnlineRouter(router, path);
  assert.deepEqual(loadOnlineRouter(path).parameters(), router.parameters());
  writeFileSync(path, "{not json", "utf8");
  assert.equal(loadOnlineRouter(path).parameters().every((x) => x === 0), true);
  rmSync(dir, { recursive: true, force: true });
});
