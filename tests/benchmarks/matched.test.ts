import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BACKEND_ABLATION_MODES,
  benchmarkIsolationArgs,
  counterbalancedOrder,
  controllerMatchedEnvironment,
  matchedUserPrompt,
  MATCHED_MODES,
} from "../../evals/benchmarks/matched.ts";
import {
  installControllerCandidate,
  loadControllerCandidate,
  readControllerActuation,
} from "../../evals/benchmarks/controller-candidate.ts";
import { CONTROLLER_FEATURE_PROTOCOL_VERSION } from "../../src/lab/controller-protocol.ts";

test("backend ablation contains the four required memory-system arms", () => {
  assert.deepEqual(BACKEND_ABLATION_MODES, ["no-memory", "flat-hybrid", "nmg-lite", "nmg-graph"]);
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

test("matched benchmark keeps QPP mechanics equal and changes only the frozen controller state", () => {
  assert.deepEqual(controllerMatchedEnvironment("no-memory"), {});
  assert.deepEqual(controllerMatchedEnvironment("nmg-deterministic"), {
    NMG_CONTROLLER_SHADOW: "1",
    NMG_QPP1_MODE: "active",
    NMG_QPP2_MODE: "active",
    NMG_CONTROLLER_RERANK: "active",
  });
  assert.deepEqual(controllerMatchedEnvironment("nmg-candidate"), {
    NMG_CONTROLLER_SHADOW: "1",
    NMG_QPP1_MODE: "active",
    NMG_QPP2_MODE: "active",
    NMG_CONTROLLER_RERANK: "active",
  });
});

test("controller candidate is frozen, validated, installed, and actuation-audited", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-controller-candidate-"));
  try {
    const source = join(directory, "candidate.json");
    writeFileSync(
      source,
      JSON.stringify({
        featureProtocolVersion: CONTROLLER_FEATURE_PROTOCOL_VERSION,
        controller: { trainingSteps: 7 },
      }),
    );
    const descriptor = loadControllerCandidate(source);
    assert.equal(descriptor.trainingSteps, 7);
    assert.equal(descriptor.sha256.length, 64);
    const arm = join(directory, "arm");
    // The benchmark creates the arm directory by copying its seed first.
    mkdirSync(arm, { recursive: true });
    installControllerCandidate(descriptor, arm);
    assert.equal(
      readFileSync(join(arm, "controller-shadow-state.json"), "utf8"),
      readFileSync(source, "utf8"),
    );

    writeFileSync(
      join(arm, "controller-shadow-events.jsonl"),
      [
        JSON.stringify({ type: "retrieval" }),
        JSON.stringify({
          type: "actuation",
          action: "rerank",
          changed: true,
          controllerTrainingSteps: 7,
        }),
      ].join("\n"),
    );
    assert.deepEqual(readControllerActuation(arm), {
      attempted: 1,
      changed: 1,
      actions: { allocate: 0, fold: 0, rerank: 1 },
      maxTrainingSteps: 7,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
