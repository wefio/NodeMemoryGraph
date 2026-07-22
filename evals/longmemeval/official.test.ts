import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadLongMemEval, scoreLongMemRetrieval } from "./official.ts";

test("loads official LongMemEval evidence labels without deriving them", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-longmem-official-"));
  try {
    const path = join(directory, "data.json");
    writeFileSync(path, JSON.stringify([{
      question_id: "q1",
      question_type: "single-session-user",
      question: "What changed?",
      answer: "The deadline",
      question_date: "2026-01-03",
      haystack_session_ids: ["s1", "s2"],
      haystack_dates: ["2026-01-01", "2026-01-02"],
      haystack_sessions: [[{ role: "user", content: "Old" }], [{
        role: "user", content: "New", has_answer: true,
      }]],
      answer_session_ids: ["s2"],
    }]));
    const [item] = loadLongMemEval(path);
    assert.deepEqual(item?.answer_session_ids, ["s2"]);
    assert.equal(item?.haystack_sessions[1]?.[0]?.has_answer, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scores LongMemEval retrieval from official session IDs", () => {
  assert.deepEqual(scoreLongMemRetrieval(["x", "s2", "s1"], ["s1", "s2"]), {
    recallAny: 1,
    recallAll: 1,
    ndcg: (1 / Math.log2(3) + 1 / Math.log2(4)) /
      (1 / Math.log2(2) + 1 / Math.log2(3)),
  });
  assert.equal(scoreLongMemRetrieval(["x"], []), null);
});

test("normalizes official numeric LongMemEval answers", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-longmem-number-"));
  try {
    const path = join(directory, "data.json");
    writeFileSync(path, JSON.stringify([{
      question_id: "q-number", question_type: "multi-session", question: "How many?",
      answer: 3, question_date: "2026-01-01", haystack_session_ids: ["s1"],
      haystack_dates: ["2026-01-01"], haystack_sessions: [[]], answer_session_ids: ["s1"],
    }]));
    assert.equal(loadLongMemEval(path)[0]?.answer, "3");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
