import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { invokeDaemon } from "../../src/cli/daemon-client.ts";
import { httpCall } from "../../src/cli/http-client.ts";
import { httpHandler } from "../../src/cli/http-server.ts";
import { serverStatePath, type ServerState } from "../../src/cli/lifecycle.ts";
import { NMG_CAPABILITIES, NMG_METHODS } from "../../src/cli/protocol.ts";
import { NmgService } from "../../src/cli/service.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

async function endpoint(server: Server, token: string, pid = process.pid): Promise<ServerState> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    pid,
    startedAt: new Date().toISOString(),
    transport: "http",
    host: "127.0.0.1",
    port: (server.address() as { port: number }).port,
    token,
  };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((done) => server.close(() => done()));
}

test("reload shutdown rejects absent/foreign handover tickets before marking the owner for shutdown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-reload-http-"));
  const service = new NmgService({ dataDirectory: directory, environment: {} });
  let stopped = false;
  const server = createServer(
    httpHandler(service, "fixture", () => {
      stopped = true;
    }),
  );
  try {
    const state = await endpoint(server, "fixture");
    await assert.rejects(httpCall(state, "shutdown", { reload: true }), /handover ticket/u);
    await assert.rejects(
      httpCall(state, "shutdown", { reload: true, ticket: "foreign" }),
      /stale or foreign/u,
    );
    assert.equal(service.shutdownRequested, false);
    assert.equal(stopped, false);
    await httpCall(state, "hello");
  } finally {
    await close(server);
    service.close();
    removeTempDirectory(directory);
  }
});

test("an uncertain mutation is not replayed when its owner exits after accepting it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-reload-no-replay-"));
  const databasePath = join(directory, "nmg.sqlite");
  const service = new NmgService({ databasePath, environment: {} });
  // The HTTP peers are controlled fixtures. A real child supplies the old owner's
  // liveness transition so the transport retry branch is exercised, not mocked away.
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  assert.ok(owner.pid);
  let accepted = 0;
  let replayed = 0;
  const newHandler = httpHandler(service, "replacement");
  const replacement = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      if (JSON.parse(body).method === "remember") replayed++;
    });
    newHandler(request, response);
  });
  let next: ServerState;
  const previous = createServer((request) => {
    request.resume();
    request.on("end", () => {
      accepted++;
      writeFileSync(serverStatePath(databasePath), JSON.stringify(next));
      owner.once("exit", () => request.socket.destroy());
      owner.kill("SIGKILL");
    });
  });
  try {
    next = await endpoint(replacement, "replacement");
    const old = await endpoint(previous, "old", owner.pid);
    writeFileSync(serverStatePath(databasePath), JSON.stringify(old));
    const connection = {
      state: old,
      databasePath,
      startedByCaller: false,
      capabilities: new Set<string>(NMG_CAPABILITIES),
      methods: new Set(NMG_METHODS),
    };
    await assert.rejects(
      invokeDaemon(connection, "remember", {
        statement: "One accepted write.",
        nodeName: "No replay",
      }),
      /not replayed.*outcome is unknown/u,
    );
    assert.equal(accepted, 1);
    assert.equal(replayed, 0);
    assert.equal(connection.state.token, "replacement");
  } finally {
    owner.kill("SIGKILL");
    await close(previous);
    await close(replacement);
    service.close();
    removeTempDirectory(directory);
  }
});
