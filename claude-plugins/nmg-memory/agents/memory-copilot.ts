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
import { WORLD_BOARD_ID, type MemoryContext, type PerfSnapshot } from "../../../src/core/types.ts";

const nmgPrompts = loadPrompts();

function dbPath(): string {
  return join(resolveNmgDataDir(), "nmg.sqlite");
}

// Per-call performance feedback, off by default. When enabled, nmg_search
// returns a compact per-phase timing line the agent can act on (e.g. detect
// a slow lexical scan and suggest retention/merge). Shared daemons keep
// their own env; this switch applies only to this MCP server's requests.
const AGENT_PERF = process.env.NMG_AGENT_PERF === "1";

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
    const r = (await invokeDaemon(
      connection,
      "search",
      AGENT_PERF ? { ...params, perf: true } : params,
    )) as MemoryContext;
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
    },
  },
  async (params) => {
    const r = (await invokeDaemon(connection, "get", params)) as MemoryContext & {
      missingMemoryIds?: string[];
    };
    return { content: [{ type: "text", text: memText(r) }] };
  },
);

// ── nmg_remember ──

server.registerTool(
  "nmg_remember",
  {
    description: nmgPrompts.remember_description,
    inputSchema: {
      statement: z.string().describe("Self-contained semantic statement"),
      nodeName: z.string().describe("Stable semantic node grouping related memories"),
      memoryType: z.enum(MEMORY_TYPES).optional(),
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
    const { boardSource, ...memory } = params;
    const r = (await invokeDaemon(connection, "remember", {
      ...memory,
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
    })) as {
      memory: { id: string };
      node: { canonicalName: string };
    };
    return {
      content: [{ type: "text", text: `Saved ${r.memory.id} under "${r.node.canonicalName}".` }],
    };
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

server.registerTool(
  "nmg_board",
  {
    description: nmgPrompts.board_description,
    inputSchema: {
      action: z
        .enum([
          "put",
          "read",
          "resolve",
          "acknowledge",
          "claim",
          "release",
          "subscribe",
          "unsubscribe",
          "discover",
        ])
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
      to: z.string().optional().describe("Stable agent name returned by discover for directed put"),
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
      return { content: [{ type: "text", text: formatAgentRoster(result.agents ?? []) }] };
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
await registerBoardAgent();
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
  const lines = r.results.length
    ? r.results.map(
        ({ memory: m, node: n }) =>
          `mid=${m.id}\tnode=${n.canonicalName}\ttype=${m.memoryType}\tL${m.tier}\t${
            (m.markers ?? []).some((marker) => marker.kind === "forget")
              ? nmgPrompts.forget_redacted
              : t115(m.statement)
          }`,
      )
    : ["No NMG match."];
  const deferred = r.progressiveDisclosure?.deferredMemoryIds;
  const nextStep =
    deferred && deferred.length > 0
      ? `${nmgPrompts.deferred_hint} Memory IDs: ${deferred.join(",")}`
      : nmgPrompts.get_hint;
  const forget = r.results.some(({ memory: m }) =>
    (m.markers ?? []).some((marker) => marker.kind === "forget"),
  );
  const perfLine = perfFeedback(r.timings, r.filterUsage);
  if (perfLine) lines.push(perfLine);
  return [
    renderDisclosure(nmgPrompts.mcp_search_disclosure, {
      count: String(r.results.length),
      next_step: nextStep,
      forget_hint: forget ? nmgPrompts.forget_hint : "",
    }),
    ...lines,
  ].join("\n");
}

/** Compact per-phase timing feedback line for agent self-maintenance. */
function perfFeedback(timings: PerfSnapshot | undefined, filters?: unknown): string | null {
  if (!timings) return null;
  const sections = Object.entries(timings.timings)
    .sort((left, right) => right[1] - left[1])
    .map(([section, ms]) => `${section}=${ms.toFixed(1)}ms`)
    .join(" ");
  let advice = "";
  // Slow + unfiltered → the agent can narrow scope instead of widening the
  // query. This is the index-decision signal surfacing at the boundary.
  if (
    timings.totalMs > 50 &&
    (!filters || (filters as { dimensions?: string[] }).dimensions?.length === 0)
  ) {
    advice = " (slow: consider --scope to narrow)";
  }
  return `[perf ${sections} total=${timings.totalMs.toFixed(1)}ms${advice}]`;
}

function memText(r: MemoryContext & { missingMemoryIds?: string[] }): string {
  const l = r.results.map(({ memory: m, node: n, evidence: e }) => {
    return `- ${m.statement}\n  mid=${m.id} n=${n.canonicalName} t=${m.memoryType} truth=${m.truthStatus}${e.content.trim() !== m.statement.trim() ? `\nSRC: ${t280(e.content)}` : ""}`;
  });
  if (r.missingMemoryIds?.length) l.push(`MISSING: ${r.missingMemoryIds.join(", ")}`);
  return l.join("\n");
}

const t115 = (v: string) => {
  const n = v.replace(/\s+/g, " ").trim();
  return n.length <= 115 ? n : `${n.slice(0, 114)}…`;
};
const t280 = (v: string) => {
  const n = v.replace(/\s+/g, " ").trim();
  return n.length <= 280 ? n : `${n.slice(0, 279)}…`;
};
const t500 = (v: string) => {
  const n = v.replace(/\s+/g, " ").trim();
  return n.length <= 500 ? n : `${n.slice(0, 499)}…`;
};

function formatBoard(
  result: BoardToolResult,
  taskId: string,
  directory: Array<{ taskId: string; entryCount: number; lastUpdatedAt: string }>,
): string {
  const entries = result.entries ?? (result.entry ? [result.entry] : []);
  const lines: string[] = [];
  if (directory.length > 0) {
    lines.push("Active named channels (world channel lobby):");
    for (const board of directory) {
      lines.push(
        `- ${board.taskId} (${board.entryCount} open · updated ${board.lastUpdatedAt.slice(0, 10)})`,
      );
    }
    lines.push("");
  }
  if (entries.length === 0) {
    lines.push(`Task board ${taskId} has no matching entries.`);
  } else {
    for (const entry of entries) {
      const claim = entry.claimedBy ? ` [claimed by ${entry.claimedBy}]` : "";
      const ack =
        entry.ackedBy && entry.ackedBy.length > 0
          ? ` (✅ acked by ${entry.ackedBy.join(", ")})`
          : "";
      lines.push(
        `- #${entry.sequence} ${entry.id} [${entry.kind}/${entry.status}]${claim}${ack} ${entry.agentId}: ${t500(entry.content)}`,
      );
    }
    if (result.action === "read") lines.push(`nextCursor=${String(result.nextCursor ?? 0)}`);
  }
  lines.push("Temporary coordination only; use nmg_remember separately for durable knowledge.");
  lines.push(
    "Board conventions (on use): entries may carry memory=<id> references to LTG records — readers expand them with nmg_get; open entries can be claimed by one Agent (lease-based, expired claims return to the pool) and released; resolve a request once it is answered — a resolved entry is closed and must not be replied to (reopen only with new substance); keep entries concise and temporary; taskId is the only channel boundary (no DMs, mentions, groups, or pinning).",
  );
  return lines.join("\n");
}

function formatAgentRoster(agents: NonNullable<BoardToolResult["agents"]>): string {
  if (agents.length === 0) return "No online NMG agents match the requested capability.";
  return [
    "Online NMG agents:",
    ...agents.map(
      (agent) =>
        `- ${agent.agentName}${agent.capabilities ? ` capabilities=${agent.capabilities}` : ""} lastSeen=${agent.lastSeenAt}`,
    ),
    "Use nmg_board action=put with to=<agent name> for directed delivery.",
  ].join("\n");
}
