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
 * The daemon is resolved from the store's own lease (`<store>.server.json`), which is how the product
 * discovers a daemon too. There is deliberately no fallback: when nothing serves the store this
 * refuses by name, because "open the file instead" is the defect this module exists to remove.
 */
import { httpCall } from "../../src/cli/http-client.ts";
import { readServerState, serverStatePath, type ServerState } from "../../src/cli/lifecycle.ts";
import type {
  NmgMethodResult,
  NmgTaskBoardParams,
  NmgTaskRunParams,
} from "../../src/cli/protocol.ts";

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
): Promise<NmgMethodResult["taskBoard"]> {
  return (await httpCall(state, "taskBoard", params)) as NmgMethodResult["taskBoard"];
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
): Promise<NmgMethodResult["taskRun"]> {
  return (await httpCall(state, "taskRun", params)) as NmgMethodResult["taskRun"];
}
