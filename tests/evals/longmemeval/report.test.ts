import assert from "node:assert/strict";
import test from "node:test";

import {
  pairedAgainst,
  summarizeAnswerTimingByMode,
  summarizeAccuracy,
  summarizeByMode,
  summarizeLatencyByMode,
  summarizeInjectedContextByMode,
  summarizeOfficialRetrievalByMode,
  summarizePipelineByMode,
  summarizeRetrievalByMode,
  summarizeTokenUsageByMode,
} from "../../../evals/longmemeval/report.ts";

const rows = [
  {
    questionId: "q1", repeat: 0, mode: "flat", passed: true, durationMs: 10,
    retrievalPassed: true,
  },
  {
    questionId: "q2", repeat: 0, mode: "flat", passed: false, durationMs: 30,
    retrievalPassed: true,
  },
  {
    questionId: "q1", repeat: 0, mode: "nmg", passed: false, durationMs: 20,
    retrievalPassed: false,
  },
  {
    questionId: "q2", repeat: 0, mode: "nmg", passed: true, durationMs: 40,
    retrievalPassed: true,
  },
  {
    questionId: "q1", repeat: 1, mode: "flat", passed: false, durationMs: 50,
    retrievalPassed: false,
  },
  {
    questionId: "q1", repeat: 1, mode: "nmg", passed: true, durationMs: 60,
    retrievalPassed: null,
  },
];

test("accuracy summaries include bounded Wilson intervals", () => {
  const summary = summarizeAccuracy(rows);
  assert.equal(summary.passed, 3);
  assert.equal(summary.total, 6);
  assert.equal(summary.accuracy, 0.5);
  assert.ok(summary.confidence95.lower > 0);
  assert.ok(summary.confidence95.upper < 1);
  assert.deepEqual(Object.keys(summarizeByMode(rows)), ["flat", "nmg"]);
});

test("latency summaries expose mean and nearest-rank percentiles", () => {
  assert.deepEqual(summarizeLatencyByMode(rows).flat, {
    count: 3,
    meanMs: 30,
    p50Ms: 30,
    p95Ms: 50,
  });
});

test("token summaries retain provider cache accounting", () => {
  const summary = summarizeTokenUsageByMode([
    {
      questionId: "q1",
      repeat: 0,
      mode: "nmg",
      passed: true,
      tokenUsage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 5, total: 205 },
    },
    {
      questionId: "q2",
      repeat: 0,
      mode: "nmg",
      passed: false,
      tokenUsage: { input: 40, output: 10, cacheRead: 30, cacheWrite: 0, total: 80 },
    },
  ]).nmg;
  assert.deepEqual(summary, {
    count: 2,
    input: 140,
    output: 30,
    cacheRead: 110,
    cacheWrite: 5,
    total: 285,
  });
});

test("answer timing summaries separate model and tool execution", () => {
  const summary = summarizeAnswerTimingByMode([
    {
      questionId: "q1",
      repeat: 0,
      mode: "nmg",
      passed: true,
      answerTiming: {
        startupMs: 100,
        promptMs: 1_000,
        modelStreamMs: 800,
        toolExecutionMs: 150,
        shutdownMs: 50,
      },
    },
    {
      questionId: "q2",
      repeat: 0,
      mode: "nmg",
      passed: true,
      answerTiming: {
        startupMs: 200,
        promptMs: 2_000,
        modelStreamMs: 1_400,
        toolExecutionMs: 500,
        shutdownMs: 100,
      },
    },
  ]).nmg;
  assert.deepEqual(summary, {
    count: 2,
    startupMs: 150,
    promptMs: 1_500,
    modelStreamMs: 1_100,
    toolExecutionMs: 325,
    shutdownMs: 75,
  });
});

test("injected context summaries label token counts as estimates", () => {
  const summary = summarizeInjectedContextByMode([
    { questionId: "q1", repeat: 0, mode: "nmg", passed: true, retrievalContextChars: 400 },
    { questionId: "q2", repeat: 0, mode: "nmg", passed: true, retrievalContextChars: 800 },
  ]).nmg;
  assert.deepEqual(summary, { count: 2, meanCharacters: 600, meanEstimatedTokens: 150 });
});

test("retrieval and answer outcomes are reported separately", () => {
  assert.equal(summarizeRetrievalByMode(rows).flat?.passed, 2);
  assert.deepEqual(summarizePipelineByMode(rows).flat, {
    evaluated: 3,
    retrievalPassed: 2,
    sufficientAnswerCorrect: 1,
    sufficientAnswerWrong: 1,
    insufficientAnswerCorrect: 0,
    insufficientAnswerWrong: 1,
  });
  assert.equal(summarizePipelineByMode(rows).nmg?.evaluated, 2);
});

test("official retrieval summaries average official session metrics", () => {
  const summary = summarizeOfficialRetrievalByMode([
    {
      questionId: "q1",
      repeat: 0,
      mode: "nmg",
      passed: true,
      officialRetrieval: { recallAny: 1, recallAll: 1, recall: 1, ndcg: 1 },
    },
    {
      questionId: "q2",
      repeat: 0,
      mode: "nmg",
      passed: false,
      officialRetrieval: { recallAny: 1, recallAll: 0, recall: 0.5, ndcg: 0.5 },
    },
  ]).nmg;
  assert.deepEqual(summary, {
    count: 2,
    recallAny: 1,
    recallAll: 0.5,
    recall: 0.75,
    ndcg: 0.75,
  });
});

test("paired comparison matches question and repeat", () => {
  assert.deepEqual(pairedAgainst(rows, "flat").nmg, {
    baseline: "flat",
    candidate: "nmg",
    pairs: 3,
    bothPass: 0,
    candidateOnly: 2,
    baselineOnly: 1,
    bothFail: 0,
    netWins: 1,
  });
});
