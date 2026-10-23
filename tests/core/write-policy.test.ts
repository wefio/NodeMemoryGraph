import assert from "node:assert/strict";
import test from "node:test";

import { assessMemoryWrite } from "../../src/core/write-policy.ts";

test("blocks credential-like values before semantic memory storage", () => {
  assert.deepEqual(
    assessMemoryWrite({
      statement: "The API key is sk-test-nmg-123456",
      memoryType: "fact",
    }),
    { allowed: false, reason: "secret" },
  );
});

test("blocks explicitly temporary instructions but permits durable preferences", () => {
  assert.equal(
    assessMemoryWrite({
      statement: "For this response only, answer briefly.",
      memoryType: "preference",
    }).allowed,
    false,
  );
  assert.equal(
    assessMemoryWrite({
      statement: "The user prefers concise Chinese explanations in future sessions.",
      memoryType: "preference",
    }).allowed,
    true,
  );
});

test("permits a temporary occurrence when deliberately encoded as an event", () => {
  assert.equal(
    assessMemoryWrite({
      statement: "The staging server was temporarily unavailable.",
      memoryType: "event",
    }).allowed,
    true,
  );
});

test("permits file names that merely contain the word temporary", () => {
  assert.equal(
    assessMemoryWrite({
      statement: "docs/temporary-todo.md 是项目完成状态的权威清单。",
      memoryType: "fact",
    }).allowed,
    true,
  );
  assert.equal(
    assessMemoryWrite({ statement: "This is a temporary workaround.", memoryType: "fact" }).allowed,
    false,
  );
});

test("escape hatch (unsafe) overrides the transient-word false positive", () => {
  // A genuinely persistent preference whose wording trips the transient-word
  // filter is now persistable via the explicit bypass (docs §3.6) instead of
  // rephrasing to dodge the regex (that would be an accidental, undesigned bypass).
  assert.equal(
    assessMemoryWrite({
      statement: "用户偏好：持久化文档不带临时时间标注。",
      memoryType: "preference",
    }).allowed,
    false,
  );
  assert.equal(
    assessMemoryWrite({
      statement: "用户偏好：持久化文档不带临时时间标注。",
      memoryType: "preference",
      bypass: true,
    }).allowed,
    true,
  );
});

test("escape hatch never overrides secrets or explicit user refusal", () => {
  // Rust-unsafe analogy: the bypass overrides compiler-style checks but never
  // the hard guarantees the harness owns (secrets) or the user's own veto.
  assert.equal(
    assessMemoryWrite({
      statement: "The API key is sk-test-nmg-123456",
      memoryType: "fact",
      bypass: true,
    }).allowed,
    false,
  );
  assert.equal(
    assessMemoryWrite({
      statement: "do not retain this conversation detail",
      memoryType: "fact",
      bypass: true,
    }).allowed,
    false,
  );
  assert.equal(
    assessMemoryWrite({
      statement: "这个不要保存，只用于当前讨论",
      memoryType: "fact",
      bypass: true,
    }).allowed,
    false,
  );
});

test("escape hatch leaves ordinary durable content untouched", () => {
  assert.equal(
    assessMemoryWrite({
      statement: "预算演进设计采用年度链结构。",
      memoryType: "fact",
      bypass: true,
    }).allowed,
    true,
  );
});

test("evidence is exempt from intent filters but not from secret detection", () => {
  // Evidence is a verbatim source excerpt (a user quote, message, or tool
  // output) — it may legitimately contain transient wording or a negative
  // imperative. The intent filters (transient wording, "do not retain")
  // judge what the model is persisting, which is the statement, not the
  // quoted source. Only secret detection must still scan the evidence,
  // because credentials can hide inside a quoted excerpt.
  assert.equal(
    assessMemoryWrite({
      statement: "用户确认了项目目录结构。",
      memoryType: "fact",
      evidence: "用户原话：这个配置暂时这样，之后再改。",
    }).allowed,
    true,
  );
  assert.equal(
    assessMemoryWrite({
      statement: "用户确认了项目目录结构。",
      memoryType: "fact",
      evidence: "用户原话：不要保存这个临时文件。",
    }).allowed,
    true,
  );
  assert.equal(
    assessMemoryWrite({
      statement: "用户确认了项目目录结构。",
      memoryType: "fact",
      evidence: "用户原话：密码是 sk-test-nmg-123456。",
    }).allowed,
    false,
  );
});

test("refuses a live process position that no event bounds", () => {
  // The failure this rule exists for: a true-today, false-tomorrow snapshot of
  // a workflow, written as if it were durable knowledge.
  const snapshot =
    "Local main is 16 commits ahead of origin/main and unpushed; wait for the audit PR before pushing.";
  assert.deepEqual(assessMemoryWrite({ statement: snapshot, memoryType: "constraint" }), {
    allowed: false,
    reason: "coordination_state",
  });
  assert.deepEqual(
    assessMemoryWrite({
      statement: "本地 main 领先 origin/main 16 个提交，未推送，等 PR 落地再说。",
      memoryType: "constraint",
    }),
    { allowed: false, reason: "coordination_state" },
  );
});

test("a stated expiry is what makes a process position recordable", () => {
  // The escape hatch for this rule is expiresAt, not bypass: naming when the
  // claim stops being true is the information an unbounded record lacks.
  const snapshot = "Local main is 16 commits ahead of origin/main and unpushed.";
  assert.equal(
    assessMemoryWrite({
      statement: snapshot,
      memoryType: "constraint",
      expiresAt: "2026-10-30T00:00:00.000Z",
    }).allowed,
    true,
  );
  assert.equal(
    assessMemoryWrite({ statement: snapshot, memoryType: "constraint", bypass: true }).allowed,
    true,
  );
});

test("an event is exempt because it records an occurrence, not a position", () => {
  assert.equal(
    assessMemoryWrite({
      statement: "The audit PR merged while 16 commits were still unpushed.",
      memoryType: "event",
    }).allowed,
    true,
  );
});

test("durable rules that merely touch process words stay allowed", () => {
  const durable = [
    "Merges require a green gate; the release order is staging then production.",
    "The user decided that benchmark scrapers never enter the product tree.",
    "合并必须通过门禁；发布顺序是暂存再生产。",
    "用户决定：基准抓取脚本不进入产品目录。",
    "The 状态 vocabulary is defined in docs/decisions/implemented/2026-09-20-name-the-collaboration-protocol.md.",
  ];
  for (const statement of durable) {
    assert.deepEqual(
      assessMemoryWrite({ statement, memoryType: "constraint" }),
      { allowed: true, reason: "allowed" },
      statement,
    );
  }
});
