import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");

/**
 * Integration: the session_shutdown archival path must never leave the daemon
 * running (the "must still shut down" requirement) — with a successful
 * archive, a failing archive, and a daemon that is already gone.
 */

function runProbe(directory: string, probeName: string, env: Record<string, string> = {}): string {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(directory, probeName)],
    { cwd: root, encoding: "utf8", env: { ...process.env, ...env } },
  );
  assert.equal(result.status, 0, `probe stderr: ${result.stderr}`);
  return result.stdout;
}

function daemonProbe(
  directory: string,
  body: string,
): { probePath: string; run: (env?: Record<string, string>) => string } {
  const probePath = join(directory, "shutdown-probe.mjs");
  writeFileSync(
    probePath,
    [
      `import { connectDaemon, invokeDaemon, shutdownOwnedDaemon } from ${JSON.stringify(
        pathToFileURL(resolve(root, "src/cli/daemon-client.ts")).href,
      )};`,
      `import { archiveOrStage, pendingArchives } from ${JSON.stringify(
        pathToFileURL(resolve(root, "src/cli/archive-staging.ts")).href,
      )};`,
      `import { isProcessAlive } from ${JSON.stringify(
        pathToFileURL(resolve(root, "src/cli/lifecycle.ts")).href,
      )};`,
      body,
    ].join("\n"),
  );
  return { probePath, run: (env = {}) => runProbe(directory, "shutdown-probe.mjs", env) };
}

test("shutdown with successful archive: daemon fully exits, nothing staged", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-arch-shutdown-ok-"));
  const staging = join(directory, "staging");
  mkdirSync(staging, { recursive: true });
  const { run } = daemonProbe(
    directory,
    [
      `const conn = await connectDaemon(${JSON.stringify(join(directory, "nmg.sqlite"))});`,
      `const pid = conn.state.pid;`,
      `const outcome = await archiveOrStage(${JSON.stringify(staging)}, {`,
      `  sessionId: "sess_ok", archivedAt: new Date().toISOString(),`,
      `}, async (p) => invokeDaemon(conn, "remember", { statement: p.statement, nodeName: p.nodeName }), 3000);`,
      `await shutdownOwnedDaemon(conn);`,
      `for (let i = 0; i < 100 && isProcessAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 20));`,
      `console.log(JSON.stringify({ outcome, alive: isProcessAlive(pid), staged: pendingArchives(${JSON.stringify(staging)}).length }));`,
    ].join("\n"),
  );
  try {
    const out = JSON.parse(run({ NMG_DATA_DIR: directory }));
    assert.equal(out.outcome, "remembered");
    assert.equal(out.alive, false, "daemon must be fully gone after shutdown");
    assert.equal(out.staged, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shutdown with failing archive: stages entry, daemon still exits", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-arch-shutdown-fail-"));
  const staging = join(directory, "staging");
  mkdirSync(staging, { recursive: true });
  const { run } = daemonProbe(
    directory,
    [
      `const conn = await connectDaemon(${JSON.stringify(join(directory, "nmg.sqlite"))});`,
      `const pid = conn.state.pid;`,
      `const outcome = await archiveOrStage(${JSON.stringify(staging)}, {`,
      `  sessionId: "sess_fail", archivedAt: new Date().toISOString(),`,
      `}, async () => { throw new Error("rpc down"); }, 500);`,
      `await shutdownOwnedDaemon(conn);`,
      `for (let i = 0; i < 100 && isProcessAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 20));`,
      `console.log(JSON.stringify({ outcome, alive: isProcessAlive(pid), staged: pendingArchives(${JSON.stringify(staging)}).length }));`,
    ].join("\n"),
  );
  try {
    const out = JSON.parse(run({ NMG_DATA_DIR: directory }));
    assert.equal(out.outcome, "staged");
    assert.equal(out.staged, 1, "failing archive must be staged for next startup");
    assert.equal(out.alive, false, "daemon must still exit when archival fails");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shutdown with dead daemon: archival stages, teardown is a safe no-op", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-arch-shutdown-dead-"));
  const staging = join(directory, "staging");
  mkdirSync(staging, { recursive: true });
  const { run } = daemonProbe(
    directory,
    [
      `const conn = await connectDaemon(${JSON.stringify(join(directory, "nmg.sqlite"))});`,
      `const pid = conn.state.pid;`,
      `process.kill(pid, "SIGKILL");`,
      `for (let i = 0; i < 100 && isProcessAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 20));`,
      `const outcome = await archiveOrStage(${JSON.stringify(staging)}, {`,
      `  sessionId: "sess_dead", archivedAt: new Date().toISOString(),`,
      `}, async () => { throw new Error("daemon gone"); }, 500);`,
      `await shutdownOwnedDaemon(conn);`,
      `console.log(JSON.stringify({ outcome, staged: pendingArchives(${JSON.stringify(staging)}).length }));`,
    ].join("\n"),
  );
  try {
    const out = JSON.parse(run({ NMG_DATA_DIR: directory }));
    assert.equal(out.outcome, "staged");
    assert.equal(out.staged, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
