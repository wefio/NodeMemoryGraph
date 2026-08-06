import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  archiveOrStage,
  flushArchives,
  pendingArchives,
  stageArchive,
  stagingDirFor,
} from "../../src/cli/archive-staging.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "nmg-staging-"));
}

const ENTRY = {
  sessionId: "sess_abc123",
  sessionFile: "session.jsonl",
  projectDir: "proj",
  archivedAt: "2026-08-04T10:00:00.000Z",
  reason: "quit",
};

test("stageArchive writes atomically and pendingArchives reads it back", () => {
  const dir = freshDir();
  const path = stageArchive(dir, ENTRY);
  assert.ok(path.endsWith("sess_abc123.json"));
  const pending = pendingArchives(dir);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sessionId, "sess_abc123");
  assert.equal(pending[0].reason, "quit");
  // No .tmp leftovers.
  assert.ok(!readdirSync(dir).some((name) => name.endsWith(".tmp")));
  rmSync(dir, { recursive: true, force: true });
});

test("stageArchive is idempotent per sessionId (overwrite, one file)", () => {
  const dir = freshDir();
  stageArchive(dir, ENTRY);
  stageArchive(dir, { ...ENTRY, summary: "updated" });
  const pending = pendingArchives(dir);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].summary, "updated");
  rmSync(dir, { recursive: true, force: true });
});

test("pendingArchives drops corrupt files defensively", () => {
  const dir = freshDir();
  stageArchive(dir, ENTRY);
  writeFileSync(join(dir, "corrupt.json"), "{not json", "utf8");
  const pending = pendingArchives(dir);
  assert.equal(pending.length, 1);
  // Corrupt file was removed.
  assert.ok(!readdirSync(dir).includes("corrupt.json"));
  rmSync(dir, { recursive: true, force: true });
});

test("flushArchives deletes each entry only after its flush succeeds", async () => {
  const dir = freshDir();
  stageArchive(dir, ENTRY);
  stageArchive(dir, { ...ENTRY, sessionId: "sess_other" });
  const flushed: string[] = [];
  const n = await flushArchives(dir, async (entry) => {
    flushed.push(entry.sessionId);
  });
  assert.equal(n, 2);
  assert.deepEqual(flushed.sort(), ["sess_abc123", "sess_other"]);
  assert.equal(pendingArchives(dir).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("flushArchives keeps the file when flush fails (resume next startup)", async () => {
  const dir = freshDir();
  stageArchive(dir, ENTRY);
  await assert.rejects(
    flushArchives(dir, async () => {
      throw new Error("daemon down");
    }),
  );
  // Entry remains staged for the next startup.
  assert.equal(pendingArchives(dir).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("archiveOrStage remembers on success and stages on failure/timeout", async () => {
  const dir = freshDir();
  const ok = await archiveOrStage(dir, ENTRY, async () => "ok", 100);
  assert.equal(ok, "remembered");
  assert.equal(pendingArchives(dir).length, 0);

  const staged = await archiveOrStage(
    dir,
    { ...ENTRY, sessionId: "sess_fail" },
    async () => {
      throw new Error("rpc failed");
    },
    100,
  );
  assert.equal(staged, "staged");
  assert.equal(pendingArchives(dir).length, 1);
  assert.equal(pendingArchives(dir)[0].sessionId, "sess_fail");
  rmSync(dir, { recursive: true, force: true });
});

test("archiveOrStage never throws (shutdown must proceed to teardown)", async () => {
  const dir = freshDir();
  // Both remember and staging fail; the call still resolves.
  const result = await archiveOrStage(
    join(dir, "nested", "missing"),
    ENTRY,
    async () => {
      throw new Error("rpc failed");
    },
    50,
  );
  assert.equal(result, "staged");
  rmSync(dir, { recursive: true, force: true });
});

test("stagingDirFor scopes to the project", () => {
  assert.equal(stagingDirFor("proj"), join("proj", ".nmg", "archive-staging"));
});
