/**
 * G3: failure, cancellation and the ordered fallback on the ordinary blackboard path.
 *
 * The design's minimal discriminating cases, on the path a caller reaches with the board's own verbs.
 * Every expectation here was measured against the board first, because the honest version of these
 * rules is stricter than a first guess: a refused deliverable is not re-selected on its own (the
 * coordinator reopens it), a live claim keeps blocking selection, and a cancellation names the lease
 * it revoked. The last case is a split refusal, because the design's split rules are host-declared
 * and refused by name rather than guessed.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BoardAdmission,
  type BoardTicket,
  type PatchTaskSpec,
  type ProbePlan,
} from "../../src/integration/ooo-board.ts";
import { checkRefinement, compileTaskUnits } from "../../src/integration/task-semantics.ts";

const REV = "input-v1";
const IMPL = "src/ordinary.ts";
const TESTS = "src/ordinary.test.ts";
const baseline = { [IMPL]: "export const a = 1;\n", [TESTS]: "test('a', () => {});\n" };

/** B runs first; A declares it as a dependency. */
const plan: ProbePlan = [
  ["B", REV, [], "isolated-artifact", null, null],
  ["A", REV, ["B"], "isolated-artifact", null, null],
];

/** What the host's verification says next. A rejection is one host decision, not a board rule. */
let verdictB: "accept" | "reject" = "accept";

const specs: Record<string, PatchTaskSpec> = {
  A: {
    instruction: "A works.",
    files: { [IMPL]: baseline[IMPL] },
    editable: [IMPL],
    verify: async () => "accept",
  },
  B: {
    instruction: "B works.",
    files: { [TESTS]: baseline[TESTS] },
    editable: [TESTS],
    verify: async () => verdictB,
  },
};

function open(runId: string) {
  const directory = mkdtempSync(join(tmpdir(), "nmg-ordinary-failure-"));
  const gate = new BoardAdmission(join(directory, "round.sqlite"), plan, specs, { runId });
  const deliver = (ticket: BoardTicket, path: string, content: string) =>
    JSON.stringify({ digest: ticket.inputDigest, files: [{ path, content }] });
  const submitAs = (ticket: BoardTicket, agentId: string, artifact: string) => {
    const entry = gate.putTaskBoardEntry({
      taskId: gate.channel,
      agentId,
      kind: "result",
      content: JSON.stringify({ ticket, artifact }),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    return gate.submit(entry.id);
  };
  return { gate, deliver, submitAs };
}

const B_DONE = "test('a', () => {}); test('b', () => {});\n";

test("a deliverable the host refuses neither accepts nor releases, and the coordinator reopens it", async (t) => {
  const { gate, deliver, submitAs } = open("ordinary-rejection");
  t.after(() => gate.close());
  verdictB = "reject";

  const ticket = gate.claim("B", "worker-one") as BoardTicket;
  assert.equal(
    await submitAs(ticket, "worker-one", deliver(ticket, TESTS, B_DONE)),
    "rejected",
    "the host's verification refuses this artifact",
  );

  assert.deepEqual(gate.accepted(), {}, "a refused artifact is not an acceptance");
  assert.equal(
    gate.next(),
    null,
    "and it is not selected again on its own: the coordinator has to reopen it",
  );
  assert.throws(
    () => gate.claim("A", "worker-two"),
    /unfulfilled dependencies/u,
    "the dependent is not released by a refused deliverable",
  );
  assert.throws(
    () => gate.claim("B", "worker-one"),
    /task already claimed/u,
    "the refused attempt still holds its claim, so a retry waits for the reopen",
  );

  // The coordinator's recovery, then the same task with an artifact the host accepts.
  gate.reopen("B");
  verdictB = "accept";
  assert.equal(gate.next(), "B", "the reopened task is selectable again");
  const retry = gate.claim("B", "worker-one") as BoardTicket;
  assert.equal(await submitAs(retry, "worker-one", deliver(retry, TESTS, B_DONE)), "accepted");
  assert.equal(gate.next(), "A", "accepting the dependency releases the dependent");
});

test("a cancellation names the lease it revokes, and the batch behind it is refused", async (t) => {
  const { gate } = open("ordinary-cancellation");
  t.after(() => gate.close());
  verdictB = "accept";

  gate.claim("B", "worker-one");
  assert.deepEqual(
    gate.cancel("operator cancelled the round"),
    ["B"],
    "the cancellation names the lease it revoked",
  );
  assert.equal(gate.cancelled(), "operator cancelled the round");
  assert.equal(gate.next(), null, "a cancelled round selects nothing");

  // Every claim in the batch is refused, not only the one that happened to be first.
  assert.throws(() => gate.claim("A", "worker-two"), /cancelled/u);
  assert.throws(() => gate.claim("B", "worker-one"), /cancelled/u);

  // The first decision is the one that took effect: a later cancel does not rewrite the reason.
  assert.deepEqual(gate.cancel("something else"), [], "cancelling twice withdraws nothing new");
  assert.equal(gate.cancelled(), "operator cancelled the round");
});

test("with no fusion point the plan falls back to its declared order", async (t) => {
  const { gate, deliver, submitAs } = open("ordinary-ordered");
  t.after(() => gate.close());
  verdictB = "accept";

  // Both tasks are on files the same session would touch, which is the shape a fusion pass would look
  // for. There is none here, so the baseline is one task at a time in declared order.
  assert.equal(gate.next(), "B", "one task is selected, not a fused pair");
  const ticketB = gate.claim("B", "worker-one") as BoardTicket;
  assert.equal(gate.next(), null, "and while its claim is live nothing else is selected");
  assert.equal(await submitAs(ticketB, "worker-one", deliver(ticketB, TESTS, B_DONE)), "accepted");

  assert.equal(gate.next(), "A");
  const ticketA = gate.claim("A", "worker-two") as BoardTicket;
  assert.equal(
    await submitAs(ticketA, "worker-two", deliver(ticketA, IMPL, "export const a = 2;\n")),
    "accepted",
  );
  assert.deepEqual(Object.keys(gate.accepted()).sort(), ["A", "B"]);
  assert.equal(gate.next(), null, "and then the plan is finished");
});

test("a split that drops a parent obligation is refused by name, with its location", () => {
  const compiled = compileTaskUnits({ plan, specs });
  assert.equal(compiled.legal, true, "the plan compiles: " + JSON.stringify(compiled.refusals));

  const dropped = checkRefinement(compiled, {
    parent: "B",
    parts: ["A"],
    join: "A",
    obligations: {},
  });
  assert.ok(dropped.length > 0, "a split that maps no parent obligation is refused, not accepted");
  for (const refusal of dropped)
    assert.ok(
      refusal.task && refusal.field && refusal.reason,
      "a refusal names its location: " + JSON.stringify(refusal),
    );
  assert.ok(
    dropped.some((refusal) => refusal.field.startsWith("obligations.")),
    "the refusal points at the obligation the split dropped: " + JSON.stringify(dropped),
  );
});
