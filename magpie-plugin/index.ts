import { fileURLToPath } from "node:url";
import { resolveNmgDataDir } from "../src/cli/data-path.ts";
import { ADAPTER_CAPABILITY_CATALOG } from "../src/integration/adapter-capability-catalog.ts";
import {
  compatibleLease,
  dropCompatibleLease,
  rpcCall,
} from "../src/integration/lease-transport.ts";
import { MagpieRuntime } from "./runtime.ts";
import { MagpiePageService } from "./service.ts";
import { readMagpieOptions } from "./options.ts";
import type { MagpieHookContext, MagpieOptions } from "./types.ts";

const runtimes = new Map<string, MagpieRuntime>();
let page: { directory: string; port: number; service: MagpiePageService } | undefined;

function runtime(value: unknown): MagpieRuntime {
  const options = readMagpieOptions(value);
  const directory = options.dataDirectory ?? resolveNmgDataDir();
  const existing = runtimes.get(directory);
  if (existing) {
    existing.configure(options);
    return existing;
  }
  const invoke: ConstructorParameters<typeof MagpieRuntime>[1] = async (method, params, signal) => {
    signal?.throwIfAborted();
    const lease = await compatibleLease(directory);
    signal?.throwIfAborted();
    if (!lease) throw new Error("NMG daemon is unavailable or incompatible");
    try {
      return await rpcCall(lease, method, params, signal);
    } catch (error) {
      dropCompatibleLease(directory);
      throw error;
    }
  };
  const created = new MagpieRuntime(
    directory,
    invoke,
    ADAPTER_CAPABILITY_CATALOG.magpie.capabilities,
    options,
  );
  runtimes.set(directory, created);
  return created;
}

async function plugin(_input: unknown, options: MagpieOptions = {}) {
  const connection = runtime(options);
  await connection.ready;
  const directory = options.dataDirectory ?? resolveNmgDataDir();
  const port = options.port ?? 3487;
  if (page && (page.port !== port || page.directory !== directory)) {
    await page.service.close();
    page = undefined;
  }
  if (!page) {
    const service = new MagpiePageService(
      (method, params, signal) => connection.request(method, params, signal),
      fileURLToPath(new URL("./ui", import.meta.url)),
      port,
    );
    await service.start();
    page = { directory, port, service };
  }
  return { tool: connection.tools };
}

export default { id: "nmg", server: plugin };

export async function onRequest(body: Record<string, unknown>, ctx: MagpieHookContext) {
  return runtime(ctx.options).onRequest(body, ctx);
}

export async function onResponse(reply: unknown, ctx: MagpieHookContext): Promise<void> {
  await runtime(ctx.options).onResponse(reply, ctx);
}
