/**
 * The round's storage is namespaced by run, so one store can hold several rounds without them
 * colliding — and a store built before that existed is migrated rather than discarded.
 *
 * What these tests are for: the design's persistence bullet "two rounds with the same taskId must
 * not collide" was untestable while a store held exactly one run (`ooo_probe_meta` had
 * `CHECK(id=1)`, the task table was keyed by `id` alone, and the board channel was a constant).
 * The first test here is that bullet; the last is that a store this code wrote earlier still
 * opens, with its run, its rows and its terminal decision intact.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  BoardAdmission,
  roundChannel,
  type PatchTaskSpec,
  type ProbePlan,
} from "../../src/integration/ooo-board.ts";

const plan: ProbePlan = [
  ["A", "", [], "isolated-artifact", null, null],
  ["B", "", [], "isolated-artifact", null, null],
  ["C", "", ["A", "B"], "isolated-artifact", null, null],
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

/** Raw rows, read with a separate handle: a migration is judged on what is in the file. */
function rows(path: string, sql: string): Record<string, unknown>[] {
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    return reader.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    reader.close();
  }
}

/** A scratch directory whose stores are closed before it is removed. One hook, not two: on
 *  Windows an open handle makes the removal fail rather than the assertion, and hooks run in
 *  registration order, so a cleanup registered before the stores are opened deletes first. */
function scratch(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "nmg-run-namespace-"));
  const opened: BoardAdmission[] = [];
  const adopt = (gate: BoardAdmission): BoardAdmission => {
    opened.push(gate);
    return gate;
  };
  const open = (name: string, options: { runId?: string } = {}): BoardAdmission =>
    adopt(new BoardAdmission(join(directory, name), plan, specs, options));
  t.after(() => {
    for (const gate of opened) gate.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { directory, open, adopt };
}

test("two runs in one store do not collide, do not see each other, and cancel separately", (t) => {
  const { directory, open, adopt } = scratch(t);
  const first = open("shared.sqlite", { runId: "run-one" });
  const second = open("shared.sqlite", { runId: "run-two" });

  // Same task ids, different runs, different channels: the collision the design asked about.
  assert.notEqual(first.channel, second.channel);
  assert.equal(first.channel, roundChannel("run-one"));
  assert.equal(second.runId, "run-two");

  const database = join(directory, "shared.sqlite");
  assert.equal(first.claim("A", "worker-one").owner, "worker-one");
  // The second run's A is untouched by the first run's claim and is still the next task to work
  // on there: one run's live claim is not another run's blocked task, and claiming it there does
  // not write the first run's row.
  assert.equal(second.next(), "A");
  assert.equal(second.accepted()["A"], undefined);
  assert.equal(second.claim("A", "worker-two").owner, "worker-two");
  assert.equal(
    rows(database, "SELECT owner FROM ooo_probe_tasks WHERE run_id='run-one' AND id='A'")[0]!.owner,
    "worker-one",
    "the other run's row for the same task id belongs to the other run",
  );

  // A terminal decision is per run: cancelling one leaves the other alive.
  second.cancel("operator stopped this one");
  assert.equal(second.cancelled(), "operator stopped this one");
  assert.equal(first.cancelled(), null);

  // A store holding several runs can still be reopened by name.
  first.observeRevision("A", "input-v1");
  const reopened = adopt(
    new BoardAdmission(join(directory, "shared.sqlite"), plan, specs, { runId: "run-one" }),
  );
  assert.equal(reopened.runId, "run-one");
  assert.equal(reopened.cancelled(), null, "the other run's cancellation is not this run's");
});

test("a store with several runs refuses to guess which one was meant", (t) => {
  const { directory, open } = scratch(t);
  const database = join(directory, "shared.sqlite");
  open("shared.sqlite", { runId: "run-one" });
  open("shared.sqlite", { runId: "run-two" });
  assert.throws(
    () => new BoardAdmission(database, plan, specs),
    /holds 2 runs; name the one to open/u,
    "adopting the newest run and starting another are both silent answers",
  );
});

test("a store with one run is still continued by opening it", (t) => {
  const { open } = scratch(t);
  const runId = open("single.sqlite").runId;
  assert.equal(runId.length > 0, true);
  const reopened = open("single.sqlite");
  assert.equal(reopened.runId, runId, "a one-run store keeps behaving as it did before");
  assert.equal(reopened.channel, roundChannel(runId));
});

test("a pre-namespace store is migrated in place, keeping its run, rows and terminal decision", (t) => {
  const { directory, open } = scratch(t);
  const database = join(directory, "legacy.sqlite");
  // The policy string this code writes for this plan, read from a store it wrote, so the fixture
  // is a store this code could have produced rather than one shaped to pass.
  const reference = open("reference.sqlite", { runId: "reference" });
  const holder = reference as unknown as {
    db: { prepare: (sql: string) => { get: () => { policy: string } } };
  };
  const policy = holder.db.prepare("SELECT policy FROM ooo_probe_runs").get().policy;

  const runId = "legacy-run";
  // The shape this code wrote before runs existed, built directly so the migration is tested
  // against real bytes rather than against this version's schema.
  const legacy = new DatabaseSync(database);
  legacy.exec(`
    CREATE TABLE ooo_probe_meta (id INTEGER PRIMARY KEY CHECK(id=1), run_id TEXT NOT NULL, policy TEXT NOT NULL,
      cancel_reason TEXT, cancelled_at TEXT);
    CREATE TABLE ooo_probe_checks (
      task_id TEXT PRIMARY KEY, ticket TEXT NOT NULL, terminal TEXT, cancelled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ooo_probe_tasks (
      id TEXT PRIMARY KEY, revision TEXT NOT NULL, input TEXT NOT NULL, dependencies TEXT NOT NULL,
      entry_id TEXT UNIQUE, attempt INTEGER NOT NULL DEFAULT 0, owner TEXT, claim_time TEXT,
      input_digest TEXT, artifact TEXT, position INTEGER NOT NULL, effect TEXT NOT NULL,
      source_revision TEXT NOT NULL, observed_revision TEXT NOT NULL,
      wait_event TEXT, external_ready INTEGER NOT NULL, operation TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'snapshot', patch_files TEXT, patch_editable TEXT,
      accepted_entry_id TEXT
    );
  `);
  legacy
    .prepare("INSERT INTO ooo_probe_meta (id, run_id, policy, cancel_reason) VALUES (1, ?, ?, ?)")
    .run(runId, policy, "operator stopped it");
  const insert = legacy.prepare(
    `INSERT INTO ooo_probe_tasks (id, revision, input, dependencies, attempt, owner, artifact, position,
       effect, source_revision, observed_revision, wait_event, external_ready, operation, kind)
     VALUES (?, 'v1', ?, ?, ?, ?, ?, ?, ?, 'input-v1', 'input-v1', NULL, 1, '', 'snapshot')`,
  );
  insert.run("A", "A", "[]", 1, "worker-one", "commit-a", 0, "isolated-artifact");
  insert.run("C", "C", '["A"]', 0, null, null, 2, "isolated-artifact");
  legacy
    .prepare(
      "INSERT INTO ooo_probe_checks (task_id, ticket, terminal, cancelled) VALUES (?, ?, ?, 0)",
    )
    .run("A", JSON.stringify({ taskId: "A", attempt: 1 }), "accepted");
  legacy.close();

  const gate = open("legacy.sqlite");
  assert.equal(gate.runId, runId, "the stored run identity is kept, not replaced");
  assert.equal(gate.channel, roundChannel(runId));
  assert.equal(gate.cancelled(), "operator stopped it", "the terminal decision survives");

  // The work state survives: the artifact, the attempt counted, the owner, and the dependency
  // list of the task that was waiting on it. Rows come back with a null prototype, so they are
  // copied before being compared as objects.
  const worked = rows(
    database,
    "SELECT artifact, attempt, owner FROM ooo_probe_tasks WHERE id='A'",
  )[0]!;
  assert.deepEqual(
    { ...worked },
    { artifact: "commit-a", attempt: 1, owner: "worker-one" },
    "the artifact, the attempt and the owner are the stored ones",
  );
  assert.equal(
    rows(database, "SELECT dependencies FROM ooo_probe_tasks WHERE id='C'")[0]!.dependencies,
    '["A"]',
  );
  assert.equal(
    rows(database, "SELECT terminal FROM ooo_probe_checks WHERE task_id='A'")[0]!.terminal,
    "accepted",
  );
  // And the decision it kept is enforced, not merely readable: a cancelled run fences work.
  assert.throws(() => gate.claim("B", "worker-two"), /round cancelled/u);
  // Acceptance, though, is not restored from the old column. A pre-namespace store recorded the
  // round's own verdict, which is what the board's independent verdict replaced, so the migration
  // must not promote it: the artifact is present and unaccepted, not silently accepted.
  gate.observeRevision("A", "input-v1");
  assert.deepEqual(gate.accepted(), {});

  const names = rows(database, "SELECT name FROM sqlite_master WHERE type='table'").map((row) =>
    String(row.name),
  );
  assert.equal(names.includes("ooo_probe_runs"), true);
  assert.equal(
    names.includes("ooo_probe_meta"),
    false,
    "the single-row table is gone, not copied forward",
  );
  assert.equal(names.includes("ooo_probe_tasks_legacy"), false);
});
