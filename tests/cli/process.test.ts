import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { NMG_PROTOCOL_VERSION } from "../../src/cli/protocol.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

const root = resolve(import.meta.dirname, "../..");
const launcher = resolve(root, "bin/nmg.mjs");

test("search compact JSON exposes bounded headers without exact evidence", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-compact-"));
  const statement = `Durable detail ${"x".repeat(420)}`;
  try {
    const remembered = runLauncher([
      "remember",
      statement,
      "--node",
      "Compact projection",
      "--json",
      "--data-dir",
      directory,
    ]) as { memory: { id: string } };
    const compact = runLauncher([
      "search",
      "Durable detail",
      "--compact-json",
      "--data-dir",
      directory,
    ]) as {
      candidates: Array<{ id: string; preview: string }>;
      activeGraphId: string | null;
      results?: unknown;
      activeGraph?: unknown;
    };

    assert.equal(compact.candidates[0]?.id, remembered.memory.id);
    assert.ok(compact.candidates[0]!.preview.length > 160);
    assert.equal(compact.candidates[0]!.preview.length, 320);
    assert.match(compact.candidates[0]!.preview, /…$/u);
    assert.ok(compact.activeGraphId);
    assert.equal(compact.results, undefined);
    assert.equal(compact.activeGraph, undefined);
  } finally {
    removeTempDirectory(directory);
  }
});

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
    const perfLine = withPerf.stdout.split("\n").find((line) => line.startsWith("perf\t"));
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
    removeTempDirectory(directory);
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
    removeTempDirectory(directory);
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
    removeTempDirectory(directory);
  }
});

test("packaged graph command writes a self-contained HTML export", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-process-graph-"));
  const outputPath = join(directory, "exports", "memory-graph.html");
  try {
    runLauncher([
      "remember",
      "Atlas graph export integration marker",
      "--node",
      "Atlas graph export",
      "--data-dir",
      directory,
      "--json",
    ]);
    const result = spawnSync(
      process.execPath,
      [launcher, "graph", "--data-dir", directory, "--out", outputPath],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Wrote memory graph to/u);
    assert.equal(existsSync(outputPath), true);
    const html = readFileSync(outputPath, "utf8");
    assert.match(html, /Atlas graph export integration marker/u);
    assert.match(html, /<!doctype html>/iu);
  } finally {
    removeTempDirectory(directory);
  }
});

test("packaged node rollback restores a journaled merge", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-process-rollback-"));
  try {
    const first = runLauncher([
      "remember",
      "Atlas uses cobalt labels",
      "--node",
      "Atlas labels",
      "--json",
      "--data-dir",
      directory,
    ]) as { memory: { id: string }; node: { id: string } };
    const second = runLauncher([
      "remember",
      "Atlas release notes stay concise",
      "--node",
      "Atlas release notes",
      "--json",
      "--data-dir",
      directory,
    ]) as { memory: { id: string }; node: { id: string } };
    const merged = runLauncher([
      "node",
      "merge",
      first.node.id,
      second.node.id,
      "--target-name",
      "Atlas conventions",
      "--json",
      "--data-dir",
      directory,
    ]) as { id: string };
    const rolledBack = runLauncher([
      "node",
      "rollback",
      merged.id,
      "--json",
      "--data-dir",
      directory,
    ]) as { rolledBackAt: string | null };
    assert.ok(rolledBack.rolledBackAt);

    const restored = runLauncher([
      "get",
      first.memory.id,
      second.memory.id,
      "--json",
      "--data-dir",
      directory,
    ]) as { results: Array<{ memory: { id: string }; node: { id: string } }> };
    assert.deepEqual(
      new Map(restored.results.map((result) => [result.memory.id, result.node.id])),
      new Map([
        [first.memory.id, first.node.id],
        [second.memory.id, second.node.id],
      ]),
    );
  } finally {
    removeTempDirectory(directory);
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
      "remember",
      "Session project fact",
      "--node",
      "Project scratch",
      "--residence",
      "stg",
      "--session-id",
      "cli-session",
      "--project-dir",
      projectDir,
      "--json",
      "--data-dir",
      directory,
    ]) as { memory: { id: string } };
    const expanded = runLauncher([
      "get",
      local.memory.id,
      "--project-dir",
      projectDir,
      "--session-id",
      "cli-session",
      "--json",
      "--data-dir",
      directory,
    ]) as { results: Array<{ memory: { id: string } }> };
    assert.equal(expanded.results[0]?.memory.id, local.memory.id);

    runLauncher([
      "remember",
      "Atlas durable storage uses SQLite",
      "--node",
      "Atlas storage",
      "--scope",
      "project=atlas",
      "--json",
      "--data-dir",
      directory,
    ]);
    const synced = runLauncher([
      "stg",
      "sync",
      "--project-dir",
      projectDir,
      "--scope",
      "project=atlas",
      "--json",
      "--data-dir",
      directory,
    ]) as { copied: number };
    assert.equal(synced.copied, 1);
  } finally {
    removeTempDirectory(directory);
  }
});

test("CLI writes external provenance as an unverified marker", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-process-external-"));
  try {
    const remembered = runLauncher([
      "remember",
      "README describes the external source contract",
      "--node",
      "External source",
      "--external-source",
      "file:README.md",
      "--retrieved-at",
      "2026-08-01T00:00:00.000Z",
      "--content-hash",
      "sha256:test",
      "--json",
      "--data-dir",
      directory,
    ]) as { memory: { truthStatus: string; markers: Array<{ kind: string }> } };
    assert.equal(remembered.memory.truthStatus, "unverified");
    assert.equal(remembered.memory.markers[0]?.kind, "external_source");
  } finally {
    removeTempDirectory(directory);
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
    const chainPeer = runLauncher([
      "remember",
      "Cobalt follows amber in the explicit test sequence.",
      "--node",
      "Explicit test sequence",
      "--json",
      "--data-dir",
      directory,
    ]) as { memory: { id: string } };
    const chain = runLauncher([
      "chain",
      "create",
      "--type",
      "logical",
      "--topic",
      "Daemon chain roundtrip",
      "--json",
      "--data-dir",
      directory,
    ]) as { id: string };
    runLauncher([
      "chain",
      "edge",
      "add",
      "--chain",
      chain.id,
      "--from",
      remembered.memory.id,
      "--to",
      chainPeer.memory.id,
      "--json",
      "--data-dir",
      directory,
    ]);
    const loadedChain = runLauncher([
      "chain",
      "get",
      "--chain",
      chain.id,
      "--json",
      "--data-dir",
      directory,
    ]) as { edges: unknown[]; topologicalOrder: string[] };
    assert.equal(loadedChain.edges.length, 1);
    assert.deepEqual(loadedChain.topologicalOrder, [remembered.memory.id, chainPeer.memory.id]);
    const removedEdge = runLauncher([
      "chain",
      "edge",
      "remove",
      "--chain",
      chain.id,
      "--from",
      remembered.memory.id,
      "--to",
      chainPeer.memory.id,
      "--json",
      "--data-dir",
      directory,
    ]) as { removed: boolean };
    assert.equal(removedEdge.removed, true);
    const removedMember = runLauncher([
      "chain",
      "remove",
      "--chain",
      chain.id,
      "--memory",
      chainPeer.memory.id,
      "--json",
      "--data-dir",
      directory,
    ]) as { removed: boolean };
    assert.equal(removedMember.removed, true);
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

    runLauncher([
      "remember",
      "A daemon restart must preserve this persistence marker.",
      "--node",
      "Daemon persistence",
      "--type",
      "fact",
      "--json",
      "--data-dir",
      directory,
    ]);

    const restarted = runLauncher([
      "daemon",
      "restart",
      "--json",
      "--data-dir",
      directory,
    ]) as {
      started: boolean;
      restarted: boolean;
      restartedFrom: number;
      pid: number;
    };
    assert.equal(restarted.started, true);
    assert.equal(restarted.restarted, true);
    assert.equal(restarted.restartedFrom, started.pid);
    assert.notEqual(restarted.pid, started.pid);

    const restartedSearch = runLauncher([
      "search",
      "daemon persistence marker",
      "--json",
      "--data-dir",
      directory,
    ]) as { results: unknown[] };
    assert.equal(restartedSearch.results.length, 1, "restart preserves the database");

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
    removeTempDirectory(directory);
  }
});

test("daemon exits after idle timeout and removes its lease", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-idle-exit-"));
  try {
    const started = runLauncher(["daemon", "start", "--json", "--data-dir", directory], {
      NMG_DAEMON_IDLE_TIMEOUT_MS: "1000",
    }) as { started: boolean; pid: number };
    assert.equal(started.started, true);
    await delay(1_600);
    const status = runLauncher(["daemon", "status", "--json", "--data-dir", directory]) as {
      running: boolean;
    };
    assert.equal(status.running, false, "daemon idle-exited without an explicit stop");
    assert.equal(
      existsSync(join(directory, "nmg.sqlite.server.json")),
      false,
      "idle exit released the server lease",
    );
  } finally {
    removeTempDirectory(directory);
  }
});

test("daemon idle timer is refreshed by requests", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-idle-refresh-"));
  try {
    runLauncher(["daemon", "start", "--json", "--data-dir", directory], {
      NMG_DAEMON_IDLE_TIMEOUT_MS: "2500",
    });
    await delay(1_500);
    const first = runLauncher(["daemon", "status", "--json", "--data-dir", directory]) as {
      running: boolean;
    };
    assert.equal(first.running, true, "still running before the idle deadline");
    await delay(1_800);
    const second = runLauncher(["daemon", "status", "--json", "--data-dir", directory]) as {
      running: boolean;
    };
    assert.equal(second.running, true, "the status request refreshed the idle timer");
  } finally {
    runLauncher(["daemon", "stop", "--json", "--data-dir", directory]);
    removeTempDirectory(directory);
  }
});

test("daemon re-spawns on the same database after idle exit with data intact", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-idle-respawn-"));
  try {
    const first = runLauncher(["daemon", "start", "--json", "--data-dir", directory], {
      NMG_DAEMON_IDLE_TIMEOUT_MS: "1000",
    }) as { started: boolean; pid: number };
    assert.equal(first.started, true);
    runLauncher([
      "remember",
      "Idle-respawn probe memory",
      "--node",
      "idle-respawn",
      "--json",
      "--data-dir",
      directory,
    ]);
    await delay(1_600);
    const gone = runLauncher(["daemon", "status", "--json", "--data-dir", directory]) as {
      running: boolean;
    };
    assert.equal(gone.running, false, "daemon idle-exited");

    const second = runLauncher(["daemon", "start", "--json", "--data-dir", directory]) as {
      started: boolean;
      pid: number;
    };
    assert.equal(second.started, true);
    assert.notEqual(second.pid, first.pid, "a fresh daemon process was spawned");
    const searched = runLauncher([
      "search",
      "respawn probe",
      "--json",
      "--data-dir",
      directory,
    ]) as { results: Array<{ memory: { statement: string } }> };
    assert.equal(searched.results[0]?.memory.statement, "Idle-respawn probe memory");
  } finally {
    runLauncher(["daemon", "stop", "--json", "--data-dir", directory]);
    removeTempDirectory(directory);
  }
});

test("daemon re-spawns over a stale lease file from a dead process", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-stale-lease-"));
  try {
    const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid;
    writeFileSync(
      join(directory, "nmg.sqlite.server.json"),
      JSON.stringify({
        pid: deadPid,
        startedAt: new Date().toISOString(),
        transport: "http",
        host: "127.0.0.1",
        port: 1,
        token: "stale",
      }),
    );
    const started = runLauncher(["daemon", "start", "--json", "--data-dir", directory]) as {
      started: boolean;
      pid: number;
    };
    assert.equal(started.started, true);
    assert.notEqual(started.pid, deadPid);
  } finally {
    runLauncher(["daemon", "stop", "--json", "--data-dir", directory]);
    removeTempDirectory(directory);
  }
});

test("connectDaemon warns when live daemon count exceeds NMG_DAEMON_LIMIT", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-daemon-limit-"));
  const liveDirectories = [join(directory, "live-1"), join(directory, "live-2")];
  try {
    for (const live of liveDirectories) {
      const started = runLauncher(["daemon", "start", "--json", "--data-dir", live]) as {
        started: boolean;
      };
      assert.equal(started.started, true);
    }
    const probe = (limit: string) => {
      const probePath = join(directory, "probe.mjs");
      writeFileSync(
        probePath,
        [
          `import { connectDaemon, shutdownOwnedDaemon } from ${JSON.stringify(
            pathToFileURL(resolve(root, "src/cli/daemon-client.ts")).href,
          )};`,
          `const conn = await connectDaemon(${JSON.stringify(join(directory, "probe", "nmg.sqlite"))});`,
          `await shutdownOwnedDaemon(conn);`,
        ].join("\n"),
      );
      return spawnSync(process.execPath, ["--experimental-strip-types", probePath], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NMG_DATA_DIR: directory, NMG_DAEMON_LIMIT: limit },
      });
    };

    const warned = probe("1");
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stderr, /NMG: warning: 2 NMG daemons running \(limit 1\)/);

    const quiet = probe("1000");
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.ok(
      !/NMG: warning/.test(quiet.stderr),
      `no warning under a high limit:\n${quiet.stderr}`,
    );
  } finally {
    for (const live of liveDirectories) {
      runLauncher(["daemon", "stop", "--json", "--data-dir", live]);
    }
    removeTempDirectory(directory);
  }
});

test("daemon client replaces a stale descriptor whose pid was reused", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-reused-pid-"));
  try {
    writeFileSync(
      join(directory, "nmg.sqlite.server.json"),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        transport: "http",
        host: "127.0.0.1",
        port: 1,
        token: "stale",
      }),
    );
    const probePath = join(directory, "reused-pid-probe.mjs");
    writeFileSync(
      probePath,
      [
        `import { connectDaemon, shutdownOwnedDaemon } from ${JSON.stringify(
          pathToFileURL(resolve(root, "src/cli/daemon-client.ts")).href,
        )};`,
        `const connection = await connectDaemon(${JSON.stringify(join(directory, "nmg.sqlite"))});`,
        `console.log(JSON.stringify({ started: connection.startedByCaller, pid: connection.state.pid }));`,
        `await shutdownOwnedDaemon(connection);`,
      ].join("\n"),
    );
    const probe = spawnSync(process.execPath, ["--experimental-strip-types", probePath], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(probe.status, 0, probe.stderr);
    const result = JSON.parse(probe.stdout.trim()) as { started: boolean; pid: number };
    assert.equal(result.started, true);
    assert.notEqual(result.pid, process.pid);
  } finally {
    removeTempDirectory(directory);
  }
});

test("daemon count ignores stale descriptors whose pid was reused", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-daemon-stale-count-"));
  try {
    writeFileSync(
      join(directory, "nmg.sqlite.server.json"),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        transport: "http",
        host: "127.0.0.1",
        port: 1,
        token: "stale",
      }),
    );
    const probePath = join(directory, "count-probe.mjs");
    writeFileSync(
      probePath,
      [
        `import { countRunningDaemons } from ${JSON.stringify(
          pathToFileURL(resolve(root, "src/cli/daemon-client.ts")).href,
        )};`,
        `console.log(await countRunningDaemons([${JSON.stringify(directory)}]));`,
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, ["--experimental-strip-types", probePath], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "0");
  } finally {
    removeTempDirectory(directory);
  }
});

test("invokeDaemon reconnects after the daemon dies mid-session", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-daemon-reconnect-"));
  try {
    const probePath = join(directory, "reconnect.mjs");
    writeFileSync(
      probePath,
      [
        `import { connectDaemon, invokeDaemon, shutdownOwnedDaemon } from ${JSON.stringify(
          pathToFileURL(resolve(root, "src/cli/daemon-client.ts")).href,
        )};`,
        `import { isProcessAlive } from ${JSON.stringify(
          pathToFileURL(resolve(root, "src/cli/lifecycle.ts")).href,
        )};`,
        `const conn = await connectDaemon(${JSON.stringify(join(directory, "nmg.sqlite"))});`,
        `const before = conn.state.pid;`,
        `await invokeDaemon(conn, "remember", { statement: "reconnect probe memory", nodeName: "reconnect-probe" });`,
        `process.kill(before, "SIGKILL");`,
        `for (let i = 0; i < 50 && isProcessAlive(before); i += 1) await new Promise((r) => setTimeout(r, 20));`,
        `const result = await invokeDaemon(conn, "search", { query: "reconnect probe" });`,
        `console.log(JSON.stringify({ before, after: conn.state.pid, reconnected: before !== conn.state.pid, found: (result.results ?? []).length > 0 }));`,
        `await shutdownOwnedDaemon(conn);`,
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, ["--experimental-strip-types", probePath], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim()) as {
      before: number;
      after: number;
      reconnected: boolean;
      found: boolean;
    };
    assert.equal(parsed.reconnected, true, "a fresh daemon process was spawned after death");
    assert.equal(parsed.found, true, "sqlite memory survived daemon death");
  } finally {
    removeTempDirectory(directory);
  }
});

function runLauncher(args: string[], env: NodeJS.ProcessEnv = {}): unknown {
  const result = spawnSync(process.execPath, [launcher, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}
