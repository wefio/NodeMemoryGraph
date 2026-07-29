import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

interface ServerState {
  pid: number;
  startedAt: string;
}

export interface ServerLease {
  statePath: string;
  release(): void;
}

export function serverStatePath(databasePath: string): string {
  return `${databasePath}.server.json`;
}

export function acquireServerLease(databasePath: string): ServerLease {
  const statePath = serverStatePath(databasePath);
  mkdirSync(dirname(statePath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number;
    try {
      descriptor = openSync(statePath, "wx");
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const state = readServerState(statePath);
      if (state && isProcessAlive(state.pid)) {
        throw new Error(`NMG server is already running (pid ${state.pid})`, { cause: error });
      }
      rmSync(statePath, { force: true });
      continue;
    }

    const state: ServerState = { pid: process.pid, startedAt: new Date().toISOString() };
    try {
      writeFileSync(descriptor, `${JSON.stringify(state)}\n`, "utf8");
    } finally {
      closeSync(descriptor);
    }
    let released = false;
    return {
      statePath,
      release() {
        if (released) return;
        released = true;
        const current = readServerState(statePath);
        if (current?.pid === process.pid) rmSync(statePath, { force: true });
      },
    };
  }

  throw new Error("could not acquire NMG server lease");
}

export async function stopServer(databasePath: string): Promise<
  | { stopped: true; pid: number }
  | { stopped: false; reason: "not-running" | "stale-state"; pid?: number }
> {
  const statePath = serverStatePath(databasePath);
  const state = readServerState(statePath);
  if (!state) {
    rmSync(statePath, { force: true });
    return { stopped: false, reason: "not-running" };
  }
  if (!isProcessAlive(state.pid)) {
    rmSync(statePath, { force: true });
    return { stopped: false, reason: "stale-state", pid: state.pid };
  }

  process.kill(state.pid, "SIGTERM");
  for (let attempt = 0; attempt < 50 && isProcessAlive(state.pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (isProcessAlive(state.pid)) {
    throw new Error(`NMG server pid ${state.pid} did not stop`);
  }
  rmSync(statePath, { force: true });
  return { stopped: true, pid: state.pid };
}

function readServerState(statePath: string): ServerState | undefined {
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8")) as Partial<ServerState>;
    return Number.isSafeInteger(value.pid) && Number(value.pid) > 0
      ? { pid: Number(value.pid), startedAt: String(value.startedAt ?? "") }
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}
