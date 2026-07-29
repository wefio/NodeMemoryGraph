import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { NMG_PROTOCOL_VERSION, type NmgResponse } from "../../src/cli/protocol.ts";

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

test("stdio server keeps one resident store across multiple NDJSON requests", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-process-stdio-"));
  const child = spawn(process.execPath, [launcher, "serve", "--stdio", "--data-dir", directory], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const requests = [
      { protocol: NMG_PROTOCOL_VERSION, id: 1, method: "hello" },
      {
        protocol: NMG_PROTOCOL_VERSION,
        id: 2,
        method: "remember",
        params: {
          statement: "The CLI resident test uses SQLite.",
          nodeName: "CLI resident test",
          memoryType: "fact",
        },
      },
      {
        protocol: NMG_PROTOCOL_VERSION,
        id: 3,
        method: "search",
        params: { query: "CLI resident SQLite" },
      },
      { protocol: NMG_PROTOCOL_VERSION, id: 4, method: "status" },
      { protocol: NMG_PROTOCOL_VERSION, id: 5, method: "shutdown" },
    ];
    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);

    const [stdout, stderr, exitCode] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      new Promise<number | null>((resolveExit, reject) => {
        child.on("error", reject);
        child.on("exit", resolveExit);
      }),
    ]);
    assert.equal(exitCode, 0, stderr);
    assert.equal(stderr, "");
    const responses = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as NmgResponse);
    assert.equal(responses.length, requests.length);
    assert.ok(responses.every((response) => response.ok));

    const search = responses[2]!;
    assert.equal(search.ok, true);
    if (search.ok) {
      const result = search.result as { results: unknown[] };
      assert.equal(result.results.length, 1);
    }
    const status = responses[3]!;
    assert.equal(status.ok, true);
    if (status.ok) {
      const result = status.result as { storage: { loaded: boolean } };
      assert.equal(result.storage.loaded, true);
    }
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resident server rejects duplicates and can be stopped by CLI", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-cli-process-lifecycle-"));
  const child = spawn(process.execPath, [launcher, "serve", "--stdio", "--data-dir", directory], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    child.stdin.write(
      `${JSON.stringify({ protocol: NMG_PROTOCOL_VERSION, id: 1, method: "hello" })}\n`,
    );
    await waitForOutput(child.stdout);

    const duplicate = spawnSync(
      process.execPath,
      [launcher, "serve", "--stdio", "--data-dir", directory],
      { cwd: root, encoding: "utf8", timeout: 2_000 },
    );
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already running/);

    const stopped = spawnSync(
      process.execPath,
      [launcher, "stop", "--json", "--data-dir", directory],
      { cwd: root, encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal((JSON.parse(stopped.stdout) as { stopped: boolean }).stopped, true);
    await waitForExit(child);

    const stoppedAgain = spawnSync(
      process.execPath,
      [launcher, "stop", "--json", "--data-dir", directory],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(stoppedAgain.status, 0, stoppedAgain.stderr);
    assert.equal((JSON.parse(stoppedAgain.stdout) as { stopped: boolean }).stopped, false);
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});

function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      output += chunk;
    });
    stream.on("end", () => resolveOutput(output));
    stream.on("error", reject);
  });
}

function waitForOutput(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolveOutput, reject) => {
    stream.once("data", () => resolveOutput());
    stream.once("error", reject);
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
}

function runLauncher(args: string[]): unknown {
  const result = spawnSync(process.execPath, [launcher, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
