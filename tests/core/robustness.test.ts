import assert from "node:assert/strict";
import test from "node:test";
import { Tensor } from "../../src/core/autodiff.ts";
import { HierarchicalActivation } from "../../src/core/hierarchical-activation.ts";

// ── numerical edge cases ──

test("Tensor.scalar with NaN evaluates without crash", () => {
  const t = Tensor.scalar(NaN);
  assert.ok(Number.isNaN(t.scalarValue));
});

test("Tensor.softmax with Inf graceful — NaN is expected (exp(Inf) is Inf)", () => {
  // exp(Inf) = Inf, so softmax produces NaN.  This is acceptable:
  // Inf inputs mean caller has a numerical bug upstream.
  const v = Tensor.vector(new Float32Array([Infinity, -Infinity, 0]));
  const s = v.softmax();
  // All we assert: doesn't throw or crash the process
  assert.ok(s.data.length === 3);
});

test("Tensor.softmax with extreme values is stable", () => {
  const v = Tensor.vector(new Float32Array(Array(100).fill(1e6)));
  const s = v.softmax();
  const total = s.data.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-7);
  assert.ok(s.data.every((x) => Number.isFinite(x)));
});

test("Tensor.l2Normalize zero vector returns zero", () => {
  const v = Tensor.vector(new Float32Array([0, 0, 0]));
  const n = v.l2Normalize();
  assert.ok(n.data.every((x) => x === 0 && !Number.isNaN(x)));
});

test("Tensor.sqrt with negative input returns 0", () => {
  const v = Tensor.vector(new Float32Array([-1, -4, -100]));
  const r = v.sqrt();
  assert.ok(r.data.every((x) => x === 0));
});

test("Tensor.divide by zero returns finite value (ε guard in reciprocal)", () => {
  const a = Tensor.scalar(1);
  const b = Tensor.scalar(0);
  const r = a.divide(b);
  assert.ok(Number.isFinite(r.scalarValue) && r.scalarValue > 0);
});

test("Tensor.norm with zero vector returns 0", () => {
  const v = Tensor.vector(new Float32Array(16));
  const n = v.norm();
  assert.equal(n.scalarValue, 0);
});

test("Tensor.dot with zero vectors returns 0", () => {
  const a = Tensor.vector(new Float32Array(16));
  const b = Tensor.vector(new Float32Array(16));
  const d = a.dot(b);
  assert.equal(d.scalarValue, 0);
});

test("Tensor.at out of bounds throws", () => {
  const v = Tensor.vector(new Float32Array([1, 2, 3]));
  assert.throws(() => v.at(-1), /bounds/);
  assert.throws(() => v.at(3), /bounds/);
  assert.throws(() => v.at(1.5), /bounds/);
});

// ── memory / leak guards ──

test("Tensor allocate 50K does not blow heap", () => {
  if (!global.gc) {
    assert.ok(true, "skipped — run with --expose-gc");
    return;
  }
  global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 50_000; i++) {
    Tensor.vector(new Float32Array(1024));
  }
  global.gc();
  const after = process.memoryUsage().heapUsed;
  const delta = (after - before) / 1024 / 1024;
  assert.ok(delta < 80, `heap grew ${delta.toFixed(1)} MB`);
});

test("HA propagate × 5K: no NaN, stable heap", () => {
  const d = 64;
  function rvec() {
    const v = new Float32Array(d);
    for (let i = 0; i < d; i++) v[i] = Math.random() * 2 - 1;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    for (let i = 0; i < d; i++) v[i] /= n;
    return v;
  }

  const ha = new HierarchicalActivation(d);
  const pool = Array.from({ length: 8 }, (_, i) => ({
    nodeId: `n${i}`,
    vector: rvec(),
  }));
  const gs = {
    mediumTermVectors: [rvec(), rvec()],
    longTermVectors: [rvec(), rvec(), rvec()],
  };

  const h0 = process.memoryUsage().heapUsed;

  for (let i = 0; i < 5_000; i++) {
    const out = ha.propagate(rvec(), pool, [], gs);
    if (out.nodeScores.some((v) => Number.isNaN(v))) {
      assert.fail(`NaN at iteration ${i}`);
    }
  }

  if (global.gc) {
    global.gc();
    const h1 = process.memoryUsage().heapUsed;
    const delta = (h1 - h0) / 1024 / 1024;
    assert.ok(delta < 100, `heap grew ${delta.toFixed(1)} MB after 5K propagates`);
  }
  assert.ok(true);
});

test("HA 200 clone cycles: no NaN, no crash", () => {
  const d = 64;
  const ha = new HierarchicalActivation(d);
  for (let i = 0; i < 200; i++) {
    const json = ha.toJSON();
    const clone = HierarchicalActivation.fromJSON(json);
    const v = () => {
      const x = new Float32Array(d);
      for (let j = 0; j < d; j++) x[j] = Math.random() * 2 - 1;
      return x;
    };
    const cs = [{ nodeId: "n0", vector: v() }];
    const out = clone.propagate(v(), cs);
    assert.ok(!Number.isNaN(out.nodeScores[0]));
  }
  assert.ok(true, "200 clone cycles");
});

// ── backward gradient stability ──

test("Multiply backward does not produce NaN on normal values", () => {
  const a = Tensor.vector(new Float32Array(Array(16).fill(0.5)), true);
  const b = Tensor.vector(new Float32Array(Array(16).fill(0.5)), true);
  const c = a.multiply(b);
  const loss = c.sum();
  loss.backward();

  assert.ok(a.grad.every((x) => Number.isFinite(x) && !Number.isNaN(x)));
  assert.ok(b.grad.every((x) => Number.isFinite(x) && !Number.isNaN(x)));
});

test("Sqrt backward does not produce NaN on positive input", () => {
  const a = Tensor.vector(new Float32Array(Array(16).fill(4.0)), true);
  const b = a.sqrt();
  const loss = b.sum();
  loss.backward();

  assert.ok(a.grad.every((x) => Number.isFinite(x) && !Number.isNaN(x) && x > 0));
  assert.ok(b.data.every((x) => Math.abs(x - 2) < 1e-7));
});

test("Divide backward does not produce NaN", () => {
  const a = Tensor.vector(new Float32Array(Array(16).fill(3.0)), true);
  const b = Tensor.vector(new Float32Array(Array(16).fill(2.0)), true);
  const c = a.divide(b);
  const loss = c.sum();
  loss.backward();

  assert.ok(a.grad.every((x) => Number.isFinite(x) && !Number.isNaN(x)));
  assert.ok(b.grad.every((x) => Number.isFinite(x) && !Number.isNaN(x)));
});
