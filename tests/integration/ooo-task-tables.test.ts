/**
 * A task row used to hold three kinds of fact at once: what the run froze, what the round
 * appended, and what can be recomputed. The split is what makes the third kind cheap to distrust —
 * the design's recomputation requirement ("delete every derived cache and get the same view") has
 * to be a real check, not a claim about the schema.
 *
 * So these tests are about *which* table decides: the manifest is never written after the plan is
 * installed, the candidate bytes outlive a wiped cache because they are facts, and whatever the
 * cache holds is overwritten by the sources rather than trusted.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import {
  BoardAdmission,
  type PatchTaskSpec,
  type ProbePlan,
} from "../../src/integration/ooo-board.ts";

const plan: ProbePlan = [
  ["A", "", [], "isolated-artifact", null, null],
  ["B", "", ["A"], "isolated-artifact", null, null],
];
// A patch task's candidate must differ from the frozen input, so the frozen file and the
// submitted candidate are two different strings here rather than the same one twice.
const FROZEN = "export const a = 1;\n";
const specs: Record<string, PatchTaskSpec> = {
  A: {
    instruction: "A.",
    files: { "a.ts": FROZEN },
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

type Rows = Record<string, unknown>[];

/** Raw rows, read through a second handle: these tests are about what is in the file. */
function rows(path: string, sql: string): Rows {
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    return reader.prepare(sql).all() as Rows;
  } finally {
    reader.close();
  }
}

/** A second, writable handle: these tests play the outsider that wipes or corrupts the cache. */
function write(path: string, sql: string): void {
  const writer = new DatabaseSync(path);
  try {
    writer.exec(sql);
  } finally {
    writer.close();
  }
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "nmg-task-tables-"));
  const database = join(directory, "round.sqlite");
  const gate = new BoardAdmission(database, plan, specs, { runId: "split-run" });
  t.after(() => {
    gate.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  /** The only way an artifact reaches the coordinator: the claimed owner's own board entry. */
  const deliver = async (task: string, agent: string): Promise<void> => {
    const ticket = gate.claim(task, agent);
    // Every task's candidate is built from its own frozen files: a patch task's candidate must
    // differ from the frozen input, and a helper that hard-codes one task's path only works for
    // that one task.
    const spec = specs[task]!;
    const artifact = JSON.stringify({
      digest: ticket.patch!.digest,
      files: Object.entries(spec.files).map(([path, content]) => ({
        path,
        content: `${content}// candidate for ${task}
`,
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
  };
  return { gate, database, deliver };
}

/** The one derived column. Who claimed is a fact, and the board stops reporting it once the round
 *  resolves the entry, so a rebuild cannot re-derive it - that is why it is not here. */
const cache = (database: string, id = "A"): Rows =>
  rows(database, `SELECT input_digest FROM ooo_probe_derived WHERE id='${id}' ORDER BY id`);

test("the three tables hold the three kinds of fact, and a write lands in the right one", (t) => {
  const { gate, database } = fixture(t);
  const manifestBefore = rows(
    database,
    "SELECT * FROM ooo_probe_manifest WHERE run_id='split-run' AND id='A'",
  );
  assert.equal(manifestBefore.length, 1, "the plan is installed as a manifest row");
  assert.equal(rows(database, "SELECT * FROM ooo_probe_facts WHERE id='A'").length, 1);
  assert.equal(
    cache(database).length,
    0,
    "no derived row is written for a task nobody has claimed: it is a cache, not a record",
  );

  gate.claim("A", "worker-one");
  assert.deepEqual(
    rows(database, "SELECT * FROM ooo_probe_manifest WHERE run_id='split-run' AND id='A'")[0],
    manifestBefore[0],
    "a claim writes no part of the manifest",
  );
  assert.equal(
    rows(database, "SELECT attempt FROM ooo_probe_facts WHERE id='A'")[0]!.attempt,
    1,
    "the attempt is a fact",
  );
  assert.equal(
    rows(database, "SELECT owner FROM ooo_probe_facts WHERE id='A'")[0]!.owner,
    "worker-one",
    "the claim holder is a fact: the board will forget it when the entry is resolved",
  );
  assert.equal(
    cache(database)[0]!.input_digest !== null,
    true,
    "and the digest of the input this attempt was claimed against is the cache",
  );

  // The projection is what reads use, and it joins the three.
  const view = rows(
    database,
    "SELECT id, owner, attempt, artifact FROM ooo_probe_task_view WHERE id='A'",
  )[0]!;
  assert.equal(view.owner, "worker-one");
  assert.equal(view.attempt, 1);
  assert.equal(view.artifact, null);
});

test("the frozen plan has one owner, and a second, different plan is refused", (t) => {
  const { database } = fixture(t);
  const frozen = (): Rows =>
    rows(database, "SELECT * FROM ooo_probe_manifest WHERE run_id='split-run' ORDER BY id");
  const before = frozen();
  assert.equal(before.length, 2, "both tasks of the plan are frozen");

  // The same two tasks in the other order are a different plan: the declared order is what the
  // fallback dispatches by, so adopting it would silently replace the run's input.
  const reordered: ProbePlan = [plan[1]!, plan[0]!];
  assert.throws(
    () => new BoardAdmission(database, reordered, specs, { runId: "split-run" }),
    /probe policy changed/u,
    "a second plan for a run that already has one is refused",
  );
  assert.deepEqual(
    frozen(),
    before,
    "and the refused plan wrote nothing over the plan the run froze",
  );

  // The same plan is not a second one: reopening the run the store already holds is how a host
  // continues a round, and it must not look like a new input.
  const again = new BoardAdmission(database, plan, specs, { runId: "split-run" });
  try {
    assert.deepEqual(frozen(), before, "reopening with the same plan changes no frozen row");
  } finally {
    again.close();
  }
});

test("deleting the derived cache and rebuilding it yields the same view", async (t) => {
  const { gate, database, deliver } = fixture(t);
  await deliver("A", "worker-one");
  const before = cache(database);
  assert.equal(before[0]!.input_digest !== null, true);

  write(database, "DELETE FROM ooo_probe_derived");
  assert.equal(cache(database).length, 0);
  // The cache really did carry an answer the view needs, so this is not a vacuous comparison.
  assert.equal(
    rows(database, "SELECT input_digest FROM ooo_probe_task_view WHERE id='A'")[0]!.input_digest,
    null,
  );

  assert.equal(gate.refreshDerived(), 2, "every manifest row is rebuilt");
  assert.deepEqual(cache(database), before, "the rebuilt cache is the same cache");
  assert.equal(
    rows(database, "SELECT artifact FROM ooo_probe_facts WHERE id='A'")[0]!.artifact !== null,
    true,
    "the candidate bytes were never in the cache: wiping it cannot lose them",
  );
  // And the rebuilt value is usable, not merely equal: the next task in the round is still
  // deliverable, which needs the digest the rebuild just recomputed.
  await deliver("B", "worker-two");
  assert.deepEqual(Object.keys(gate.accepted()).sort(), ["A", "B"]);
});

test("the sources overwrite the cache rather than trusting it", async (t) => {
  const { gate, database, deliver } = fixture(t);
  await deliver("A", "worker-one");
  const honest = cache(database)[0]!;
  write(database, "UPDATE ooo_probe_derived SET input_digest='bogus' WHERE id='A'");
  assert.equal(cache(database)[0]!.input_digest, "bogus");

  gate.refreshDerived();
  assert.notEqual(cache(database)[0]!.input_digest, "bogus");
  assert.deepEqual(cache(database), [honest], "and the rebuilt digest is the frozen one");
  // The claim the cache was corrupted beside is untouched: it is a fact.
  assert.equal(
    rows(database, "SELECT owner FROM ooo_probe_facts WHERE id='A'")[0]!.owner,
    "worker-one",
  );
});
