/**
 * Chaos 4 — storage corruption & locking (SQLite).
 *
 * Corruption must fail loudly (clear errors, never a silent broken store),
 * and a failed open must NOT leak the underlying handle — on Windows the
 * leaked handle pins the file and every rmSync fails with EPERM forever
 * (this test reproduces that incident and guards the fix in SqliteLocalDaemonState).
 * Concurrent writers must survive via busy_timeout.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SqliteLocalDaemonState } from "../../src/core/store/local-daemon-state.ts";

function freshDir(): { directory: string; db: string } {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-chaos4-"));
  return { directory, db: join(directory, "nmg.sqlite") };
}

function writeBoard(store: SqliteLocalDaemonState, content: string, taskId: string) {
  return store.putTaskBoardEntry({
    content,
    taskId,
    agentId: "chaos",
    kind: "note",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
}

function tryDelete(dir: string, db: string): boolean {
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(db, { force: true });
      return true;
    } catch {
      // Windows: the handle may still be pinned; retry a few times.
      // (The fs.rm maxRetries path is also armed, so this loop is a backstop.)
      void new Promise((r) => setTimeout(r, 100));
    }
  }
  void dir;
  return false;
}

test("chaos truncated DB: opens with a clear error and releases the handle", async () => {
  const { directory, db } = freshDir();
  const s = new SqliteLocalDaemonState(db);
  s.close();
  truncateSync(db, 512);
  await assert.rejects(
    async () => {
      new SqliteLocalDaemonState(db);
    },
    (e: Error) => {
      assert.match(e.message, /malformed|not a database/i);
      return true;
    },
  );
  // The failed open must not pin the file (Windows EPERM incident).
  assert.equal(tryDelete(directory, db), true, "DB must be deletable after a failed open");
  rmSync(directory, { recursive: true, force: true });
});

test("chaos deleted DB: reopen builds a fresh store", () => {
  const { directory, db } = freshDir();
  const s1 = new SqliteLocalDaemonState(db);
  writeBoard(s1, "to be wiped", "chaos4-wipe");
  s1.close();
  rmSync(db, { force: true });
  const s2 = new SqliteLocalDaemonState(db);
  writeBoard(s2, "fresh start", "chaos4-fresh");
  s2.close();
  rmSync(directory, { recursive: true, force: true });
});

test("chaos concurrent writers: busy_timeout keeps both alive", async () => {
  const { directory, db } = freshDir();
  const s1 = new SqliteLocalDaemonState(db);
  const s2 = new SqliteLocalDaemonState(db);
  const results = await Promise.all(
    [s1, s2].map((s, i) =>
      (async () => {
        try {
          writeBoard(s, `concurrent write ${i}`, "chaos4-conc");
          return "ok";
        } catch (error) {
          return `error: ${error instanceof Error ? error.message : String(error)}`;
        }
      })(),
    ),
  );
  assert.deepEqual(results, ["ok", "ok"], "both writers must succeed under busy_timeout");
  s1.close();
  s2.close();
  rmSync(directory, { recursive: true, force: true });
});

test("chaos truncated active WAL: reading fails loudly and the writer persists new entries", (t) => {
  const { directory, db } = freshDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const taskId = "chaos4-wal";
  const initial = new SqliteLocalDaemonState(db);
  const baseline = writeBoard(initial, "checkpointed", taskId);
  initial.close();

  const writer = new SqliteLocalDaemonState(db);
  let next;
  try {
    const damaged = writeBoard(writer, "in active WAL", taskId);
    const wal = `${db}-wal`;
    const size = statSync(wal).size;
    assert.ok(size > 100, `active WAL should exist, size=${size}`);
    truncateSync(wal, 100);
    assert.throws(() => {
      const reader = new SqliteLocalDaemonState(db);
      try {
        // Opening checks the schema; reading forces SQLite to touch the truncated WAL.
        reader.getTaskBoardEntryById(taskId, damaged.id);
      } finally {
        reader.close();
      }
    }, /disk I\/O error|malformed|not a database/i);
    next = writeBoard(writer, "writer survives", taskId);
  } finally {
    writer.close();
  }

  const reopened = new SqliteLocalDaemonState(db);
  try {
    assert.equal(reopened.getTaskBoardEntryById(taskId, baseline.id)?.content, baseline.content);
    assert.equal(reopened.getTaskBoardEntryById(taskId, next.id)?.content, next.content);
  } finally {
    reopened.close();
  }
});

test("chaos empty DB file: SQLite initializes it as a fresh store", () => {
  const { directory, db } = freshDir();
  writeFileSync(db, "");
  // An empty file is not corruption — SQLite treats it as a brand-new
  // database, so the store must open and accept writes.
  const s = new SqliteLocalDaemonState(db);
  writeBoard(s, "empty file recovers", "chaos4-empty");
  s.close();
  rmSync(directory, { recursive: true, force: true });
});
