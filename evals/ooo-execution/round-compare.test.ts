// S4: the comparison must be honest about what it measured, so the test pins the two things
// that make it meaningful — the arms are the same round (quality parity), and the control
// really does not overlap the wait.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FrozenPatchWork } from "../../src/integration/ooo-patch.ts";
import { compareModes, describe, armLog } from "./round-compare.ts";
import { parseRoundSpec, type RoundSpec } from "./round-spec.ts";

const BASELINE = ["evals/ooo-execution/cancellation.test.ts"];
const CASE_TOKEN = "cancelling a round kills";

function specObject(): Record<string, unknown> {
  return {
    revision: "HEAD",
    baseline: BASELINE,
    checks: [
      { label: "protocol-regression", command: process.execPath, args: ["-e", "process.exit(0)"] },
    ],
    a: { instruction: "repair what the check exposes", editable: BASELINE },
    b: { instruction: "add the missing regressions", editable: BASELINE },
    worker: { kind: "replay", log: "unused-in-this-test" },
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

/** The same answers for both arms: the comparison is about scheduling, so the inputs to the
 *  scheduler must not differ between them. */
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
          content: `${frozen.work.files[BASELINE[0]!]}\ntest("compare added", () => {});\n`,
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

test(
  "the comparison runs both modes over the same plan and reports what it measured",
  { timeout: 180_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "nmg-ooo-compare-"));
    t.after(() =>
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    );
    const spec: RoundSpec = parseRoundSpec(specObject());
    const comparison = await compareModes({
      spec,
      repository: process.cwd(),
      outputDirectory: directory,
      times: 1,
      workerFor: async () => async (task, frozen) => answers(task, frozen),
    });

    // Both arms are the same round: same frozen work, same verdicts, same acceptances. Without
    // that, the timings would be measuring two different rounds.
    assert.equal(comparison.qualityParity, true, JSON.stringify(comparison.differences));
    for (const entry of comparison.arms)
      assert.deepEqual(entry.verdicts, { B: "accepted", A: "accepted", C: "accepted" });
    assert.equal(comparison.arms.length, 2);
    const ooo = comparison.arms.find((entry) => entry.mode === "ooo")!;
    const sequential = comparison.arms.find((entry) => entry.mode === "sequential")!;
    assert.equal(sequential.hiddenWaitMs, 0, "the control has nothing to overlap");
    assert.ok(ooo.hostChecks >= 1 && sequential.hostChecks >= 1);

    // The reported lines state both sides and do not declare a winner on their own.
    const lines = describe(comparison);
    assert.ok(lines.some((line) => line.startsWith("ooo: wall ")));
    assert.ok(lines.some((line) => line.startsWith("sequential: wall ")));
    assert.ok(lines.some((line) => line.includes("out-of-order minus sequential wall clock")));
    assert.ok(
      !lines.some((line) => /significant|proven|better design/i.test(line)),
      "the report must not claim a result the data does not carry",
    );

    // Every arm keeps its own store, log and record: a failure sample has to be pointable-at.
    for (const entry of comparison.arms) {
      const { terminal } = armLog(directory, entry.mode, entry.run);
      assert.ok(terminal, `${entry.mode}-${entry.run} has no terminal event`);
      assert.deepEqual(terminal.verdicts, entry.verdicts);
    }
    const written = JSON.parse(readFileSync(join(directory, "compare.json"), "utf8")) as {
      arms: unknown[];
    };
    assert.equal(written.arms.length, 2);
  },
);

test("a comparison whose arms disagree about quality says so instead of comparing times", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-ooo-compare-skew-"));
  t.after(() =>
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );
  const spec: RoundSpec = parseRoundSpec(specObject());
  const comparison = await compareModes({
    spec,
    repository: process.cwd(),
    outputDirectory: directory,
    times: 1,
    // The out-of-order arm answers; the control refuses to complete. The verdicts differ, so
    // the harness must refuse to treat the timings as comparable.
    workerFor: async (mode) =>
      mode === "ooo"
        ? async (task, frozen) => answers(task, frozen)
        : async () => {
            throw new Error("this arm could not answer");
          },
  });
  assert.equal(comparison.qualityParity, false);
  assert.ok(
    comparison.differences.some((line) => line.includes("not the same round")),
    JSON.stringify(comparison.differences),
  );
});
