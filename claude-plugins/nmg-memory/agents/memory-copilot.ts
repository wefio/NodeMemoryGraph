import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  connectDaemon,
  invokeDaemon,
  shutdownOwnedDaemon,
} from "../../../src/cli/daemon-client.ts";
import { resolveNmgDataDir } from "../../../src/cli/data-path.ts";
import { loadPrompts, renderDisclosure } from "../../../src/prompts/load.ts";
import { coordinationEnabled } from "../../../src/integration/config.ts";
import { renderLabOutput } from "../../../src/integration/lab-capabilities.ts";
import {
  STATE_OPERATIONS,
  stateOperation,
  renderStateOutput,
} from "../../../src/integration/state.ts";
import type { NmgStateResult } from "../../../src/cli/protocol.ts";
import { memoryDisclosureEntries } from "../../../src/integration/search-projection.ts";
import { COMMON_REMEMBER_ACTIONS } from "../../../src/integration/tool-contract.ts";
import {
  renderEvidenceSurface,
  renderRememberSurface,
  renderSearchSurface,
} from "../../../src/integration/agent-surface.ts";
import { WORLD_BOARD_ID, type MemoryContext } from "../../../src/core/types.ts";

const nmgPrompts = loadPrompts();

function dbPath(): string {
  return join(resolveNmgDataDir(), "nmg.sqlite");
}

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

const server = new McpServer(
  { name: "nmg-memory", version: "0.1.0" },
  {
    instructions: nmgPrompts.memory_policy,
  },
);

// ── nmg_search ──

server.registerTool(
  "nmg_search",
  {
    description: nmgPrompts.search_description,
    inputSchema: {
      query: z.string().describe("Focused recall query"),
      limit: z.number().int().min(1).max(50).default(8),
      maxTier: z.number().int().min(0).max(3).optional(),
      graphHops: z.number().int().min(0).max(3).optional(),
      nodeName: z.string().optional(),
      includeHistorical: z.boolean().optional(),
      secondPass: z.boolean().optional(),
    },
  },
  async (params) => {
    await invokeDaemon(connection, "sessionActiveGraph", {
      action: "beginDisclosureTurn",
      sessionId: BOARD_SESSION_ID,
    }).catch(() => undefined);
    const r = (await invokeDaemon(connection, "search", {
      ...params,
      sessionId: BOARD_SESSION_ID,
    })) as MemoryContext;
    const disclosed = await discloseContext(r, "header");
    return {
      content: [
        {
          type: "text",
          text: searchH(disclosed.context, disclosed.foldedMemoryIds),
        },
      ],
    };
  },
);

// ── nmg_get ──

server.registerTool(
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
  async (params) => {
    const r = (await invokeDaemon(connection, "get", {
      ...params,
      sessionId: BOARD_SESSION_ID,
    })) as MemoryContext & {
      missingMemoryIds?: string[];
    };
    const disclosed = await discloseContext(r, "evidence", params.activeGraphId);
    return {
      content: [
        {
          type: "text",
          text: memText(disclosed.context, disclosed.foldedMemoryIds),
        },
      ],
    };
  },
);

// ── nmg_remember ──

server.registerTool(
  "nmg_remember",
  {
    description: nmgPrompts.mcp_remember_description,
    inputSchema: {
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
      semanticTaskId: z
        .string()
        .optional()
        .describe(nmgPrompts.semantic_task_id_parameter_description),
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
    },
  },
  async (params) => {
    if (params.action === "claim_outcome") {
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
      const result = await invokeDaemon(connection, "recordClaimOutcomes", {
        semanticTaskId: params.semanticTaskId,
        activeGraphId: params.activeGraphId,
        sessionId: BOARD_SESSION_ID,
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
            type: "text",
            text: `Task-attributed claim outcome recorded. ${JSON.stringify(result)}`,
          },
        ],
      };
    }
    if (params.action === "forget") {
      if (!params.memoryId) throw new Error("action=forget requires memoryId");
      const result = await invokeDaemon(connection, "resolveRemember", {
        action: "forget",
        memoryId: params.memoryId,
        sessionId: BOARD_SESSION_ID,
      });
      return {
        content: [
          {
            type: "text",
            text: `Memory withdrawn from normal retrieval. ${JSON.stringify(result)}`,
          },
        ],
      };
    }
    if (params.action === "resolve" || params.action === "reopen") {
      if (!params.memoryId) throw new Error(`action=${params.action} requires memoryId`);
      const result = await invokeDaemon(connection, "resolveRemember", {
        action: params.action,
        memoryId: params.memoryId,
        relatedMemoryIds: params.relatedMemoryIds,
        reason: params.resolutionReason,
        sessionId: BOARD_SESSION_ID,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    if (params.action === "supersede") {
      if (!params.newMemoryId || !params.supersededMemoryId) {
        throw new Error("action=supersede requires newMemoryId and supersededMemoryId");
      }
      const result = await invokeDaemon(connection, "resolveRemember", {
        action: "supersede",
        newMemoryId: params.newMemoryId,
        supersededMemoryId: params.supersededMemoryId,
        reason: params.resolutionReason,
        sessionId: BOARD_SESSION_ID,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    if (params.action === "relate") {
      if (!params.newMemoryId || !params.relatedMemoryId || !params.relationJudgement) {
        throw new Error(
          "action=relate requires newMemoryId, relatedMemoryId, and relationJudgement",
        );
      }
      const result = await invokeDaemon(connection, "resolveRemember", {
        action: "relate",
        newMemoryId: params.newMemoryId,
        relatedMemoryId: params.relatedMemoryId,
        relationJudgement: params.relationJudgement,
        confidence: params.relationConfidence,
        sessionId: BOARD_SESSION_ID,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
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
    const r = (await invokeDaemon(connection, "remember", {
      ...memory,
      sessionId: BOARD_SESSION_ID,
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
      content: [{ type: "text", text: renderRememberSurface(r) }],
    };
  },
);

server.registerTool(
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
  async (params) => {
    if (params.action !== "list" && !params.capability)
      throw new Error(`${params.action} requires capability`);
    if (params.action === "enable" && !params.reason) throw new Error("enable requires reason");
    if (params.action === "invoke" && !params.operation)
      throw new Error("invoke requires operation");
    const result = await invokeDaemon(connection, "lab", {
      ...params,
      sessionId: BOARD_SESSION_ID,
      scope: params.action === "enable" ? "session" : undefined,
      requester: params.action === "enable" ? `agent:mcp:${BOARD_AGENT_ID}` : undefined,
    });
    return { content: [{ type: "text", text: renderLabOutput(result) }] };
  },
);

// ── Unified state and board identity ──

// Identity chain mirrors the Pi extension: NMG_AGENT_ID / NMG_SESSION_ID win,
// then a per-server pid (one stdio server per host session, so pid ≈ session).
const BOARD_SESSION_ID = process.env.NMG_SESSION_ID?.trim() || `mcp:${process.pid}`;
const BOARD_AGENT_ID = process.env.NMG_AGENT_ID?.trim() || BOARD_SESSION_ID;
const BOARD_AGENT_CAPABILITIES = process.env.NMG_AGENT_CAPABILITIES?.trim() || undefined;
let lastBoardHeartbeatAt = 0;

async function registerBoardAgent(): Promise<void> {
  await invokeDaemon(connection, "taskBoard", {
    action: "registerAgent",
    id: BOARD_AGENT_ID,
    agentName: BOARD_AGENT_ID,
    capabilities: BOARD_AGENT_CAPABILITIES,
    supportedInterfaces: "mcp",
  });
  lastBoardHeartbeatAt = Date.now();
}

async function heartbeatBoardAgent(): Promise<void> {
  if (Date.now() - lastBoardHeartbeatAt < 60_000) return;
  await invokeDaemon(connection, "taskBoard", {
    action: "heartbeat",
    id: BOARD_AGENT_ID,
  });
  lastBoardHeartbeatAt = Date.now();
}

server.registerTool(
  "nmg_state",
  {
    description: nmgPrompts.state_description,
    inputSchema: {
      action: z.enum(["read", "write"]),
      space: z.enum(["ag", "board"]),
      operation: z.enum(STATE_OPERATIONS).optional(),
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
      to: z.string().optional().describe("Stable agent name returned by discover for directed put"),
      capabilities: z.string().optional().describe("Capability substring used by discover"),
    },
  },
  async (params) => {
    const operation = stateOperation(params);
    if (params.space === "ag") {
      const result = (await invokeDaemon(connection, "state", {
        action: params.action,
        space: "ag",
        operation,
        text: params.text,
        reason: params.reason,
        ttlSeconds: params.ttlSeconds,
        sessionId: BOARD_SESSION_ID,
        requester: `agent:mcp:${BOARD_AGENT_ID}`,
      })) as NmgStateResult;
      return { content: [{ type: "text", text: renderStateOutput(result) }] };
    }
    if (!coordinationEnabled()) throw new Error("Board coordination is disabled");
    await heartbeatBoardAgent();
    const result = (await invokeDaemon(connection, "state", {
      ...params,
      operation,
      taskId: params.taskId?.trim() || WORLD_BOARD_ID,
      agentId: BOARD_AGENT_ID,
      id: BOARD_AGENT_ID,
      agentName: params.agentName ?? BOARD_AGENT_ID,
      sourceSessionId: BOARD_SESSION_ID,
      sessionId: BOARD_SESSION_ID,
    })) as NmgStateResult;
    await receiptBoardRead(result.result);
    return { content: [{ type: "text", text: renderStateOutput(result) }] };
  },
);

async function receiptBoardRead(result: NmgStateResult["result"]): Promise<void> {
  if (result.action !== "read") return;
  const receipts = result.entries
    .filter(
      (entry) =>
        entry.status === "open" &&
        entry.sourceSessionId !== BOARD_SESSION_ID &&
        !(entry.sourceSessionId == null && entry.agentId === BOARD_AGENT_ID),
    )
    .map((entry) =>
      invokeDaemon(connection, "taskBoard", {
        action: "recordDelivery",
        entryId: entry.id,
        sessionId: BOARD_SESSION_ID,
        agentId: BOARD_AGENT_ID,
        source: "read",
      }),
    );
  await Promise.allSettled(receipts);
}

// ── Lifecycle ──

const connection = await connectDaemon(dbPath());
if (coordinationEnabled()) await registerBoardAgent();
const transport = new StdioServerTransport();
await server.connect(transport);
const done = async () => {
  await invokeDaemon(connection, "sessionActiveGraph", {
    action: "release",
    sessionId: BOARD_SESSION_ID,
  }).catch(() => undefined);
  await shutdownOwnedDaemon(connection);
  process.exit(0);
};
process.on("SIGINT", done);
process.on("SIGTERM", done);

// ── Compact formatters ──

async function discloseContext(
  context: MemoryContext,
  disclosure: "header" | "evidence",
  projectionId = context.activeGraph?.id,
): Promise<{ context: MemoryContext; foldedMemoryIds: string[] }> {
  const rawDecision = (await invokeDaemon(connection, "sessionActiveGraph", {
    action: "disclose",
    sessionId: BOARD_SESSION_ID,
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
