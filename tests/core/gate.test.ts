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

test("先前 and 之前 give the same explicit recall decision for a fresh-session question", () => {
  const question = (cue: string) =>
    `用户对 NodeMemoryGraph 的 AG 状态与可见内容改进，${cue}提出过哪些实现约束？请仅报告本轮自动召回消息中的候选，不把候选当成已核实事实。`;
  const expected = decideMemoryLoad(question("之前"));
  assert.equal(expected.mode, "retrieve");
  assert.deepEqual(decideMemoryLoad(question("先前")), expected);
});

test("Chinese recollection questions without a temporal prefix trigger recall", () => {
  for (const question of [
    "你记得 working-state-maintenance Skill装在哪里吗？",
    "你记得我的偏好是什么？",
    "您记得我们选的是哪个吗？",
    "好像是不是要精简AG内容来着？还有其他几步其他的？",
    "那个目录叫什么来着?",
  ]) {
    assert.deepEqual(decideMemoryLoad(question), decideMemoryLoad("之前决定了什么？"), question);
  }
});

test("reminders and colorization are not recollection questions", () => {
  for (const instruction of [
    "记得保存文件。",
    "你记得把测试跑完。",
    "以后记得运行测试。",
    "这个工具用来着色。",
  ]) {
    assert.equal(decideMemoryLoad(instruction).mode, "none", instruction);
  }
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

test("supported multilingual recall cues trigger without matching generic questions", () => {
  assert.equal(decideMemoryLoad("Was haben wir letztes Mal entschieden?").mode, "retrieve");
  assert.equal(decideMemoryLoad("Qu'avons-nous décidé la dernière fois ?").mode, "retrieve");
  assert.equal(decideMemoryLoad("前回は何を決めましたか？").mode, "retrieve");
  assert.equal(decideMemoryLoad("¿Qué decidimos la última vez?").mode, "retrieve");
  assert.equal(decideMemoryLoad("Erkläre SQLite-Indizes.").mode, "none");
  assert.equal(decideMemoryLoad("Explique les index SQLite.").mode, "none");
  assert.equal(decideMemoryLoad("SQLiteのインデックスを説明してください。").mode, "none");
  assert.equal(decideMemoryLoad("Explica los índices de SQLite.").mode, "none");
});
