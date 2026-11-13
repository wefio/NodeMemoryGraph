import { AsyncLocalStorage } from "node:async_hooks";
import type { AdapterCapability } from "./adapter-capability-assembly.ts";
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
}
import {
  assembleAdapterCapabilities,
  type AdapterToolBindings,
} from "./adapter-capability-assembly.ts";
import { ADAPTER_CAPABILITY_CATALOG } from "./adapter-capability-catalog.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadPrompts, renderDisclosure } from "../prompts/load.ts";
import { coordinationEnabled } from "./config.ts";
import { renderLabOutput } from "./lab-capabilities.ts";
import {
  STATE_OPERATIONS,
  stateOperation,
  renderStateOutput,
  captureStateInvocation,
} from "./state.ts";
import type { NmgStateResult } from "../cli/protocol.ts";
import { memoryDisclosureEntries } from "./search-projection.ts";
import { COMMON_REMEMBER_ACTIONS } from "./tool-contract.ts";
import { searchParameterDescription } from "./tool-contract.ts";
import {
  renderEvidenceSurface,
  renderRememberSurface,
  renderSearchSurface,
} from "./agent-surface.ts";
import { WORLD_BOARD_ID, type MemoryContext } from "../core/types.ts";

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
      projectDir && ["search", "get", "remember", "resolveRemember"].includes(method)
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

  // ── nmg_search ──

  toolBindings.nmg_search = () => {
    const registered = server.registerTool(
      "nmg_search",
      {
        description: nmgPrompts.search_description,
        inputSchema: {
          query: z.string().describe("Focused recall query"),
          recallCue: z
            .string()
            .optional()
            .describe(nmgPrompts.search_recall_cue_parameter_description),
          recallRevision: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(nmgPrompts.search_recall_revision_parameter_description),
          limit: z.number().int().min(1).max(50).default(8),
          maxTier: z.number().int().min(0).max(3).optional(),
          graphHops: z.number().int().min(0).max(3).optional(),
          nodeName: z.string().optional(),
          sourceActor: z.enum(["user", "assistant", "system", "tool"]).optional(),
          includeHistorical: z.boolean().optional(),
          scope: z.record(z.string(), z.string()).optional(),
          eventTimeFrom: z
            .string()
            .optional()
            .describe(searchParameterDescription("eventTimeFrom")),
          eventTimeTo: z.string().optional().describe(searchParameterDescription("eventTimeTo")),
          secondPass: z.boolean().optional(),
        },
      },
      async (params, extra) =>
        withBinding(extra, async () => {
          // An explicit preparation must survive until its piggybacked search.
          if (params.recallRevision === undefined) {
            await invoke("sessionActiveGraph", {
              action: "beginDisclosureTurn",
              sessionId: binding().sessionId,
            }).catch(() => undefined);
          }
          const r = (await invoke("search", {
            ...params,
            sessionId: binding().sessionId,
          })) as MemoryContext;
          const disclosed = await discloseContext(r, "header");
          return {
            content: [
              {
                type: "text" as const,
                text: searchH(disclosed.context, disclosed.foldedMemoryIds),
              },
            ],
          };
        }),
    );
    return () => registered.remove();
  };

  // ── nmg_get ──

  toolBindings.nmg_get = () => {
    const registered = server.registerTool(
      "nmg_get",
      {
        description: nmgPrompts.get_description,
        inputSchema: {
          memoryIds: z.array(z.string()).min(1).max(50).describe("Memory IDs from nmg_search"),
          graphHops: z.number().int().min(0).max(3).optional(),
          activeGraphId: z
            .string()
            .optional()
            .describe(nmgPrompts.mcp_active_graph_id_parameter_description),
        },
      },
      async (params, extra) =>
        withBinding(extra, async () => {
          const r = (await invoke("get", {
            ...params,
            sessionId: binding().sessionId,
          })) as MemoryContext & {
            missingMemoryIds?: string[];
          };
          const disclosed = await discloseContext(r, "evidence", params.activeGraphId);
          return {
            content: [
              {
                type: "text" as const,
                text: memText(disclosed.context, disclosed.foldedMemoryIds),
              },
            ],
          };
        }),
    );
    return () => registered.remove();
  };

  // ── nmg_remember ──

  toolBindings.nmg_remember = () => {
    const registered = server.registerTool(
      "nmg_remember",
      {
        description: nmgPrompts.mcp_remember_description,
        inputSchema: rememberSchema,
      },
      async (params, extra) =>
        withBinding(extra, async () => {
          const sessionId = binding().sessionId;
          switch (params.action) {
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

  toolBindings.nmg_lab = () => {
    const registered = server.registerTool(
      "nmg_lab",
      {
        description: nmgPrompts.lab_description,
        inputSchema: {
          action: z.enum(["list", "status", "enable", "disable", "invoke"]),
          capability: z
            .enum([
              "reasoning_workspace",
              "recall_gate",
              "memory_graph_reasoner",
              "controller_shadow",
              "controller_controlled",
              "controller_active",
            ])
            .optional(),
          reason: z.string().optional(),
          ttlSeconds: z.number().int().min(60).max(86_400).optional(),
          operation: z.string().optional(),
          input: z.unknown().optional(),
        },
      },
      async (params, extra) =>
        withBinding(extra, async () => {
          if (params.action !== "list" && !params.capability)
            throw new Error(`${params.action} requires capability`);
          if (params.action === "enable" && !params.reason)
            throw new Error("enable requires reason");
          if (params.action === "invoke" && !params.operation)
            throw new Error("invoke requires operation");
          const result = await invoke("lab", {
            ...params,
            sessionId: binding().sessionId,
            scope: params.action === "enable" ? "session" : undefined,
            requester: params.action === "enable" ? `agent:mcp:${binding().agentId}` : undefined,
          });
          return { content: [{ type: "text" as const, text: renderLabOutput(result) }] };
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

  toolBindings.nmg_state = () => {
    const registered = server.registerTool(
      "nmg_state",
      {
        description: nmgPrompts.state_description,
        inputSchema: {
          action: z.enum(["read", "write"]),
          space: z.enum(["ag", "board"]),
          operation: z.enum(STATE_OPERATIONS).optional(),
          notification: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Explicit notice: key, scopes [direct|channel|event], optional recipients (stable IDs), invite:true enrolls invitees and sender in taskId; reuse key for retries.",
            ),
          eventId: z.string().optional(),
          event: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Event create/mutation payload; mutations require expectedRevision, kind and text.",
            ),
          activity: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Session processing report for agentActivity: state busy/idle/unknown, optional capabilities and ttlSeconds.",
            ),
          text: z.string().optional(),
          agentName: z.string().optional(),
          taskId: z.string().optional().describe(nmgPrompts.board_task_id_parameter_description),
          content: z.string().optional().describe(nmgPrompts.board_content_parameter_description),
          kind: z
            .enum(["blocker", "decision", "goal", "handoff", "note", "question", "result"])
            .optional(),
          entryId: z.string().optional(),
          resolution: z.string().optional(),
          reason: z.string().optional(),
          digest: z
            .string()
            .optional()
            .describe("deliver only: the sha256 identity of the artifact being handed in"),
          ref: z.string().optional().describe("deliver only: where the artifact can be read"),
          summary: z
            .string()
            .optional()
            .describe("deliver only: what the artifact contains, in one line"),
          verdict: z
            .enum(["accepted", "rejected", "undecidable"])
            .optional()
            .describe("judge only: your ruling on someone else's deliverable"),
          leaseSeconds: z.number().int().min(60).max(86_400).optional(),
          afterCursor: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),
          includeResolved: z.boolean().optional(),
          ttlSeconds: z.number().int().min(60).max(2_592_000).optional(),
          to: z
            .string()
            .optional()
            .describe("Stable agent name returned by discover for directed put"),
          capabilities: z.string().optional().describe("Capability substring used by discover"),
        },
      },
      async (params, extra) =>
        withBinding(extra, async () => {
          const operation = stateOperation(params);
          if (params.space === "ag") {
            const captured = await captureStateInvocation(
              {
                action: params.action,
                space: "ag",
                operation,
                text: params.text,
                reason: params.reason,
                ttlSeconds: params.ttlSeconds,
                sessionId: binding().sessionId,
                requester: `agent:mcp:${binding().agentId}`,
              },
              (sessionId) =>
                invoke("state", { action: "read", space: "ag", operation: "status", sessionId }),
            );
            const result = (await invoke("state", captured)) as NmgStateResult;
            return { content: [{ type: "text" as const, text: renderStateOutput(result) }] };
          }
          if (!coordinationEnabled()) throw new Error("Board coordination is disabled");
          await heartbeatBoardAgent();
          const result = (await invoke("state", {
            ...params,
            operation,
            taskId: params.taskId?.trim() || WORLD_BOARD_ID,
            agentId: binding().agentId,
            id: binding().agentId,
            agentName: params.agentName ?? binding().agentId,
            sourceSessionId: binding().sessionId,
            sessionId: binding().sessionId,
          })) as NmgStateResult;
          await receiptBoardRead(result.result);
          return { content: [{ type: "text" as const, text: renderStateOutput(result) }] };
        }),
    );
    return () => registered.remove();
  };

  async function receiptBoardRead(result: NmgStateResult["result"]): Promise<void> {
    if (result.action !== "read") return;
    const receipts = result.entries
      .filter(
        (entry) =>
          entry.status === "open" &&
          entry.sourceSessionId !== binding().sessionId &&
          !(entry.sourceSessionId == null && entry.agentId === binding().agentId),
      )
      .map((entry) =>
        invoke("taskBoard", {
          action: "recordDelivery",
          entryId: entry.id,
          sessionId: binding().sessionId,
          agentId: binding().agentId,
          source: "read",
        }),
      );
    await Promise.allSettled(receipts);
  }

  // ── Compact formatters ──

  async function discloseContext(
    context: MemoryContext,
    disclosure: "header" | "evidence",
    projectionId = context.activeGraph?.id,
  ): Promise<{ context: MemoryContext; foldedMemoryIds: string[] }> {
    const rawDecision = (await invoke("sessionActiveGraph", {
      action: "disclose",
      sessionId: binding().sessionId,
      projectionId,
      disclosure,
      entries: memoryDisclosureEntries(context, disclosure),
    }).catch(() => null)) as {
      freshMemoryIds?: unknown;
      foldedMemoryIds?: unknown;
    } | null;
    const freshMemoryIds = Array.isArray(rawDecision?.freshMemoryIds)
      ? rawDecision.freshMemoryIds
      : context.results.map((result) => result.memory.id);
    const foldedMemoryIds = Array.isArray(rawDecision?.foldedMemoryIds)
      ? rawDecision.foldedMemoryIds
      : [];
    const freshIds = new Set(freshMemoryIds);
    return {
      context: {
        ...context,
        results: context.results.filter((result) => freshIds.has(result.memory.id)),
      },
      foldedMemoryIds,
    };
  }

  function foldedDisclosureText(memoryIds: string[]): string {
    if (memoryIds.length === 0) return "";
    return `${nmgPrompts.in_context_title}\n${memoryIds
      .map((id) => `- memory=${id}; already_in_context=true`)
      .join("\n")}`;
  }

  function searchH(r: MemoryContext, foldedMemoryIds: string[] = []): string {
    const deferred = r.progressiveDisclosure?.deferredMemoryIds;
    const nextStep =
      deferred && deferred.length > 0
        ? `${nmgPrompts.deferred_hint} Memory IDs: ${deferred.join(",")}`
        : nmgPrompts.get_hint;
    const forget = r.results.some(({ memory: m }) =>
      (m.markers ?? []).some((marker) => marker.kind === "forget"),
    );
    return [
      renderSearchSurface(r, {
        emptyText: "No NMG match.",
        preamble: renderDisclosure(nmgPrompts.search_disclosure, {}),
        postamble: renderDisclosure(nmgPrompts.search_disclosure_metadata, {
          count: String(r.results.length),
          next_step: nextStep,
          forget_hint: forget ? nmgPrompts.forget_hint : "",
        }),
      }),
      foldedDisclosureText(foldedMemoryIds),
    ]
      .filter(Boolean)
      .join("\n");
  }

  function memText(
    r: MemoryContext & { missingMemoryIds?: string[] },
    foldedMemoryIds: string[] = [],
  ): string {
    const forget = r.results.some(({ memory }) =>
      (memory.markers ?? []).some((marker) => marker.kind === "forget"),
    );
    return [
      renderEvidenceSurface(r, {
        preamble: renderDisclosure(nmgPrompts.get_disclosure, {}),
        postamble: renderDisclosure(nmgPrompts.get_disclosure_metadata, {
          count: String(r.results.length),
          next_step: "",
          forget_hint: forget ? nmgPrompts.forget_hint : "",
        }),
        missingMemoryIds: r.missingMemoryIds,
      }),
      foldedDisclosureText(foldedMemoryIds),
    ]
      .filter(Boolean)
      .join("\n");
  }

  const assembly = assembleAdapterCapabilities(
    options.capabilities ?? ADAPTER_CAPABILITY_CATALOG.mcp.capabilities,
    { tools: toolBindings },
  );
  return {
    server,
    ready: assembly.ready,
    dispose: () => assembly.dispose(),
    registerPresence: (bound: McpSessionBinding) =>
      scope.run({ binding: bound }, registerBoardAgent),
  };
}
