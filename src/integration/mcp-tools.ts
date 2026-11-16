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
  type AdapterToolBindings,
  type SharedAdapterTool,
} from "./adapter-capability-assembly.ts";
import { ADAPTER_CAPABILITY_CATALOG } from "./adapter-capability-catalog.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadPrompts } from "../prompts/load.ts";
import { coordinationEnabled } from "./config.ts";
import { COMMON_REMEMBER_ACTIONS, supportedRememberActions } from "./tool-contract.ts";
import { renderRememberSurface } from "./agent-surface.ts";
import type { MemoryContext } from "../core/types.ts";

const nmgPrompts = loadPrompts();

const MEMORY_TYPES = ["constraint", "event", "fact", "preference", "state", "strategy"] as const;
const ACTORS = ["assistant", "system", "tool", "user"] as const;
const TRUTH = ["asserted", "inferred", "unverified", "verified"] as const;
const EVIDENCE_ROLES = [
  "contradict",
  "example",
  "exception",
  "origin",
  "support",
  "update",
] as const;

const rememberSchema = {
  action: z
    .enum(COMMON_REMEMBER_ACTIONS)
    .default("save")
    .describe(nmgPrompts.mcp_remember_action_parameter_description),
  memoryId: z.string().optional().describe(nmgPrompts.remember_memory_id_parameter_description),
  newMemoryId: z
    .string()
    .optional()
    .describe(nmgPrompts.remember_new_memory_id_parameter_description),
  supersededMemoryId: z
    .string()
    .optional()
    .describe(nmgPrompts.remember_superseded_memory_id_parameter_description),
  relatedMemoryId: z
    .string()
    .optional()
    .describe(nmgPrompts.remember_related_memory_id_parameter_description),
  relationJudgement: z
    .enum(["conflict", "distinct", "refines", "related", "same_entity"])
    .optional()
    .describe(nmgPrompts.remember_relation_judgement_parameter_description),
  relationConfidence: z.number().min(0).max(1).optional(),
  resolutionReason: z.string().optional(),
  relatedMemoryIds: z.array(z.string()).optional(),
  activeGraphId: z
    .string()
    .optional()
    .describe(nmgPrompts.mcp_active_graph_id_parameter_description),
  taskSuccess: z.boolean().optional().describe(nmgPrompts.feedback_label_parameter_description),
  userCorrection: z.boolean().optional().describe(nmgPrompts.feedback_label_parameter_description),
  evidenceSufficient: z
    .boolean()
    .optional()
    .describe(nmgPrompts.feedback_label_parameter_description),
  expansionUseful: z.boolean().optional().describe(nmgPrompts.feedback_label_parameter_description),
  excessiveNoise: z.boolean().optional().describe(nmgPrompts.feedback_label_parameter_description),
  noMemoryNeeded: z.boolean().optional().describe(nmgPrompts.feedback_label_parameter_description),
  memoryMisleading: z
    .boolean()
    .optional()
    .describe(nmgPrompts.feedback_misleading_parameter_description),
  feedbackNote: z.string().optional().describe(nmgPrompts.feedback_note_parameter_description),
  semanticTaskId: z.string().optional().describe(nmgPrompts.semantic_task_id_parameter_description),
  claimOutcome: z
    .enum(["supported", "contradicted"])
    .optional()
    .describe(nmgPrompts.claim_outcome_parameter_description),
  claimSourceLineage: z
    .string()
    .optional()
    .describe(nmgPrompts.claim_source_lineage_parameter_description),
  claimIndexes: z
    .array(z.number().int().min(0))
    .optional()
    .describe(nmgPrompts.claim_indexes_parameter_description),
  claimWeight: z.number().gt(0).max(1).optional(),
  statement: z.string().optional().describe("Self-contained semantic statement"),
  nodeName: z.string().optional().describe(nmgPrompts.node_name_parameter_description),
  memoryType: z.enum(MEMORY_TYPES).optional(),
  recallTriggers: z
    .array(z.string().min(1).max(80))
    .max(16)
    .optional()
    .describe(nmgPrompts.recall_triggers_parameter_description),
  stateKey: z.string().optional(),
  eventTime: z.string().optional(),
  referenceTime: z
    .string()
    .optional()
    .describe("Source ISO timestamp with Z/offset anchoring eventTime, for historical replay."),
  timeZone: z
    .string()
    .optional()
    .describe("Source IANA time zone; defaults to referenceTime's offset."),
  sourceActor: z.enum(ACTORS).optional(),
  truthStatus: z.enum(TRUTH).optional(),
  evidence: z.string().optional(),
  evidenceRole: z.enum(EVIDENCE_ROLES).optional(),
  tier: z.number().int().min(0).max(3).optional(),
  importance: z.number().min(0).max(1).optional(),
  scope: z.record(z.string(), z.string()).optional(),
  residence: z.enum(["ltg", "stg"]).optional(),
  writeReason: z.string().optional(),
  boardSource: z
    .object({
      taskId: z.string().describe("Task board channel the content came from"),
      entryId: z.string().describe("Task board entry the content came from"),
    })
    .optional()
    .describe(nmgPrompts.remember_board_source_parameter_description),
};
type RememberParams = z.infer<z.ZodObject<typeof rememberSchema>>;
type McpInvoke = (method: NmgMethod, params: Record<string, unknown>) => Promise<unknown>;

async function recordFeedback(params: RememberParams, sessionId: string, invoke: McpInvoke) {
  const labels = {
    taskSuccess: params.taskSuccess,
    userCorrection: params.userCorrection,
    evidenceSufficient: params.evidenceSufficient,
    expansionUseful: params.expansionUseful,
    excessiveNoise: params.excessiveNoise,
    noMemoryNeeded: params.noMemoryNeeded,
    memoryMisleading: params.memoryMisleading,
    note: params.feedbackNote,
  };
  if (!params.activeGraphId?.trim())
    throw new Error("action=feedback requires activeGraphId from the rated recall");
  if (Object.values(labels).every((value) => value === undefined))
    throw new Error("action=feedback requires at least one label or feedbackNote");
  const result = await invoke("recordFeedback", {
    activeGraphId: params.activeGraphId,
    sessionId,
    ...labels,
  });
  return {
    content: [
      { type: "text" as const, text: `Retrieval feedback processed. ${JSON.stringify(result)}` },
    ],
  };
}

async function claimOutcome(params: RememberParams, sessionId: string, invoke: McpInvoke) {
  if (
    !params.memoryId ||
    !params.claimOutcome ||
    !params.semanticTaskId?.trim() ||
    !params.claimSourceLineage?.trim()
  ) {
    throw new Error(
      "action=claim_outcome requires memoryId, claimOutcome, semanticTaskId, and claimSourceLineage",
    );
  }
  const result = await invoke("recordClaimOutcomes", {
    semanticTaskId: params.semanticTaskId,
    activeGraphId: params.activeGraphId,
    sessionId: sessionId,
    collectionOrigin: "natural",
    votes: [
      {
        memoryId: params.memoryId,
        claimIndexes: params.claimIndexes,
        outcome: params.claimOutcome,
        source: "task",
        sourceLineage: params.claimSourceLineage,
        weight: params.claimWeight,
      },
    ],
  });
  return {
    content: [
      {
        type: "text" as const,
        text: `Task-attributed claim outcome recorded. ${JSON.stringify(result)}`,
      },
    ],
  };
}

async function forgetMemory(params: RememberParams, sessionId: string, invoke: McpInvoke) {
  if (!params.memoryId) throw new Error("action=forget requires memoryId");
  const result = await invoke("resolveRemember", {
    action: "forget",
    memoryId: params.memoryId,
    sessionId: sessionId,
  });
  return {
    content: [
      {
        type: "text" as const,
        text: `Memory withdrawn from normal retrieval. ${JSON.stringify(result)}`,
      },
    ],
  };
}

async function resolveMemory(params: RememberParams, sessionId: string, invoke: McpInvoke) {
  if (!params.memoryId) throw new Error(`action=${params.action} requires memoryId`);
  const result = await invoke("resolveRemember", {
    action: params.action,
    memoryId: params.memoryId,
    relatedMemoryIds: params.relatedMemoryIds,
    reason: params.resolutionReason,
    sessionId: sessionId,
  });
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

async function supersedeMemory(params: RememberParams, sessionId: string, invoke: McpInvoke) {
  if (!params.newMemoryId || !params.supersededMemoryId) {
    throw new Error("action=supersede requires newMemoryId and supersededMemoryId");
  }
  const result = await invoke("resolveRemember", {
    action: "supersede",
    newMemoryId: params.newMemoryId,
    supersededMemoryId: params.supersededMemoryId,
    reason: params.resolutionReason,
    sessionId: sessionId,
  });
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

async function relateMemory(params: RememberParams, sessionId: string, invoke: McpInvoke) {
  if (!params.newMemoryId || !params.relatedMemoryId || !params.relationJudgement) {
    throw new Error("action=relate requires newMemoryId, relatedMemoryId, and relationJudgement");
  }
  const result = await invoke("resolveRemember", {
    action: "relate",
    newMemoryId: params.newMemoryId,
    relatedMemoryId: params.relatedMemoryId,
    relationJudgement: params.relationJudgement,
    confidence: params.relationConfidence,
    sessionId: sessionId,
  });
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

async function saveMemory(params: RememberParams, sessionId: string, invoke: McpInvoke) {
  if (!params.statement?.trim() || !params.nodeName?.trim()) {
    throw new Error("action=save requires statement and nodeName");
  }
  const boardSource = params.boardSource;
  const memory: Record<string, unknown> = { ...params };
  for (const key of [
    "action",
    "boardSource",
    "memoryId",
    "newMemoryId",
    "supersededMemoryId",
    "relatedMemoryId",
    "relationJudgement",
    "relationConfidence",
    "resolutionReason",
    "relatedMemoryIds",
    "activeGraphId",
    "semanticTaskId",
    "claimOutcome",
    "claimSourceLineage",
    "claimIndexes",
    "claimWeight",
    "taskSuccess",
    "userCorrection",
    "evidenceSufficient",
    "expansionUseful",
    "excessiveNoise",
    "noMemoryNeeded",
    "memoryMisleading",
    "feedbackNote",
  ]) {
    delete memory[key];
  }
  const r = (await invoke("remember", {
    ...memory,
    sessionId: sessionId,
    ...(boardSource
      ? {
          markers: [
            {
              kind: "board_origin",
              attributes: {
                taskId: boardSource.taskId,
                entryId: boardSource.entryId,
              },
            },
          ],
        }
      : {}),
  })) as Parameters<typeof renderRememberSurface>[0];
  return {
    content: [{ type: "text" as const, text: renderRememberSurface(r) }],
  };
}

export function createNmgMcpServer(options: NmgMcpOptions) {
  const scope = new AsyncLocalStorage<{ binding: McpSessionBinding; signal?: AbortSignal }>();
  const toolBindings: AdapterToolBindings = {};
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

  // ── nmg_remember ──

  toolBindings.nmg_remember = (endpoint) => {
    const registered = server.registerTool(
      "nmg_remember",
      {
        description: nmgPrompts.mcp_remember_description,
        inputSchema: {
          ...rememberSchema,
          action: z
            .enum(supportedRememberActions(endpoint?.methods))
            .default("save")
            .describe(nmgPrompts.mcp_remember_action_parameter_description),
        },
      },
      async (params, extra) =>
        withBinding(extra, async () => {
          const sessionId = binding().sessionId;
          switch (params.action) {
            case "feedback":
              return recordFeedback(params, sessionId, invoke);
            case "claim_outcome":
              return claimOutcome(params, sessionId, invoke);
            case "forget":
              return forgetMemory(params, sessionId, invoke);
            case "resolve":
            case "reopen":
              return resolveMemory(params, sessionId, invoke);
            case "supersede":
              return supersedeMemory(params, sessionId, invoke);
            case "relate":
              return relateMemory(params, sessionId, invoke);
            default:
              return saveMemory(params, sessionId, invoke);
          }
        }),
    );
    return () => registered.remove();
  };

  // ── Unified state and board identity ──

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
    { tools: toolBindings, registerTool },
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
