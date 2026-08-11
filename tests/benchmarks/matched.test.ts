import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKEND_ABLATION_MODES,
  benchmarkIsolationArgs,
  counterbalancedOrder,
  controllerShadowEnvironment,
  matchedUserPrompt,
  MATCHED_MODES,
} from "../../evals/benchmarks/matched.ts";

test("backend ablation contains the four required memory-system arms", () => {
  assert.deepEqual(BACKEND_ABLATION_MODES, [
    "no-memory",
    "flat-hybrid",
    "nmg-lite",
    "nmg-graph",
  ]);
});

test("backend ablation order is deterministic and preserves every arm", () => {
  const first = counterbalancedOrder(BACKEND_ABLATION_MODES, "question-a:0");
  const repeated = counterbalancedOrder(BACKEND_ABLATION_MODES, "question-a:0");
  assert.deepEqual(first, repeated);
  assert.deepEqual([...first].sort(), [...BACKEND_ABLATION_MODES].sort());
});

test("benchmark answer agents cannot inspect local golden-answer files", () => {
  const baseline = benchmarkIsolationArgs();
  assert.ok(baseline.includes("--no-tools"));
  assert.ok(baseline.includes("--no-context-files"));
  assert.ok(baseline.includes("--no-skills"));
  assert.ok(!baseline.includes("read"));

  const nmg = benchmarkIsolationArgs("nmg-extension.ts");
  assert.ok(nmg.includes("nmg_remember,nmg_search,nmg_get"));
  assert.ok(!nmg.includes("read"));
});

test("matched benchmark arms share the exact user prompt", () => {
  const prompts = MATCHED_MODES.map(() =>
    matchedUserPrompt({
      benchmark: "PersonaMem",
      question: "What drink does the user prefer?",
      options: ["Tea", "Coffee"],
    }),
  );
  assert.equal(new Set(prompts).size, 1);
  assert.match(prompts[0]!, /<final_answer>/);
});

test("matched benchmark changes only controller shadow state between NMG arms", () => {
  assert.deepEqual(controllerShadowEnvironment("no-memory"), {});
  assert.deepEqual(controllerShadowEnvironment("nmg-deterministic"), {
    NMG_CONTROLLER_SHADOW: "0",
  });
  assert.deepEqual(controllerShadowEnvironment("nmg-shadow"), {
    NMG_CONTROLLER_SHADOW: "1",
  });
});

test("LongMemEval matched prompt preserves question time without arm-specific instructions", () => {
  const prompts = MATCHED_MODES.map(() =>
    matchedUserPrompt({
      benchmark: "LongMemEval",
      question: "Which version is current?",
      questionDate: "2026/07/26",
    }),
  );
  assert.equal(new Set(prompts).size, 1);
  assert.match(prompts[0]!, /Question date: 2026\/07\/26/);
  assert.doesNotMatch(prompts[0]!, /NMG|memory tool/i);
});
