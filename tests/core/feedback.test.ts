import assert from "node:assert/strict";
import test from "node:test";

import { contentTokens, deriveAnswerOverlapMemoryIds } from "../../src/core/feedback.ts";
import type { MemorySearchResult } from "../../src/core/types.ts";

function mkResult(id: string, statement: string): MemorySearchResult {
  return {
    memory: { id, statement },
    node: {} as MemorySearchResult["node"],
    evidence: {} as MemorySearchResult["evidence"],
    evidenceRecords: [],
    lexicalScore: 0,
    vectorScore: 0,
    routeScore: 0,
    combinedScore: 0,
  } as unknown as MemorySearchResult;
}

test("contentTokens: numbers (any length) + len>=4 non-stopword words", () => {
  // "ran"/"in" too short, "the"/"I" stopwords/short, "5k"/"25" numeric.
  assert.deepEqual(contentTokens("I ran the 5K in 25 minutes"), ["5k", "25", "minutes"]);
});

test("contentTokens: Chinese text produces stable character bigrams", () => {
  assert.deepEqual(contentTokens("用户偏好中文解释"), [
    "用户",
    "户偏",
    "偏好",
    "好中",
    "中文",
    "文解",
    "解释",
  ]);
});

test("deriveAnswerOverlapMemoryIds: verbatim quote of the answer-bearing memory is detected", () => {
  const results = [
    mkResult("a", "My personal best time in the 5K was 25 minutes 50 seconds"),
    mkResult("b", "I prefer running in the morning"),
  ];
  // Answer restates the 5K time -> memory "a" overlaps, "b" does not.
  const attributed = deriveAnswerOverlapMemoryIds(
    "Your personal best time was 25 minutes 50 seconds.",
    results,
  );
  assert.deepEqual(attributed, ["a"]);
});

test("deriveAnswerOverlapMemoryIds: paraphrase with >=half token overlap is detected", () => {
  const results = [mkResult("b", "I prefer running in the morning")];
  // "running in the morning is cool" -> running, morning overlap (2 of 3).
  const attributed = deriveAnswerOverlapMemoryIds("running in the morning is cool", results);
  assert.deepEqual(attributed, ["b"]);
});

test("deriveAnswerOverlapMemoryIds: unrelated answer yields no attributed memories", () => {
  const results = [mkResult("a", "My personal best time in the 5K was 25 minutes 50 seconds")];
  const attributed = deriveAnswerOverlapMemoryIds("I don't have that information.", results);
  assert.deepEqual(attributed, []);
});

test("deriveAnswerOverlapMemoryIds: empty answer or empty statement is safe", () => {
  assert.deepEqual(deriveAnswerOverlapMemoryIds("", [mkResult("a", "something distinctive")]), []);
  assert.deepEqual(deriveAnswerOverlapMemoryIds("something distinctive", [mkResult("a", "")]), []);
});

test("deriveAnswerOverlapMemoryIds: prompt-vs-answer differential drops prompt-shared tokens", () => {
  // The answer only restates prompt words (recall follows the prompt, so this
  // is a systematic false positive). With no prompt, the memory "looks attributed"
  // at 100% overlap; once prompt tokens are subtracted the contribution is
  // zero and the memory must NOT be diagnostically attributed.
  const results = [mkResult("a", "Atlas uses SQLite storage")];
  const prompt = "Atlas uses SQLite storage?";
  const answer = "Atlas uses SQLite storage.";
  assert.deepEqual(
    deriveAnswerOverlapMemoryIds(answer, results),
    ["a"],
    "sanity: without prompt it visibly overlaps",
  );
  assert.deepEqual(
    deriveAnswerOverlapMemoryIds(answer, results, prompt),
    [],
    "prompt-shared restatement is not evidence attributable to the memory",
  );
});

test("deriveAnswerOverlapMemoryIds: new info beyond the prompt still counts as overlap", () => {
  const results = [mkResult("a", "Atlas pins SQLite for offline operation")];
  const prompt = "Which storage does Atlas use offline?";
  const answer = "Atlas pins SQLite for offline operation.";
  // pins/sqlite/operation are not in the prompt -> still >=half the memory's
  // distinctive tokens appear in the (differenced) answer -> used survives.
  assert.deepEqual(deriveAnswerOverlapMemoryIds(answer, results, prompt), ["a"]);
});

test("deriveAnswerOverlapMemoryIds: Chinese automatic recall can be attributed from the answer", () => {
  const results = [
    mkResult("zh-used", "用户偏好中文解释，并希望保留精确的技术细节"),
    mkResult("zh-unused", "用户在 Windows 环境中进行开发"),
  ];

  assert.deepEqual(
    deriveAnswerOverlapMemoryIds(
      "我会继续使用中文解释，并保留精确的技术细节。",
      results,
      "请按用户偏好回答。",
    ),
    ["zh-used"],
  );
});
