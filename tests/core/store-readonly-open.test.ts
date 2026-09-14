// The read-only factory is a way to look at a store that already exists: it does not create the file,
// does not migrate it, and cannot write to it. The offline host that views a finished round's private
// database is the caller this exists for.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NmgStoreBase } from "../../src/core/store/base.ts";

const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const noop = { chainId: "no-such-chain", memoryId: "no-such-memory" };

test("a read-only open neither creates, migrates nor writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-readonly-"));
  test.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  // A missing store is refused by name, and the refusal does not create it.
  const missing = join(dir, "missing.sqlite");
  assert.throws(
    () => new NmgStoreBase(missing, undefined, { readOnly: true }),
    /does not exist/u,
    "a read-only open of a missing store is refused, not created",
  );
  assert.equal(existsSync(missing), false, "the refusal created the file it was asked to read");

  // A real store, written and closed by its owner.
  const database = join(dir, "store.sqlite");
  const owner = new NmgStoreBase(database);
  assert.equal(owner.removeMemoryFromChain(noop), false, "the owner can write");
  owner.close();
  const before = hash(database);

  // The view reads the same file and cannot write it: the refusal comes from the handle itself, so
  // setting query_only is not what makes this safe.
  const view = new NmgStoreBase(database, undefined, { readOnly: true });
  assert.throws(
    () => view.removeMemoryFromChain(noop),
    /readonly|read-only|attempt to write|not authorized/iu,
    "a write through the read-only handle is refused",
  );
  view.close();
  assert.equal(
    hash(database),
    before,
    "the read-only view changed the database, or checkpointed it",
  );

  // Releasing the view leaves the owner able to write: read-only is a capability of one connection.
  const again = new NmgStoreBase(database);
  assert.equal(again.removeMemoryFromChain(noop), false, "the owner can still write");
  again.close();

  // An existing file with no recognisable schema is not an empty store: it is refused, and migrating
  // it is exactly what the refusal must not do.
  const empty = join(dir, "empty.sqlite");
  new DatabaseSync(empty).close();
  assert.throws(
    () => new NmgStoreBase(empty, undefined, { readOnly: true }),
    /no recognisable schema/u,
    "a schemaless file is refused rather than read as an empty run",
  );
  const probe = new DatabaseSync(empty, { readOnly: true });
  assert.equal(
    (probe.prepare("SELECT COUNT(*) AS c FROM sqlite_master").get() as { c: number }).c,
    0,
    "the refusal migrated the file",
  );
  probe.close();
});
