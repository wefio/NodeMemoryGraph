/**
 * The host half of a round's board: it serves an existing round store over the daemon transport, so
 * the drivers - separate processes - reach it as clients instead of opening the file.
 *
 * This is the same composition the product daemon uses (`NmgService` + `serveHttp` + the store's
 * lease), and it is deliberately the *only* writer of that store while it runs: a round that both
 * served its store and wrote it from the harness process would be the two-writer shape the design
 * rules out.
 *
 * `close()` asks the served endpoint to shut down, waits for it, and then closes the service; the
 * idle timeout is off by default, so a host lives until it is closed rather than racing the drivers.
 */
import { httpCall } from "../../src/cli/http-client.ts";
import { serveHttp } from "../../src/cli/http-server.ts";
import {
  acquireServerLease,
  readServerState,
  serverStatePath,
  type ServerState,
} from "../../src/cli/lifecycle.ts";
import { NmgService } from "../../src/cli/service.ts";

export interface RoundHost {
  databasePath: string;
  /** The endpoint as published on the store's lease; throws until it is published. */
  state(): ServerState;
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
