// Rendering arms for the adjacency answer-stage probe: the same records must
// reach every arm, and only their placement may differ between tail and
// anchored. These tests pin that property, because a silent rendering
// difference would turn a placement comparison into a content comparison.

import assert from "node:assert/strict";
import test from "node:test";

import {
  renderArm,
  type Turn,
} from "../../evals/omnimemeval/research/probes/adjacency-rendering-ablation.ts";

const turn = (sid: string, si: number, i: number, raw: string): Turn => ({
  sid,
  si,
  i,
  raw,
  text: raw.toLowerCase(),
  date: `2023-05-0${si}`,
});

const page: Turn[] = [turn("A1", 1, 0, "anchor one"), turn("B1", 2, 0, "anchor two")];
const appended = [
  { turn: turn("A2", 1, 1, "neighbour after A1"), anchor: page[0]!, score: 0.75 },
  { turn: turn("A0", 1, -1, "neighbour before A1"), anchor: page[0]!, score: 0.75 },
  { turn: turn("B2", 2, 1, "neighbour after B1"), anchor: page[1]!, score: 0.58 },
];
const placebo: Turn[] = [turn("C1", 3, 0, "unrelated c"), turn("C2", 3, 1, "unrelated c2")];

test("page carries only the page records", () => {
  assert.deepEqual(renderArm("page", page, appended, placebo), [
    "[2023-05-01] anchor one",
    "[2023-05-02] anchor two",
  ]);
});

test("tail and anchored carry exactly the same records", () => {
  const tail = renderArm("tail", page, appended, placebo);
  const anchored = renderArm("anchored", page, appended, placebo);
  assert.deepEqual([...tail].sort(), [...anchored].sort());
  assert.equal(tail.length, 5);
});

test("anchored places neighbours next to their anchor in session order", () => {
  assert.deepEqual(renderArm("anchored", page, appended, placebo), [
    "[2023-05-01] anchor one",
    "[2023-05-01] neighbour before A1",
    "[2023-05-01] neighbour after A1",
    "[2023-05-02] anchor two",
    "[2023-05-02] neighbour after B1",
  ]);
});

test("tail appends everything after the page", () => {
  assert.deepEqual(renderArm("tail", page, appended, placebo), [
    "[2023-05-01] anchor one",
    "[2023-05-02] anchor two",
    "[2023-05-01] neighbour after A1",
    "[2023-05-01] neighbour before A1",
    "[2023-05-02] neighbour after B1",
  ]);
});

test("placebo uses only records from sessions the page did not touch", () => {
  const rendered = renderArm("placebo", page, appended, placebo);
  assert.deepEqual(rendered, [
    "[2023-05-01] anchor one",
    "[2023-05-02] anchor two",
    "[2023-05-03] unrelated c",
    "[2023-05-03] unrelated c2",
  ]);
  assert.ok(!rendered.some((line) => line.includes("neighbour")));
});

test("a turn without a date renders without a prefix", () => {
  const undated: Turn[] = [{ sid: "X", si: 1, i: 0, raw: "no date", text: "no date" }];
  assert.deepEqual(renderArm("page", undated, [], []), ["no date"]);
});

test("bracketed keeps the anchored placement and marks each related group", () => {
  const anchored = renderArm("anchored", page, appended, placebo);
  const bracketed = renderArm("anchored-bracketed", page, appended, placebo);
  // Same records, same order; only brace markers are added around groups.
  assert.deepEqual(
    bracketed.filter((line) => line !== "{" && line !== "}"),
    anchored,
  );
  assert.deepEqual(bracketed, [
    "{",
    "[2023-05-01] anchor one",
    "[2023-05-01] neighbour before A1",
    "[2023-05-01] neighbour after A1",
    "}",
    "{",
    "[2023-05-02] anchor two",
    "[2023-05-02] neighbour after B1",
    "}",
  ]);
});

test("a page record without neighbours is not wrapped", () => {
  const solo: Turn[] = [turn("S1", 4, 0, "solo anchor")];
  assert.deepEqual(renderArm("anchored-bracketed", solo, [], placebo), [
    "[2023-05-04] solo anchor",
  ]);
});
