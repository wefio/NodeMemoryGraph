import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";

import { httpHandler } from "../../src/cli/http-server.ts";
import type { ServerState } from "../../src/cli/lifecycle.ts";
import { NMG_PROTOCOL_VERSION } from "../../src/cli/protocol.ts";
import { NmgService } from "../../src/cli/service.ts";
import { NmgStore } from "../../src/core/store.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

export interface TestWorkspace {
  path: string;
}

export interface TestDatabase {
  path: string;
  store: NmgStore;
}

export interface TestDaemon {
  state: ServerState;
}

export type TestPlugin = (context: Context, runtime: TestRuntime) => void | Promise<void>;

type DisposableFiber = { dispose(): Promise<void> };

/** Test-only composition root. Product code never depends on Cordis. */
export class TestRuntime {
  readonly #root = new Context();
  readonly #fibers: DisposableFiber[] = [];
  readonly #resources = new Map<symbol, unknown>();
  #disposed = false;

  async use(plugin: TestPlugin): Promise<void> {
    if (this.#disposed) throw new Error("TestRuntime is already disposed");
    const fiber = await this.#root.plugin((context) => plugin(context, this));
    this.#fibers.push(fiber);
  }

  provide<T>(key: symbol, value: T): void {
    if (this.#resources.has(key)) throw new Error("test resource is already provided");
    this.#resources.set(key, value);
  }

  require<T>(key: symbol, name: string): T {
    if (!this.#resources.has(key)) throw new Error(`${name} must be loaded first`);
    return this.#resources.get(key) as T;
  }

  workspace(): TestWorkspace {
    return this.require(WORKSPACE, "testWorkspace");
  }

  database(): TestDatabase {
    return this.require(DATABASE, "testDatabase");
  }

  daemon(): TestDaemon {
    return this.require(DAEMON, "testDaemon");
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const fiber of this.#fibers.reverse()) await fiber.dispose();
    this.#fibers.length = 0;
    this.#resources.clear();
    await this.#root.fiber.dispose();
  }
}

const WORKSPACE = Symbol("TestWorkspace");
const DATABASE = Symbol("TestDatabase");
const DAEMON = Symbol("TestDaemon");

export function testWorkspace(): TestPlugin {
  return (context, runtime) => {
    const path = mkdtempSync(join(tmpdir(), "nmg-test-runtime-"));
    runtime.provide(WORKSPACE, { path } satisfies TestWorkspace);
    context.effect(() => () => removeTempDirectory(path), "test-workspace");
  };
}

export function testDatabase(): TestPlugin {
  return (context, runtime) => {
    const workspace = runtime.workspace();
    const path = join(workspace.path, "nmg.sqlite");
    const store = new NmgStore(path);
    runtime.provide(DATABASE, { path, store } satisfies TestDatabase);
    context.effect(() => () => store.close(), "test-database");
  };
}

export function testDaemon(): TestPlugin {
  return async (context, runtime) => {
    const database = runtime.database();
    const service = new NmgService({ databasePath: database.path });
    const token = randomBytes(32).toString("base64url");
    let server!: Server;
    server = createServer(httpHandler(service, token, () => server.closeAllConnections?.()));
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test daemon did not bind TCP");
    runtime.provide(DAEMON, {
      state: {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        transport: "http",
        host: "127.0.0.1",
        port: address.port,
        token,
        protocol: NMG_PROTOCOL_VERSION,
      },
    } satisfies TestDaemon);
    context.effect(
      () => async () => {
        server.closeAllConnections?.();
        await close(server);
        service.close();
      },
      "test-daemon",
    );
  };
}

export async function withTestRuntime<T>(
  plugins: TestPlugin[],
  task: (runtime: TestRuntime) => T | Promise<T>,
): Promise<T> {
  const runtime = new TestRuntime();
  try {
    for (const plugin of plugins) await runtime.use(plugin);
    return await task(runtime);
  } finally {
    await runtime.dispose();
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
