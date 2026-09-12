import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BLOCK_COLUMNS,
  columnsForBlocks,
  RELEVANCE_FEATURE_COUNT,
} from "../../src/core/relevance-features.ts";
import {
  RelevanceModel,
  readRelevanceModel,
  type RelevanceTrainingExample,
} from "../../src/lab/relevance-model.ts";

/** A separable 1-feature problem: label = feature0 > 0. */
function separable(count = 400): RelevanceTrainingExample[] {
  const examples: RelevanceTrainingExample[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = (index / count) * 4 - 2;
    const features = new Array<number>(RELEVANCE_FEATURE_COUNT).fill(0);
    features[0] = value;
    examples.push({ features, label: value > 0 ? 1 : 0 });
  }
  return examples;
}

test("RelevanceModel learns a separable set and ranks classes correctly", () => {
  const model = new RelevanceModel({ hidden: 4 });
  const low = new Array<number>(RELEVANCE_FEATURE_COUNT).fill(0);
  const high = new Array<number>(RELEVANCE_FEATURE_COUNT).fill(0);
  high[0] = 1.5;
  low[0] = -1.5;
  model.train(separable(), { epochs: 150, learningRate: 0.5 });
  assert.ok(model.predict(high) > 0.9, `high=${model.predict(high)}`);
  assert.ok(model.predict(low) < 0.1, `low=${model.predict(low)}`);
});

test("RelevanceModel round-trips through JSON", () => {
  const model = new RelevanceModel({ hidden: 4 });
  model.train(separable(200), { epochs: 20, learningRate: 0.5 });
  const restored = RelevanceModel.fromJSON(JSON.parse(JSON.stringify(model.toJSON())));
  const probe = new Array<number>(RELEVANCE_FEATURE_COUNT).fill(0);
  probe[0] = 1.2;
  assert.equal(restored.predict(probe), model.predict(probe));
});

test("readRelevanceModel returns null for a missing or malformed file", () => {
  const directory = mkdtempSync(join(tmpdir(), "relevance-model-"));
  try {
    assert.equal(readRelevanceModel(join(directory, "missing.json")), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function probe(value: number): number[] {
  const features = new Array<number>(RELEVANCE_FEATURE_COUNT).fill(0);
  features[0] = value;
  return features;
}

test("focal loss trains a separable set", () => {
  const model = new RelevanceModel({ hidden: 4 });
  model.train(separable(), { epochs: 150, learningRate: 0.5, loss: "focal", gamma: 2 });
  assert.ok(model.predict(probe(1.5)) > model.predict(probe(-1.5)));
  assert.ok(model.predict(probe(1.5)) > 0.5);
});

test("pairwise (RankNet) training ranks positives above hard negatives", () => {
  const model = new RelevanceModel({ hidden: 4 });
  const pairs = Array.from({ length: 300 }, (_, index) => ({
    positiveFeatures: probe(1 + index / 1000),
    negativeFeatures: probe(-1 - index / 1000),
  }));
  model.trainPairs(pairs, { epochs: 40, learningRate: 0.1 });
  assert.ok(model.predict(probe(1)) > model.predict(probe(-1)));
});

test("Platt calibration returns finite parameters and keeps predict in (0,1)", () => {
  const model = new RelevanceModel({ hidden: 4 });
  model.train(separable(200), { epochs: 20, learningRate: 0.5 });
  const calibration = model.fitCalibration(separable(200));
  assert.ok(Number.isFinite(calibration.scale) && Number.isFinite(calibration.shift));
  for (const value of [-2, -1, 0, 1, 2]) {
    const probability = model.predict(probe(value));
    assert.ok(probability > 0 && probability < 1);
  }
});

test("a core-only head ignores the scale-bound feature block", () => {
  const model = new RelevanceModel({
    columns: columnsForBlocks(["core"]),
    blocks: ["core"],
    embedder: "none",
  });
  assert.equal(model.featureCount, RELEVANCE_FEATURE_COUNT - BLOCK_COLUMNS.retrieval.length);
  // Embedder-free: it loads whatever the runtime is.
  assert.equal(model.requiresEmbeddedScores(), false);
  assert.equal(model.acceptsEmbedder("gemini-embedding-001::768"), true);
  // And it physically cannot read the optional columns.
  const row = Array.from({ length: RELEVANCE_FEATURE_COUNT }, () => 0.5);
  const skewed = [...row];
  for (const column of BLOCK_COLUMNS.retrieval) skewed[column] = 1234;
  assert.equal(model.predict(row), model.predict(skewed));
});

test("an embedding-block head is bound to the embedder it was trained on", () => {
  const model = new RelevanceModel({
    columns: columnsForBlocks(["core", "retrieval"]),
    blocks: ["core", "retrieval"],
    embedder: "bge-small-en-v1.5::384",
  });
  assert.equal(model.featureCount, RELEVANCE_FEATURE_COUNT);
  assert.equal(model.requiresEmbeddedScores(), true);
  assert.equal(model.acceptsEmbedder("bge-small-en-v1.5::384"), true);
  // A different embedder means a different absolute score scale: refuse.
  assert.equal(model.acceptsEmbedder("gemini-embedding-001::768"), false);
  assert.equal(model.acceptsEmbedder("none"), false);
  const restored = RelevanceModel.fromJSON(model.toJSON());
  assert.deepEqual(restored.columns, model.columns);
  assert.deepEqual(restored.blocks, model.blocks);
  assert.equal(restored.embedder, model.embedder);
});

test("a malformed column list is refused at load, not predicted from", () => {
  const state = new RelevanceModel({ hidden: 4 }).toJSON();
  assert.throws(() => RelevanceModel.fromJSON({ ...state, columns: [0, 0] }), /unique/u);
  assert.throws(
    () => RelevanceModel.fromJSON({ ...state, columns: [RELEVANCE_FEATURE_COUNT] }),
    /out of range/u,
  );
  assert.throws(() => RelevanceModel.fromJSON({ ...state, columns: [] }), /at least one column/u);
});
