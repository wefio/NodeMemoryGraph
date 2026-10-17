import type { MemoryContext, RememberResult } from "../core/types.ts";
import {
  DEFAULT_INFORMATION_OUTPUT_CHARACTERS,
  TEMPORARY_INFORMATION_LABEL,
  type InformationView,
  type PreparedInformationOutput,
} from "../core/information-view.ts";
import { boardEntryView as boardBodyView } from "../core/board-entry-view.ts";
import { prepareInformationOutput } from "./information-output.ts";
import type { SessionActiveGraphSnapshot } from "../core/session-active-graph.ts";
import { DEFAULT_LOGICAL_CHAIN_MAX_CHARS, projectLogicalChains } from "./chain-projection.ts";
import {
  compactRetrievalReason,
  compactSearchContext,
  type CompactSearchCandidate,
  type CompactSearchContext,
} from "./search-projection.ts";

export interface SearchSurfaceOptions {
  preamble?: string;
  postamble?: string;
  emptyText?: string;
  memoryReferences?: Readonly<Record<string, string>>;
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
  previews?: TaskBoardSurfacePreview[];
  nextCursor?: string | null;
  agents?: TaskBoardAgentEntry[];
}

export interface TaskBoardSurfaceEntry {
  id?: string;
  taskId?: string;
  to?: string | null;
  serialState?: string | null;
  kind?: string;
  status?: string;
  agentId?: string;
  content?: string;
  claimedBy?: string | null;
  ackedBy?: string[];
  deliveredBy?: string | null;
  deliverableDigest?: string | null;
  verdict?: string | null;
  judgedBy?: string | null;
}

export interface TaskBoardSurfacePreview {
  id?: string;
  serialState?: string | null;
  taskId?: string;
  kind?: string;
  status?: string;
  agentId?: string;
  to?: string | null;
  claimedBy?: string | null;
  ackCount?: number;
  deliveredBy?: string | null;
  deliverableDigest?: string | null;
  verdict?: string | null;
  judgedBy?: string | null;
  createdAt?: string;
  resolvedAt?: string | null;
  preview?: string;
}

export interface TaskBoardSurfaceOptions {
  taskId: string;
  directory?: TaskBoardDirectoryEntry[];
  emptyText?: string;
  includeConventions?: boolean;
  maxCharacters?: number;
}

/** Typed preparation is shared by ordinary tools and programmatic consumers.
 * Only the active frame's admitted temporary items belong on this surface.
 */
export interface SessionActiveGraphSurfaceOptions {
  /** Per-turn dedicated state preparation can exclude it from mixed materials. */
  includeWorkingState?: boolean;
  /** Automatic continuity only; explicit reads retain historical observations. */
  contextTurn?: number;
}

export function prepareSessionActiveGraphSurface(
  snapshot: SessionActiveGraphSnapshot | null,
  maxCharacters = DEFAULT_INFORMATION_OUTPUT_CHARACTERS,
  options: SessionActiveGraphSurfaceOptions = {},
): PreparedInformationOutput {
  const views: InformationView[] = [];
  if (snapshot) {
    for (const item of snapshot.items) {
      if (
        (!snapshot.temporaryProjectionActive && item.kind !== "working_state") ||
        (options.includeWorkingState === false && item.kind === "working_state") ||
        !item.temporary ||
        item.kind === "semantic_memory" ||
        item.taskFrameId !== snapshot.activeTaskFrameId ||
        !currentContextObservation(item, options.contextTurn)
      )
        continue;
      views.push({
        purpose: agInformationPurpose(item),
        source: {
          kind: "ag",
          sessionId: snapshot.sessionId,
          taskFrameId: item.taskFrameId,
          itemId: item.id,
        },
        body: item.statement,
        requiredLabels:
          item.kind === "reasoning_artifact"
            ? [TEMPORARY_INFORMATION_LABEL, "[hypothesis]"]
            : [TEMPORARY_INFORMATION_LABEL],
      });
    }
  }
  return prepareInformationOutput(views, { maxCharacters });
}

function currentContextObservation(
  item: SessionActiveGraphSnapshot["items"][number],
  turn: number | undefined,
): boolean {
  if (turn === undefined || !["tool_observation", "board_projection"].includes(item.kind))
    return true;
  return (
    item.observedTurn !== undefined && item.observedTurn <= turn && item.observedTurn >= turn - 1
  );
}

function agInformationPurpose(
  item: SessionActiveGraphSnapshot["items"][number],
): InformationView["purpose"] {
  if (item.kind === "working_state") return "state";
  if (item.kind === "reasoning_artifact") return "reasoning";
  return item.sourceKind === "tool_error" ? "diagnostic" : "material";
}

/** Compatibility text interface; preparing text never commits disclosure. */
export function renderSessionActiveGraphSurface(
  snapshot: SessionActiveGraphSnapshot | null,
  maxCharacters = 8_000,
  options: SessionActiveGraphSurfaceOptions = {},
): string {
  return prepareSessionActiveGraphSurface(snapshot, maxCharacters, options).text;
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
  return renderCompactSearchSurface(compactSearchContext(context), {
    ...options,
    memoryReferences: context.memoryReferences ?? options.memoryReferences,
  });
}

/** Render only the already-filtered Agent-facing candidate DTO. Storage tiers,
 * scores, QPP internals, timings and token estimates never cross this boundary. */
export function renderCompactSearchSurface(
  context: CompactSearchContext,
  options: SearchSurfaceOptions = {},
): string {
  const retrievalNote = degradedRetrievalNote(context.retrieval);
  const tesseraLines = (context.tesserae ?? []).map((tessera) => {
    const position = tessera.stale ? "(stale)" : tessera.line ? `:${tessera.line}` : "";
    return `- tessera=${tessera.path}${position}; label=${tessera.label || "(bookmark)"}`;
  });
  if (context.candidates.length === 0 && tesseraLines.length === 0) {
    return [retrievalNote, options.emptyText ?? "No matching NMG memory found."]
      .filter(Boolean)
      .join("\n");
  }
  const lines = context.candidates.map((candidate) =>
    searchCandidateLine(candidate, context.activeGraphId ? options.memoryReferences : undefined),
  );
  return [
    options.preamble,
    retrievalNote,
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

function searchCandidateLine(
  candidate: CompactSearchCandidate,
  references: SearchSurfaceOptions["memoryReferences"],
): string {
  const flags = [candidate.external ? "[external]" : "", candidate.open ? "[open]" : ""].filter(
    Boolean,
  );
  const fields = [
    `memory=${searchMemoryReference(candidate, references)}`,
    `node=${candidate.node}`,
    `type=${candidate.type}`,
    ...temporalLabels(candidate),
    ...(candidate.chains.length > 0 ? [`chains=${candidate.chains.join(",")}`] : []),
    `preview=${candidate.preview}`,
  ];
  return `- ${flags.length > 0 ? `${flags.join(" ")} ` : ""}${fields.join("; ")}`;
}

/** Independent admitted candidate/bookmark rows for automatic context. Labels
 * and reference scope travel with each row even if neighbouring rows are omitted.
 */
export function searchInformationViews(context: MemoryContext): InformationView[] {
  const compact = compactSearchContext(context);
  const labels = [
    "[candidate preview; not exact evidence]",
    degradedRetrievalNote(compact.retrieval),
    compact.activeGraphId ? `activeGraphId=${compact.activeGraphId}` : "",
  ].filter(Boolean);
  const views: InformationView[] = compact.candidates.map((candidate) => ({
    purpose: "material",
    source: {
      kind: "memory",
      memoryId: candidate.id,
      activeGraphId: compact.activeGraphId ?? undefined,
    },
    body: searchCandidateLine(
      candidate,
      compact.activeGraphId ? context.memoryReferences : undefined,
    ),
    requiredLabels: labels,
    preview: true,
  }));
  for (const tessera of compact.tesserae ?? []) {
    const position = tessera.stale ? "(stale)" : tessera.line ? `:${tessera.line}` : "";
    views.push({
      purpose: "material",
      body: `- tessera=${tessera.path}${position}; label=${tessera.label || "(bookmark)"}`,
      requiredLabels: ["[bookmark; not exact evidence]"],
      preview: true,
    });
  }
  if (views.length === 0)
    views.push({
      purpose: "diagnostic",
      body: "No matching NMG memory found.",
      requiredLabels: [degradedRetrievalNote(compact.retrieval)].filter(Boolean),
    });
  return views;
}

function searchMemoryReference(
  candidate: CompactSearchCandidate,
  references: SearchSurfaceOptions["memoryReferences"],
): string {
  return !candidate.forgotten && references && Object.hasOwn(references, candidate.id)
    ? references[candidate.id]!
    : candidate.id;
}

function degradedRetrievalNote(retrieval: CompactSearchContext["retrieval"]): string {
  if (!retrieval?.degraded) return "";
  return `[degraded retrieval: mode=${retrieval.mode}; reason=${compactRetrievalReason(retrieval.reason)}] — results are lexical-only; vector ranking is unavailable.`;
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
  "Board conventions (on use): entries may carry memory=<id> references to LTG records — readers expand them with nmg_get; open entries can be claimed by one Agent (lease-based, expired claims return to the pool) and released; a claim ends in a deliverable — the holder records it with action=deliver (digest, optional ref/summary) and a *different* agent records the ruling with action=judge (accepted|rejected|undecidable, reason required), because a self-report is not an acceptance; resolve a request once it is answered — a resolved entry is closed and must not be replied to (reopen only with new substance); keep entries concise and temporary; taskId is the only channel boundary (no DMs, mentions, groups, or pinning).";

/** Host-neutral information preparation. Native envelopes remain adapter-owned. */
export function prepareTaskBoardSurface(
  result: TaskBoardSurfaceResult,
  options: TaskBoardSurfaceOptions,
): PreparedInformationOutput {
  if (result.action === "discover") {
    return prepareInformationOutput(discoveryViews(result.agents ?? []), options);
  }
  const views = [
    ...boardDirectoryViews(options.directory ?? []),
    ...boardItemViews(result, options),
  ];
  const cursor =
    (result.action === "read" || result.action === "readPreviews") && result.nextCursor
      ? { body: `nextCursor=${result.nextCursor}` }
      : null;
  if (cursor) views.push(cursor);
  views.push({ body: "Temporary coordination only." });
  if (options.includeConventions === true) views.push({ body: TASK_BOARD_CONVENTIONS });
  const output = prepareInformationOutput(views, options);
  // The transport cursor is not a promise that every fetched entry was shown.
  if (cursor && output.omitted.some((view) => view.requiredLabels?.length)) {
    return prepareInformationOutput(
      views.filter((view) => view !== cursor),
      options,
    );
  }
  return output;
}

/** Compatibility text interface used by ordinary tools on every host. */
export function renderTaskBoardSurface(
  result: TaskBoardSurfaceResult,
  options: TaskBoardSurfaceOptions,
): string {
  return prepareTaskBoardSurface(result, options).text;
}

function discoveryViews(agents: readonly TaskBoardAgentEntry[]): InformationView[] {
  if (agents.length === 0)
    return [{ body: "No online NMG agents match the requested capability." }];
  return [
    { body: "Online NMG agents:" },
    ...agents.map((agent) => ({
      body: `- ${agent.agentName}${agent.description ? ` — ${agent.description}` : ""}${agent.capabilities ? ` capabilities=${agent.capabilities}` : ""} (id=${agent.id ?? agent.agentName}; lastSeen=${agent.lastSeenAt})`,
    })),
    {
      body: "Use nmg_board action=put with to=<agent name> for directed delivery.",
    },
  ];
}

function boardDirectoryViews(directory: readonly TaskBoardDirectoryEntry[]): InformationView[] {
  if (directory.length === 0) return [];
  return [
    { body: "Active named channels (world channel lobby):" },
    ...directory.map((board) => ({
      body: `- ${board.taskId} (${board.entryCount} open · updated ${board.lastUpdatedAt.slice(0, 10)})`,
    })),
  ];
}

function boardItemViews(
  result: TaskBoardSurfaceResult,
  options: TaskBoardSurfaceOptions,
): InformationView[] {
  const views: InformationView[] = [];
  if (result.action === "readPreviews") {
    const previews = result.previews ?? [];
    if (previews.length > 0) {
      views.push({
        body: "Compact view (use action=read for bodies / nmg_get for pointers):",
      });
      views.push(...previews.map((entry) => boardEntryView(entry, options.taskId, true)));
      return views;
    }
  } else {
    if (result.action === "readInbox") views.push({ body: "Actionable for me:" });
    const entries = result.entries ?? (result.entry ? [result.entry] : []);
    if (entries.length > 0) {
      views.push(...entries.map((entry) => boardEntryView(entry, options.taskId, false)));
      return views;
    }
  }
  views.push({
    body: options.emptyText ?? `Task board ${options.taskId} has no matching entries.`,
  });
  return views;
}

function boardEntryView(
  entry: TaskBoardSurfaceEntry & TaskBoardSurfacePreview,
  taskId: string,
  previewOnly: boolean,
): InformationView {
  const channel = entry.taskId ?? taskId;
  const content = String(previewOnly ? (entry.preview ?? "") : (entry.content ?? ""));
  const body = boardBodyView(content, previewOnly ? 200 : 500);
  const preview = previewOnly || body !== content;
  return {
    source: entry.id ? { kind: "board", taskId: channel, entryId: entry.id } : undefined,
    body,
    requiredLabels: [boardEntryLabels(entry, taskId), ...(preview ? ["[preview]"] : [])],
    preview,
  };
}

function boardEntryLabels(
  entry: TaskBoardSurfaceEntry & TaskBoardSurfacePreview,
  taskId: string,
): string {
  const claim = entry.claimedBy ? ` [claimed by ${entry.claimedBy}]` : "";
  const ack = entry.ackedBy?.length
    ? ` (✅ acked by ${entry.ackedBy.join(", ")})`
    : entry.ackCount
      ? ` (✅ acked ${entry.ackCount})`
      : "";
  const channel = entry.taskId && entry.taskId !== taskId ? ` channel=${entry.taskId}` : "";
  const to = entry.to ? ` to=${entry.to}` : "";
  const serial = entry.serialState ? ` [${entry.serialState}]` : "";
  return `- ${String(entry.id ?? "?")} [${String(entry.kind ?? "entry")}/${String(entry.status ?? "open")}]${channel}${to}${serial}${claim}${ack}${renderJudgement(entry)} ${String(entry.agentId ?? "unknown")}:`;
}

/** Artifact identity and independent verdict remain protected display content. */
function renderJudgement(entry: {
  deliveredBy?: string | null;
  deliverableDigest?: string | null;
  verdict?: string | null;
  judgedBy?: string | null;
}): string {
  const digest = entry.deliverableDigest ? ` ${entry.deliverableDigest}` : "";
  const delivered = entry.deliveredBy ? ` [delivered by ${entry.deliveredBy}${digest}]` : "";
  const judged = entry.verdict ? ` [verdict ${entry.verdict} by ${entry.judgedBy ?? "?"}]` : "";
  return `${delivered}${judged}`;
}
