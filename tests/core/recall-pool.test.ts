import assert from "node:assert/strict";
import test from "node:test";
import { RecallPool } from "../../src/core/recall-pool.ts";
import { RECALL_VOCABULARY, RECALL_POOL_CAPACITY } from "../../src/core/recall-vocabulary.ts";
import { decideMemoryLoad } from "../../src/core/gate.ts";

const seed = (phrase: string) => ({ phrase, mode: "cue" as const });

test("the entire seed vocabulary fits with growth room; additions need no regex", () => {
  assert.ok(RECALL_VOCABULARY.length < RECALL_POOL_CAPACITY);
  const pool = new RecallPool([seed("custom workflow")]);
  assert.equal(pool.observe("Use CUSTOM WORKFLOW", 1)?.phrase, "custom workflow");
  assert.equal(pool.observe("custom workflows", 2), undefined);
});

test("seed and learned terms share capacity and evicted seeds do not return on lookup", () => {
  const pool = new RecallPool([seed("seed alpha"), seed("seed beta")], 2, 1);
  pool.add(seed("learned gamma"));
  assert.equal(pool.observe("seed alpha", 1), undefined);
  assert.equal(pool.entries().length, 2);
  assert.equal(pool.observe("learned gamma", 2)?.phrase, "learned gamma");
  assert.equal(pool.observe("seed alpha", 3), undefined);
  assert.equal(decideMemoryLoad("previously", { terms: [] }).mode, "none");
});

test("two distinct user turns promote; repeated reads in one turn do not", () => {
  const pool = new RecallPool([seed("seed alpha"), seed("seed beta")], 2, 1);
  pool.observe("seed alpha", 1);
  pool.observe("seed alpha", 1);
  assert.equal(pool.entries().find((e) => e.phrase === "seed alpha")?.protected, false);
  pool.observe("seed alpha", 2);
  assert.equal(pool.entries().find((e) => e.phrase === "seed alpha")?.protected, true);
  pool.add(seed("new gamma"));
  assert.equal(pool.observe("seed beta", 3), undefined);
  assert.equal(pool.observe("seed alpha", 4)?.phrase, "seed alpha");
});

test("protected overflow demotes the least recent term, without seed immunity", () => {
  const pool = new RecallPool([seed("seed alpha"), seed("seed beta")], 2, 1);
  for (const turn of [1, 2]) pool.observe("seed alpha", turn);
  for (const turn of [3, 4]) pool.observe("seed beta", turn);
  pool.add(seed("new gamma"));
  assert.equal(pool.observe("seed alpha", 5), undefined);
  assert.equal(pool.observe("seed beta", 6)?.phrase, "seed beta");
});

test("removal covers all forms of a seed phrase and remains removed", () => {
  const pool = new RecallPool();
  assert.equal(pool.remove("what"), true);
  assert.equal(pool.observe("What is my setup?", 1), undefined);
  assert.equal(pool.observe("What should i use?", 2)?.mode, "cue");
});

test("seed phrases keep question and context conditions; quoted words cannot gain retention", () => {
  const pool = new RecallPool();
  assert.equal(pool.observe("你记得跑测试。", 1), undefined);
  assert.equal(pool.observe("你记得装在哪里吗？", 2)?.mode, "retrieve");
  assert.equal(pool.observe("这个工具用来着色。", 3), undefined);
  assert.equal(pool.observe('Output "previously"', 4), undefined);
  assert.equal(pool.observe("previously password=fixture-only", 5), undefined);
});
