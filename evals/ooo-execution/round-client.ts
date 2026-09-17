/**
 * The evidence drivers' thin adapter: they reach the round's board through the daemon that serves
 * it, never by opening the database themselves.
 *
 * The design fixes one writer per store. A round's store is served by its host (an `NmgService` on
 * the daemon transport), and the drivers - separate processes - are clients of that daemon. A driver
 * that opened `<runDir>/store.sqlite` directly would be a second writer, and a lifecycle write on a
 * managed entry would bypass the run's coordinated transition; the store's fence refuses such a
 * write, so the direct path cannot be the documented one either.
 *
 * Two pessimistic rules live here, both about the same failure: a process that serves an endpoint
 * cannot answer a call to it while it is blocked, so "the answer will come" is an assumption this
 * module refuses to make.
 *
 *  - The call has a bound. A client gives up with a message naming the bound and the reason to
 *    suspect, instead of the transport's own five-minute headers timeout - which is what a blocked
 *    host produces, and what made this failure take 305 seconds to read the first time.
 *  - A client never calls the endpoint it serves. The lease records the serving pid, so this is a
 *    fact rather than a guess; a host that wants to write its own store calls the round's entry
 *    in-process (see `round-host.ts`), which is the design's shape for an offline host.
 *
 * The daemon is resolved from the store's own lease (`<store>.server.json`), which is how the product
 * discovers a daemon too. There is deliberately no fallback: when nothing serves the store this
 * refuses by name, because "open the file instead" is the defect this module exists to remove.
 */
import { httpCall, TimeoutError } from "../../src/cli/http-client.ts";
import { readServerState, serverStatePath, type ServerState } from "../../src/cli/lifecycle.ts";
import type {
  NmgMethodResult,
  NmgTaskBoardParams,
  NmgTaskRunParams,
} from "../../src/cli/protocol.ts";

/**
 * How long a round's board call may take.
 *
 * A board verb is a local SQLite write, so seconds are already generous; the point of the bound is
 * that a blocked host turns into a named failure in seconds rather than an opaque one in minutes.
 */
export const ROUND_CALL_TIMEOUT_MS = 30_000;

/**
 * The daemon serving this store, or a refusal naming what is missing.
 *
 * `readServerState` is a read of the lease file, not a spawn: a research round's store is served by
 * the round host, and a driver must not start a second daemon on it.
 */
export function roundDaemon(databasePath: string): ServerState {
  const state = readServerState(serverStatePath(databasePath));
  if (!state || state.transport !== "http" || !state.host || !state.port || !state.token) {
    throw new Error(
      `no daemon is serving ${databasePath}: start the round host for that store and pass --daemon ` +
        "with the store it serves (a driver does not open a database of its own)",
    );
  }
  if (state.pid === process.pid) {
    throw new Error(
      `this process is the one serving ${databasePath}; a host calls the round's entry in-process ` +
        "instead of over HTTP, because it cannot answer itself while it is blocked",
    );
  }
  return state;
}

/**
 * One board write or read, as the daemon's protocol defines it.
 *
 * The result is the protocol's own union rather than the store's return type, so a driver narrows by
 * `action` and gets the same fields a daemon client gets - there is no second shape for the harness.
 */
export async function boardCall(
  state: ServerState,
  params: NmgTaskBoardParams,
  options: { timeoutMs?: number } = {},
): Promise<NmgMethodResult["taskBoard"]> {
  return (await call(
    state,
    "taskBoard",
    params,
    options.timeoutMs,
  )) as NmgMethodResult["taskBoard"];
}

/**
 * One transition of a run, as the daemon's protocol defines it.
 *
 * The round's own record is written through this and not through the store: registering the run,
 * freezing its plan and adopting the entries it carries are the runner's acts, and they belong to the
 * daemon that owns the store for the same reason the board verbs do.
 */
export async function runCall(
  state: ServerState,
  params: NmgTaskRunParams,
  options: { timeoutMs?: number } = {},
): Promise<NmgMethodResult["taskRun"]> {
  return (await call(state, "taskRun", params, options.timeoutMs)) as NmgMethodResult["taskRun"];
}

async function call(
  state: ServerState,
  method: "taskBoard" | "taskRun",
  params: unknown,
  timeoutMs = ROUND_CALL_TIMEOUT_MS,
): Promise<unknown> {
  try {
    return await httpCall(state, method, params, { timeoutMs });
  } catch (error) {
    if (!(error instanceof TimeoutError)) throw error;
    throw new Error(
      `${error.message}: ${state.host}:${state.port} is served by pid ${state.pid}, and a host that is ` +
        "blocked - a synchronous wait in that process - cannot answer, so check the host rather than " +
        "retrying",
      { cause: error },
    );
  }
}
