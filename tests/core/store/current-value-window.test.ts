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
 * Every boundary below is stamped **in SQL**, so the stamp and the read share one clock source: no read
 * here compares JavaScript's clock against SQLite's. Sharing a clock *source* is not the same as sharing
 * one clock *read*, though, and that difference cost this file a case. "An expiry a moment ago is still
 * current" stamped a boundary half a grace in the past in one statement and read it in another, so it
 * asserted that the read happens within the half that is left - measured, a delay of 20 ms after the
 * store was reopened already answered "not active", while 0 and 10 ms answered "current". It failed on a
 * loaded CI runner and not once in 30 local runs. A row's boundary is stamped by one statement and
 * compared by another, so that case cannot be asked at row level at all; it is asked below as a relation,
 * where the boundary and the predicate share one `'now'` in one statement.
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

// Deliberately a literal, not `CLOCK_GRACE_MS / 2000`: a fixture derived from the constant under test
// moves with it, so zeroing the grace would move the stamp onto `now` and the case would pass while the
// bug it exists for was live. The case below asserts the relation to the constant instead.
const half = "0.025";

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

test("the freshness half widens one grace into the past and no further", () => {
  // One statement, one clock read, and the store's own predicate rather than a copy of it: this pins the
  // widening itself instead of a stopwatch, and it pins the boundary - at exactly one grace an expiry is
  // already excluded. Every assertion holds whether or not SQLite hands out the same `'now'` twice inside
  // one statement: the two boundaries that could disagree with it are a whole grace apart.
  const raw = new DatabaseSync(":memory:");
  const isCurrent = (offsetSeconds: number): boolean => {
    const boundary = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${offsetSeconds.toFixed(3)} seconds')`;
    const row = raw
      .prepare(`SELECT ${notExpired("r")} AS is_current FROM (SELECT ${boundary} AS expires_at) r`)
      .get() as { is_current: number };
    return row.is_current === 1;
  };
  try {
    assert.equal(isCurrent(0), true, "an expiry stamped now is current");
    assert.equal(
      isCurrent(-(CLOCK_GRACE_MS / 2000)),
      true,
      "an expiry inside the grace is current",
    );
    assert.equal(
      isCurrent(-(CLOCK_GRACE_MS / 1000)),
      false,
      "at exactly the grace it is not current",
    );
    assert.equal(isCurrent(-60), false, "an expiry a minute ago is not current");
  } finally {
    raw.close();
  }
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
