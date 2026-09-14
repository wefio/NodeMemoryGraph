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
