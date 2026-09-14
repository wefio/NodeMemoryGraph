/**
 * The design's C4: an unknown external result in a crash window is not guessed - not as success,
 * and not as "it never happened".
 *
 * The store enforces this more strongly than a comment could: an external event can only be marked
 * ready when the check issued for the waiting task has reported a terminal, bound result. So the
 * crash window - between the external operation being issued and its result being recorded - cannot
 * be closed by anyone deciding the answer arrived, and the wait is read back as pending rather than
 * promoted or discarded.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  BoardAdmission,
  type PatchTaskSpec,
  type ProbePlan,
} from "../../src/integration/ooo-board.ts";

const plan: ProbePlan = [
  ["A", "", [], "isolated-artifact", "protocol-regression", null],
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

function rows(path: string, sql: string): Record<string, unknown>[] {
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    return reader.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    reader.close();
  }
}

function scratch(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "nmg-external-window-"));
  const opened: BoardAdmission[] = [];
  t.after(() => {
    // The crash simulation in the test closes a gate on purpose, so a second close is expected.
    for (const gate of opened) {
      try {
        gate.close();
      } catch {
        /* already closed by the test */
      }
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return {
    database: join(directory, "window.sqlite"),
    open: (runId?: string): BoardAdmission => {
      const gate = new BoardAdmission(
        join(directory, "window.sqlite"),
        plan,
        specs,
        runId ? { runId } : {},
      );
      opened.push(gate);
      return gate;
    },
  };
}

test("a pending external result survives a restart as pending, not as a guess", (t) => {
  const { database, open } = scratch(t);
  const gate = open("run-window");

  // The check runs while the wait is pending: that is the concurrency the round exists for.
  assert.equal(gate.issueCheck("A", "worker-one").taskId, "A");

  // The wait cannot be closed by announcing it. There is no terminal evidence bound to this task, so
  // the store refuses - which is the property, not the message.
  assert.throws(
    () => gate.externalReady("protocol-regression"),
    /bound terminal evidence/,
    "a result that nobody observed must not be recordable",
  );
  assert.throws(() => gate.externalReady("invented"), /unknown external event/);

  // Simulate the crash: nothing was recorded, the handle goes away, a successor opens the store.
  gate.close();
  const successor = open("run-window");
  const pending = rows(
    database,
    "SELECT external_ready, artifact FROM ooo_probe_task_view WHERE run_id='run-window' AND id='A'",
  )[0]!;
  assert.equal(pending.external_ready, 0, "an unrecorded result is not read back as success");
  assert.equal(pending.artifact, null, "and no artifact appeared while nobody was looking");
  assert.deepEqual(successor.accepted(), {}, "the crashed window accepts nothing");
  assert.equal(successor.cancelled(), null, "and the crash is not mistaken for a cancellation");

  // The successor is no more able to close the wait by fiat than the first process was: pending has
  // to stay pending until a check reports, which is the difference between an unknown result and a
  // convenient one. It is still nameable, so pending does not mean lost.
  assert.throws(() => successor.externalReady("protocol-regression"), /bound terminal evidence/);
  assert.equal(
    rows(
      database,
      "SELECT external_ready FROM ooo_probe_task_view WHERE run_id='run-window' AND id='A'",
    )[0]!.external_ready,
    0,
    "the wait is still the same pending wait after the restart",
  );
});
