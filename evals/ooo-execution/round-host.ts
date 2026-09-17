/**
 * The host half of a round's board: it serves an existing round store over the daemon transport, so
 * the drivers - separate processes - reach it as clients instead of opening the file.
 *
 * This is the same composition the product daemon uses (`NmgService` + `serveHttp` + the store's
 * lease), and it is deliberately the *only* writer of that store while it runs: a round that both
 * served its store and wrote it from another connection would be the two-writer shape the design
 * rules out.
 *
 * Two ways to run it, and the difference matters:
 *
 *  - `serveRoundStore` hosts in this process, for a caller that also *calls* the round entry
 *    in-process (`host.call(...)`) - the design's offline-host shape. Such a process must not call
 *    its own endpoint over HTTP: `round-client.ts` refuses that by the lease's pid, because a blocked
 *    host cannot answer itself.
 *  - `--store <path>` hosts as its own process, which is what a client that wants the wire needs
 *    (the test that proves the drivers work does exactly this). Its idle timeout is a backstop, so a
 *    host whose test died still exits instead of holding the store and the lease forever.
 *
 * `close()` asks the served endpoint to shut down, waits for it, and then closes the service.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { httpCall } from "../../src/cli/http-client.ts";
import { serveHttp } from "../../src/cli/http-server.ts";
import {
  acquireServerLease,
  readServerState,
  serverStatePath,
  type ServerState,
} from "../../src/cli/lifecycle.ts";
import { NmgService } from "../../src/cli/service.ts";
import type { NmgMethod, NmgMethodResult } from "../../src/cli/protocol.ts";

export interface RoundHost {
  databasePath: string;
  /** The endpoint as published on the store's lease; throws until it is published. */
  state(): ServerState;
  /** This host's own call path: the round entry in-process, never the endpoint it serves. */
  call<M extends NmgMethod>(method: M, params?: unknown): Promise<NmgMethodResult[M]>;
  /** Resolves when the endpoint stops - its idle timeout, or a `shutdown` call. */
  closed: Promise<void>;
  close(): Promise<void>;
}

const PUBLISH_TIMEOUT_MS = 10_000;

export async function serveRoundStore(
  databasePath: string,
  options: { idleTimeoutMs?: number } = {},
): Promise<RoundHost> {
  const service = new NmgService({ databasePath, environment: {} });
  const lease = acquireServerLease(databasePath);
  const served = serveHttp(service, lease, { idleTimeoutMs: options.idleTimeoutMs ?? 0 });
  const state = () => {
    const current = readServerState(serverStatePath(databasePath));
    if (!current?.port) {
      throw new Error(`the round host has not published an endpoint for ${databasePath} yet`);
    }
    return current;
  };

  // serveHttp publishes the endpoint after it listens, so a caller that raced it would see a lease
  // without a port. Wait for the port rather than guess how long listen takes.
  const deadline = Date.now() + PUBLISH_TIMEOUT_MS;
  while (!readServerState(serverStatePath(databasePath))?.port && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return {
    databasePath,
    state,
    call: (method, params) => service.invoke(method, params),
    closed: served,
    close: async () => {
      try {
        await httpCall(state(), "shutdown");
      } catch {
        // A host whose endpoint is already gone still has to release the service and the lease.
      }
      await served;
      service.close();
    },
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { store: { type: "string" }, "idle-ms": { type: "string" } },
  });
  if (!values.store) throw new Error("--store is required: the round store this host serves");
  // A host run as its own process is what a client that wants the wire needs. The idle timeout is the
  // backstop: a host whose owner died still exits rather than holding the store and its lease.
  const idleMs = Number(values["idle-ms"] ?? 120_000);
  const host = await serveRoundStore(values.store, { idleTimeoutMs: idleMs });
  const stop = () => void host.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.write(`[host] serving ${host.databasePath} on pid ${process.pid}\n`);
  await host.closed;
  await host.close();
}
