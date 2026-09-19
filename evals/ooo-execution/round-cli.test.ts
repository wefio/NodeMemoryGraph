// S3 exit: a supported round is repeated from a spec file without editing a research script,
// and is queryable and cancellable from other processes.
//
// The spec's `replay` worker is the point of the stage's repeatability: the same spec that ran
// a round can re-run it from its own record, and the round's identity check (round-log.ts
// compareFrozen) refuses a spec whose frozen work differs from the log's.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BoardAdmission } from "../../src/integration/ooo-board.ts";
import {
  ROUND_PLAN,
  cancelRun,
  describeRun,
  logPath,
  readBaseline,
  readRecord,
  runSpecifiedRound,
  storePath,
} from "./round-runner.ts";
import { parseRoundSpec, type RoundSpec } from "./round-spec.ts";
import type { FrozenPatchWork } from "../../src/integration/ooo-patch.ts";

const CLI = join(import.meta.dirname, "round-cli.ts");
/** Baseline small enough to keep the test quick, with a real test title the case cites. */
const BASELINE = ["evals/ooo-execution/cancellation.test.ts"];
const CASE_TOKEN = "cancelling a round kills";

function specObject(log: string): Record<string, unknown> {
  return {
    revision: "HEAD",
    baseline: BASELINE,
    checks: [
      { label: "protocol-regression", command: process.execPath, args: ["-e", "process.exit(0)"] },
    ],
    a: { instruction: "repair what the check exposes", editable: BASELINE },
    b: { instruction: "add the missing regressions", editable: BASELINE },
    worker: { kind: "replay", log },
    noChangeCases: { A: [{ name: "check-identity", token: CASE_TOKEN }] },
    admitted: {
      A: ["no-change-needed", "cannot-complete"],
      B: ["cannot-complete"],
      C: ["promote-candidate", "cannot-complete"],
    },
    budget: { perFile: 40_000, output: 40_000 },
    limits: { turns: 2, reads: 2, timeoutMs: 60_000 },
  };
}

/** The answers a round needs, written against the frozen envelope rather than fixed text:
 *  the digest has to be the one the round hands this attempt, and a patch has to be built from
 *  the frozen content, or the host refuses it for a reason the test would then be asserting. */
function answers(task: string, frozen: FrozenPatchWork): string {
  if (task === "A")
    return JSON.stringify({
      digest: frozen.digest,
      kind: "conclusion",
      conclusion: "no-change-needed",
      summary: "the check passes, so there is nothing to repair",
      evidence: "cited from the frozen suite",
      citations: [
        {
          case: "check-identity",
          test: "cancelling a round kills its running check and leaves no accepted work",
        },
      ],
    });
  if (task === "B")
    return JSON.stringify({
      digest: frozen.digest,
      files: [
        {
          path: BASELINE[0]!,
          content: `${frozen.work.files[BASELINE[0]!]}\ntest("round-cli added", () => {});\n`,
        },
      ],
    });
  return JSON.stringify({
    digest: frozen.digest,
    kind: "conclusion",
    conclusion: "promote-candidate",
    summary: "combined candidate verified by the host",
    evidence: "composed-check accept",
    citations: [],
  });
}

function writeSpec(directory: string, log: string): string {
  const path = join(directory, "spec.json");
  writeFileSync(path, JSON.stringify(specObject(log), null, 2), "utf8");
  return path;
}

test("a spec is refused unless it is fully understood", () => {
  const base = specObject(".nmg/round.jsonl");
  assert.equal(parseRoundSpec(base).revision, "HEAD");
  // Each refusal names the field it refused: a spec that is half-understood must not run.
  for (const [field, patch] of [
    ["surplus", { surplus: 1 }],
    ["baseline[0]", { baseline: ["../outside.ts"] }],
    ["worker.kind", { worker: { kind: "stub" } }],
    ["a.instruction", { a: { editable: BASELINE } }],
    ["admitted.A", { admitted: { A: [] } }],
  ] as const) {
    let message = "";
    try {
      parseRoundSpec({ ...base, ...patch });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.ok(message.includes(field), `${field}: got ${JSON.stringify(message)}`);
  }
});

test(
  "the CLI submits a spec, reports status, and re-runs the same round from its own record",
  { timeout: 120_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "nmg-ooo-cli-"));
    t.after(() =>
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    );
    const first = join(directory, "first");
    // First pass: record a round by running the spec with a stub worker, which is how a log that
    // matches this spec's frozen work comes into existence at all. The spec is written twice
    // because the recorded log only exists after this pass; the frozen inputs are identical.
    const placeholder = writeSpec(directory, join(directory, "not-recorded-yet.jsonl"));
    const spec = parseRoundSpec(JSON.parse(readFileSync(placeholder, "utf8"))) as RoundSpec;
    const { revision, baseline } = readBaseline(spec, process.cwd());
    const recorded = await runSpecifiedRound({
      spec,
      runDir: first,
      repository: process.cwd(),
      worker: async (task, frozen) => answers(task, frozen),
      revision,
      baseline,
    });
    assert.deepEqual(recorded.verdicts, { B: "accepted", A: "accepted", C: "accepted" });
    assert.ok(readFileSync(logPath(first), "utf8").includes('"kind":"terminal"'));
    // The same spec, rewritten to replay the log this pass produced.
    const specPath = writeSpec(directory, logPath(first));

    // Second pass: the same spec through the CLI, now replaying that record. No model call,
    // and the round identity check has to accept the recorded answers.
    const submitted = execFileSync(
      process.execPath,
      ["--experimental-strip-types", CLI, "submit", specPath, "--run-dir", join(directory, "run")],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.match(submitted, /verdicts: \{"B":"accepted","A":"accepted","C":"accepted"\}/);
    assert.match(submitted, /accepted: \{"A":"[\s\S]*"B":"[\s\S]*"C":"/);
    const runDir = join(directory, "run");
    assert.ok(readRecord(runDir)?.finishedAt, "the run record is durable");

    // status: a second process reads the same run directory.
    const status = execFileSync(
      process.execPath,
      ["--experimental-strip-types", CLI, "status", "--run-dir", runDir],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.match(status, /worker: replay/);
    assert.match(status, /coordinator accepted: \{"A":"/);
    assert.match(status, /measurements: host \d+ ms/);

    // An unknown flag is refused rather than ignored, and the refusal names the flag.
    let refusal = "";
    try {
      execFileSync(
        process.execPath,
        ["--experimental-strip-types", CLI, "status", "--run-dir", runDir, "--verbose"],
        { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" },
      );
    } catch (error) {
      refusal = String((error as { stderr?: string }).stderr ?? "");
    }
    assert.match(refusal, /unknown flag: --verbose/);

    // cancel: recorded in the round's own store by a different process.
    const cancelled = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        CLI,
        "cancel",
        "--run-dir",
        runDir,
        "--reason",
        "operator stopped the round",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.match(cancelled, /cancellation recorded: operator stopped the round/);
    assert.match(describeRun(runDir), /coordinator cancelled: operator stopped the round/);
    assert.equal(cancelRun(runDir, "again"), "operator stopped the round");
  },
);

test(
  "a round already cancelled in the store stops before it dispatches anything",
  { timeout: 120_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "nmg-ooo-cli-cancel-"));
    t.after(() =>
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    );
    const log = join(directory, "recorded.jsonl");
    const spec = parseRoundSpec(JSON.parse(readFileSync(writeSpec(directory, log), "utf8")));
    const runDir = join(directory, "run");
    const { revision, baseline } = readBaseline(spec, process.cwd());

    // The cancellation is written by another process, before the round starts: the round polls
    // the store, and must not spend a worker call after it.
    mkdirSync(runDir, { recursive: true });
    const prepared = new BoardAdmission(storePath(runDir), ROUND_PLAN, {});
    prepared.cancel("stopped before dispatch");
    prepared.close();

    let dispatched = 0;
    const result = await runSpecifiedRound({
      spec,
      runDir,
      repository: process.cwd(),
      worker: async (task, frozen) => {
        dispatched += 1;
        return answers(task, frozen);
      },
      revision,
      baseline,
    });
    assert.equal(dispatched, 0, "a cancelled round must not spend a worker call");
    assert.equal(result.cancelled, "stopped before dispatch");
    assert.deepEqual(result.accepted, {});
    assert.match(describeRun(runDir), /cancelled: stopped before dispatch/);
  },
);
