import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNmgMcpServer } from "../src/integration/mcp-tools.ts";
import { ADAPTER_CAPABILITY_CATALOG } from "../src/integration/adapter-capability-catalog.ts";
import {
  compatibleLease,
  dropCompatibleLease,
  rpcCall,
} from "../src/integration/lease-transport.ts";
import { resolveNmgDataDir } from "../src/cli/data-path.ts";
import { CodexSessionStore } from "./session-store.ts";
import { codexMcpBinding, type CodexBinding } from "./session.ts";
import { CodexTurnTraces } from "./turn-traces.ts";
import { CodexHook } from "./hook.ts";

const declared = ADAPTER_CAPABILITY_CATALOG.codex.capabilities;
const toolCapabilities = new Set(["memory-tools", "state-tool", "lab-tools"]);

export function createCodexAdapter(dataDirectory = resolveNmgDataDir()) {
  const sessions = new CodexSessionStore(dataDirectory);
  const traces = new CodexTurnTraces(dataDirectory);
  const invoke = async (method: string, params: unknown, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const lease = await compatibleLease(dataDirectory);
    if (!lease)
      throw new Error(
        "NMG daemon is unavailable or incompatible; start the NMG daemon before using the Codex plugin",
      );
    try {
      return await rpcCall(lease, method, params, signal);
    } catch (error) {
      dropCompatibleLease(dataDirectory);
      throw error;
    }
  };
  return {
    mcp: () =>
      createNmgMcpServer({
        capabilities: declared.filter((capability) => toolCapabilities.has(capability)),
        resolveBinding: (metadata) => sessions.resolve(codexMcpBinding(metadata)),
        onContext: (binding, context) => traces.note(binding as CodexBinding, context),
        invoke,
      }),
    hook: (writeOutput: (text: string) => Promise<void>) => {
      const deadline = AbortSignal.timeout(4000);
      return new CodexHook(
        {
          dataDirectory,
          writeOutput,
          invoke: (method, params, signal) =>
            invoke(method, params, signal ? AbortSignal.any([signal, deadline]) : deadline),
        },
        declared.filter((capability) => !toolCapabilities.has(capability)),
      );
    },
  };
}

export async function main(mode = process.argv[2]): Promise<void> {
  const adapter = createCodexAdapter();
  if (mode === "mcp") {
    const mcp = adapter.mcp();
    await mcp.ready;
    await mcp.server.connect(new StdioServerTransport());
    return;
  }
  if (mode !== "hook") throw new Error("Usage: nmg.mjs mcp|hook");
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 8_000_000) throw new Error("Codex hook input exceeded its limit");
    }
    const hook = adapter.hook(
      (text) =>
        new Promise<void>((done, reject) =>
          process.stdout.write(text, (error) => (error ? reject(error) : done())),
        ),
    );
    await hook.run(JSON.parse(input || "{}") as Record<string, unknown>);
  } catch (error) {
    process.stderr.write(
      String(`NMG Codex hook skipped: ${error instanceof Error ? error.message : String(error)}`) +
        "\n",
    );
  }
}
