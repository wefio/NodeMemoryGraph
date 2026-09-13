import assert from "node:assert/strict";
import test from "node:test";

import {
  QUERY_SURFACE_FEATURE_NAMES,
  SCALE_BOUND_FEATURE_NAMES,
  SHAPE_FEATURE_NAMES,
  SUFFICIENCY_FEATURE_NAMES,
  querySurfaceFeatures,
  shapeFeatures,
  sufficiencyFeatures,
} from "../../src/core/sufficiency-features.ts";

/** One named shape feature of a list, so a test reads as the property it checks. */
function feature(scores: readonly number[], tau: number, name: string): number {
  const index = SHAPE_FEATURE_NAMES.indexOf(name as never);
  assert.ok(index >= 0, `unknown shape feature ${name}`);
  return shapeFeatures(scores, tau)[index]!;
}

const close = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: ${actual} != ${expected}`);

const MONOTONE = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1];

test("a monotone list has an exact shape", () => {
  close(feature(MONOTONE, 0.5, "top1"), 1, "top1");
  close(feature(MONOTONE, 0.5, "top_gap"), 0.1, "top_gap");
  // The top gap is one ninth of the top-10 range, not of the whole list.
  close(feature(MONOTONE, 0.5, "gap_concentration"), 0.1 / 0.9, "gap_concentration");
  close(feature(MONOTONE, 0.5, "decay_slope"), -0.1, "decay_slope");
  close(feature(MONOTONE, 0.5, "elbow"), 0, "elbow");
  close(feature(MONOTONE, 0.5, "top10_std"), Math.sqrt(0.0825), "top10_std");
  close(feature(MONOTONE, 0.5, "list_length"), 10, "list_length");
  close(feature(MONOTONE, 0.5, "nn_above_tau"), 6, "nn_above_tau");
  close(feature(MONOTONE, 0.5, "margin_over_tau"), 0.5, "margin_over_tau");
});

test("a flat list has no shape at all", () => {
  const flat = [0.5, 0.5, 0.5];
  close(feature(flat, 0.5, "top_gap"), 0, "top_gap");
  // Zero range must not produce a division: it is zero, not undefined.
  close(feature(flat, 0.5, "gap_concentration"), 0, "gap_concentration");
  close(feature(flat, 0.5, "top10_std"), 0, "top10_std");
  close(feature(flat, 0.5, "decay_slope"), 0, "decay_slope");
  close(feature(flat, 0.5, "elbow"), 0, "elbow");
  close(feature(flat, 0.5, "top5_concentration"), 1, "top5_concentration");
  // Fewer than ten candidates means no deep window, so the bimodal gap is the
  // top-three mean itself. Locked here because it is a definition, not a detail.
  close(feature(flat, 0.5, "bimodal_gap"), 0.5, "bimodal_gap");
  close(feature(flat, 0.5, "nn_above_tau"), 3, "nn_above_tau");
});

test("an elbow is reported where the list breaks", () => {
  const elbowed = [1, 0.95, 0.9, 0.2, 0.15, 0.1];
  close(feature(elbowed, 0.2, "elbow"), 0.65, "elbow");
  assert.ok(
    feature(elbowed, 0.2, "elbow") > feature(MONOTONE, 0.2, "elbow"),
    "a break must score above a straight line",
  );
  // The break is the top gap, so concentration sees it too.
  // The range is top1 - the tenth score (here the last one, 0.1), not top1 - top2.
  close(feature(elbowed, 0.2, "gap_concentration"), 0.05 / 0.9, "gap_concentration");
});

test("an empty list is zeros rather than an error", () => {
  const values = shapeFeatures([], 0.5);
  assert.equal(values.length, SHAPE_FEATURE_NAMES.length);
  assert.ok(
    values.every((value) => value === 0),
    "an empty list must be a value the decision layer can see",
  );
});

test("shape features refuse non-finite input and never reorder the caller's list", () => {
  assert.throws(() => shapeFeatures([1, Number.NaN], 0.5), /must be finite/);
  assert.throws(() => shapeFeatures([1, 0.5], Number.POSITIVE_INFINITY), /tau must be finite/);
  const unsorted = [0.2, 0.9, 0.4];
  shapeFeatures(unsorted, 0.5);
  assert.deepEqual(unsorted, [0.2, 0.9, 0.4], "the caller's array is not mutated");
});

test("the feature names and the produced rows agree", () => {
  assert.equal(shapeFeatures([1, 0.5], 0.5).length, SHAPE_FEATURE_NAMES.length);
  assert.equal(querySurfaceFeatures("q").length, QUERY_SURFACE_FEATURE_NAMES.length);
  assert.equal(sufficiencyFeatures([1, 0.5], "q", 0.5).length, SUFFICIENCY_FEATURE_NAMES.length);
  for (const name of SCALE_BOUND_FEATURE_NAMES) {
    assert.ok(
      (SUFFICIENCY_FEATURE_NAMES as readonly string[]).includes(name),
      `scale-bound feature ${name} is not in the declared list`,
    );
  }
});

test("query-surface features count what they say", () => {
  const [chars, words, average, hasNumbers, punctuation] =
    querySurfaceFeatures("Atlas uses SQLite 3!");
  close(chars!, 20, "chars");
  close(words!, 4, "words");
  close(average!, 4, "average word length");
  close(hasNumbers!, 1, "has numbers");
  close(punctuation!, 1, "punctuation");
  const [emptyChars, emptyWords, emptyAverage] = querySurfaceFeatures("");
  close(emptyChars!, 0, "empty chars");
  close(emptyWords!, 0, "empty words");
  close(emptyAverage!, 0, "empty average");
});
