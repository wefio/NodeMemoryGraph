import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { NMG_PROTOCOL_VERSION } from "../../src/cli/protocol.ts";

const root = resolve(import.meta.dirname, "../..");
const launcher = resolve(root, "bin/nmg.mjs");

test("search prints a per-phase perf line by default and omits it with --no-perf", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-perf-"));
  try {
    const remember = spawnSync(
      process.execPath,
      [launcher, "remember", "perf demo memory", "--node", "perfdemo", "--data-dir", directory],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(remember.status, 0, remember.stderr);

    const withPerf = spawnSync(
      process.execPath,
      [launcher, "search", "perf", "--data-dir", directory],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(withPerf.status, 0, withPerf.stderr);
    const perfLine = withPerf.stdout
      .split("\n")
      .find((line) => line.startsWith("perf\t"));
    assert.ok(perfLine, `perf line present:\n${withPerf.stdout}`);
    assert.match(perfLine!, /search\.direct=/, "direct search section listed");
    assert.match(perfLine!, /total=\d+(\.\d+)?ms/, "wall-clock total");

    const noPerf = spawnSync(
      process.execPath,
      [launcher, "search", "perf", "--data-dir", directory, "--no-perf"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(noPerf.status, 0, noPerf.stderr);
    assert.ok(
      !noPerf.stdout.split("\n").some((line) => line.startsWith("perf\t")),
      `no perf line with --no-perf:\n${noPerf.stdout}`,
    );

    const json = spawnSync(
      process.execPath,
      [launcher, "search", "perf", "--data-dir", directory, "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout) as { timings?: { timings: Record<string, number> } };
    assert.ok(parsed.timings, "json search carries timings");
    assert.ok(parsed.timings!.timings["search.direct"] >= 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test("CLI writes and reads project STG and exposes scoped sync", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-process-stg-"));
  const projectDir = resolve(directory, "project");
  try {
    const local = runLauncher([
      "remember", "Session project fact", "--node", "Project scratch", "--residence", "stg",
      "--project-dir", projectDir, "--json", "--data-dir", directory,
    ]) as { memory: { id: string } };
    const expanded = runLauncher([
      "get", local.memory.id, "--project-dir", projectDir, "--json", "--data-dir", directory,
    ]) as { results: Array<{ memory: { id: string } }> };
    assert.equal(expanded.results[0]?.memory.id, local.memory.id);

    runLauncher([
      "remember", "Atlas durable storage uses SQLite", "--node", "Atlas storage", "--scope",
      "project=atlas", "--json", "--data-dir", directory,
    ]);
    const synced = runLauncher([
      "stg", "sync", "--project-dir", projectDir, "--scope", "project=atlas", "--json",
      "--data-dir", directory,
    ]) as { copied: number };
    assert.equal(synced.copied, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP daemon starts once, serves CLI requests, and stops cleanly", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-process-http-"));
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

    const remembered = runLauncher([
      "remember",
      "The HTTP daemon keeps one resident NMG service.",
      "--node",
      "HTTP daemon",
      "--type",
      "fact",
      "--json",
      "--data-dir",
      directory,
    ]) as { memory: { id: string } };
    const searched = runLauncher([
      "search",
      "resident HTTP service",
      "--json",
      "--data-dir",
      directory,
    ]) as { results: unknown[] };
    assert.equal(searched.results.length, 1);

    const maintained = runLauncher([
      "retention",
      "candidates",
      "--dormant-after-days",
      "1",
      "--json",
      "--data-dir",
      directory,
    ]) as { candidates: unknown[] };
    assert.ok(Array.isArray(maintained.candidates));

    const archived = runLauncher([
      "retention",
      "archive",
      remembered.memory.id,
      "--json",
      "--data-dir",
      directory,
    ]) as { storageState: string };
    assert.equal(archived.storageState, "dormant");
    const restored = runLauncher([
      "retention",
      "restore",
      remembered.memory.id,
      "--json",
      "--data-dir",
      directory,
    ]) as { storageState: string };
    assert.equal(restored.storageState, "indexed");
    const deleted = runLauncher([
      "memory",
      "delete",
      remembered.memory.id,
      "--json",
      "--data-dir",
      directory,
    ]) as { deleted: boolean };
    assert.equal(deleted.deleted, true);

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
    const stoppedStatus = runLauncher(["daemon", "status", "--json", "--data-dir", directory]) as {
      running: boolean;
    };
    assert.equal(stoppedStatus.running, false);
  } finally {
    spawnSync(process.execPath, [launcher, "daemon", "stop", "--json", "--data-dir", directory], {
      cwd: root,
      encoding: "utf8",
    });
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
