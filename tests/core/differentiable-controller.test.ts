import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROLLER_BUDGET_DIMENSIONS,
  DifferentiableController,
} from "../../src/core/differentiable-controller.ts";

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

test("differentiable controller learns necessary memories separately from noise", () => {
  const controller = new DifferentiableController(2);
  for (let step = 0; step < 500; step += 1) {
    controller.train(
      {
        memories: [
          { features: [1, 0], target: true },
          { features: [-1, 0], target: false },
        ],
      },
      0.1,
    );
  }
  assert.ok(controller.scoreMemory([1, 0]) > 0.85);
  assert.ok(controller.scoreMemory([-1, 0]) < 0.15);
});

test("pairwise memory loss learns evidence-over-noise ordering", () => {
  const controller = new DifferentiableController(2);
  const preferred = [0.8, 0.2];
  const rejected = [0.2, 0.8];
  for (let step = 0; step < 300; step += 1) {
    controller.train(
      {
        memoryPairs: [{ preferredFeatures: preferred, rejectedFeatures: rejected }],
      },
      0.1,
    );
  }
  assert.ok(controller.scoreMemory(preferred) > controller.scoreMemory(rejected) + 0.6);
});

test("differentiable controller state round-trips without changing decisions", () => {
  const controller = new DifferentiableController(3);
  controller.train(
    {
      memories: [{ features: [1, 0, -1], target: true }],
      nodes: [{ features: [1, 0, -1], target: true }],
    },
    0.2,
  );
  const restored = DifferentiableController.fromJSON(controller.toJSON());

  assert.equal(restored.trainingSteps, 1);
  assert.equal(restored.scoreMemory([1, 0, -1]), controller.scoreMemory([1, 0, -1]));
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

test("scalar and batched binary heads match the analytical zero-state gradient", () => {
  const learningRate = 0.1;
  const allExamples = Array.from({ length: 8 }, (_, index) => ({
    features: [(index + 1) / 10, ((index * 3) % 7) / 7, index % 2 === 0 ? 1 : -1],
    target: index % 3 === 0,
  }));

  for (const count of [7, 8]) {
    const examples = allExamples.slice(0, count);
    const controller = new DifferentiableController(3);
    const result = controller.train({ nodes: examples }, learningRate);
    const state = controller.toJSON();
    const expectedGradient = [0, 0, 0];
    let expectedBiasGradient = 0;
    for (const example of examples) {
      const residual = 0.5 - Number(example.target);
      expectedBiasGradient += residual / count;
      example.features.forEach((feature, index) => {
        expectedGradient[index]! += (residual * feature) / count;
      });
    }

    assert.equal(result.observations, count);
    assert.ok(Math.abs(result.loss - Math.log(2)) < 2e-7);
    expectedGradient.forEach((gradient, index) => {
      assert.ok(Math.abs(state.parameters.nodeWeights[index]! + learningRate * gradient) < 1e-7);
    });
    assert.ok(Math.abs(state.parameters.nodeBias[0]! + learningRate * expectedBiasGradient) < 1e-7);
  }
});
