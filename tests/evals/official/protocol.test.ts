import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { longMemEvalJudgePrompt } from "../../../evals/longmemeval/official.ts";
import {
  beamEventAlignmentPrompt,
  beamJudgePrompt,
  normalizedKendallTauB,
  personaMemCorrect,
} from "../../../evals/official/protocol.ts";

test("PersonaMem uses the official single-option extraction rule", () => {
  assert.equal(personaMemCorrect("<final_answer>(b)</final_answer>", "(b)"), true);
  assert.equal(personaMemCorrect("It could be (a) or (b)", "(b)"), false);
  assert.equal(personaMemCorrect("Option c", "(c)"), true);
});

test("LongMemEval protocol preserves update and abstention instructions", () => {
  assert.match(longMemEvalJudgePrompt(
    "knowledge-update", "Q", "A", "H", false,
  ), /previous information.*updated answer/su);
  assert.match(longMemEvalJudgePrompt(
    "single-session-user", "Q", "A", "H", true,
  ), /unanswerable question/u);
});

test("BEAM protocol includes the official rubric inputs and score scale", () => {
  const prompt = beamJudgePrompt("question", "criterion", "candidate");
  assert.match(prompt, /QUESTION.*question/u);
  assert.match(prompt, /RUBRIC CRITERION.*criterion/u);
  assert.match(prompt, /1\.0, 0\.5, or 0\.0/u);
});

test("BEAM event alignment prompt preserves stable rubric and system indices", () => {
  const prompt = beamEventAlignmentPrompt("question", ["first", "second"], ["answer"]);
  assert.match(prompt, /"index": 0/u);
  assert.match(prompt, /"referenceIndex"/u);
  assert.match(prompt, /exactly one output object per system item/u);
});

test("BEAM event ordering uses normalized Kendall tau-b", () => {
  assert.equal(normalizedKendallTauB([0, 1, 2], [0, 1, 2]), 1);
  assert.equal(normalizedKendallTauB([0, 1, 2], [2, 1, 0]), 0);
  const partial = normalizedKendallTauB([0, 1, 2], [0, 2]);
  assert.ok(partial > 0 && partial < 1);
  assert.equal(
    normalizedKendallTauB([0, 1, 2], [3]),
    0.1464466094067262,
  );
});

test("LoCoMo bridge invokes the pinned official scorer when bootstrapped", (context) => {
  // This file lives at tests/evals/official/, so the repository root is three
  // levels up. Resolving only two levels pointed at tests/ and made the
  // bootstrap probe fail even on a fully bootstrapped checkout, so this test
  // silently skipped instead of ever exercising the official scorer.
  const root = resolve(import.meta.dirname, "../../..");
  const python = resolve(root, ".benchmarks/python/Scripts/python.exe");
  const upstream = resolve(root, ".benchmarks/official/LoCoMo/task_eval/evaluation.py");
  if (!existsSync(python) || !existsSync(upstream)) {
    context.skip("run npm run benchmark:setup to enable official scorer parity");
    return;
  }
  const result = spawnSync(python, [resolve(root, "evals/official/locomo_score.py")], {
    cwd: root,
    input: JSON.stringify({ qas: [{
      answer: "tea",
      category: 2,
      evidence: ["d1"],
      prediction: "Tea",
      prediction_context: ["d1"],
    }] }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.slice(result.stdout.lastIndexOf("\n{") + 1));
  assert.deepEqual(output, { scores: [1], recalls: [1] });
});
