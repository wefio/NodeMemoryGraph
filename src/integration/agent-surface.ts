import type { MemoryContext, RememberResult } from "../core/types.ts";
import type { SessionActiveGraphSnapshot } from "../core/session-active-graph.ts";
import { DEFAULT_LOGICAL_CHAIN_MAX_CHARS, projectLogicalChains } from "./chain-projection.ts";
import {
  compactSearchContext,
  type CompactSearchCandidate,
  type CompactSearchContext,
} from "./search-projection.ts";

export interface SearchSurfaceOptions {
  preamble?: string;
  postamble?: string;
  emptyText?: string;
}

export interface EvidenceSurfaceOptions {
  preamble?: string;
  postamble?: string;
  emptyText?: string;
  missingMemoryIds?: string[];
  logicalChainMaxChars?: number;
}

export interface TaskBoardDirectoryEntry {
  taskId: string;
  entryCount: number;
  lastUpdatedAt: string;
}

export interface TaskBoardAgentEntry {
  id?: string;
  agentName: string;
  description?: string | null;
  capabilities?: string | null;
  lastSeenAt: string;
}

export interface TaskBoardSurfaceResult {
  action: string;
  entry?: TaskBoardSurfaceEntry;
  entries?: TaskBoardSurfaceEntry[];
  nextCursor?: string | null;
  agents?: TaskBoardAgentEntry[];
}

export interface TaskBoardSurfaceEntry {
  id?: string;
  kind?: string;
  status?: string;
  agentId?: string;
  content?: string;
  claimedBy?: string | null;
  ackedBy?: string[];
}

export interface TaskBoardSurfaceOptions {
  taskId: string;
  directory?: TaskBoardDirectoryEntry[];
  emptyText?: string;
  includeConventions?: boolean;
}

/** Model-facing projection of temporary AG state. Durable semantic memories are
 * omitted because search/get already render them with provenance. */
export function renderSessionActiveGraphSurface(
  snapshot: SessionActiveGraphSnapshot | null,
  maxCharacters = 8_000,
): string {
  if (!snapshot?.temporaryProjectionActive) return "";
  const temporary = snapshot.items.filter((item) => item.temporary);
  if (temporary.length === 0) return "";
  const lines = ["Session working state (temporary; not durable memory):"];
  let used = lines[0]!.length;
  for (const item of temporary) {
    const line = `- ${excerpt(item.statement, 500)}`;
    if (used + line.length + 1 > Math.max(128, maxCharacters)) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function excerpt(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function temporalLabels(candidate: CompactSearchCandidate): string[] {
  const day = (value: string | null | undefined): string | null =>
    value ? value.slice(0, 10) : null;
  const labels: string[] = [];
  const event = day(candidate.eventTime);
  if (event) labels.push(`time=${event}`);
  const expires = day(candidate.expiresAt);
  if (expires) labels.push(`expires=${expires}`);
  return labels;
}

/**
 * Host-neutral default rendering for the progressive search surface. Adapters
 * may supply host prompt copy, but candidate fields, redaction, chain labels,
 * and next-step placement stay identical across hosts.
 */
export function renderSearchSurface(
  context: MemoryContext,
  options: SearchSurfaceOptions = {},
): string {
  return renderCompactSearchSurface(compactSearchContext(context), options);
}

/** Render only the already-filtered Agent-facing candidate DTO. Storage tiers,
 * scores, QPP internals, timings and token estimates never cross this boundary. */
export function renderCompactSearchSurface(
  context: CompactSearchContext,
  options: SearchSurfaceOptions = {},
): string {
  const tesseraLines = (context.tesserae ?? []).map((tessera) => {
    const position = tessera.stale ? "(stale)" : tessera.line ? `:${tessera.line}` : "";
    return `- tessera=${tessera.path}${position}; label=${tessera.label || "(bookmark)"}`;
  });
  if (context.candidates.length === 0 && tesseraLines.length === 0) {
    return options.emptyText ?? "No matching NMG memory found.";
  }
  const lines = context.candidates.map((candidate) => {
    const flags = [candidate.external ? "[external]" : "", candidate.open ? "[open]" : ""].filter(
      Boolean,
    );
    const fields = [
      `memory=${candidate.id}`,
      `node=${candidate.node}`,
      `type=${candidate.type}`,
      ...temporalLabels(candidate),
      ...(candidate.chains.length > 0 ? [`chains=${candidate.chains.join(",")}`] : []),
      `preview=${candidate.preview}`,
    ];
    return `- ${flags.length > 0 ? `${flags.join(" ")} ` : ""}${fields.join("; ")}`;
  });
  return [
    options.preamble,
    ...lines,
    ...tesseraLines,
    context.logicalChainCount > 0
      ? `logical_chains=${context.logicalChainCount}; use nmg_get for compact chain structure with exact evidence.`
      : "",
    context.activeGraphId ? `activeGraphId=${context.activeGraphId}` : "",
    options.postamble,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Exact-evidence surface. Statements are emitted once; logical structure has
 * an independent budget and refers to stable local labels. */
export function renderEvidenceSurface(
  context: MemoryContext,
  options: EvidenceSurfaceOptions = {},
): string {
  const chains = projectLogicalChains(
    context,
    options.logicalChainMaxChars ?? DEFAULT_LOGICAL_CHAIN_MAX_CHARS,
  );
  const records = context.results.map(({ memory, node, evidence }) => {
    const external = (memory.markers ?? []).find((marker) => marker.kind === "external_source");
    const forgotten = (memory.markers ?? []).some((marker) => marker.kind === "forget");
    const flags = [
      chains.labels.get(memory.id) ? `[${chains.labels.get(memory.id)}]` : "",
      external ? `[external, ${memory.truthStatus}]` : "",
      memory.resolution === "open" || memory.resolution === "reopened" ? "[open]" : "",
    ].filter(Boolean);
    const details = [
      `memory=${memory.id}`,
      `node=${node.canonicalName}`,
      `type=${memory.memoryType}`,
      `truth=${memory.truthStatus}`,
      `scope=${JSON.stringify(memory.scope)}`,
      ...(memory.eventTime ? [`time=${memory.eventTime}`] : []),
    ];
    const externalSource = external?.attributes?.source
      ? `\n  EXTERNAL_SOURCE=${String(external.attributes.source)}; retrievedAt=${String(external.attributes.retrievedAt ?? "unknown")}`
      : "";
    const source =
      !forgotten && evidence.content.trim() !== memory.statement.trim()
        ? `\n  SOURCE=${excerpt(evidence.content, 320)}`
        : "";
    const statement = forgotten ? "[forget] (content withdrawn)" : memory.statement;
    return `- ${flags.length > 0 ? `${flags.join(" ")} ` : ""}${statement}\n  ${details.join("; ")}${externalSource}${source}`;
  });
  const missing = options.missingMemoryIds?.length
    ? `MISSING: ${options.missingMemoryIds.join(", ")}`
    : "";
  const body = [options.preamble, ...records, missing, chains.text, options.postamble]
    .filter(Boolean)
    .join("\n");
  return body || options.emptyText || "No active memory found.";
}

/** Default follow-up guidance after a durable save. The model remains the
 * semantic judge; NMG only exposes bounded candidates. */
export function renderRememberSurface(
  result: Pick<RememberResult, "memory" | "duplicates" | "supersedeCandidates">,
): string {
  const memoryId = result.memory?.id;
  const lines = [`Saved${memoryId ? ` ${memoryId}` : " memory"}.`];
  const supersede = (result.supersedeCandidates ?? []).slice(0, 3);
  if (supersede.length > 0 && memoryId) {
    lines.push(
      "NMG found possible older values. Similarity is only a candidate signal; decide semantically.",
      ...supersede.map(
        (candidate) => `- ${candidate.memoryId}: ${excerpt(candidate.statement, 180)}`,
      ),
      "If exactly one candidate is genuinely replaced in the same scope, call nmg_remember again with action=supersede, newMemoryId, supersededMemoryId, and a short reason. Otherwise do nothing.",
    );
  }
  const duplicates = (result.duplicates ?? []).filter(
    (candidate) => candidate.memoryId !== memoryId,
  );
  if (duplicates.length > 0) {
    lines.push(
      "Possible semantic neighbours were retained as distinct nodes:",
      ...duplicates
        .slice(0, 3)
        .map((candidate) => `- ${candidate.memoryId}: ${excerpt(candidate.statement, 180)}`),
      "Only if a relationship is useful, call nmg_remember again with action=relate, newMemoryId, relatedMemoryId, and relationJudgement. Similarity alone is not identity; otherwise do nothing.",
    );
  }
  return lines.join("\n");
}

export const TASK_BOARD_CONVENTIONS =
  "Board conventions (on use): entries may carry memory=<id> references to LTG records — readers expand them with nmg_get; open entries can be claimed by one Agent (lease-based, expired claims return to the pool) and released; resolve a request once it is answered — a resolved entry is closed and must not be replied to (reopen only with new substance); keep entries concise and temporary; taskId is the only channel boundary (no DMs, mentions, groups, or pinning).";

/** Host-neutral board rendering. Host-only actions such as Pi rename remain in
 * the adapter and can bypass this renderer. */
export function renderTaskBoardSurface(
  result: TaskBoardSurfaceResult,
  options: TaskBoardSurfaceOptions,
): string {
  if (result.action === "discover") {
    const agents = result.agents ?? [];
    return agents.length === 0
      ? "No online NMG agents match the requested capability."
      : [
          "Online NMG agents:",
          ...agents.map(
            (agent) =>
              `- ${agent.agentName}${agent.description ? ` — ${agent.description}` : ""}${agent.capabilities ? ` capabilities=${agent.capabilities}` : ""} (id=${agent.id ?? agent.agentName}; lastSeen=${agent.lastSeenAt})`,
          ),
          "Use nmg_board action=put with to=<agent name> for directed delivery.",
        ].join("\n");
  }
  const entries = result.entries ?? (result.entry ? [result.entry] : []);
  const lines: string[] = [];
  for (const board of options.directory ?? []) {
    if (lines.length === 0) lines.push("Active named channels (world channel lobby):");
    lines.push(
      `- ${board.taskId} (${board.entryCount} open · updated ${board.lastUpdatedAt.slice(0, 10)})`,
    );
  }
  if (lines.length > 0) lines.push("");
  if (entries.length === 0) {
    lines.push(options.emptyText ?? `Task board ${options.taskId} has no matching entries.`);
  } else {
    for (const entry of entries) {
      const claim = entry.claimedBy ? ` [claimed by ${entry.claimedBy}]` : "";
      const ack = entry.ackedBy?.length ? ` (✅ acked by ${entry.ackedBy.join(", ")})` : "";
      lines.push(
        `- ${String(entry.id ?? "?")} [${String(entry.kind ?? "entry")}/${String(entry.status ?? "open")}]${claim}${ack} ${String(entry.agentId ?? "unknown")}: ${excerpt(String(entry.content ?? ""), 500)}`,
      );
    }
    if (result.action === "read") lines.push(`nextCursor=${String(result.nextCursor ?? "")}`);
  }
  lines.push("Temporary coordination only; use nmg_remember separately for durable knowledge.");
  if (options.includeConventions !== false) lines.push(TASK_BOARD_CONVENTIONS);
  return lines.join("\n");
}
