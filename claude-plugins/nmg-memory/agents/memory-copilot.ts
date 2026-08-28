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
import {
  COMMON_BOARD_ACTIONS,
  COMMON_REMEMBER_ACTIONS,
} from "../../../src/integration/tool-contract.ts";
import {
  renderEvidenceSurface,
  renderRememberSurface,
  renderSearchSurface,
  renderTaskBoardSurface,
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
    const r = (await invokeDaemon(connection, "search", {
      ...params,
      sessionId: BOARD_SESSION_ID,
    })) as MemoryContext;
    return { content: [{ type: "text", text: searchH(r) }] };
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
    return { content: [{ type: "text", text: memText(r) }] };
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
                attributes: { taskId: boardSource.taskId, entryId: boardSource.entryId },
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
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── nmg_board ──

interface BoardEntry {
  id: string;
  sequence: number;
  kind: string;
  status: string;
  agentId: string;
  content: string;
  sourceSessionId?: string | null;
  claimedBy?: string | null;
  ackedBy?: string[];
}

interface BoardToolResult {
  action: string;
  entry?: BoardEntry;
  entries?: BoardEntry[];
  nextCursor?: number;
  taskId?: string;
  agents?: Array<{
    agentName: string;
    description: string | null;
    capabilities: string | null;
    lastSeenAt: string;
  }>;
}

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

if (coordinationEnabled())
  server.registerTool(
    "nmg_board",
    {
      description: nmgPrompts.board_description,
      inputSchema: {
        action: z
          .enum(COMMON_BOARD_ACTIONS)
          .describe(nmgPrompts.board_action_parameter_description),
        taskId: z.string().optional().describe(nmgPrompts.board_task_id_parameter_description),
        content: z.string().optional().describe(nmgPrompts.board_content_parameter_description),
        kind: z
          .enum(["blocker", "decision", "goal", "handoff", "note", "question", "result"])
          .optional(),
        entryId: z.string().optional(),
        resolution: z.string().optional(),
        reason: z.string().optional(),
        leaseSeconds: z.number().int().min(60).max(86_400).optional(),
        afterCursor: z.number().int().min(0).optional(),
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
    async (params) => {
      await heartbeatBoardAgent();
      // taskId is optional: without one, entries land on the shared world
      // channel (the lobby), which every agent reads by default.
      const taskId = params.taskId?.trim() || WORLD_BOARD_ID;
      if (params.action === "discover") {
        const result = (await invokeDaemon(connection, "taskBoard", {
          action: "discover",
          taskId,
          agentId: BOARD_AGENT_ID,
          capabilities: params.capabilities,
        })) as BoardToolResult;
        return {
          content: [
            {
              type: "text",
              text: renderTaskBoardSurface(
                {
                  ...result,
                  agents: (result.agents ?? []).map((agent) => ({
                    ...agent,
                    id: agent.agentName,
                  })),
                },
                { taskId },
              ),
            },
          ],
        };
      }
      if (params.action === "subscribe" || params.action === "unsubscribe") {
        const result = (await invokeDaemon(connection, "taskBoard", {
          action: params.action,
          taskId,
          sessionId: BOARD_SESSION_ID,
          agentId: BOARD_AGENT_ID,
        })) as { taskId: string };
        const text =
          params.action === "unsubscribe"
            ? `已退出频道 ${result.taskId}：不再接收该频道新条目的唤醒通知（用 nmg_board subscribe 重新加入）。`
            : `已加入频道 ${result.taskId}：接收该频道新条目的唤醒通知（未订阅的频道不会打扰你）。`;
        return { content: [{ type: "text", text }] };
      }
      const result = (await invokeDaemon(connection, "taskBoard", {
        ...params,
        taskId,
        agentId: BOARD_AGENT_ID,
        sourceSessionId: BOARD_SESSION_ID,
      })) as BoardToolResult;
      const entries = result.entries ?? (result.entry ? [result.entry] : []);
      if (result.action === "read") {
        // Reading is a delivery: receipt every open, non-own-echo entry so the
        // wake path never re-pushes what this session already saw.
        const receipts = entries
          .filter((entry) => {
            if (entry.status !== "open") return false;
            return !(
              entry.sourceSessionId === BOARD_SESSION_ID ||
              (entry.sourceSessionId == null && entry.agentId === BOARD_AGENT_ID)
            );
          })
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
      // The world channel read surfaces the lobby: the directory of active
      // named channels, so an agent that knows no channel name can find one.
      let directory: Array<{ taskId: string; entryCount: number; lastUpdatedAt: string }> = [];
      if (result.action === "read" && taskId === WORLD_BOARD_ID) {
        const lobby = (await invokeDaemon(connection, "taskBoard", {
          action: "list",
          agentId: BOARD_AGENT_ID,
        })) as { boards?: typeof directory };
        directory = lobby.boards ?? [];
      }
      return { content: [{ type: "text", text: formatBoard(result, taskId, directory) }] };
    },
  );

// ── Lifecycle ──

const connection = await connectDaemon(dbPath());
if (coordinationEnabled()) await registerBoardAgent();
const transport = new StdioServerTransport();
await server.connect(transport);
const done = async () => {
  await shutdownOwnedDaemon(connection);
  process.exit(0);
};
process.on("SIGINT", done);
process.on("SIGTERM", done);

// ── Compact formatters ──

function searchH(r: MemoryContext): string {
  const deferred = r.progressiveDisclosure?.deferredMemoryIds;
  const nextStep =
    deferred && deferred.length > 0
      ? `${nmgPrompts.deferred_hint} Memory IDs: ${deferred.join(",")}`
      : nmgPrompts.get_hint;
  const forget = r.results.some(({ memory: m }) =>
    (m.markers ?? []).some((marker) => marker.kind === "forget"),
  );
  return renderSearchSurface(r, {
    emptyText: "No NMG match.",
    preamble: renderDisclosure(nmgPrompts.search_disclosure, {
      count: String(r.results.length),
      next_step: nextStep,
      forget_hint: forget ? nmgPrompts.forget_hint : "",
    }),
  });
}

function memText(r: MemoryContext & { missingMemoryIds?: string[] }): string {
  const forget = r.results.some(({ memory }) =>
    (memory.markers ?? []).some((marker) => marker.kind === "forget"),
  );
  return renderEvidenceSurface(r, {
    preamble: renderDisclosure(nmgPrompts.get_disclosure, {
      count: String(r.results.length),
      next_step: "",
      forget_hint: forget ? nmgPrompts.forget_hint : "",
    }),
    missingMemoryIds: r.missingMemoryIds,
  });
}

function formatBoard(
  result: BoardToolResult,
  taskId: string,
  directory: Array<{ taskId: string; entryCount: number; lastUpdatedAt: string }>,
): string {
  return renderTaskBoardSurface(result, { taskId, directory });
}
