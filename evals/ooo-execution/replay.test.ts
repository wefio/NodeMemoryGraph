// S2: a round is replayed from its log, not re-run.
//
// The property under test is narrow and checkable: with the worker answers taken from the
// log and the host checks executed as before, the round reaches the *same* terminal state
// it recorded — and when the log is edited or truncated, it does not. The second half
// matters more than the first: a replay that trusts its own input is a transcript, not
// evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCycle, type CheckRunner, type CycleOptions, type CycleResult } from "./cycle.ts";
import {
  RoundLog,
  compareTerminal,
  readRoundLog,
  recordedWorker,
  terminalEvent,
} from "./round-log.ts";

/** A deterministic round: the same three tasks the live cycle runs, with the host check
 *  replaced by a function so the test needs no worktrees. */
function roundOptions(overrides: Partial<CycleOptions> = {}): CycleOptions {
  // The frozen suite passes while the probe is intact, so the round has the shape the
  // live one has: a real wait on a passing check, a gap-closing patch, a composition.
  const verify: CheckRunner = async ({ files }) => {
    // Substring tests on purpose: a check that depends on an exact trailing newline in a
    // test fixture fails for reasons that have nothing to do with the round.
    const intact = (files["src/probe.ts"] ?? "").includes("value = 1");
    const titled = (files["src/probe.test.ts"] ?? "").includes("probe identity");
    const passed = intact && titled;
    return {
      verdict: passed ? "accept" : "reject",
      outcomes: [
        {
          label: "protocol-regression",
          status: passed ? "passed" : "failed",
          log: "deterministic host check",
        },
      ],
    };
  };
  const baseline = {
    "src/probe.ts": "export const value = 1;\n",
    "src/probe.test.ts": "test('probe identity', () => {});\n",
  };
  const artifacts: Record<string, (digest: string) => string> = {
    // A repairs nothing: the check passed, so a cited no-change conclusion is the honest
    // answer, which is also the answer the live rounds had trouble producing.
    A: (digest) =>
      JSON.stringify({
        digest,
        kind: "conclusion",
        conclusion: "no-change-needed",
        summary: "the check passed",
        evidence: "protocol-regression=passed",
        citations: [{ case: "check-identity", test: "probe identity" }],
      }),
    // B adds the regression its case rule asks for, leaving the implementation intact.
    B: (digest) =>
      JSON.stringify({
        digest,
        files: [
          {
            path: "src/probe.test.ts",
            content: "test('probe identity', () => {});\ntest('probe regression', () => {});\n",
          },
        ],
      }),
    C: (digest) =>
      JSON.stringify({
        digest,
        kind: "conclusion",
        conclusion: "promote-candidate",
        summary: "composed candidate",
        evidence: "composed check passed",
        citations: [],
      }),
  };
  return {
    repository: process.cwd(),
    revision: "HEAD",
    baseline,
    checks: [{ label: "protocol-regression", command: "node", args: ["-e", ""] }],
    worker: async (taskId, frozen) => ({ artifact: artifacts[taskId]!(frozen.digest) }),
    aInstruction: "repair the check",
    bInstruction: "add a regression",
    aEditable: ["src/probe.ts"],
    bEditable: ["src/probe.test.ts"],
    budget: { perFile: 8_000, output: 8_000 },
    limits: { turns: 4, reads: 2, timeoutMs: 60_000 },
    runChecks: verify,
    noChangeCases: {
      A: [{ name: "check-identity", token: "probe identity" }],
      B: [{ name: "regression", token: "probe regression" }],
    },
    admitted: {
      A: ["no-change-needed", "cannot-complete"],
      B: ["cannot-complete"],
      C: ["promote-candidate", "cannot-complete"],
    },
    maxReopens: 1,
    ...overrides,
  };
}

test("a round replays from its log to the same terminal state, with no worker call", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-replay-"));
  t.after(() =>
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );
  const path = join(directory, "round.jsonl");

  const original = await runCycle(roundOptions({ roundLog: new RoundLog(path) }));
  const events = readRoundLog(readFileSync(path, "utf8"));
  const recorded = terminalEvent(events);
  assert.ok(recorded, "the round must record its own terminal state");
  assert.equal(recorded.accepted.C !== undefined, original.accepted.C !== undefined);

  // Replay: the same round, with the recorded answers instead of a worker.
  let calls = 0;
  const replayed = await runCycle(
    roundOptions({
      worker: async (taskId, frozen, dependencies) => {
        calls += 1;
        return recordedWorker(events)(taskId, frozen, dependencies);
      },
    }),
  );
  assert.equal(calls, 3, "replay asks for exactly the recorded attempts");
  assert.deepEqual(compareTerminal(recorded, replayed), []);
  // And the replayed round reaches the same state as the round it replaces.
  assert.deepEqual(replayed.accepted, original.accepted);
  assert.deepEqual(replayed.verdicts, original.verdicts);
  assert.deepEqual(replayed.composed, original.composed);
});

test("an edited artifact in the log does not reproduce the verdict", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-replay-edit-"));
  t.after(() =>
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );
  const path = join(directory, "round.jsonl");
  await runCycle(roundOptions({ roundLog: new RoundLog(path) }));

  // Rewrite B's recorded patch so it no longer carries the title its case rule asks for,
  // keeping everything else — including its digest field — exactly as recorded.
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const edited = lines.map((line) => {
    const event = JSON.parse(line) as { kind: string; taskId?: string; artifact?: string };
    if (event.kind !== "artifact" || event.taskId !== "B") return line;
    const artifact = JSON.parse(event.artifact!) as { files: { path: string; content: string }[] };
    artifact.files[0]!.content = "export const value = 99;\n";
    return JSON.stringify({ ...event, artifact: JSON.stringify(artifact) });
  });
  const editedPath = join(directory, "edited.jsonl");
  writeFileSync(editedPath, edited.join("\n") + "\n", "utf8");

  const events = readRoundLog(readFileSync(editedPath, "utf8"));
  const recorded = terminalEvent(events)!;
  const replayed = await runCycle(roundOptions({ worker: recordedWorker(events) }));

  // The round completes, but not with the recorded outcome: the host re-checked the
  // artifact instead of trusting the log.
  const differences = compareTerminal(recorded, replayed);
  assert.ok(differences.length > 0, "an edited artifact must not reproduce the verdict");
  assert.ok(
    differences.some((line) => line.startsWith("B:")),
    `expected B to differ, got ${JSON.stringify(differences)}`,
  );
});

test("a truncated log is detected, not repaired", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-replay-cut-"));
  t.after(() =>
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );
  const path = join(directory, "round.jsonl");
  await runCycle(roundOptions({ roundLog: new RoundLog(path) }));

  // Drop the last recorded artifact. The replay cannot invent the answer, and the missing
  // attempt surfaces as a recorded failure rather than as a round that quietly differs.
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const artifactIndexes = lines
    .map((line, index) => ((JSON.parse(line) as { kind: string }).kind === "artifact" ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(artifactIndexes.length, 3);
  const truncated = lines.filter((_, index) => index !== artifactIndexes.at(-1));
  const events = readRoundLog(truncated.join("\n") + "\n");
  const recorded = terminalEvent(events)!;

  const replayed = await runCycle(roundOptions({ worker: recordedWorker(events) }));
  assert.equal(replayed.verdicts.C, "rejected");
  assert.ok(
    replayed.rejections.some((item) => /no artifact for C attempt 1/.test(item.artifact)),
    `expected the missing attempt to be reported, got ${JSON.stringify(replayed.rejections)}`,
  );
  assert.ok(compareTerminal(recorded, replayed).some((line) => line.startsWith("C:")));
});

test("a malformed log line is refused, not skipped", () => {
  assert.throws(() => readRoundLog("not json\n"), /not JSON/);
  assert.throws(() => readRoundLog('{"at":"now","kind":"invented"}\n'), /unknown kind/);
  assert.throws(() => readRoundLog('{"kind":"plan"}\n'), /no timestamp/);
  // A log with no terminal event is readable; the caller decides what that means.
  const events = readRoundLog('{"at":"now","kind":"plan","tasks":[],"checks":[]}\n');
  assert.equal(events.length, 1);
  assert.equal(terminalEvent(events), null);
});

test("a replay is a round like any other: it cannot accept what the host refuses", async () => {
  // Even a faithful log cannot talk the host into an acceptance it did not make.
  const result: CycleResult = await runCycle(
    roundOptions({
      worker: async () => ({ artifact: JSON.stringify({ digest: "f".repeat(64), files: [] }) }),
    }),
  );
  assert.deepEqual(result.accepted, {});
  assert.equal(result.verdicts.B, "rejected");
});
