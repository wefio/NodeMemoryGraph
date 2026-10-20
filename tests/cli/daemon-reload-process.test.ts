import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { connectDaemon, invokeDaemon, type DaemonConnection } from "../../src/cli/daemon-client.ts";
import { httpCall } from "../../src/cli/http-client.ts";
import {
  acquireReloadLease,
  acquireServerLease,
  isProcessAlive,
  readServerState,
  serverReloadPath,
  serverStatePath,
  waitForReload,
} from "../../src/cli/lifecycle.ts";
import { reloadDaemon } from "../../src/cli/daemon-reload.ts";
import { NMG_PROTOCOL_VERSION } from "../../src/cli/protocol.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

stripProviderEnv();
const launcher = resolve(import.meta.dirname, "../../bin/nmg.mjs");

async function withDaemon(
  run: (fixture: {
    connection: DaemonConnection;
    databasePath: string;
    owned: Set<number>;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "nmg-reload-process-"));
  const databasePath = join(directory, "nmg.sqlite");
  const owned = new Set<number>();
  try {
    const connection = await connectDaemon(databasePath);
    owned.add(connection.state.pid);
    await run({ connection, databasePath, owned });
  } finally {
    const current = readServerState(serverStatePath(databasePath));
    if (current && owned.has(current.pid) && isProcessAlive(current.pid)) {
      await httpCall(current, "shutdown");
      const deadline = Date.now() + 5_000;
      while (isProcessAlive(current.pid) && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 25));
      assert.equal(isProcessAlive(current.pid), false, "the fixture's owner exited");
    }
    removeTempDirectory(directory);
  }
}

test("reload replaces built code, preserves durable memory/board and clears volatile AG/leases", async () => {
  await withDaemon(async ({ connection, databasePath, owned }) => {
    await invokeDaemon(connection, "remember", {
      statement: "Reload keeps durable evidence.",
      nodeName: "Reload evidence",
    });
    await invokeDaemon(connection, "taskBoard", {
      action: "put",
      taskId: "reload",
      agentId: "fixture",
      content: "Durable coordination.",
    });
    await invokeDaemon(connection, "state", {
      action: "write",
      space: "ag",
      operation: "enable",
      sessionId: "fixture",
      reason: "reload fixture",
      requester: "agent:fixture",
    });
    await invokeDaemon(connection, "state", {
      action: "write",
      space: "ag",
      operation: "replace",
      sessionId: "fixture",
      text: "Volatile plan.",
    });
    const captured = (await invokeDaemon(connection, "state", {
      action: "read",
      space: "ag",
      operation: "status",
      sessionId: "fixture",
    })) as { result: { activation: { workingStateBinding: unknown } } };
    const oldBinding = captured.result.activation.workingStateBinding;
    const before = connection.state.pid;
    const cli = spawnSync(
      process.execPath,
      [launcher, "daemon", "reload", "--db", databasePath, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(cli.status, 0, cli.stderr);
    const reloaded = JSON.parse(cli.stdout) as Awaited<ReturnType<typeof reloadDaemon>>;
    owned.add(reloaded.pid);
    assert.equal(reloaded.reloadedFrom, before);
    assert.notEqual(reloaded.pid, before);
    assert.equal(isProcessAlive(before), false);
    assert.equal(reloaded.transientState, "cleared");
    assert.equal(existsSync(serverReloadPath(databasePath)), false);
    // Deliberately stale discovery: refresh must happen before a missing-method refusal.
    connection.methods = new Set(["hello", "status"]);
    connection.capabilities = new Set(["hello", "status"]);
    const state = (await invokeDaemon(connection, "state", {
      action: "read",
      space: "ag",
      sessionId: "fixture",
    })) as { information: { text: string } };
    assert.equal(state.information.text, "");
    assert.equal(
      connection.startedByCaller,
      false,
      "a client does not own the controller's replacement",
    );
    const status = (await invokeDaemon(connection, "state", {
      action: "read",
      space: "ag",
      operation: "status",
      sessionId: "fixture",
    })) as { result: { activation: unknown } };
    assert.equal(status.result.activation, null);
    await invokeDaemon(connection, "state", {
      action: "write",
      space: "ag",
      operation: "enable",
      sessionId: "fixture",
      requester: "agent:fixture",
      reason: "new owner fixture",
    });
    await assert.rejects(
      invokeDaemon(connection, "state", {
        action: "write",
        space: "ag",
        operation: "replace",
        sessionId: "fixture",
        workingStateBinding: oldBinding,
        text: "Late old-owner write.",
      }),
      /binding/u,
    );
    const memory = (await invokeDaemon(connection, "search", {
      query: "Reload keeps durable evidence",
    })) as { results: unknown[] };
    assert.equal(memory.results.length, 1);
    const board = (await invokeDaemon(connection, "taskBoard", {
      action: "read",
      taskId: "reload",
      agentId: "fixture",
    })) as { entries: { content: string }[] };
    assert.equal(board.entries[0]?.content, "Durable coordination.");
  });
});

test("daemon reload prints an operator-readable completion summary", async () => {
  await withDaemon(async ({ databasePath, owned }) => {
    const cli = spawnSync(process.execPath, [launcher, "daemon", "reload", "--db", databasePath], {
      encoding: "utf8",
    });
    const next = readServerState(serverStatePath(databasePath));
    assert.ok(next);
    owned.add(next.pid);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /^Reloaded NMG daemon from pid .*transient AG and leases cleared/u);
  });
});

test("a failed replacement is reported as failure, never as a successful reload", async () => {
  await withDaemon(async ({ connection, databasePath }) => {
    const entrypoint = join(dirname(databasePath), "failed-replacement.mjs");
    writeFileSync(entrypoint, "process.exit(2);");
    await assert.rejects(reloadDaemon(databasePath, entrypoint), /replacement exited/u);
    assert.equal(isProcessAlive(connection.state.pid), false);
    assert.equal(existsSync(serverReloadPath(databasePath)), false);
    assert.equal(readServerState(serverStatePath(databasePath)), undefined);
  });
});

test("reload gate blocks competing starts, waits client connections and fences foreign child tickets", async () => {
  await withDaemon(async ({ connection, databasePath }) => {
    const gate = acquireReloadLease(databasePath);
    let connected = false;
    const pending = connectDaemon(databasePath).then((next) => {
      connected = true;
      return next;
    });
    try {
      assert.throws(() => acquireReloadLease(databasePath), /already in progress/u);
      assert.throws(() => acquireServerLease(databasePath), /no second owner/u);
      assert.throws(() => acquireServerLease(databasePath, "foreign"), /stale or foreign/u);
      await assert.rejects(waitForReload(databasePath, 0), /still in progress/u);
      assert.equal(
        existsSync(serverReloadPath(databasePath)),
        true,
        "a timeout cannot remove a live gate",
      );
      const raw = spawnSync(process.execPath, [launcher, "daemon", "run", "--db", databasePath], {
        encoding: "utf8",
      });
      assert.equal(raw.status, 1);
      assert.match(raw.stderr, /no second owner/u);
      await new Promise((done) => setTimeout(done, 30));
      assert.equal(connected, false);
      assert.equal(readServerState(serverStatePath(databasePath))?.pid, connection.state.pid);
    } finally {
      gate.release();
    }
    assert.equal((await pending).state.pid, connection.state.pid);
  });
});

test("abandoned or malformed reload gates fail closed without deleting coordination or starting an owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-reload-abandoned-"));
  const databasePath = join(directory, "nmg.sqlite");
  try {
    const orphan = JSON.stringify({ pid: 2147483647, ticket: "orphan" });
    writeFileSync(serverReloadPath(databasePath), orphan);
    await assert.rejects(waitForReload(databasePath), /owner exited/u);
    assert.equal(readFileSync(serverReloadPath(databasePath), "utf8"), orphan);
    writeFileSync(serverReloadPath(databasePath), "not-json");
    await assert.rejects(connectDaemon(databasePath), /operator recovery/u);
    assert.equal(existsSync(serverStatePath(databasePath)), false);
  } finally {
    removeTempDirectory(directory);
  }
});

test("an old daemon without controlled reload is never stopped as an implicit upgrade", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-reload-old-owner-"));
  const databasePath = join(directory, "nmg.sqlite");
  const methods: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      methods.push(JSON.parse(body).method);
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          result: {
            protocol: NMG_PROTOCOL_VERSION,
            service: "node-memory-graph",
            version: "old",
            capabilities: ["hello", "shutdown"],
          },
          id: 1,
        }),
      );
    });
  });
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    writeFileSync(
      serverStatePath(databasePath),
      JSON.stringify({
        pid: process.pid,
        transport: "http",
        host: "127.0.0.1",
        port: (server.address() as { port: number }).port,
        token: "fixture",
      }),
    );
    const original = readFileSync(serverStatePath(databasePath), "utf8");
    await assert.rejects(reloadDaemon(databasePath, launcher), /coordinated initial upgrade/u);
    assert.deepEqual(methods, ["hello"]);
    assert.equal(readFileSync(serverStatePath(databasePath), "utf8"), original);
    assert.equal(existsSync(serverReloadPath(databasePath)), false);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    removeTempDirectory(directory);
  }
});
