/**
 * Two fencing properties the persistence contract asks for, tested through the public surface:
 *
 *   - concurrent readers of the same ready task: exactly one gets a legal claim;
 *   - a generic board operation cannot move a managed round's own state.
 *
 * Both are checked by what the store ends up holding and what the round then reads, not by what
 * a call returns. What is deliberately not asserted here is which task `next()` selects after a
 * claim: that is the coordinator's scheduling policy, and the design puts dispatch order in the
 * coordinator rather than in the fence. The second test also accepts either outcome of the
 * generic call - a refusal is correct too - because the property is that the round's owner,
 * attempt and acceptance do not change underneath it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import {
  BoardAdmission,
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

/** Raw rows, read with a separate handle: the fence is judged on what is in the file. */
function rows(path: string, sql: string): Record<string, unknown>[] {
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    return reader.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    reader.close();
  }
}

/** A scratch directory whose stores are closed before it is removed. One hook, not two: on
 *  Windows an open handle makes the removal fail instead of the assertion, and hooks run in
 *  registration order. */
function scratch(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "nmg-managed-fence-"));
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

test("one reader of the same ready task is given the claim, the second is refused", (t) => {
  const { directory, open } = scratch(t);
  const database = join(directory, "claim.sqlite");
  const gate = open("claim.sqlite", { runId: "run-claim" });

  assert.equal(gate.claim("A", "worker-one").owner, "worker-one");
  const entryId = String(
    rows(
      database,
      "SELECT entry_id FROM ooo_probe_task_view WHERE run_id='run-claim' AND id='A'",
    )[0]!.entry_id,
  );

  // The second reader of the same ready task is refused rather than handed the same work.
  assert.throws(() => gate.claim("A", "worker-two"));
  assert.equal(
    rows(database, "SELECT owner FROM ooo_probe_task_view WHERE run_id='run-claim' AND id='A'")[0]!
      .owner,
    "worker-one",
    "the claim the store holds is the first one",
  );

  // And the refusal is not the round's own bookkeeping. A second reader that reaches the board
  // directly - the shape another process has, and the one the round's own check cannot see -
  // must lose the same CAS. Without this the property holds only because one caller asked
  // nicely, and the store would hand the same live claim to two readers.
  const store = new NmgStore(database);
  try {
    assert.throws(
      () => store.claimTaskBoardEntry({ taskId: gate.channel, entryId, agentId: "worker-two" }),
      /already claimed by worker-one/u,
      "the store refuses a live claim held by another reader",
    );
    assert.equal(
      rows(
        database,
        "SELECT owner FROM ooo_probe_task_view WHERE run_id='run-claim' AND id='A'",
      )[0]!.owner,
      "worker-one",
      "and the direct attempt did not reassign the round's own claim either",
    );
  } finally {
    store.close();
  }
});

test("a claim the board retires inside the verification window cannot be committed", async (t) => {
  const { directory, open } = scratch(t);
  const database = join(directory, "retired.sqlite");
  const gate = open("retired.sqlite", { runId: "run-retired" });
  const ticket = gate.claim("A", "worker-one");
  const entryId = String(
    rows(
      database,
      "SELECT entry_id FROM ooo_probe_task_view WHERE run_id='run-retired' AND id='A'",
    )[0]!.entry_id,
  );

  // The work is real and the host would accept it: the round is one transaction away from
  // committing. What happens in between is another writer retiring the entry the round holds -
  // verification is await-capable, which is exactly the window the design fences.
  const artifact = JSON.stringify({
    digest: ticket.patch!.digest,
    files: [{ path: "a.ts", content: "export const a = 2;\n" }],
  });
  const result = gate.putTaskBoardEntry({
    taskId: gate.channel,
    agentId: "worker-one",
    kind: "result",
    content: JSON.stringify({ ticket, artifact }),
    expiresAt: new Date(gate.now + 86_400).toISOString(),
  });
  gate.afterVerify = async () => {
    const store = new NmgStore(database);
    try {
      store.resolveTaskBoardEntry({
        taskId: gate.channel,
        entryId,
        agentId: "outsider",
        resolution: "this entry is mine to close",
      });
    } finally {
      store.close();
    }
  };

  // The commit is where the claim is re-checked. A generic write cannot make the round ACCEPT
  // anything - the board's own verbs are how an Agent works a handoff, so the fence is not that
  // the write is impossible; it is that the decision taken before the wait is not applied after
  // it. The retired attempt fails closed instead, and nothing is accepted on its behalf.
  assert.equal(
    await gate.submit(result.id),
    "stale",
    "an attempt whose claim was retired while it verified is stale, not committed",
  );
  assert.deepEqual(gate.accepted(), {}, "a retired attempt accepts nothing");
  const after = rows(
    database,
    "SELECT owner, attempt, artifact FROM ooo_probe_task_view WHERE run_id='run-retired' AND id='A'",
  )[0]!;
  assert.equal(after.owner, "worker-one", "and the round's own claim is still its own fact");
  assert.equal(after.attempt, 1, "the outsider's resolve opened no attempt either");
  assert.equal(after.artifact, null, "no artifact bytes were written by the retired attempt");
});

test("a generic board claim on the round's entry leaves the round's own state alone", (t) => {
  const { directory, open } = scratch(t);
  const database = join(directory, "fence.sqlite");
  const gate = open("fence.sqlite", { runId: "run-fence" });
  gate.claim("A", "worker-one");

  const entryId = String(
    rows(
      database,
      "SELECT entry_id FROM ooo_probe_task_view WHERE run_id='run-fence' AND id='A'",
    )[0]!.entry_id,
  );
  assert.notEqual(entryId, "null", "the round's task holds a board entry to attack");

  // The generic board is a second connection to the same file, which is also the multi-process
  // shape: whichever it decides, the round must still be the owner of its own row.
  const store = new NmgStore(database);
  try {
    try {
      store.claimTaskBoardEntry({ taskId: gate.channel, entryId, agentId: "impostor" });
    } catch {
      // A refusal is an acceptable answer; the assertions below are what the contract is about.
    }
    const after = rows(
      database,
      "SELECT owner, attempt FROM ooo_probe_task_view WHERE run_id='run-fence' AND id='A'",
    )[0]!;
    assert.equal(after.owner, "worker-one", "the round's claim is its own fact");
    assert.equal(after.attempt, 1, "the generic claim opened no attempt on the round's task");
    assert.deepEqual(gate.accepted(), {}, "no generic write makes the round accept anything");
    assert.equal(gate.cancelled(), null, "and nothing terminal was written on the round's behalf");
  } finally {
    store.close();
  }
});
