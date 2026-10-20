import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { daemonBuildProblem, parseDaemonHello } from "./daemon-client.ts";
import { httpCall } from "./http-client.ts";
import {
  acquireReloadLease,
  isProcessAlive,
  readServerState,
  serverStatePath,
  type ServerState,
} from "./lifecycle.ts";

/** Operator-only code replacement, not automatic restart or in-process module hot reload. */
export async function reloadDaemon(databasePath: string, entrypoint: string) {
  const problem = daemonBuildProblem(
    entrypoint,
    resolve(import.meta.dirname, "../../dist/cli/main.js"),
  );
  if (problem) throw new Error(problem);
  const lease = acquireReloadLease(databasePath);
  try {
    const previous = readServerState(serverStatePath(databasePath));
    if (!previous || !isProcessAlive(previous.pid))
      throw new Error("reload requires a running daemon");
    const hello = parseDaemonHello(await httpCall(previous, "hello", {}, { timeoutMs: 5_000 }));
    if (!hello.capabilities.includes("controlled-reload"))
      throw new Error(
        "This daemon cannot drain for reload; a coordinated initial upgrade is required",
      );
    await httpCall(
      previous,
      "shutdown",
      { reload: true, ticket: lease.ticket },
      { timeoutMs: 10_000 },
    );
    await waitForExit(previous.pid);
    const pid = await launchReplacement(entrypoint, databasePath, lease.ticket);
    const next = await waitForReplacement(databasePath, pid);
    const ready = parseDaemonHello(await httpCall(next, "hello", {}, { timeoutMs: 5_000 }));
    return {
      reloaded: true,
      reloadedFrom: previous.pid,
      pid: next.pid,
      endpoint: `${next.host}:${next.port}`,
      transientState: "cleared",
      catalogFingerprint: ready.catalogFingerprint,
    };
  } finally {
    lease.release();
  }
}

function launchReplacement(
  entrypoint: string,
  databasePath: string,
  ticket: string,
): Promise<number> {
  return new Promise((ready, reject) => {
    const child = spawn(
      process.execPath,
      [entrypoint, "daemon", "run", "--db", databasePath, "--reload-ticket", ticket],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.once("error", reject);
    child.once("spawn", () => {
      if (!child.pid) {
        reject(new Error("reload could not launch the replacement daemon"));
        return;
      }
      child.unref();
      ready(child.pid);
    });
  });
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline)
      throw new Error("reload owner did not exit; no replacement was started");
    await new Promise((done) => setTimeout(done, 25));
  }
}

async function waitForReplacement(databasePath: string, pid: number): Promise<ServerState> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) throw new Error("reload replacement exited before becoming ready");
    const state = readServerState(serverStatePath(databasePath));
    if (state?.pid === pid && state.transport === "http" && state.port && state.token) return state;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("reload replacement did not become ready");
}
