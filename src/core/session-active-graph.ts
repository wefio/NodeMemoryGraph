import { createHash, randomUUID } from "node:crypto";

import type { ActiveGraph, ActiveGraphEdge } from "./types.ts";

export type SessionActiveGraphItemKind =
  "semantic_memory" | "tool_observation" | "board_projection" | "reasoning_artifact";

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
}

export interface SessionActiveGraphRuntimeOptions {
  maxSessions?: number;
  maxItemsPerSession?: number;
  maxCharactersPerSession?: number;
  maxProjectionsPerSession?: number;
  now?: () => number;
}

interface SessionState<TPart> {
  agId: string;
  sessionId: string;
  activeTaskFrameId: string;
  sequence: number;
  latestProjectionId: string | null;
  temporaryProjectionActive: boolean;
  items: Map<string, SessionActiveGraphItem>;
  edges: Map<string, ActiveGraphEdge>;
  projections: Map<string, SessionActiveGraphProjection<TPart>>;
  projectionOrder: string[];
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
  }

  registerProjection(
    graph: ActiveGraph,
    parts: Array<ActiveGraphProjectionPart<TPart>>,
  ): SessionActiveGraphProjection<TPart> {
    const sessionId = normalizedSessionId(graph.sessionId);
    const state = this.#state(sessionId, graph.taskId);
    const taskFrameId = graph.taskId.trim() || state.activeTaskFrameId;
    const parentProjectionId =
      state.activeTaskFrameId === taskFrameId ? state.latestProjectionId : null;
    state.activeTaskFrameId = taskFrameId;
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
    state.latestProjectionId = projectionId;
    state.projections.set(projectionId, projection);
    state.projectionOrder.push(projectionId);
    this.#projectionOwners.set(projectionId, sessionId);
    this.#activateProjectionItems(state, projectedGraph, createdAt);
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

  observe(input: {
    sessionId: string;
    statement: string;
    sourceId?: string | null;
    nodeId?: string | null;
    taskFrameId?: string;
    kind?: Exclude<SessionActiveGraphItemKind, "semantic_memory">;
    activation?: number;
  }): { added: boolean; item: SessionActiveGraphItem } {
    const sessionId = normalizedSessionId(input.sessionId);
    const state = this.#state(sessionId, input.taskFrameId);
    const statement = input.statement.trim();
    if (!statement) throw new Error("Active Graph observation statement is required");
    const sourceId = input.sourceId?.trim() || null;
    const kind = input.kind ?? "tool_observation";
    const id = `ag-item:${hash(`${kind}\u0000${sourceId ?? ""}\u0000${statement}`)}`;
    const now = new Date(this.#now()).toISOString();
    const existing = state.items.get(id);
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
      taskFrameId: input.taskFrameId?.trim() || state.activeTaskFrameId,
      createdAt: now,
      lastActivatedAt: now,
      activation: clamp01(input.activation ?? 0.7),
      temporary: true,
    };
    state.items.set(id, item);
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
    const items = [...state.items.values()]
      .filter((item) => item.kind === "semantic_memory" || state.temporaryProjectionActive)
      .sort((left, right) => right.activation - left.activation)
      .map((item) => ({ ...item }));
    return {
      agId: state.agId,
      sessionId: state.sessionId,
      activeTaskFrameId: state.activeTaskFrameId,
      projectionSequence: state.sequence,
      latestProjectionId: state.latestProjectionId,
      temporaryProjectionActive: state.temporaryProjectionActive,
      items,
      edges: [...state.edges.values()].map((edge) => ({ ...edge })),
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
        latestProjectionId: null,
        temporaryProjectionActive: false,
        items: new Map(),
        edges: new Map(),
        projections: new Map(),
        projectionOrder: [],
        touchedAt: this.#now(),
      };
      this.#sessions.set(sessionId, state);
      this.#trimSessions();
    }
    return state;
  }

  #activateProjectionItems(state: SessionState<TPart>, graph: ActiveGraph, now: string): void {
    for (const selection of graph.selections) {
      const id = `memory:${selection.memoryId}`;
      const existing = state.items.get(id);
      if (existing) {
        existing.lastActivatedAt = now;
        existing.activation = Math.max(existing.activation, clamp01(selection.scores.combined));
      } else {
        state.items.set(id, {
          id,
          kind: "semantic_memory",
          statement: `memory:${selection.memoryId}`,
          sourceId: selection.memoryId,
          nodeId: selection.nodeId,
          taskFrameId: graph.taskFrameId ?? graph.taskId,
          createdAt: now,
          lastActivatedAt: now,
          activation: clamp01(selection.scores.combined),
          temporary: false,
        });
      }
    }
    for (const edge of graph.edges) state.edges.set(edge.id, { ...edge });
    this.#trimItems(state);
  }

  #trimItems(state: SessionState<TPart>): void {
    const ordered = [...state.items.values()].sort(compareEvictionPriority);
    let characters = ordered.reduce((sum, item) => sum + item.statement.length, 0);
    while (ordered.length > this.maxItemsPerSession || characters > this.maxCharactersPerSession) {
      const removed = ordered.shift();
      if (!removed) break;
      state.items.delete(removed.id);
      characters -= removed.statement.length;
    }
  }

  #trimProjections(state: SessionState<TPart>): void {
    while (state.projectionOrder.length > this.maxProjectionsPerSession) {
      const removed = state.projectionOrder.shift();
      if (!removed) break;
      state.projections.delete(removed);
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
