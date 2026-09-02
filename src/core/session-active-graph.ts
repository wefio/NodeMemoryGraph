import { createHash, randomUUID } from "node:crypto";

import type { ActiveGraph, ActiveGraphEdge } from "./types.ts";

export type SessionActiveGraphItemKind =
  "semantic_memory" | "tool_observation" | "board_projection" | "reasoning_artifact";

export type SessionDisclosureLevel = "header" | "exact" | "evidence";

export interface SessionDisclosureEntry {
  memoryId: string;
  contentHash: string;
  disclosure: SessionDisclosureLevel;
  turn: number;
}

export interface SessionActiveGraphItem {
  id: string;
  kind: SessionActiveGraphItemKind;
  statement: string;
  sourceId: string | null;
  nodeId: string | null;
  taskFrameId: string;
  createdAt: string;
  lastActivatedAt: string;
  activation: number;
  temporary: boolean;
  /** Optional TTL in ms from `createdAt`. When set and expired, the item is
   * excluded from snapshots and evicted from the live graph. Used by
   * `reasoning_artifact` (hypothetical MGR output) so hypotheses expire
   * instead of lingering as if they were durable. */
  ttlMs?: number;
  /** Optional provenance tag for the item's origin (e.g. "mgr" for a
   * reasoning artifact, "bash" for a tool observation). Never implies durable
   * truth. */
  sourceKind?: string;
}

export interface ActiveGraphProjectionPart<TPart> {
  traceId: string;
  memoryIds: Set<string>;
  value: TPart;
}

export interface SessionActiveGraphProjection<TPart> {
  projectionId: string;
  agId: string;
  sessionId: string;
  taskFrameId: string;
  sequence: number;
  parentProjectionId: string | null;
  graph: ActiveGraph;
  parts: ReadonlyArray<ActiveGraphProjectionPart<TPart>>;
  createdAt: string;
}

export interface SessionActiveGraphSnapshot {
  agId: string;
  sessionId: string;
  activeTaskFrameId: string;
  projectionSequence: number;
  latestProjectionId: string | null;
  temporaryProjectionActive: boolean;
  items: SessionActiveGraphItem[];
  edges: ActiveGraphEdge[];
  /** Projection ids disclosed to the model (host-neutral disclosure ledger).
   * An adapter marks a projection as disclosed instead of keeping its own
   * injection window; the ledger is session-local and memory-resident. */
  disclosedProjectionIds: string[];
  /** Content-level disclosure ledger used by every adapter to fold unchanged
   * memory without confusing retrieval with model-visible evidence. */
  disclosureTurn: number;
  disclosures: SessionDisclosureEntry[];
}

export interface SessionActiveGraphRuntimeOptions {
  maxSessions?: number;
  maxItemsPerSession?: number;
  maxCharactersPerSession?: number;
  maxProjectionsPerSession?: number;
  /** Bounded cooling set: how many task frames (active + cooled) a session may
   * keep at once. The oldest cooled frame is evicted beyond this cap. */
  maxTaskFramesPerSession?: number;
  maxDisclosureTurns?: number;
  maxDisclosuresPerSession?: number;
  now?: () => number;
}

/** One semantic task partition inside AG: its own items, edges, and latest
 * projection. Frames other than the active one are the bounded "cooling set":
 * they keep their state so a task return does not reconstruct it, but they are
 * evicted LRU when the frame cap is exceeded. */
interface FrameState {
  taskFrameId: string;
  items: Map<string, SessionActiveGraphItem>;
  edges: Map<string, ActiveGraphEdge>;
  latestProjectionId: string | null;
  lastActivatedAt: number;
}

interface SessionState<TPart> {
  agId: string;
  sessionId: string;
  activeTaskFrameId: string;
  sequence: number;
  temporaryProjectionActive: boolean;
  projections: Map<string, SessionActiveGraphProjection<TPart>>;
  projectionOrder: string[];
  frames: Map<string, FrameState>;
  /** Host-neutral disclosure ledger: projection ids that have been surfaced to
   * the model. Session-local, memory-resident, cleared with the session. */
  disclosedProjectionIds: Set<string>;
  disclosureTurn: number;
  disclosures: Map<string, SessionDisclosureEntry>;
  touchedAt: number;
}

/**
 * Bounded, process-resident working graph shared by every daemon adapter.
 *
 * The graph is mutable, but every search creates a frozen projection revision.
 * Persistence remains the responsibility of STG/LTG and retrieval traces; this
 * class deliberately has no database path.
 */
export class SessionActiveGraphRuntime<TPart = unknown> {
  readonly #sessions = new Map<string, SessionState<TPart>>();
  readonly #projectionOwners = new Map<string, string>();
  readonly #now: () => number;
  readonly maxSessions: number;
  readonly maxItemsPerSession: number;
  readonly maxCharactersPerSession: number;
  readonly maxProjectionsPerSession: number;
  readonly maxTaskFramesPerSession: number;
  readonly maxDisclosureTurns: number;
  readonly maxDisclosuresPerSession: number;

  constructor(options: SessionActiveGraphRuntimeOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.maxSessions = bounded(options.maxSessions, 1, 4_096, 256);
    this.maxItemsPerSession = bounded(options.maxItemsPerSession, 1, 10_000, 256);
    this.maxCharactersPerSession = bounded(
      options.maxCharactersPerSession,
      256,
      10_000_000,
      32_000,
    );
    this.maxProjectionsPerSession = bounded(options.maxProjectionsPerSession, 1, 10_000, 128);
    this.maxTaskFramesPerSession = bounded(options.maxTaskFramesPerSession, 1, 1_024, 8);
    this.maxDisclosureTurns = bounded(options.maxDisclosureTurns, 1, 10_000, 12);
    this.maxDisclosuresPerSession = bounded(options.maxDisclosuresPerSession, 1, 100_000, 128);
  }

  registerProjection(
    graph: ActiveGraph,
    parts: Array<ActiveGraphProjectionPart<TPart>>,
  ): SessionActiveGraphProjection<TPart> {
    const sessionId = normalizedSessionId(graph.sessionId);
    const state = this.#state(sessionId, graph.taskId);
    const taskFrameId = graph.taskId.trim() || state.activeTaskFrameId;
    const frame = this.#activateFrame(state, taskFrameId);
    // Parent chain is frame-local: a projection belongs to the frame it was
    // frozen from, and returning to a cooled frame resumes that frame's own
    // chain rather than linking across frames.
    const parentProjectionId = frame.latestProjectionId;
    state.sequence += 1;
    const projectionId = randomUUID();
    const traceIds = [...new Set(parts.map((part) => part.traceId))];
    const createdAt = new Date(this.#now()).toISOString();
    const projectedGraph: ActiveGraph = deepFreezeGraph({
      ...graph,
      id: projectionId,
      agId: state.agId,
      projectionId,
      projectionSequence: state.sequence,
      parentProjectionId,
      taskFrameId,
      traceIds,
    });
    const projection: SessionActiveGraphProjection<TPart> = Object.freeze({
      projectionId,
      agId: state.agId,
      sessionId,
      taskFrameId,
      sequence: state.sequence,
      parentProjectionId,
      graph: projectedGraph,
      parts: Object.freeze(parts.map(copyPart)),
      createdAt,
    });
    frame.latestProjectionId = projectionId;
    state.projections.set(projectionId, projection);
    state.projectionOrder.push(projectionId);
    this.#projectionOwners.set(projectionId, sessionId);
    this.#activateProjectionItems(state, frame, projectedGraph, createdAt);
    this.#trimProjections(state);
    this.#touch(state);
    return projection;
  }

  projection(
    projectionId: string,
    sessionId?: string | null,
  ): SessionActiveGraphProjection<TPart> | null {
    const owner = this.#projectionOwners.get(projectionId);
    if (!owner) return null;
    if (sessionId?.trim() && normalizedSessionId(sessionId) !== owner) return null;
    return this.#sessions.get(owner)?.projections.get(projectionId) ?? null;
  }

  projectionOwner(projectionId: string): string | null {
    return this.#projectionOwners.get(projectionId) ?? null;
  }

  /** Record that a projection was disclosed to the model (host-neutral
   * disclosure ledger). Idempotent; the projection must belong to this
   * session. Adapters call this instead of maintaining their own injection
   * window, so "already in context" is one shared, session-owned record. */
  markDisclosed(projectionId: string, sessionId?: string | null): boolean {
    const owner = this.#projectionOwners.get(projectionId);
    if (!owner) return false;
    if (sessionId?.trim() && normalizedSessionId(sessionId) !== owner) return false;
    const state = this.#sessions.get(owner);
    if (!state) return false;
    state.disclosedProjectionIds.add(projectionId);
    this.#touch(state);
    return true;
  }

  /** Advance the session-owned model-turn clock and expire old disclosure
   * entries. Adapters call this once for a new user turn, never for tool-loop
   * re-entry within the same turn. */
  beginDisclosureTurn(sessionId: string): number {
    const state = this.#state(normalizedSessionId(sessionId));
    state.disclosureTurn += 1;
    for (const [memoryId, entry] of state.disclosures) {
      if (state.disclosureTurn - entry.turn >= this.maxDisclosureTurns) {
        state.disclosures.delete(memoryId);
      }
    }
    this.#touch(state);
    return state.disclosureTurn;
  }

  clearDisclosures(sessionId: string): boolean {
    const state = this.#sessions.get(normalizedSessionId(sessionId));
    if (!state) return false;
    state.disclosureTurn = 0;
    state.disclosures.clear();
    state.disclosedProjectionIds.clear();
    this.#touch(state);
    return true;
  }

  /** Atomically decide which candidate memories need model-visible rendering
   * and record the resulting disclosure depth. A deeper disclosure or changed
   * content is fresh; an unchanged equal/deeper entry is folded. */
  disclose(input: {
    sessionId: string;
    projectionId?: string | null;
    disclosure: SessionDisclosureLevel;
    entries: Array<{ memoryId: string; contentHash: string }>;
  }): { freshMemoryIds: string[]; foldedMemoryIds: string[] } {
    const sessionId = normalizedSessionId(input.sessionId);
    if (input.projectionId) {
      const owner = this.#projectionOwners.get(input.projectionId);
      if (!owner) throw new Error(`active graph ${input.projectionId} does not exist`);
      if (owner !== sessionId) {
        throw new Error(`active graph ${input.projectionId} belongs to another session`);
      }
    }
    const state = this.#state(sessionId);
    const freshMemoryIds: string[] = [];
    const foldedMemoryIds: string[] = [];
    for (const raw of input.entries) {
      const memoryId = raw.memoryId.trim();
      const contentHash = raw.contentHash.trim();
      if (!memoryId || !contentHash) continue;
      const previous = state.disclosures.get(memoryId);
      const alreadyAvailable =
        previous?.contentHash === contentHash &&
        disclosureRank(previous.disclosure) >= disclosureRank(input.disclosure);
      if (alreadyAvailable) {
        foldedMemoryIds.push(memoryId);
        continue;
      }
      freshMemoryIds.push(memoryId);
      state.disclosures.delete(memoryId);
      state.disclosures.set(memoryId, {
        memoryId,
        contentHash,
        disclosure: input.disclosure,
        turn: state.disclosureTurn,
      });
    }
    while (state.disclosures.size > this.maxDisclosuresPerSession) {
      const oldest = state.disclosures.keys().next().value;
      if (oldest === undefined) break;
      state.disclosures.delete(oldest);
    }
    if (input.projectionId) state.disclosedProjectionIds.add(input.projectionId);
    this.#touch(state);
    return { freshMemoryIds, foldedMemoryIds };
  }

  observe(input: {
    sessionId: string;
    statement: string;
    sourceId?: string | null;
    nodeId?: string | null;
    taskFrameId?: string;
    kind?: Exclude<SessionActiveGraphItemKind, "semantic_memory">;
    activation?: number;
    /** TTL in ms from creation; the item stops being surfaced once expired. */
    ttlMs?: number;
    /** Provenance tag (e.g. "mgr" for a reasoning artifact). */
    sourceKind?: string;
  }): { added: boolean; item: SessionActiveGraphItem } {
    const sessionId = normalizedSessionId(input.sessionId);
    const state = this.#state(sessionId, input.taskFrameId);
    const taskFrameId = input.taskFrameId?.trim() || state.activeTaskFrameId;
    const frame = this.#activateFrame(state, taskFrameId);
    const statement = input.statement.trim();
    if (!statement) throw new Error("Active Graph observation statement is required");
    const sourceId = input.sourceId?.trim() || null;
    const kind = input.kind ?? "tool_observation";
    const id = `ag-item:${hash(`${kind}\u0000${sourceId ?? ""}\u0000${statement}`)}`;
    const now = new Date(this.#now()).toISOString();
    const existing = frame.items.get(id);
    if (existing) {
      existing.lastActivatedAt = now;
      existing.activation = Math.max(existing.activation, clamp01(input.activation ?? 0.7));
      this.#touch(state);
      return { added: false, item: { ...existing } };
    }
    const item: SessionActiveGraphItem = {
      id,
      kind,
      statement,
      sourceId,
      nodeId: input.nodeId?.trim() || null,
      taskFrameId,
      createdAt: now,
      lastActivatedAt: now,
      activation: clamp01(input.activation ?? 0.7),
      temporary: true,
      ttlMs: input.ttlMs,
      sourceKind: input.sourceKind,
    };
    frame.items.set(id, item);
    this.#trimItems(state);
    this.#touch(state);
    return { added: true, item: { ...item } };
  }

  activateTemporaryProjection(sessionId: string): SessionActiveGraphSnapshot {
    const state = this.#state(normalizedSessionId(sessionId));
    state.temporaryProjectionActive = true;
    this.#touch(state);
    return this.snapshot(sessionId)!;
  }

  snapshot(sessionId: string): SessionActiveGraphSnapshot | null {
    const state = this.#sessions.get(normalizedSessionId(sessionId));
    if (!state) return null;
    this.#touch(state);
    const frame = state.frames.get(state.activeTaskFrameId);
    const nowMs = this.#now();
    const items = frame
      ? [...frame.items.values()]
          .filter((item) => this.#liveItem(item, nowMs))
          .filter((item) => item.kind === "semantic_memory" || state.temporaryProjectionActive)
          .sort((left, right) => right.activation - left.activation)
          .map((item) => ({ ...item }))
      : [];
    return {
      agId: state.agId,
      sessionId: state.sessionId,
      activeTaskFrameId: state.activeTaskFrameId,
      projectionSequence: state.sequence,
      latestProjectionId: frame?.latestProjectionId ?? null,
      temporaryProjectionActive: state.temporaryProjectionActive,
      items,
      edges: frame ? [...frame.edges.values()].map((edge) => ({ ...edge })) : [],
      disclosedProjectionIds: [...state.disclosedProjectionIds],
      disclosureTurn: state.disclosureTurn,
      disclosures: [...state.disclosures.values()].map((entry) => ({ ...entry })),
    };
  }

  /** Snapshot of one task frame (active or cooled), or null when the session
   * or frame does not exist. Lets an Agent inspect cooled state on task return. */
  taskFrame(sessionId: string, taskFrameId: string): SessionActiveGraphSnapshot | null {
    const state = this.#sessions.get(normalizedSessionId(sessionId));
    if (!state) return null;
    const frame = state.frames.get(taskFrameId.trim());
    if (!frame) return null;
    const nowMs = this.#now();
    const items = [...frame.items.values()]
      .filter((item) => this.#liveItem(item, nowMs))
      .filter((item) => item.kind === "semantic_memory" || state.temporaryProjectionActive)
      .sort((left, right) => right.activation - left.activation)
      .map((item) => ({ ...item }));
    return {
      agId: state.agId,
      sessionId: state.sessionId,
      activeTaskFrameId: taskFrameId.trim(),
      projectionSequence: state.sequence,
      latestProjectionId: frame.latestProjectionId,
      temporaryProjectionActive: state.temporaryProjectionActive,
      items,
      edges: [...frame.edges.values()].map((edge) => ({ ...edge })),
      disclosedProjectionIds: [...state.disclosedProjectionIds],
      disclosureTurn: state.disclosureTurn,
      disclosures: [...state.disclosures.values()].map((entry) => ({ ...entry })),
    };
  }

  release(sessionId: string): boolean {
    const key = normalizedSessionId(sessionId);
    const state = this.#sessions.get(key);
    if (!state) return false;
    for (const projectionId of state.projectionOrder) this.#projectionOwners.delete(projectionId);
    this.#sessions.delete(key);
    return true;
  }

  clear(): void {
    this.#sessions.clear();
    this.#projectionOwners.clear();
  }

  #state(sessionId: string, taskFrameId?: string): SessionState<TPart> {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = {
        agId: randomUUID(),
        sessionId,
        activeTaskFrameId: taskFrameId?.trim() || "session",
        sequence: 0,
        temporaryProjectionActive: false,
        projections: new Map(),
        projectionOrder: [],
        frames: new Map(),
        disclosedProjectionIds: new Set(),
        disclosureTurn: 0,
        disclosures: new Map(),
        touchedAt: this.#now(),
      };
      this.#sessions.set(sessionId, state);
      this.#trimSessions();
    }
    return state;
  }

  /** Make `taskFrameId` the active frame (creating it or reviving a cooled
   * one) and apply the bounded cooling-set eviction. Returns the frame. */
  #activateFrame(state: SessionState<TPart>, taskFrameId: string): FrameState {
    const key = taskFrameId.trim() || "session";
    let frame = state.frames.get(key);
    if (!frame) {
      frame = {
        taskFrameId: key,
        items: new Map(),
        edges: new Map(),
        latestProjectionId: null,
        lastActivatedAt: this.#now(),
      };
      state.frames.set(key, frame);
    }
    frame.lastActivatedAt = this.#now();
    state.activeTaskFrameId = key;
    this.#trimFrames(state);
    return frame;
  }

  #activateProjectionItems(
    state: SessionState<TPart>,
    frame: FrameState,
    graph: ActiveGraph,
    now: string,
  ): void {
    for (const selection of graph.selections) {
      const id = `memory:${selection.memoryId}`;
      const existing = frame.items.get(id);
      if (existing) {
        existing.lastActivatedAt = now;
        existing.activation = Math.max(existing.activation, clamp01(selection.scores.combined));
      } else {
        frame.items.set(id, {
          id,
          kind: "semantic_memory",
          statement: `memory:${selection.memoryId}`,
          sourceId: selection.memoryId,
          nodeId: selection.nodeId,
          taskFrameId: frame.taskFrameId,
          createdAt: now,
          lastActivatedAt: now,
          activation: clamp01(selection.scores.combined),
          temporary: false,
        });
      }
    }
    for (const edge of graph.edges) frame.edges.set(edge.id, { ...edge });
    this.#trimItems(state);
  }

  /** An item is live when it has no TTL or its TTL has not elapsed. Expired
   * items are excluded from snapshots; the live graph stops surfacing them. */
  #liveItem(item: SessionActiveGraphItem, nowMs: number): boolean {
    if (!item.ttlMs || item.ttlMs <= 0) return true;
    return Date.parse(item.createdAt) + item.ttlMs > nowMs;
  }

  /** Unified budget: the session's total items/characters across ALL frames
   * (active + cooled) must stay under the per-session caps. Evicts the
   * lowest-activation item anywhere, so tool observations, board projections,
   * and reasoning artifacts share one pool with retrieved semantic memories. */
  #trimItems(state: SessionState<TPart>): void {
    const all = [...state.frames.values()].flatMap((frame) =>
      [...frame.items.values()].map((item) => ({ frame, item })),
    );
    const ordered = all.sort((a, b) => compareEvictionPriority(a.item, b.item));
    let characters = ordered.reduce((sum, entry) => sum + entry.item.statement.length, 0);
    while (ordered.length > this.maxItemsPerSession || characters > this.maxCharactersPerSession) {
      const removed = ordered.shift();
      if (!removed) break;
      removed.frame.items.delete(removed.item.id);
      characters -= removed.item.statement.length;
    }
  }

  /** Bounded cooling set: evict the least-recently-activated frame beyond the
   * frame cap. The active frame is never evicted; a cooled frame is dropped
   * whole (its items/edges disappear with it, projections stay readable). */
  #trimFrames(state: SessionState<TPart>): void {
    while (state.frames.size > this.maxTaskFramesPerSession) {
      const active = state.activeTaskFrameId;
      const evictable = [...state.frames.values()]
        .filter((frame) => frame.taskFrameId !== active)
        .sort((a, b) => a.lastActivatedAt - b.lastActivatedAt);
      const oldest = evictable[0];
      if (!oldest) break;
      state.frames.delete(oldest.taskFrameId);
    }
  }

  #trimProjections(state: SessionState<TPart>): void {
    while (state.projectionOrder.length > this.maxProjectionsPerSession) {
      const removed = state.projectionOrder.shift();
      if (!removed) break;
      state.projections.delete(removed);
      state.disclosedProjectionIds.delete(removed);
      this.#projectionOwners.delete(removed);
    }
  }

  #trimSessions(): void {
    while (this.#sessions.size > this.maxSessions) {
      const oldest = [...this.#sessions.values()].sort((a, b) => a.touchedAt - b.touchedAt)[0];
      if (!oldest) break;
      this.release(oldest.sessionId);
    }
  }

  #touch(state: SessionState<TPart>): void {
    state.touchedAt = this.#now();
    this.#sessions.delete(state.sessionId);
    this.#sessions.set(state.sessionId, state);
  }
}

function disclosureRank(level: SessionDisclosureLevel): number {
  return { header: 0, exact: 1, evidence: 2 }[level];
}

function copyPart<TPart>(part: ActiveGraphProjectionPart<TPart>): ActiveGraphProjectionPart<TPart> {
  return Object.freeze({
    traceId: part.traceId,
    memoryIds: new Set(part.memoryIds),
    value: part.value,
  });
}

function deepFreezeGraph(graph: ActiveGraph): ActiveGraph {
  graph.nodeIds = Object.freeze([...graph.nodeIds]) as unknown as string[];
  graph.memoryIds = Object.freeze([...graph.memoryIds]) as unknown as string[];
  graph.traceIds = Object.freeze([...(graph.traceIds ?? [])]) as unknown as string[];
  graph.edges = Object.freeze(
    graph.edges.map((edge) => Object.freeze({ ...edge })),
  ) as unknown as ActiveGraphEdge[];
  graph.selections = Object.freeze(
    graph.selections.map((item) => Object.freeze({ ...item })),
  ) as unknown as ActiveGraph["selections"];
  graph.expansions = Object.freeze(
    graph.expansions.map((item) => Object.freeze({ ...item })),
  ) as unknown as ActiveGraph["expansions"];
  graph.budgetLedger = Object.freeze(
    graph.budgetLedger.map((item) => Object.freeze({ ...item })),
  ) as unknown as ActiveGraph["budgetLedger"];
  graph.budget = Object.freeze({ ...graph.budget });
  graph.usage = Object.freeze({
    ...graph.usage,
    exhausted: Object.freeze([
      ...graph.usage.exhausted,
    ]) as unknown as ActiveGraph["usage"]["exhausted"],
  });
  return Object.freeze(graph);
}

function compareEvictionPriority(
  left: SessionActiveGraphItem,
  right: SessionActiveGraphItem,
): number {
  if (left.activation !== right.activation) return left.activation - right.activation;
  return Date.parse(left.lastActivatedAt) - Date.parse(right.lastActivatedAt);
}

function normalizedSessionId(sessionId: string | null | undefined): string {
  return sessionId?.trim() || "__anonymous__";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 24);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function bounded(value: number | undefined, min: number, max: number, fallback: number): number {
  return Math.max(min, Math.min(max, Math.floor(value ?? fallback)));
}
