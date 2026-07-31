import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connectDaemon, invokeDaemon, shutdownOwnedDaemon } from "../../../src/cli/daemon-client.ts";
import type { MemoryContext, PerfSnapshot } from "../../../src/core/types.ts";

function dbPath(): string {
  return join(process.env.NMG_DATA_DIR ?? join(process.cwd(), ".nmg"), "nmg.sqlite");
}

// Per-call performance feedback, off by default. When enabled, nmg_search
// returns a compact per-phase timing line the agent can act on (e.g. detect
// a slow lexical scan and suggest retention/merge). Shared daemons keep
// their own env; this switch applies only to this MCP server's requests.
const AGENT_PERF = process.env.NMG_AGENT_PERF === "1";

const MEMORY_TYPES = ["constraint", "event", "fact", "preference", "state", "strategy"] as const;
const ACTORS = ["assistant", "system", "tool", "user"] as const;
const TRUTH = ["asserted", "inferred", "unverified", "verified"] as const;
const EVIDENCE_ROLES = ["contradict", "example", "exception", "origin", "support", "update"] as const;

const server = new McpServer(
  { name: "nmg-memory", version: "0.1.0" },
  {
    instructions:
      "Durable memory: nmg_search→headers, nmg_get→exact evidence, nmg_remember→save. Never save secrets/chatter/duplicates.",
  },
);

// ── nmg_search ──

server.registerTool(
  "nmg_search",
  {
    description: "Search memory headers (mid, node, type, tier, preview). Use nmg_get on selected IDs.",
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
    const r = (await invokeDaemon(connection, "search", AGENT_PERF ? { ...params, perf: true } : params)) as MemoryContext;
    return { content: [{ type: "text", text: searchH(r) }] };
  },
);

// ── nmg_get ──

server.registerTool(
  "nmg_get",
  {
    description: "Load exact memory statements + evidence for selected IDs.",
    inputSchema: {
      memoryIds: z.array(z.string()).min(1).max(50).describe("Memory IDs from nmg_search"),
      graphHops: z.number().int().min(0).max(3).optional(),
    },
  },
  async (params) => {
    const r = (await invokeDaemon(connection, "get", params)) as MemoryContext & { missingMemoryIds?: string[] };
    return { content: [{ type: "text", text: memText(r) }] };
  },
);

// ── nmg_remember ──

server.registerTool(
  "nmg_remember",
  {
    description: "Save durable memory. Auto-save stable facts/prefs/constraints/states. Skip secrets/chatter/duplicates.",
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
      scope: z.record(z.string()).optional(),
      residence: z.enum(["ltg", "stg"]).optional(),
      writeReason: z.string().optional(),
    },
  },
  async (params) => {
    const r = (await invokeDaemon(connection, "remember", params)) as {
      memory: { id: string }; node: { canonicalName: string };
    };
    return { content: [{ type: "text", text: `Saved ${r.memory.id} under "${r.node.canonicalName}".` }] };
  },
);

// ── Lifecycle ──

const connection = await connectDaemon(dbPath());
const transport = new StdioServerTransport();
await server.connect(transport);
const done = async () => { await shutdownOwnedDaemon(connection); process.exit(0); };
process.on("SIGINT", done);
process.on("SIGTERM", done);

// ── Compact formatters ──

function searchH(r: MemoryContext): string {
  const lines = r.results.length
    ? r.results.map(
        ({ memory: m, node: n }) =>
          `mid=${m.id}\tnode=${n.canonicalName}\ttype=${m.memoryType}\tL${m.tier}\t${t115(m.statement)}`,
      )
    : ["No NMG match."];
  const perfLine = perfFeedback(r.timings, r.filterUsage);
  if (perfLine) lines.push(perfLine);
  return lines.join("\n");
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
  if (timings.totalMs > 50 && (!filters || (filters as { dimensions?: string[] }).dimensions?.length === 0)) {
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

const t115 = (v: string) => { const n = v.replace(/\s+/g, " ").trim(); return n.length <= 115 ? n : `${n.slice(0, 114)}…`; };
const t280 = (v: string) => { const n = v.replace(/\s+/g, " ").trim(); return n.length <= 280 ? n : `${n.slice(0, 279)}…`; };
