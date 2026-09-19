// The status read path is borrowed. It must not migrate the store, must not publish, and must not give
// the caller any way to write - so it goes through the owner's narrow port rather than the board.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BoardAdmission, openRoundQuery } from "../../src/integration/ooo-board.ts";

const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const entries = (path: string): number => {
  const db = new DatabaseSync(path, { readOnly: true });
  const count = db.prepare("SELECT COUNT(*) AS c FROM task_board_entries").get() as { c: number };
  db.close();
  return count.c;
};

test("the terminal decision outlives the host that made it, and still refuses new work", () => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-round-cancel-"));
  test.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const database = join(dir, "cancelled.sqlite");

  // One host claims a task and then decides to stop the round. Cancel is reachable through the
  // ordinary owner, with no dedicated surface: it is the round's own lifecycle operation.
  const first = new BoardAdmission(database, undefined, {}, { runId: "cancel-run" });
  const task = first.next()!;
  first.claim(task, "worker-one");
  assert.deepEqual(
    first.cancel("operator stopped the round"),
    [task],
    "the cancellation names the lease it revoked",
  );
  first.close();

  // A second host opens the same store. The decision has to be a fact in the store rather than in
  // the memory of the process that made it, or a restart would silently resume a stopped round.
  const second = new BoardAdmission(database, undefined, {}, { runId: "cancel-run" });
  try {
    assert.equal(
      second.cancelled(),
      "operator stopped the round",
      "the terminal reason survives the host that recorded it",
    );
    assert.throws(() => second.claim(task, "worker-two"), /cancelled/u);
    assert.deepEqual(second.accepted(), {}, "and nothing is accepted after the decision");
    const fenced = new DatabaseSync(database, { readOnly: true });
    try {
      const row = fenced
        .prepare("SELECT owner, artifact, attempt FROM ooo_probe_facts WHERE run_id=? AND id=?")
        .get("cancel-run", task) as {
        owner: string | null;
        artifact: string | null;
        attempt: number;
      };
      assert.equal(row.owner, null, "the revoked claim is gone, not merely refused");
      assert.equal(row.artifact, null, "and the attempt holds no artifact");
      assert.equal(
        row.attempt,
        2,
        "the fence advanced the attempt past the claim it revoked, so a late delivery is stale",
      );
    } finally {
      fenced.close();
    }
  } finally {
    second.close();
  }
});

test("the query port reads a round without migrating, publishing or exposing a write", () => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-round-view-"));
  test.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const database = join(dir, "store.sqlite");
  const owner = new BoardAdmission(database);
  owner.close();
  const before = hash(database);
  const beforeEntries = entries(database);

  const view = openRoundQuery(database);
  try {
    assert.deepEqual(
      Object.keys(view.port).sort(),
      ["accepted", "cancelled"],
      "the port is reads only",
    );
    const asRecord = view.port as unknown as Record<string, unknown>;
    for (const forbidden of ["close", "claim", "cancel", "deliver", "judge", "put", "db"])
      assert.equal(asRecord[forbidden], undefined, `the port exposes ${forbidden}`);
    assert.equal(view.port.cancelled(), null, "an uncancelled round has no reason");
    assert.deepEqual(view.port.accepted(), {}, "nothing is accepted yet");
  } finally {
    view.close();
  }

  assert.equal(hash(database), before, "the read path wrote to the store");
  assert.equal(entries(database), beforeEntries, "the read path published something");

  // Each refusal names its own reason: nothing is created, migrated or guessed.
  assert.throws(() => openRoundQuery(join(dir, "missing.sqlite")), /does not exist/u);
  const bare = join(dir, "bare.sqlite");
  new DatabaseSync(bare).close();
  assert.throws(() => openRoundQuery(bare), /no round schema/u);
  assert.throws(() => openRoundQuery(database, "no-such-run"), /holds no run/u);
});
