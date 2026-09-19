/**
 * D9: the commit result and a notification failure are two different facts.
 *
 * `submit()` used to return through its post-commit notification, so a subscriber that could not be
 * reached made a submission that had already landed read as a failed one - and a caller retrying on
 * that reading submits the same work twice. The guard is the board's (`ooo-board.ts`), so the case
 * belongs here rather than in the round that used to supply the harness: the round was retired in
 * `docs/decisions/implemented/2026-09-18-retire-the-round-instrument.md`, and the property it pinned
 * is the board's.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BoardAdmission, type PatchTaskSpec, type ProbePlan } from "../../src/integration/ooo-board.ts";
import { preparePatchWork } from "../../src/integration/ooo-patch.ts";

const TASK = "A";
const FILE = "src/check.ts";
const baseline = { [FILE]: "export const a = 1;\n" };
const plan: ProbePlan = [[TASK, "", [], "isolated-artifact", null, null]];

/** One board-level unit, claimed and submitted the way a host does it: the store decides the verdict
 *  from the candidate bytes, and the host never reads a worker's claim about itself. */
async function submitOne(board: BoardAdmission): Promise<string> {
  const spec: PatchTaskSpec = {
    instruction: "work on A",
    files: baseline,
    editable: [FILE],
    verify: async () => "accept",
  };
  board.installPatchTask(TASK, spec);
  const ticket = board.claim(TASK, "post-commit-test");
  assert.ok(ticket.patch, "the plan declares a patch task");
  const frozen = preparePatchWork({
    taskId: ticket.patch.taskId,
    attempt: ticket.attempt,
    instruction: ticket.patch.instruction,
    files: ticket.patch.files,
    editable: ticket.patch.editable,
    visible: ticket.patch.visible,
    admittedConclusions: ticket.patch.admittedConclusions,
    budget: ticket.patch.budget,
    limits: ticket.patch.limits,
  });
  // The worker's artifact is the wire shape the host validates (`{ digest, files: [{ path, content }] }`),
  // not the store's `PatchSubmission`: the host re-derives the submission from its own frozen work.
  const artifact = JSON.stringify({
    digest: frozen.digest,
    files: [{ path: FILE, content: `${baseline[FILE]}// A\n` }],
  });
  const entry = board.putTaskBoardEntry({
    taskId: board.channel,
    agentId: "post-commit-test",
    kind: "result",
    content: JSON.stringify({ ticket, artifact }),
    expiresAt: new Date(board.now + 86_400_000).toISOString(),
  });
  return board.submit(entry.id);
}

test("a notification that fails does not turn a landed commit into a failed submission", async () => {
  // The control first: the same unit with a reachable notification reports nothing, so the failure
  // below is the notification and not a field that is always set.
  const quiet = new BoardAdmission(":memory:", plan, {});
  try {
    assert.equal(await submitOne(quiet), "accepted", "the unit is accepted when nothing fails");
    assert.equal(
      quiet.lastNotificationFailure(),
      null,
      "a notification that arrives is not a failure",
    );
  } finally {
    quiet.close();
  }

  const board = new BoardAdmission(":memory:", plan, {});
  // The board runs its own post-commit bookkeeping through `afterVerify`, so only the notification
  // part of "after the commit" fails: the commit itself has already happened by then.
  board.afterCommit = async () => {
    throw new Error("subscriber unreachable");
  };
  try {
    assert.equal(
      await submitOne(board),
      "accepted",
      "the commit landed, and the caller is told so rather than told the submission failed",
    );
    assert.deepEqual(Object.keys(board.accepted()), [TASK], "the artifact is the board's now");
    assert.match(
      String(board.lastNotificationFailure()),
      /subscriber unreachable/u,
      "the failure is reported separately instead of thrown at a caller who would then resubmit",
    );
  } finally {
    board.close();
  }
});
