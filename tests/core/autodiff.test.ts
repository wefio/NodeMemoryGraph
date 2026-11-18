import assert from "node:assert/strict";
import test from "node:test";

import { Tensor } from "../../src/core/autodiff.ts";
import { tryMatvecSimd } from "../../src/core/matvec-simd.ts";

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

test("matrix multiplication preserves rectangular tails and gradients", () => {
  const left = Tensor.matrix([1, 2, 3, 4, 5, 6], 2, 3, true);
  const right = Tensor.matrix([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 3, 5, true);
  const product = left.matmul(right);

  assert.deepEqual([...product.data], [46, 52, 58, 64, 70, 100, 115, 130, 145, 160]);
  product.sum().backward();
  assert.deepEqual([...left.grad], [15, 40, 65, 15, 40, 65]);
  assert.deepEqual([...right.grad], [5, 5, 5, 5, 5, 7, 7, 7, 7, 7, 9, 9, 9, 9, 9]);
});

test("SIMD matvec preserves Float32 accumulation across blocks and odd dimensions", () => {
  const rows = 1025;
  const columns = 1025;
  const matrix = Float32Array.from({ length: rows * columns }, (_, i) => Math.sin(i) / 3);
  const vector = Float32Array.from({ length: columns }, (_, i) => Math.cos(i) / 5);
  matrix[columns] = Number.NaN;
  matrix[columns * 2] = Number.POSITIVE_INFINITY;
  matrix[columns * 3] = -0;
  const result = new Float32Array(rows);
  assert.equal(tryMatvecSimd(matrix, vector, result), true);
  for (let row = 0; row < rows; row += 1) {
    let sum = 0;
    for (let column = 0; column < columns; column += 1) {
      sum = Math.fround(sum + matrix[row * columns + column]! * vector[column]!);
    }
    assert.ok(Object.is(result[row], sum), `row ${row} differs from scalar Float32 accumulation`);
  }
  assert.equal(tryMatvecSimd(matrix, vector, result.subarray(0, 2)), false);
  assert.equal(
    tryMatvecSimd(matrix.subarray(0, 2 * columns), vector, result.subarray(0, 2)),
    false,
  );
});

test("large autodiff matvec gives the same analytic gradients on repeated backward passes", () => {
  const rows = 129;
  const columns = 1025;
  const values = Float32Array.from({ length: rows * columns }, (_, i) => (i % 23) - 11);
  const weights = Tensor.matrix(values, rows, columns, true);
  const input = Tensor.vector(new Float32Array(columns).fill(2), true);
  const loss = weights.matmul(input).sum();
  const expectedInputGradient = Float32Array.from({ length: columns }, (_, column) => {
    let sum = 0;
    for (let row = 0; row < rows; row += 1) sum += values[row * columns + column]!;
    return sum;
  });
  assert.equal(
    loss.scalarValue,
    values.reduce((sum, value) => sum + value * 2, 0),
  );
  for (let turn = 0; turn < 2; turn += 1) {
    weights.zeroGrad();
    input.zeroGrad();
    loss.backward();
    assert.ok(weights.grad.every((value) => value === 2));
    assert.deepEqual(input.grad, expectedInputGradient);
  }
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

test("L2 normalization gradient agrees with finite differences", () => {
  const values = [0.3, -0.4, 0.5];
  const weights = Tensor.vector([0.2, 0.7, -0.1]);
  const input = Tensor.vector(values, true);
  input.l2Normalize().dot(weights).backward();

  const epsilon = 1e-3;
  const evaluate = (items: number[]) => Tensor.vector(items).l2Normalize().dot(weights).scalarValue;
  values.forEach((_, index) => {
    const above = [...values];
    const below = [...values];
    above[index]! += epsilon;
    below[index]! -= epsilon;
    const numerical = (evaluate(above) - evaluate(below)) / (2 * epsilon);
    approximately(input.grad[index]!, numerical, 2e-4);
  });
});

test("SumN accumulates gradients when an input is shared", () => {
  const shared = Tensor.vector([1, 2, 3], true);
  const other = Tensor.vector([4, 5, 6], true);

  Tensor.sumN([shared, shared, other]).sum().backward();

  assert.deepEqual([...shared.grad], [2, 2, 2]);
  assert.deepEqual([...other.grad], [1, 1, 1]);
});
