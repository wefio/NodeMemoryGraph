import { spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { httpCall } from "./http-client.ts";
import { isProcessAlive, readServerState, serverStatePath, type ServerState } from "./lifecycle.ts";
import type { NmgMethod } from "./protocol.ts";

const DEFAULT_DAEMON_LIMIT = 32;
const DAEMON_COUNT_MEMO_MS = 1_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".nmg", "build"]);
const SERVER_STATE_SUFFIX = ".server.json";

export interface DaemonConnection {
  state: ServerState;
  startedByCaller: boolean;
  /** 数据库路径，供连接失败重连时重新拉起同库 daemon。 */
  databasePath: string;
}

export async function connectDaemon(databasePath: string): Promise<DaemonConnection> {
  const statePath = serverStatePath(databasePath);
  const existing = readyState(statePath);
  if (existing) {
    try {
      await httpCall(existing, "hello");
      return { startedByCaller: false, state: existing, databasePath };
    } catch {
      // The OS may have reused a stale descriptor's PID for an unrelated
      // process. Only an authenticated endpoint proves daemon identity.
      rmSync(statePath, { force: true });
    }
  }

  await warnIfDaemonLimitExceeded();

  const entrypoint = resolve(import.meta.dirname, "../../bin/nmg.mjs");
  const child = spawn(process.execPath, [entrypoint, "daemon", "run", "--db", databasePath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const state = await waitForState(statePath);
  await httpCall(state, "hello");
  return { startedByCaller: true, state, databasePath };
}

export async function shutdownOwnedDaemon(connection: DaemonConnection): Promise<void> {
  if (!connection.startedByCaller || !isProcessAlive(connection.state.pid)) return;
  try {
    await httpCall(connection.state, "shutdown");
  } catch {
    // The daemon may already be gone.
  }
  try {
    await waitForProcessExit(connection.state.pid);
  } catch {
    // Graceful shutdown can stall on Windows (keep-alive socket teardown or
    // SQLite handle release). Force-exit the survivor so an owned daemon
    // never lingers after its client is done.
    try {
      process.kill(connection.state.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await waitForProcessExit(connection.state.pid);
  }
}

/**
 * 调用 daemon；连接级失败（fetch 网络层的 TypeError，如 daemon 空闲超时
 * 退出后的 ECONNREFUSED）时自动重连一次并重试。HTTP 层 4xx/5xx 与协议
 * 错误是普通 Error，不重试——避免掩盖真实错误。
 */
export async function invokeDaemon(
  connection: DaemonConnection,
  method: NmgMethod,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  try {
    return await httpCall(connection.state, method, params);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // A live owner with a transiently broken endpoint must not cause a second
    // daemon to be spawned for the same database. Let the caller retry after
    // the fault window; reconnect is reserved for an owner that has exited.
    if (isProcessAlive(connection.state.pid)) throw error;
    const reconnected = await connectDaemon(connection.databasePath);
    connection.state = reconnected.state;
    connection.startedByCaller = reconnected.startedByCaller;
    return await httpCall(connection.state, method, params);
  }
}

/**
 * 统计当前存活的 NMG daemon 数量：扫描 NMG_DATA_DIR（默认 ~/.nmg）与
 * cwd 下所有 `*.server.json`，按 pid 和 authenticated hello 探活计数。1 秒 memo 摊销扫描成本
 * （评测多进程、每 arm 一次 spawn 场景）。
 */
export async function countRunningDaemons(roots: string[] = daemonScanRoots()): Promise<number> {
  const key = roots.join("|");
  const now = Date.now();
  if (memoizedDaemonCount?.key === key && now - memoizedDaemonCount.at < DAEMON_COUNT_MEMO_MS) {
    return memoizedDaemonCount.count;
  }
  const states = new Map<string, ServerState>();
  const seenPaths = new Set<string>();
  for (const root of roots) {
    if (!root) continue;
    collectDaemonStates(root, seenPaths, states);
  }
  const alive = await Promise.all([...states.values()].map(authenticatedDaemonAlive));
  const count = alive.filter(Boolean).length;
  memoizedDaemonCount = { key, at: now, count };
  return count;
}

function daemonScanRoots(): string[] {
  const dataDir = resolve(process.env.NMG_DATA_DIR ?? join(homedir(), ".nmg"));
  return [dataDir];
}

function collectDaemonStates(
  directory: string,
  seenPaths: Set<string>,
  states: Map<string, ServerState>,
): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return; // 目录不存在或不可读
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectDaemonStates(full, seenPaths, states);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(SERVER_STATE_SUFFIX)) continue;
    const path = resolve(full);
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    const state = readServerState(full);
    if (state?.transport === "http" && state.host && state.port && state.token && isProcessAlive(state.pid)) {
      states.set(`${state.host}:${state.port}:${state.token}`, state);
    }
  }
}

/** 拉起新 daemon 前检查数量上限；越限向 stderr 警告一次（每进程），不阻断。 */
async function warnIfDaemonLimitExceeded(): Promise<void> {
  const limit = daemonLimit();
  if (limit <= 0 || daemonLimitWarningIssued) return;
  const count = await countRunningDaemons();
  if (count <= limit) return;
  daemonLimitWarningIssued = true;
  process.stderr.write(
    `NMG: warning: ${count} NMG daemons running (limit ${limit}); ` +
      "raise NMG_DAEMON_LIMIT or stop stale daemons (`nmg daemon stop --data-dir <dir>`)\n",
  );
}

async function authenticatedDaemonAlive(state: ServerState): Promise<boolean> {
  return await new Promise<boolean>((resolveAlive) => {
    const timeout = setTimeout(() => resolveAlive(false), 250);
    void httpCall(state, "hello").then(
      () => {
        clearTimeout(timeout);
        resolveAlive(true);
      },
      () => {
        clearTimeout(timeout);
        resolveAlive(false);
      },
    );
  });
}

function daemonLimit(): number {
  return integerEnvironment("NMG_DAEMON_LIMIT", DEFAULT_DAEMON_LIMIT);
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

let memoizedDaemonCount: { key: string; at: number; count: number } | undefined;
let daemonLimitWarningIssued = false;

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
