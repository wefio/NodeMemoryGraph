import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { httpCall } from "./http-client.ts";
import { isProcessAlive, readServerState, serverStatePath, type ServerState } from "./lifecycle.ts";
import type { NmgMethod } from "./protocol.ts";

export interface DaemonConnection {
  state: ServerState;
  startedByCaller: boolean;
}

export async function connectDaemon(databasePath: string): Promise<DaemonConnection> {
  const statePath = serverStatePath(databasePath);
  const existing = readyState(statePath);
  if (existing) {
    await httpCall(existing, "hello");
    return { startedByCaller: false, state: existing };
  }

  const entrypoint = resolve(import.meta.dirname, "../../bin/nmg.mjs");
  const child = spawn(process.execPath, [entrypoint, "daemon", "run", "--db", databasePath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const state = await waitForState(statePath);
  await httpCall(state, "hello");
  return { startedByCaller: true, state };
}

export async function shutdownOwnedDaemon(connection: DaemonConnection): Promise<void> {
  if (!connection.startedByCaller || !isProcessAlive(connection.state.pid)) return;
  try {
    await httpCall(connection.state, "shutdown");
  } catch {
    // The daemon may already be gone.
  }
  await waitForProcessExit(connection.state.pid);
}

export async function invokeDaemon(
  connection: DaemonConnection,
  method: NmgMethod,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return httpCall(connection.state, method, params);
}

function readyState(statePath: string): ServerState | undefined {
  const state = readServerState(statePath);
  return state?.transport === "http" && state.port && state.token && isProcessAlive(state.pid)
    ? state
    : undefined;
}

async function waitForState(statePath: string): Promise<ServerState> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = readyState(statePath);
    if (state) return state;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("NMG daemon did not become ready");
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && isProcessAlive(pid); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  if (isProcessAlive(pid)) throw new Error(`NMG daemon pid ${pid} did not stop`);
}
