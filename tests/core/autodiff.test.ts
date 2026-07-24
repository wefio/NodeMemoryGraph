import assert from "node:assert/strict";
import test from "node:test";

import { Tensor } from "../../src/core/autodiff.ts";

function approximately(actual: number, expected: number, tolerance = 1e-5): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test("UOp autodiff evaluates lazily and differentiates matrix multiplication", () => {
  const weights = Tensor.matrix([1, 2, 3, 4], 2, 2, true);
  const input = Tensor.vector([5, 6], true);
  const loss = weights.matmul(input).sum();

  assert.equal(loss.scalarValue, 56);
  loss.backward();
  assert.deepEqual([...weights.grad], [5, 6, 5, 6]);
  assert.deepEqual([...input.grad], [4, 6]);
});

test("softmax cross entropy produces the expected graph gradient", () => {
  const logits = Tensor.vector([1, 2, 3], true);
  const probabilities = logits.softmax();
  const loss = probabilities.at(2).log().multiply(Tensor.scalar(-1));

  loss.backward();
  const values = [...probabilities.data];
  approximately(
    values.reduce((sum, value) => sum + value, 0),
    1,
  );
  approximately(logits.grad[0]!, values[0]!);
  approximately(logits.grad[1]!, values[1]!);
  approximately(logits.grad[2]!, values[2]! - 1);
});

test("shared UOps accumulate gradients from multiple graph paths", () => {
  const value = Tensor.scalar(3, true);
  const loss = value.multiply(value).add(value).sum();
  loss.backward();
  approximately(value.grad[0]!, 7);
});
