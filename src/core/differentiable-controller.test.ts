import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROLLER_BUDGET_DIMENSIONS,
  DifferentiableController,
} from "./differentiable-controller.ts";

test("differentiable controller learns node, edge, control, and budget targets", () => {
  const controller = new DifferentiableController(2);
  const budgetTargets = [0.9, 0.8, 0.7, 0.6, 0.4, 0.3, 0.2];
  let firstLoss = 0;
  let lastLoss = 0;
  for (let step = 0; step < 1_000; step += 1) {
    const result = controller.train(
      {
        nodes: [
          { features: [1, 0], target: true },
          { features: [-1, 0], target: false },
        ],
        edges: [
          { features: [0, 1], target: true },
          { features: [0, -1], target: false },
        ],
        control: { features: [1, 1], target: "expand" },
        budget: { features: [1, 1], targets: budgetTargets },
      },
      0.1,
    );
    if (step === 0) firstLoss = result.loss;
    lastLoss = result.loss;
  }

  assert.ok(lastLoss < firstLoss * 0.25);
  assert.ok(controller.scoreNode([1, 0]) > 0.85);
  assert.ok(controller.scoreNode([-1, 0]) < 0.15);
  assert.ok(controller.scoreEdge([0, 1]) > 0.85);
  assert.ok(controller.scoreEdge([0, -1]) < 0.15);
  assert.equal(controller.chooseControl([1, 1]).action, "expand");
  assert.ok(controller.chooseControl([1, 1]).probabilities.expand > 0.9);
  const allocation = controller.allocateBudget([1, 1]);
  CONTROLLER_BUDGET_DIMENSIONS.forEach((dimension, index) => {
    assert.ok(Math.abs(allocation[dimension] - budgetTargets[index]!) < 0.2);
  });
});

test("differentiable controller state round-trips without changing decisions", () => {
  const controller = new DifferentiableController(3);
  controller.train({ nodes: [{ features: [1, 0, -1], target: true }] }, 0.2);
  const restored = DifferentiableController.fromJSON(controller.toJSON());

  assert.equal(restored.trainingSteps, 1);
  assert.equal(restored.scoreNode([1, 0, -1]), controller.scoreNode([1, 0, -1]));
  assert.deepEqual(restored.toJSON(), controller.toJSON());
});

test("differentiable controller rejects malformed features and empty feedback", () => {
  const controller = new DifferentiableController(2);
  assert.throws(() => controller.scoreNode([1]), /expected 2 controller features/);
  assert.throws(() => controller.train({}), /at least one target/);
  assert.throws(
    () => controller.train({ budget: { features: [1, 1], targets: [0.5] } }),
    /budget target count/,
  );
});
