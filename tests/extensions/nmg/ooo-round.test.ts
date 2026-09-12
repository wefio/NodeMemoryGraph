// The Pi adaptation is a thin surface over the round entry point: its job is to bind parameters
// correctly and refuse what it cannot answer, so the tests are about that, not about running rounds.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeStart,
  roundArgv,
  type OooRoundParams,
} from "../../../.pi/extensions/nmg/ooo-round.ts";

test("every action refuses what it cannot answer, by name", () => {
  const missingRunDir = () => roundArgv({ action: "status" } satisfies OooRoundParams);
  assert.throws(missingRunDir, /runDir is required/);
  assert.throws(
    () => roundArgv({ action: "submit", runDir: "r" }),
    /submit requires specPath/,
    "a round without a spec would have to be invented",
  );
  assert.throws(
    () => roundArgv({ action: "cancel", runDir: "r" }),
    /cancel requires reason/,
    "a cancellation without a reason is not a decision that survives a restart",
  );
});

test("the arguments are the reviewed entry point's, action by action", () => {
  assert.deepEqual(roundArgv({ action: "status", runDir: "run1" }), [
    "--experimental-strip-types",
    "evals/ooo-execution/round-cli.ts",
    "status",
    "--run-dir",
    "run1",
  ]);
  assert.deepEqual(roundArgv({ action: "submit", specPath: "s.json", runDir: "run1" }), [
    "--experimental-strip-types",
    "evals/ooo-execution/round-cli.ts",
    "submit",
    "s.json",
    "--run-dir",
    "run1",
  ]);
  // `--live` is the switch that spends tokens, so it must only ever appear when asked for.
  assert.ok(
    !roundArgv({ action: "submit", specPath: "s.json", runDir: "run1" }).includes("--live"),
    "a round without an explicit live flag must not call a provider",
  );
  assert.ok(
    roundArgv({ action: "submit", specPath: "s.json", runDir: "run1", live: true }).includes(
      "--live",
    ),
  );
  assert.deepEqual(roundArgv({ action: "cancel", runDir: "run1", reason: "operator stopped it" }), [
    "--experimental-strip-types",
    "evals/ooo-execution/round-cli.ts",
    "cancel",
    "--run-dir",
    "run1",
    "--reason",
    "operator stopped it",
  ]);
});

test("a started round is described by where it runs and what it will cost", () => {
  const text = describeStart(
    { action: "submit", specPath: "s.json", runDir: "run1" },
    { pid: 42, logPath: "run1/cli.log" },
  );
  assert.match(text, /detached \(pid 42\)/);
  assert.match(text, /recorded answers \(no model calls\)/, "the default must be visible as free");
  assert.match(
    describeStart(
      { action: "submit", specPath: "s.json", runDir: "run1", live: true },
      { pid: 1, logPath: "l" },
    ),
    /this spends tokens/,
  );
});
