/**
 * Chaos 1 — daemon process kill (SIGKILL) mid-session.
 *
 * Existing tests cover reconnect and teardown; this covers the crash-
 * recovery property: data remembered before the kill must survive (SQLite
 * WAL durability), the next connectDaemon must spawn a fresh daemon on the
 * same store, and the search must find the pre-crash record. No daemon
 * must linger afterwards.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");

test("chaos SIGKILL: pre-crash memories survive, fresh daemon finds them, zero residue", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-chaos1-"));
  const probePath = join(directory, "kill-probe.mjs");
  writeFileSync(
    probePath,
    [
      `import { connectDaemon, invokeDaemon, shutdownOwnedDaemon } from ${JSON.stringify(
        pathToFileURL(resolve(root, "src/cli/daemon-client.ts")).href,
      )};`,
      `import { isProcessAlive } from ${JSON.stringify(
        pathToFileURL(resolve(root, "src/cli/lifecycle.ts")).href,
      )};`,
      `const db = ${JSON.stringify(join(directory, "nmg.sqlite"))};`,
      `const first = await connectDaemon(db);`,
      `const pid1 = first.state.pid;`,
      `await invokeDaemon(first, "remember", {`,
      `  statement: "pre-crash durable record 7",`,
      `  nodeName: "chaos-crash-durable",`,
      `  writeReason: "chaos_kill_probe",`,
      `});`,
      `process.kill(pid1, "SIGKILL");`,
      `for (let i = 0; i < 100 && isProcessAlive(pid1); i += 1) await new Promise((r) => setTimeout(r, 20));`,
      `const second = await connectDaemon(db);`,
      `const pid2 = second.state.pid;`,
      `const found = await invokeDaemon(second, "search", { query: "pre-crash durable record 7" });`,
      `await shutdownOwnedDaemon(second);`,
      `for (let i = 0; i < 100 && isProcessAlive(pid2); i += 1) await new Promise((r) => setTimeout(r, 20));`,
      `console.log(JSON.stringify({`,
      `  pid1, pid2, respawned: pid1 !== pid2,`,
      `  found: (found.results ?? []).length > 0,`,
      `  pid1Gone: !isProcessAlive(pid1),`,
      `  pid2Gone: !isProcessAlive(pid2),`,
      `}));`,
    ].join("\n"),
  );
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", probePath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NMG_DATA_DIR: directory },
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim()) as {
      pid1: number;
      pid2: number;
      respawned: boolean;
      found: boolean;
      pid1Gone: boolean;
      pid2Gone: boolean;
    };
    assert.equal(out.respawned, true, "a fresh daemon must be spawned on the same store");
    assert.equal(out.found, true, "pre-crash memories must survive SIGKILL (WAL durability)");
    assert.equal(out.pid1Gone, true, "killed daemon must not linger");
    assert.equal(out.pid2Gone, true, "second daemon must be fully shut down");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
