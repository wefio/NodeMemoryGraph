import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export interface ServerState {
  pid: number;
  startedAt: string;
  protocol?: string;
  transport?: "http";
  host?: string;
  port?: number;
  token?: string;
}

export interface ServerLease {
  statePath: string;
  update(state: Partial<Omit<ServerState, "pid" | "startedAt">>): void;
  release(): void;
}

export function serverStatePath(databasePath: string): string {
  return `${databasePath}.server.json`;
}

export function acquireServerLease(databasePath: string, reloadTicket?: string): ServerLease {
  assertReloadAdmission(databasePath, reloadTicket);
  const statePath = serverStatePath(databasePath);
  mkdirSync(dirname(statePath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number;
    try {
      descriptor = openSync(statePath, "wx", 0o600);
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
      update(update) {
        if (released) throw new Error("cannot update a released NMG server lease");
        Object.assign(state, update);
        writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");
      },
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

export interface ReloadLease {
  ticket: string;
  release(): void;
}

interface ReloadOwner {
  pid: number;
  ticket: string;
}

export function serverReloadPath(databasePath: string): string {
  return `${databasePath}.reload.json`;
}

/** An exclusive handover gate, not another daemon descriptor or state store. */
export function acquireReloadLease(databasePath: string): ReloadLease {
  const path = serverReloadPath(databasePath);
  mkdirSync(dirname(path), { recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    throw new Error("NMG daemon reload is already in progress; inspect its owner before recovery", {
      cause: error,
    });
  }
  const owner: ReloadOwner = { pid: process.pid, ticket: randomUUID() };
  try {
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  return {
    ticket: owner.ticket,
    release() {
      const current = readReloadOwner(databasePath);
      if (current?.pid === owner.pid && current.ticket === owner.ticket)
        rmSync(path, { force: true });
    },
  };
}

function readReloadOwner(databasePath: string): ReloadOwner | undefined {
  const path = serverReloadPath(databasePath);
  if (!existsSync(path)) return undefined;
  let owner: Partial<ReloadOwner>;
  try {
    owner = JSON.parse(readFileSync(path, "utf8")) as Partial<ReloadOwner>;
  } catch (error) {
    throw new Error("Unreadable daemon reload gate; operator recovery required", { cause: error });
  }
  if (
    !owner ||
    !Number.isSafeInteger(owner.pid) ||
    Number(owner.pid) <= 0 ||
    typeof owner.ticket !== "string" ||
    !owner.ticket
  )
    throw new Error("Invalid daemon reload gate; operator recovery required");
  return { pid: Number(owner.pid), ticket: owner.ticket };
}

export function requireReloadTicket(databasePath: string, ticket: unknown): void {
  if (typeof ticket !== "string" || !ticket)
    throw new Error("reload requires its captured handover ticket");
  assertReloadAdmission(databasePath, ticket);
}

function assertReloadAdmission(databasePath: string, ticket?: string): void {
  const owner = readReloadOwner(databasePath);
  if (ticket) {
    if (!owner || owner.ticket !== ticket || !isProcessAlive(owner.pid))
      throw new Error("NMG daemon reload ticket is stale or foreign");
    return;
  }
  if (owner) throw new Error("NMG daemon reload is in progress; no second owner may start");
}

/** Never clear an abandoned gate or silently spawn over a failed handover. */
export async function waitForReload(databasePath: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let owner = readReloadOwner(databasePath);
  while (owner) {
    if (!isProcessAlive(owner.pid))
      throw new Error("NMG reload owner exited; operator recovery required");
    if (Date.now() >= deadline)
      throw new Error("NMG daemon reload is still in progress; retry later");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    owner = readReloadOwner(databasePath);
  }
}

export async function stopServer(
  databasePath: string,
): Promise<
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

export function readServerState(statePath: string): ServerState | undefined {
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8")) as Partial<ServerState>;
    return Number.isSafeInteger(value.pid) && Number(value.pid) > 0
      ? {
          pid: Number(value.pid),
          startedAt: String(value.startedAt ?? ""),
          protocol: typeof value.protocol === "string" ? value.protocol : undefined,
          transport: value.transport === "http" ? "http" : undefined,
          host: typeof value.host === "string" ? value.host : undefined,
          port: Number.isSafeInteger(value.port) ? Number(value.port) : undefined,
          token: typeof value.token === "string" ? value.token : undefined,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
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
