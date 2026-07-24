/**
 * ForkMerge live demo: same query → two HA branches → joint gradient.
 *
 * Shows:
 * 1. Forward: two HAs score the same candidates independently
 * 2. Contrastive training: push branches apart (minimise cosine similarity)
 * 3. Alignment training: pull branches together (maximise cosine similarity)
 * 4. Stable convergence on both sides
 */

import { HierarchicalActivation } from "../src/core/hierarchical-activation.ts";
import { ForkMerge } from "../src/core/fork-merge.ts";

const D = 64;
const N = 12;

// ── helpers ──

function rvec(): Float32Array {
  const v = new Float32Array(D);
  for (let i = 0; i < D; i++) v[i] = Math.random() * 2 - 1;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < D; i++) v[i] /= n;
  return v;
}

function cands(): Array<{ nodeId: string; vector: Float32Array }> {
  return Array.from({ length: N }, (_, i) => ({
    nodeId: `n${i}`,
    vector: rvec(),
  }));
}

// ── setup: two HAs with slightly different temperatures ──

const base = new HierarchicalActivation(D);
const jA = base.toJSON();
jA.temperature = 1.0;
const left = HierarchicalActivation.fromJSON(jA);

const jB = base.toJSON();
jB.temperature = 3.0; // softer attention, scores will differ
const right = HierarchicalActivation.fromJSON(jB);

const fm = new ForkMerge(left, right, { divergenceWeight: 2.0 });

// ── demo ──

const query = rvec();
const pool = cands();

console.log("═".repeat(55));
console.log("  ForkMerge Demo");
console.log("═".repeat(55));
console.log(`  dim=${D} candidates=${N} left_temp=1.0 right_temp=3.0`);

// Baseline
const r0 = fm.forward(query, pool);
console.log(`\n  baseline divergence: ${r0.divergence.toFixed(6)}`);

// Contrastive training (push apart)
console.log("\n── contrastive training (push apart) ──");
for (let epoch = 0; epoch < 5; epoch++) {
  let totalLoss = 0;
  for (let i = 0; i < 20; i++) {
    const sample = { query: rvec(), candidates: cands() };
    const { loss } = fm.trainContrastive(sample, 0.05);
    totalLoss += loss;
  }
  const div = fm.forward(query, pool).divergence;
  console.log(`  epoch ${epoch + 1}: loss=${(totalLoss / 20).toFixed(4)} div=${div.toFixed(6)}`);
}

// Alignment training (pull together)
console.log("\n── alignment training (pull together) ──");
for (let epoch = 0; epoch < 5; epoch++) {
  let totalLoss = 0;
  for (let i = 0; i < 20; i++) {
    const sample = { query: rvec(), candidates: cands() };
    const { loss } = fm.trainAlign(sample, 0.05);
    totalLoss += loss;
  }
  const div = fm.forward(query, pool).divergence;
  console.log(`  epoch ${epoch + 1}: loss=${(totalLoss / 20).toFixed(4)} div=${div.toFixed(6)}`);
}

console.log("\n── serialisation ──");
const json = fm.toJSON();
console.log(`  left trainingSteps:  ${json.left.trainingSteps}`);
console.log(`  right trainingSteps: ${json.right.trainingSteps}`);
console.log(`  divergenceWeight:    ${json.config.divergenceWeight}`);
console.log("═".repeat(55));
