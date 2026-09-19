/**
 * The design's D5: the owner's borrowed view and the offline read-only path must agree on the same
 * facts at the same evaluation time. Each path is covered for its own properties elsewhere; what
 * this file adds is that they do not disagree, so "status says accepted" and "the dependency view
 * says accepted" cannot come from two different rules or two different moments.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BoardAdmission,
  openRoundQuery,
  type BoardTicket,
  type PatchTaskSpec,
  type ProbePlan,
} from "../../src/integration/ooo-board.ts";

const plan: ProbePlan = [
  ["A", "", [], "isolated-artifact", null, null],
  ["B", "", [], "isolated-artifact", null, null],
];
const specs: Record<string, PatchTaskSpec> = {
  A: {
    instruction: "A.",
    files: { "a.ts": "export const a = 1;\n" },
    editable: ["a.ts"],
    verify: async () => "accept",
  },
  B: {
    instruction: "B.",
    files: { "b.ts": "export const b = 1;\n" },
    editable: ["b.ts"],
    verify: async () => "accept",
  },
};

function scratch(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "nmg-read-paths-"));
  const opened: BoardAdmission[] = [];
  t.after(() => {
    for (const gate of opened) gate.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return {
    directory,
    open: (name: string, options: { runId?: string } = {}): BoardAdmission => {
      const gate = new BoardAdmission(join(directory, name), plan, specs, options);
      opened.push(gate);
      return gate;
    },
  };
}

/** The only way an artifact becomes accepted: the claimed owner's own board entry, verified by the
 *  host. The two paths are compared on a NON-EMPTY answer, because two readers that both say
 *  "nothing accepted" agree without either of them reading anything. */
async function accept(
  gate: BoardAdmission,
  ticket: BoardTicket,
  task: string,
  agent: string,
): Promise<void> {
  const artifact = JSON.stringify({
    digest: ticket.patch!.digest,
    files: Object.entries(specs[task]!.files).map(([path, content]) => ({
      path,
      content: `${content}// candidate for ${task}\n`,
    })),
  });
  const entry = gate.putTaskBoardEntry({
    taskId: gate.channel,
    agentId: agent,
    kind: "result",
    content: JSON.stringify({ ticket, artifact }),
    expiresAt: new Date(gate.now + 86_400_000).toISOString(),
  });
  assert.equal(await gate.submit(entry.id), "accepted");
}

test("the owner's view and the offline reader report the same facts", async (t) => {
  const { directory, open } = scratch(t);
  const database = join(directory, "agree.sqlite");
  const gate = open("agree.sqlite", { runId: "run-agree" });
  const ticketA = gate.claim("A", "worker-one");

  // While the round is live: nothing is accepted on either path, and neither reports a terminal
  // decision. An artifact that exists is not acceptance, and a claim is not a verdict.
  const live = openRoundQuery(database, "run-agree");
  try {
    assert.deepEqual(gate.accepted(), {}, "nothing is accepted yet");
    assert.deepEqual(live.port.accepted(), gate.accepted(), "both paths agree while live");
    assert.equal(live.port.cancelled(), null, "no terminal reason yet");
    assert.equal(live.port.cancelled(), gate.cancelled(), "both paths agree on that too");
  } finally {
    live.close();
  }

  // The accepting direction, so agreement is not the agreement of two empty answers: the owner's
  // view and a freshly opened read-only one must both report A, and the offline reader is the one
  // an outside process would ask.
  await accept(gate, ticketA, "A", "worker-one");
  assert.deepEqual(
    Object.keys(gate.accepted()),
    ["A"],
    "the owner's view reports the accepted task, so the comparison below is not vacuous",
  );
  const reader = openRoundQuery(database, "run-agree");
  try {
    assert.deepEqual(
      reader.port.accepted(),
      gate.accepted(),
      "both paths report the same acceptance",
    );
    assert.equal(
      reader.port.accepted()["A"],
      gate.accepted()["A"],
      "and the same artifact bytes, not merely the same task ids",
    );
  } finally {
    reader.close();
  }

  // After a terminal decision: the read-only path is opened fresh, so its answer is the one an
  // outside process would get right now - and it has to be the same answer.
  gate.cancel("operator stopped this one");
  const after = openRoundQuery(database, "run-agree");
  try {
    assert.equal(after.port.cancelled(), "operator stopped this one");
    assert.equal(after.port.cancelled(), gate.cancelled(), "the terminal reason is the same one");
    assert.deepEqual(after.port.accepted(), gate.accepted(), "and so is acceptance");
    assert.deepEqual(after.port.accepted(), {}, "a cancelled round accepts nothing on either path");
  } finally {
    after.close();
  }
});
