import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoardAdmission,
  type PatchTaskSpec,
  type ProbePlan,
} from "../../src/integration/ooo-board.ts";
import { expectedRenameOf, RENAME_TARGET, renameSource } from "./rename-probe.ts";

const TARGET = RENAME_TARGET;
const source = renameSource();
const expected = expectedRenameOf(source);

/** Two independent patch tasks plus one that depends on the first, so "more than one claim at once"
 *  is real work and a dependency is still a dependency. */
const plan: ProbePlan = [
  ["P", "", [], "isolated-artifact", null, null],
  ["Q", "", [], "isolated-artifact", null, null],
  ["R", "", ["P"], "isolated-artifact", null, null],
];

async function verifyRename() {
  return "accept" as const;
}

const spec = (id: string): PatchTaskSpec => ({
  instruction: `rename for ${id}`,
  files: { [TARGET]: source },
  editable: [TARGET],
  verify: verifyRename,
});

function fixture(
  t: TestContext,
  options: ConstructorParameters<typeof BoardAdmission>[3],
): BoardAdmission {
  const dir = mkdtempSync(join(tmpdir(), "ooo-slots-"));
  const gate = new BoardAdmission(
    join(dir, "store.sqlite"),
    plan,
    { P: spec("P"), Q: spec("Q"), R: spec("R") },
    options,
  );
  t.after(() => {
    gate.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return gate;
}

/** The host submission path: the result entry carries the ticket and the artifact, and the store
 *  decides. Accepting a claimed task is what frees its dependents. */
async function acceptUnit(
  gate: BoardAdmission,
  ticket: { owner: string; patch?: { digest: string } },
) {
  const entry = gate.putTaskBoardEntry({
    taskId: gate.channel,
    agentId: ticket.owner,
    kind: "result",
    content: JSON.stringify({
      ticket,
      artifact: JSON.stringify({
        digest: ticket.patch!.digest,
        files: [{ path: TARGET, content: expected }],
      }),
    }),
    expiresAt: new Date(gate.now + 60_000).toISOString(),
  });
  return gate.submit(entry.id);
}

const handoffs = (gate: BoardAdmission) =>
  gate
    .readTaskBoard({ taskId: gate.channel })
    .entries.filter((entry) => entry.kind === "handoff")
    .sort((left, right) => String(left.to).localeCompare(String(right.to)));

test("a declared budget holds two claims at once, and the store is why each handoff is directed", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ooo-slots-unrefused-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A budget above one without a target is refused, and by name: the store keeps one outstanding
  // un-directed actionable per channel and queues the next as `pending`, so the second slot's
  // handoff could be published but its claim would be refused - a fallback, not a second slot.
  assert.throws(
    () =>
      new BoardAdmission(
        join(dir, "store.sqlite"),
        plan,
        { P: spec("P"), Q: spec("Q"), R: spec("R") },
        { slots: 2 },
      ),
    /must name each handoff's target/,
  );

  const gate = fixture(t, { slots: 2, handoffTarget: (taskId) => `worker-${taskId}` });
  assert.deepEqual(gate.candidates(), ["P", "Q"], "R waits on P, at any budget");
  assert.deepEqual(gate.startable(), ["P", "Q"], "two slots may start both legal tasks");
  // The publication is the load-bearing part: both handoffs exist before either is claimed, and
  // neither is queued behind the other, because a directed entry is not serialised.
  const published = handoffs(gate);
  assert.equal(published.length, 2, "one handoff per startable task, published up front");
  assert.deepEqual(
    published.map((entry) => entry.to),
    ["worker-P", "worker-Q"],
  );
  assert.deepEqual(
    published.map((entry) => entry.serialState),
    [null, null],
    "a directed entry is not serialised, which is what lets two claims coexist",
  );
  // A republish must not withdraw the offer it just made, and it must not churn it either: a reader
  // that saw the offer by id would otherwise chase an entry that was resolved and replaced. With one
  // slot the non-head handoff is retired as unselected, which is right there and wrong here.
  const idsBefore = published.map((entry) => entry.id);
  gate.refresh();
  assert.deepEqual(
    handoffs(gate).map((entry) => entry.id),
    idsBefore,
    "a republish keeps every startable handoff, by identity",
  );
  assert.throws(() => gate.claim("R", "worker-R"), /unfulfilled dependencies/);
  // The non-head is claimed first, deliberately: with two slots both legal tasks are startable, and
  // a licence that named only the head would refuse this one.
  assert.equal(gate.claim("Q", "worker-Q").owner, "worker-Q", "the second legal task is startable");
  assert.equal(gate.claim("P", "worker-P").owner, "worker-P", "the second claim is held at once");
  // Both slots are spent: the rule's own answer is an empty set, for both readings.
  assert.deepEqual(gate.candidates(), []);
  assert.deepEqual(gate.startable(), []);
  assert.throws(() => gate.claim("Q", "worker-Q"), /task already claimed/);
});

test("at the default budget the licence is still the head of the ordered set", (t) => {
  const gate = fixture(t, {});
  assert.deepEqual(
    gate.candidates(),
    ["P", "Q"],
    "the legal set is what a caller may report or rank, whatever the budget",
  );
  assert.deepEqual(gate.startable(), ["P"], "the licence is the budget's part of that set");
  const published = handoffs(gate);
  assert.equal(published.length, 1, "one slot publishes one handoff");
  assert.equal(published[0]!.to, null, "the default budget publishes the broadcast handoff");
  assert.equal(
    published[0]!.serialState,
    "outstanding",
    "an un-directed actionable takes the board's serial slot, which is the D14 boundary",
  );
  // Q has no published handoff, because a run with one slot never offers it one - the refusal
  // names that, and it is the same refusal the layer gave before a budget existed.
  assert.throws(() => gate.claim("Q", "worker-Q"), /no published handoff for this task/);
  const ticket = gate.claim("P", "worker-P");
  assert.equal(ticket.owner, "worker-P");
  assert.deepEqual(gate.candidates(), [], "a spent budget selects nothing, as it always did");
});

test("accepting a claimed unit frees its dependent while the other slot is still held", async (t) => {
  const gate = fixture(t, { slots: 2, handoffTarget: (taskId) => `worker-${taskId}` });
  const first = gate.claim("P", "worker-P");
  gate.claim("Q", "worker-Q");
  assert.deepEqual(gate.candidates(), [], "both slots are spent, and R is not free yet");
  assert.equal(await acceptUnit(gate, first), "accepted");
  assert.deepEqual(
    gate.candidates(),
    ["R"],
    "P's acceptance frees R, and Q's claim still holds the other slot",
  );
  assert.deepEqual(gate.startable(), ["R"], "one slot left is one startable task");
});
