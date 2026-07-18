import assert from "node:assert/strict";
import test from "node:test";

import { decideMemoryLoad } from "./gate.ts";

test("explicit questions about past or current user state trigger automatic recall", () => {
  assert.equal(decideMemoryLoad("我之前使用过什么视频软件？").mode, "retrieve");
  assert.equal(decideMemoryLoad("What is my current 5K personal best?").mode, "retrieve");
  assert.equal(
    decideMemoryLoad("How many items of clothing do I need to pick up?").mode,
    "retrieve",
  );
  assert.equal(decideMemoryLoad("When was my last museum visit?").mode, "retrieve");
  assert.equal(decideMemoryLoad("Do you remember what we decided last time?").mode, "retrieve");
});

test("planning and recommendation prompts receive recall cues", () => {
  assert.equal(decideMemoryLoad("推荐一个适合我的剪辑方案").mode, "cue");
  assert.equal(decideMemoryLoad("How should we plan the next release?").mode, "cue");
});

test("ordinary prompts do not load dynamic long-term memory", () => {
  assert.equal(decideMemoryLoad("计算 2 + 2").mode, "none");
  assert.equal(decideMemoryLoad("Explain how a B-tree works").mode, "none");
});
