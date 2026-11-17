import { AsyncLocalStorage } from "node:async_hooks";
import type { AdapterCapability, AdapterEndpoint } from "./adapter-capability-assembly.ts";
import type { NmgMethod } from "../cli/protocol.ts";

export interface McpSessionBinding {
  sessionId: string;
  agentId: string;
  projectDir?: string;
}
export interface NmgMcpOptions {
  resolveBinding: (
    metadata: Record<string, unknown> | undefined,
  ) => McpSessionBinding | Promise<McpSessionBinding>;
  invoke: (
    method: NmgMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  capabilities?: readonly AdapterCapability[];
  endpoint?: AdapterEndpoint;
  onContext?: (binding: McpSessionBinding, context: MemoryContext) => Promise<void>;
}
import {
  assembleAdapterCapabilities,
  disabledBoardCapability,
  type SharedAdapterTool,
} from "./adapter-capability-assembly.ts";
import { ADAPTER_CAPABILITY_CATALOG } from "./adapter-capability-catalog.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadPrompts } from "../prompts/load.ts";
import { coordinationEnabled } from "./config.ts";
import type { MemoryContext } from "../core/types.ts";

const nmgPrompts = loadPrompts();

export function createNmgMcpServer(options: NmgMcpOptions) {
  const scope = new AsyncLocalStorage<{ binding: McpSessionBinding; signal?: AbortSignal }>();
  const binding = () => {
    const active = scope.getStore()?.binding;
    if (!active) throw new Error("NMG MCP request has no host session binding");
    return active;
  };
  const invoke = (method: NmgMethod, params: Record<string, unknown>) => {
    scope.getStore()?.signal?.throwIfAborted();
    const projectDir = scope.getStore()?.binding.projectDir;
    const scoped =
      projectDir &&
      ["search", "get", "remember", "resolveRemember", "recordClaimOutcomes"].includes(method) &&
      (options.endpoint?.searchParameters?.includes("projectDir") ?? true)
        ? { ...params, projectDir }
        : params;
    return options.invoke(method, scoped, scope.getStore()?.signal);
  };
  const withBinding = async <T>(
    extra: { _meta?: Record<string, unknown>; signal: AbortSignal },
    run: () => Promise<T>,
  ) => {
    const bound = await options.resolveBinding(extra._meta);
    extra.signal.throwIfAborted();
    return scope.run({ binding: bound, signal: extra.signal }, run);
  };
  const server = new McpServer(
    { name: "nmg-memory", version: "0.1.0" },
    {
      instructions: nmgPrompts.memory_policy,
    },
  );

  // Presence follows the adapter-supplied request binding, including multiplexed hosts.
  const BOARD_AGENT_CAPABILITIES = process.env.NMG_AGENT_CAPABILITIES?.trim() || undefined;
  const lastBoardHeartbeatAt = new Map<string, number>();

  async function registerBoardAgent(): Promise<void> {
    await invoke("taskBoard", {
      action: "registerAgent",
      id: binding().agentId,
      agentName: binding().agentId,
      capabilities: BOARD_AGENT_CAPABILITIES,
      supportedInterfaces: "mcp",
    });
    lastBoardHeartbeatAt.set(binding().agentId, Date.now());
  }

  async function heartbeatBoardAgent(): Promise<void> {
    const previous = lastBoardHeartbeatAt.get(binding().agentId);
    if (previous === undefined) return registerBoardAgent();
    if (Date.now() - previous < 60_000) return;
    await invoke("taskBoard", {
      action: "heartbeat",
      id: binding().agentId,
    });
    lastBoardHeartbeatAt.set(binding().agentId, Date.now());
  }

  const agentNames = new Map<string, string>();
  function registerTool(tool: SharedAdapterTool) {
    const schema = z.fromJSONSchema(
      tool.inputSchema as unknown as Parameters<typeof z.fromJSONSchema>[0],
    );
    const registered = server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: schema },
      async (params, extra) =>
        withBinding(extra, async () => {
          const { sessionId, agentId } = binding();
          const output = await tool.execute(params as Record<string, unknown>, {
            sessionId,
            requester: `agent:mcp:${agentId}`,
            invoke,
            memory: {
              search: {
                beginDisclosureTurn: true,
                onSearch: async ({ disclosed }) => {
                  await options.onContext?.(binding(), disclosed).catch(() => undefined);
                },
              },
              onEvidenceDisclosed: async (_request, context) => {
                await options.onContext?.(binding(), context).catch(() => undefined);
              },
            },
            boardReads: "receipt",
            boardIdentity: async () => {
              await heartbeatBoardAgent();
              return {
                id: agentId,
                agentName: agentNames.get(agentId) ?? agentId,
                saveName: (name) => {
                  agentNames.set(agentId, name);
                },
              };
            },
          });
          return { content: [{ type: "text" as const, text: output.text }] };
        }),
    );
    return () => registered.remove();
  }

  const assembly = assembleAdapterCapabilities(
    options.capabilities ?? ADAPTER_CAPABILITY_CATALOG.mcp.capabilities,
    { registerTool },
    { endpoint: options.endpoint, disabled: disabledBoardCapability(coordinationEnabled()) },
  );
  return {
    server,
    ready: assembly.ready,
    dispose: () => assembly.dispose(),
    registerPresence: (bound: McpSessionBinding) =>
      scope.run({ binding: bound }, registerBoardAgent),
  };
}
