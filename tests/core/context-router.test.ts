import assert from "node:assert/strict";
import test from "node:test";

import { ContextRouter, CONTEXT_ACTIONS } from "../../src/lab/context-router.ts";

const features = Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0));

test("router is a 132-parameter gate; permissions and costs remain external", () => {
  const router = new ContextRouter();
  assert.equal(router.parameters().length, 132);
  assert.deepEqual(router.values(features), [0, 0, 0, 0]);
  assert.equal(router.select(features, ["none", "retrieve"], [0, 0, 0, 1]).action, "none");
  assert.equal(router.select(features, ["retrieve"]).action, "retrieve");
  assert.throws(() => router.select(features, []), /allowed/);
});

test("observed-action regression never treats unexecuted actions as failures", () => {
  const router = new ContextRouter();
  router.update(features, "retrieve", 1, 0.1);
  const values = router.values(features);
  assert.deepEqual(values.slice(0, 3), [0, 0, 0]);
  assert.ok(values[3]! > 0);
  router.update(features, "cue", -1, 0.1);
  assert.ok(router.values(features)[1]! < 0);
  assert.equal(router.values(features)[3], values[3]);
});

test("epsilon exploration reports the probability of the actually sampled action", () => {
  const router = new ContextRouter();
  const selected = router.select(features, ["none", "retrieve"], undefined, 0.2, () => 0.95);
  assert.equal(selected.action, "retrieve");
  assert.ok(Math.abs(selected.probability - 0.1) < 1e-12);
  const greedy = router.select(features, ["none", "retrieve"], undefined, 0.2, () => 0);
  assert.equal(greedy.probability, 0.9);
  assert.equal(CONTEXT_ACTIONS.length, 4);
});

test("parameter snapshots are detached and round-trip without changing predictions", () => {
  const router = new ContextRouter();
  router.update(features, "resurface", 0.7, 0.1);
  const weights = router.parameters();
  const restored = new ContextRouter(weights);
  assert.deepEqual(restored.values(features), router.values(features));
  weights.fill(99);
  assert.deepEqual(restored.values(features), router.values(features));
});

test("changing samples/actions agree with finite-difference loss gradients", () => {
  const router = new ContextRouter(Array.from({ length: 132 }, (_, i) => ((i % 7) - 3) * 0.01));
  for (let step = 0; step < 8; step++) {
    const x = Array.from({ length: 32 }, (_, i) => (((i + step) % 5) - 2) / 4);
    const action = CONTEXT_ACTIONS[step % 4]!;
    const index = step % 4;
    const reward = step % 2 ? 0.3 : -0.6;
    const before = router.parameters();
    const loss = (weights: number[]) => {
      const prediction = x.reduce(
        (sum, value, i) => sum + value * weights[index * 32 + i]!,
        weights[128 + index]!,
      );
      return 0.5 * (prediction - reward) ** 2;
    };
    const numeric = before.map((_, i) => {
      const plus = [...before];
      const minus = [...before];
      plus[i]! += 0.001;
      minus[i]! -= 0.001;
      return (loss(plus) - loss(minus)) / 0.002;
    });
    const measured = router.update(x, action, reward, 0.05);
    assert.ok(Math.abs(measured - loss(before)) < 1e-6);
    const after = router.parameters();
    for (let i = 0; i < 132; i++) {
      assert.ok(
        Math.abs(after[i]! - (before[i]! - 0.05 * numeric[i]!)) < 1e-6,
        `step ${step}, parameter ${i}`,
      );
    }
  }
});

test("invalid numerical inputs are rejected before parameters change", () => {
  const router = new ContextRouter();
  const before = router.parameters();
  assert.throws(() => router.update(features, "cue", NaN, 0.1), /reward/);
  assert.throws(() => router.update(features, "cue", 1, Infinity), /learning rate/);
  assert.throws(() => router.values([1]), /32/);
  assert.throws(() => router.values(features.map(() => Infinity)), /features/);
  assert.throws(() => router.select(features, ["none"], [0, 0, 0, NaN]), /cost/);
  assert.throws(() => router.select(features, ["none"], undefined, 2), /epsilon/);
  assert.throws(() => router.select(features, ["none"], undefined, 0, () => 1), /random/);
  assert.deepEqual(router.parameters(), before);
});
