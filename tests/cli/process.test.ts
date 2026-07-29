import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { NMG_PROTOCOL_VERSION } from "../../src/cli/protocol.ts";

const root = resolve(import.meta.dirname, "../..");
const launcher = resolve(root, "bin/nmg.mjs");

test("packaged launcher runs one-shot status without creating storage", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-process-status-"));
  try {
    const result = spawnSync(
      process.execPath,
      [launcher, "status", "--json", "--data-dir", directory],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout) as {
      protocol: string;
      storage: { exists: boolean; loaded: boolean };
    };
    assert.equal(status.protocol, NMG_PROTOCOL_VERSION);
    assert.equal(status.storage.exists, false);
    assert.equal(status.storage.loaded, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("packaged one-shot commands remember, search, and get through the same database", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-process-roundtrip-"));
  try {
    const remembered = runLauncher([
      "remember",
      "User prefers concise answers",
      "--node",
      "Response preferences",
      "--type",
      "preference",
      "--scope",
      "user=local",
      "--json",
      "--data-dir",
      directory,
    ]) as { memory: { id: string } };
    const searched = runLauncher([
      "search",
      "concise answers",
      "--scope",
      "user=local",
      "--json",
      "--data-dir",
      directory,
    ]) as { results: Array<{ memory: { id: string } }> };
    assert.equal(searched.results[0]?.memory.id, remembered.memory.id);

    const expanded = runLauncher([
      "get",
      remembered.memory.id,
      "--json",
      "--data-dir",
      directory,
    ]) as {
      results: Array<{ memory: { id: string }; evidence: { content: string } }>;
      missingMemoryIds: string[];
    };
    assert.equal(expanded.results[0]?.memory.id, remembered.memory.id);
    assert.equal(expanded.results[0]?.evidence.content, "User prefers concise answers");
    assert.deepEqual(expanded.missingMemoryIds, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("packaged launcher rejects unknown options with a usage exit code", () => {
  const result = spawnSync(process.execPath, [launcher, "status", "--typo"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option: --typo/);
});

test("gRPC daemon starts once, serves CLI requests, and stops cleanly", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-process-grpc-"));
  try {
    const started = runLauncher(["daemon", "start", "--json", "--data-dir", directory]) as {
      started: boolean;
      pid: number;
      endpoint: string;
    };
    assert.equal(started.started, true);
    assert.match(started.endpoint, /^127\.0\.0\.1:\d+$/);

    const duplicate = runLauncher(["daemon", "start", "--json", "--data-dir", directory]) as {
      started: boolean;
      alreadyRunning: boolean;
      pid: number;
    };
    assert.equal(duplicate.started, false);
    assert.equal(duplicate.alreadyRunning, true);
    assert.equal(duplicate.pid, started.pid);

    runLauncher([
      "remember",
      "The gRPC daemon keeps one resident NMG service.",
      "--node",
      "gRPC daemon",
      "--type",
      "fact",
      "--json",
      "--data-dir",
      directory,
    ]);
    const searched = runLauncher([
      "search",
      "resident gRPC service",
      "--json",
      "--data-dir",
      directory,
    ]) as { results: unknown[] };
    assert.equal(searched.results.length, 1);

    const status = runLauncher(["daemon", "status", "--json", "--data-dir", directory]) as {
      running: boolean;
      pid: number;
    };
    assert.equal(status.running, true);
    assert.equal(status.pid, started.pid);

    const stopped = runLauncher(["daemon", "stop", "--json", "--data-dir", directory]) as {
      stopped: boolean;
    };
    assert.equal(stopped.stopped, true);
    const stoppedStatus = runLauncher([
      "daemon",
      "status",
      "--json",
      "--data-dir",
      directory,
    ]) as { running: boolean };
    assert.equal(stoppedStatus.running, false);
  } finally {
    spawnSync(
      process.execPath,
      [launcher, "daemon", "stop", "--json", "--data-dir", directory],
      { cwd: root, encoding: "utf8" },
    );
    rmSync(directory, { recursive: true, force: true });
  }
});

function runLauncher(args: string[]): unknown {
  const result = spawnSync(process.execPath, [launcher, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
