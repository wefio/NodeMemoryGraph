/**
 * The current-value window and its clock grace.
 *
 * A write stamps validity and expiry from JavaScript, a read compares against SQLite's `now`, and the
 * two clock readers disagree at millisecond granularity. Measured on this machine, a row stamped
 * `...T02:58:38.468Z` was read back while SQLite's `now` said `...38.467Z`, so `valid_from <= now` was
 * false and a memory written a moment earlier read as "not active" - about one run in 1500, which is
 * how a product suite failed intermittently under load. These cases pin the window: it is widened by a
 * named grace on both boundaries and never narrowed, and a value dated well into the future is still
 * excluded, because that is what the comparison is for.
 *
 * Every boundary below is stamped **in SQL**, so the stamp and the read share one clock source and the
 * expectation does not depend on how long the test takes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CLOCK_GRACE_MS,
  clockNow,
  currentlyValid,
  notExpired,
} from "../../../src/core/store/clock.ts";
import { NmgStore } from "../../../src/core/store.ts";

const half = (CLOCK_GRACE_MS / 2000).toFixed(3);

/** A memory whose validity boundaries are stamped in SQL, then reopened through the store: the read
 *  then compares SQLite's clock against SQLite's clock. */
function withStamped(set: string, run: (store: NmgStore, id: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-window-"));
  const path = join(directory, "test.sqlite");
  const opened = new NmgStore(path);
  const saved = opened.remember({
    statement: "the project name is Atlas",
    nodeName: "project name",
    memoryType: "fact",
    sourceActor: "user",
  });
  opened.close();
  const raw = new DatabaseSync(path);
  raw.prepare(`UPDATE memory_records SET ${set} WHERE id = ?`).run(saved.memory.id);
  raw.close();
  const store = new NmgStore(path);
  try {
    run(store, saved.memory.id);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

test("a value stamped a moment in the future is current, not missing", () => {
  // The flake itself, made deterministic: the stamp is half a grace ahead of SQLite's own `now`, which
  // is what a write's JavaScript timestamp looks like to a read that follows it by microseconds.
  withStamped(
    `valid_from = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${half} seconds')`,
    (store, id) => {
      assert.equal(store.demoteMemory(id, "no longer relevant").residence, "stg");
    },
  );
});

test("a value dated well into the future is still not current", () => {
  withStamped(`valid_from = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds')`, (store, id) => {
    assert.throws(() => store.demoteMemory(id, "no longer relevant"), /is not active/);
  });
});

test("a value that expired a moment ago is still current", () => {
  withStamped(
    `expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${half} seconds')`,
    (store, id) => {
      assert.equal(store.demoteMemory(id, "expired a clock tick ago").residence, "stg");
    },
  );
});

test("a value that expired a minute ago is not current", () => {
  withStamped(`expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds')`, (store, id) => {
    assert.throws(() => store.demoteMemory(id, "long expired"), /is not active/);
  });
});

test("a just-written memory is never read as not active", () => {
  // The regression, at the rate the flake actually occurred: writes and reads of the same memory, in
  // one store, with nothing between them.
  const directory = mkdtempSync(join(tmpdir(), "nmg-window-loop-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    for (let i = 0; i < 400; i += 1) {
      const saved = store.remember({
        statement: `the project name is Atlas ${i}`,
        nodeName: "project name",
        memoryType: "fact",
        sourceActor: "user",
      });
      assert.equal(
        store.demoteMemory(saved.memory.id, "no longer relevant").residence,
        "stg",
        `write ${i} could not be read back`,
      );
    }
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("the window widens by the grace on both boundaries and never narrows", () => {
  assert.ok(CLOCK_GRACE_MS > 0, "a grace of zero is the bug this window exists for");
  const later = clockNow("later");
  const earlier = clockNow("earlier");
  assert.match(currentlyValid("m"), /m\.valid_from <= strftime\(.*'\+/);
  assert.ok(
    currentlyValid("m").includes(later),
    "valid_from is compared against the later instant",
  );
  assert.ok(
    currentlyValid("m").includes(earlier),
    "valid_until is compared against the earlier one",
  );
  assert.ok(notExpired("m").includes(earlier), "expiry is compared against the earlier one");
  // SQLite has no `milliseconds` modifier, and an unknown one makes the whole expression NULL, which
  // silently excludes every row instead of failing loudly.
  assert.doesNotMatch(later, /milliseconds/);
});
