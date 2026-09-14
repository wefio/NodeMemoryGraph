/**
 * G1 and G2 on the ordinary path: a board handoff, walked with the board's own verbs and nothing
 * else, reaches the shared semantics, runs work, and has that work accepted by an independent
 * verdict - and accepting it releases the dependent that was waiting for it.
 *
 * Nothing here touches `ooo_round`, its CLI or the research entry: the point of G1 is that a caller
 * who only knows the board and the shared semantics can get the whole thing. The selection is
 * asserted through `next()`, which is now the compiler's answer, and cross-checked against
 * `deriveStatus` over the same recorded facts, so the two views are held together rather than
 * assumed to agree.
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
import {
  compileTaskUnits,
  deriveStatus,
  type RecordedFacts,
} from "../../src/integration/task-semantics.ts";

const IMPL = "src/ordinary.ts";
const TESTS = "src/ordinary.test.ts";
const baseline = { [IMPL]: "export const a = 1;\n", [TESTS]: "test('a', () => {});\n" };

/** B first, and A declared as waiting on it: the dependency is the thing under test. */
const REV = "input-v1";
const plan: ProbePlan = [
  ["B", REV, [], "isolated-artifact", null, null],
  ["A", REV, ["B"], "isolated-artifact", null, null],
];

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
    verify: async () => "accept",
  },
};

test("an ordinary handoff reaches the shared semantics, runs, is accepted, and releases its dependent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-ordinary-handoff-"));
  const gate = new BoardAdmission(join(directory, "round.sqlite"), plan, specs, {
    runId: "ordinary-handoff",
  });
  try {
    // The semantics' view of the same plan, for the cross-check at the end.
    const { units, legal, refusals } = compileTaskUnits({ plan, specs });
    assert.equal(legal, true, `the plan compiles: ${JSON.stringify(refusals)}`);

    // Before anything is accepted, the dependent is not selectable: B is the only legal action, and
    // A must not appear merely because it is declared.
    assert.equal(gate.next(), "B");
    assert.deepEqual(
      deriveStatus(units, {}).ready,
      ["B"],
      "the compiler agrees that B is the only thing to do",
    );

    // The worker is the caller's own code. Here it delivers a patch whose digest is the one the
    // claim froze, which is the only envelope the board accepts for a patch task.
    const delivery = (taskId: string, ticket: BoardTicket, path: string, content: string) =>
      JSON.stringify({ digest: ticket.inputDigest, files: [{ path, content }] });

    const ticketB = gate.claim("B", "worker-one") as BoardTicket;
    const entryB = gate.putTaskBoardEntry({
      taskId: gate.channel,
      agentId: "worker-one",
      kind: "result",
      content: JSON.stringify({
        ticket: ticketB,
        artifact: delivery("B", ticketB, TESTS, "test('a', () => {}); test('b', () => {});\n"),
      }),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(
      await gate.submit(entryB.id),
      "accepted",
      "the artifact is accepted by the board's own verdict",
    );

    // G2: the acceptance is what releases A. The compiler says so over the recorded facts, and the
    // board - which now answers selection with that same rule - says so too.
    const accepted = gate.accepted();
    const commitB = accepted.B;
    assert.ok(commitB, "B's artifact is the value A is released by");
    const facts: RecordedFacts = {
      artifacts: { B: commitB },
      verdicts: { B: { digest: commitB, verdict: "accepted" } },
      revisions: { B: REV },
      sourceRevisions: { B: REV },
    };
    assert.deepEqual(deriveStatus(units, facts).ready, ["A"], "accepting B releases A");
    assert.deepEqual(deriveStatus(units, facts).accepted, ["B"]);
    assert.equal(gate.next(), "A", "and the board's selection is that same answer");

    // The released dependent runs to completion through the same ordinary path.
    const ticketA = gate.claim("A", "worker-two") as BoardTicket;
    const entryA = gate.putTaskBoardEntry({
      taskId: gate.channel,
      agentId: "worker-two",
      kind: "result",
      content: JSON.stringify({
        ticket: ticketA,
        artifact: delivery("A", ticketA, IMPL, "export const a = 2;\n"),
      }),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(await gate.submit(entryA.id), "accepted");
    assert.deepEqual(Object.keys(gate.accepted()).sort(), ["A", "B"]);
    assert.equal(gate.next(), null, "and with both accepted there is nothing left to select");
  } finally {
    gate.close();
  }
});
