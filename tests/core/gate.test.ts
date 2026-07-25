import assert from "node:assert/strict";
import test from "node:test";

import { decideMemoryLoad } from "../../src/core/gate.ts";

// ── explicit recall (retrieve) ──

test("explicit questions about past or current user state trigger automatic recall", () => {
  assert.equal(decideMemoryLoad("我之前使用过什么视频软件？").mode, "retrieve");
  assert.equal(decideMemoryLoad("What is my current 5K personal best?").mode, "retrieve");
  assert.equal(
    decideMemoryLoad("How many items of clothing do I need to pick up?").mode,
    "retrieve",
  );
  assert.equal(decideMemoryLoad("When was my last museum visit?").mode, "retrieve");
  assert.equal(decideMemoryLoad("Do you remember what we decided last time?").mode, "retrieve");
  assert.equal(decideMemoryLoad("What did Caroline research?").mode, "retrieve");
  assert.equal(decideMemoryLoad("What did Caroline research?").maxTier, 3);
});

// ── planning and recommendation (cue) ──

test("planning and recommendation prompts receive recall cues", () => {
  assert.equal(decideMemoryLoad("推荐一个适合我的剪辑方案").mode, "cue");
  assert.equal(decideMemoryLoad("How should we plan the next release?").mode, "cue");
});

// ── no memory needed ──

test("ordinary prompts do not load dynamic long-term memory", () => {
  assert.equal(decideMemoryLoad("计算 2 + 2").mode, "none");
  assert.equal(decideMemoryLoad("Explain how a B-tree works").mode, "none");
});

// ── Chinese positive coverage ──

test("Chinese second-person recall patterns match", () => {
  // Time-anchored or context-prefixed queries the regex gate is expected to catch.
  assert.equal(decideMemoryLoad("我上次决定过了吗？").mode, "retrieve");
  assert.equal(decideMemoryLoad("我们当时是怎么商量的？").mode, "retrieve");
  assert.equal(decideMemoryLoad("我之前说过我的预算吗？").mode, "retrieve");
  assert.equal(decideMemoryLoad("还记得上个月那个方案吗？").mode, "retrieve");
  assert.equal(decideMemoryLoad("我现在的偏好是什么？").mode, "retrieve");
  assert.equal(decideMemoryLoad("我最近用的哪个好一点？").mode, "retrieve");
  assert.equal(decideMemoryLoad("根据我的习惯推荐一个").mode, "retrieve");
  assert.equal(decideMemoryLoad("按照我的要求来").mode, "retrieve");
  assert.equal(decideMemoryLoad("根据我的偏好推荐一个").mode, "retrieve");
  // Bare-first-person queries without a temporal or context marker do not match
  // any current pattern. These are known false negatives of a regex-only gate.
  assert.equal(decideMemoryLoad("我选择了什么？").mode, "none");
  assert.equal(decideMemoryLoad("我偏好什么？").mode, "none");
});

// ── Chinese negative coverage (must not match) ──

test("Chinese factual or meta-level questions do not trigger memory retrieval", () => {
  assert.equal(decideMemoryLoad("Python 的装饰器怎么用？").mode, "none");
  assert.equal(decideMemoryLoad("写一个排序算法").mode, "none");
  assert.equal(decideMemoryLoad("把这段话翻译成英文").mode, "none");
  assert.equal(decideMemoryLoad("现在的汇率是多少？").mode, "none");
  assert.equal(decideMemoryLoad("你好吗？").mode, "none");
  assert.equal(decideMemoryLoad("谢谢").mode, "none");
});

// ── non-English / non-Chinese probe ──

test("known-recognisable non-English prompts default to no retrieval", () => {
  // Gate only has explicit regex entries for Chinese and English. Other
  // languages are not blocked on purpose — they just don't have patterns yet.
  // Expected: mode none. If this one fails, someone added a pattern that
  // over-matches and the gate needs a bounds test.
  assert.equal(decideMemoryLoad("Was ist meine Lieblingsfarbe?").mode, "none");
  assert.equal(decideMemoryLoad("Qu'est-ce que j'ai décidé la dernière fois?").mode, "none");
  assert.equal(decideMemoryLoad("私の好みは何ですか？").mode, "none");
  assert.equal(decideMemoryLoad("¿Qué decidimos la última vez?").mode, "none");
});
