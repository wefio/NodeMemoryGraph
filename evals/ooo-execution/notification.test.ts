/**
 * The design's D9: the commit result and a notification failure are two different facts.
 *
 * `submit()` used to return through the post-commit notification, so a subscriber that could not be
 * reached made a submission that had already landed read as a failed one - and a caller retrying on
 * that reading submits the same work twice. A real round runs here, because the artifact envelope is
 * the board's business and a hand-built one would test my model of it rather than the contract.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  openRoundStore,
  runCycle,
  type CheckRunner,
} from "../../src/integration/ooo-cycle.ts";

const IMPL = "src/check.ts";
const TESTS = "src/check.test.ts";
const baseline = { [IMPL]: "export const a = 1;\n", [TESTS]: "test('a', () => {});\n" };
const checks = [{ label: "fixed", command: process.execPath, args: ["-e", "process.exit(0)"] }];

const runChecks: CheckRunner = async () => ({
  verdict: "accept",
  outcomes: [{ label: "fixed", status: "passed" }],
});

/** A worker that always produces a well-formed artifact for the task it is given. */
async function worker(taskId: string, frozen: { digest: string }): Promise<string> {
  if (taskId === "A") {
    return JSON.stringify({
      digest: frozen.digest,
      files: [{ path: IMPL, content: "export const a = 2;\n" }],
    });
  }
  if (taskId === "B") {
    return JSON.stringify({
      digest: frozen.digest,
      files: [{ path: TESTS, content: "test('a', () => {}); test('b', () => {});\n" }],
    });
  }
  return JSON.stringify({
    digest: frozen.digest,
    kind: "conclusion",
    conclusion: "promote-candidate",
    summary: "composed check passed",
    evidence: "candidate-check accept",
    citations: [],
  });
}

const options = (operations: ReturnType<typeof openRoundStore>) => ({
  operations,
  repository: process.cwd(),
  revision: "0".repeat(40),
  baseline,
  checks,
  runChecks,
  worker: worker as never,
  aInstruction: "A works.",
  bInstruction: "B works.",
  aEditable: [IMPL],
  bEditable: [TESTS],
  budget: { perFile: 20_000, output: 40_000 },
  limits: { turns: 4, reads: 3, timeoutMs: 60_000 },
});

test("a notification that fails does not turn a landed commit into a failed submission", async () => {
  // The control: the same round with a board that can be reached. Nothing is reported, so the
  // failure below is the notification and not simply a field that is always set.
  const quiet = openRoundStore();
  try {
    const result = await runCycle(options(quiet));
    assert.deepEqual(result.verdicts, { B: "accepted", A: "accepted", C: "accepted" });
    assert.equal(
      quiet.lastNotificationFailure(),
      null,
      "a notification that arrives is not a failure",
    );
  } finally {
    quiet.close();
  }

  // The host opens its own board, and the notification that runs after a commit is a field on it,
  // so the one call this round makes after committing can be made to fail. Everything else about
  // this round is ordinary.
  const operations = openRoundStore();
  // The board also uses this for its own post-commit bookkeeping, so it runs first and only the
  // notification part of "after the commit" fails.
  let notified = false;
  const postCommit = operations.afterCommit;
  operations.afterCommit = async () => {
    await postCommit();
    // Only the notification that follows a landed commit fails; the board's earlier post-commit
    // work has to keep working, or the round never reaches the submission at all.
    if (!notified && Object.keys(operations.accepted()).length > 0) {
      notified = true;
      throw new Error("subscriber unreachable");
    }
  };
  try {
    const result = await runCycle(options(operations));
    assert.deepEqual(
      Object.keys(operations.accepted()).sort(),
      ["A", "B", "C"],
      "the commit landed, and the caller is told so rather than told the submission failed",
    );
    assert.equal(result.composed.verdict, "accept");
    assert.match(
      String(operations.lastNotificationFailure()),
      /subscriber unreachable/u,
      "the failure is reported separately instead of thrown at a caller who would then resubmit",
    );
  } finally {
    operations.close();
  }
});
