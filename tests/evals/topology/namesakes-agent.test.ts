import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNamesakesAttributionCases,
  buildNamesakesAttributionJobs,
  namesakesAttributionPrompt,
  mcnemarExactPValue,
  parseSelectedIds,
  scoreNamesakesAttribution,
} from "../../../evals/topology/namesakes-agent.ts";
import type { NamesakesEntity } from "../../../evals/topology/namesakes.ts";

test("Namesakes attribution cases pair clean evidence with one high-scoring contaminant", () => {
  const [row, foreign] = fixture();
  const [testCase] = buildNamesakesAttributionCases([row, foreign], {
    threshold: -1,
    limit: 1,
    contextRadius: 30,
  });
  assert.ok(testCase);
  assert.equal(testCase.foreignTarget, "Jordan novelist");
  assert.deepEqual(testCase.expectedIds, ["S1", "S2"]);
  assert.deepEqual(
    testCase.cleanRecords.map((record) => record.tag),
    ["Same", "Same"],
  );
  assert.deepEqual(
    testCase.contaminatedRecords.map((record) => record.tag),
    ["Same", "Same", "Other"],
  );
  assert.match(testCase.contaminatedRecords[2]!.text, /published books/u);
  assert.match(namesakesAttributionPrompt(testCase, "contaminated"), /\[X1\]/u);
  assert.doesNotMatch(namesakesAttributionPrompt(testCase, "clean"), /\[X1\]/u);
});

test("Namesakes response parser accepts fenced JSON and de-duplicates IDs", () => {
  assert.deepEqual(parseSelectedIds('```json\n{"selected_ids":["S1","S1","S2"]}\n```'), [
    "S1",
    "S2",
  ]);
  assert.throws(() => parseSelectedIds("not json"), /JSON object/u);
});

test("Namesakes attribution score exposes contaminant acceptance", () => {
  assert.deepEqual(scoreNamesakesAttribution(["S1", "X1"], ["S1", "S2"]), {
    truePositives: 1,
    falsePositives: 1,
    falseNegatives: 1,
    precision: 0.5,
    recall: 0.5,
    exact: false,
    acceptedContaminant: true,
  });
});

test("Namesakes repeated jobs contain both counterbalanced arms for every repeat", () => {
  const [row, foreign] = fixture();
  const cases = buildNamesakesAttributionCases([row, foreign], {
    threshold: -1,
    limit: 1,
  });
  const jobs = buildNamesakesAttributionJobs(cases, 3);
  assert.equal(jobs.length, 6);
  assert.deepEqual(new Set(jobs.map((job) => job.repeat)), new Set([0, 1, 2]));
  for (const repeat of [0, 1, 2]) {
    assert.deepEqual(
      new Set(jobs.filter((job) => job.repeat === repeat).map((job) => job.arm)),
      new Set(["clean", "contaminated"]),
    );
  }
});

test("Namesakes paired discordance uses an exact two-sided McNemar test", () => {
  assert.equal(mcnemarExactPValue(0, 0), 1);
  assert.equal(mcnemarExactPValue(5, 7), 0.7744140625);
  assert.ok(mcnemarExactPValue(0, 10) < 0.01);
});

function fixture(): [NamesakesEntity, NamesakesEntity] {
  const text = "Jordan led the team. Later Jordan scored. Jordan novelist wrote a novel.";
  const athlete: NamesakesEntity = {
    pagename: "Jordan athlete",
    pageid: "fixture",
    title: "Jordan athlete",
    url: "https://example.test/jordan",
    text,
    entities: [
      { text: "Jordan", start: 0, end: 6, tag: "Same" },
      { text: "Jordan", start: 27, end: 33, tag: "Same" },
      { text: "Jordan novelist", start: 42, end: 57, tag: "Other" },
    ],
  };
  const foreignText = "Jordan novelist published books and won a literary prize.";
  const foreign: NamesakesEntity = {
    pagename: "Jordan novelist",
    pageid: "foreign",
    title: "Jordan novelist",
    url: "https://example.test/jordan-novelist",
    text: foreignText,
    entities: [{ text: "Jordan novelist", start: 0, end: 15, tag: "Same" }],
  };
  return [athlete, foreign];
}
