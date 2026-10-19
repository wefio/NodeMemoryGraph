import { containsSecret } from "./write-policy.ts";

export const EVENT_NOTICE_CHANNEL = "__nmg_event_updates__";
export function isCoordinationEventNotice(entry: {
  eventNotice?: unknown;
  eventId?: unknown;
  eventRevision?: unknown;
  to?: unknown;
}): boolean {
  return (
    entry.eventNotice === true &&
    typeof entry.eventId === "string" &&
    entry.eventId.length > 0 &&
    typeof entry.eventRevision === "number" &&
    Number.isSafeInteger(entry.eventRevision) &&
    entry.eventRevision > 0 &&
    typeof entry.to === "string"
  );
}
export interface CoordinationChannel {
  channelId: string;
  summary: string;
  state: "active" | "ended" | "abandoned";
}
export interface CoordinationEffect {
  id: string;
  resource: string;
  condition: string;
  state: "active" | "released";
  owner: string;
}
export interface CoordinationEvent {
  id: string;
  title: string;
  summary: string;
  initiator: string;
  updatedBy: string;
  status: "active" | "ended";
  outcome: string | null;
  revision: number;
  parentId: string | null;
  dependencies: string[];
  participants: string[];
  resources: string[];
  channels: CoordinationChannel[];
  effects: CoordinationEffect[];
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}
export interface CoordinationEventChange {
  revision: number;
  actorId: string;
  kind: string;
  text: string;
  payload: CoordinationMutation | { kind: "created"; text: string; record: CoordinationEvent };
  createdAt: string;
}
export type CoordinationMutation =
  | { kind: "note" | "close" | "reopen"; text: string; outcome?: string }
  | { kind: "channel"; text: string; channel: CoordinationChannel }
  | {
      kind: "relations";
      text: string;
      participants?: string[];
      resources?: string[];
      dependencies?: string[];
    }
  | { kind: "effect"; text: string; effect: Omit<CoordinationEffect, "owner"> };
export interface CreateCoordinationEvent {
  agentId: string;
  title: string;
  summary?: string;
  parentId?: string;
  dependencies?: string[];
  participants?: string[];
  resources?: string[];
}
export interface UpdateCoordinationEvent {
  eventId: string;
  agentId: string;
  expectedRevision: number;
  change: CoordinationMutation;
}
export interface AgentWorkStatus {
  agentId: string;
  activity: "idle" | "working";
  statusNote: string;
  taskCount: number;
  tasks: Array<{ entryId: string; taskId: string; summary: string; eventId?: string }>;
}

export function coordinationText(
  value: unknown,
  field: string,
  maximum = 3000,
  empty = false,
): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > maximum)
    throw new Error(`${field} must be ${empty ? "0" : "1"}..${maximum} characters`);
  if (containsSecret(value.normalize("NFKC"))) throw new Error(`${field} cannot contain secrets`);
  return value.trim();
}
export function coordinationPageLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("Event page limit must be a positive safe integer");
  return Math.min(limit, 200);
}

export function coordinationNames(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32)
    throw new Error(`${field} must be an array of at most 32 strings`);
  return [...new Set(value.map((item) => coordinationText(item, field, 200)))];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("event input must be an object");
  return value as Record<string, unknown>;
}
function oneOf<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (!choices.includes(value as T)) throw new Error(`Invalid ${field}`);
  return value as T;
}
export function parseCoordinationMutation(value: unknown): CoordinationMutation {
  const data = object(value),
    text = coordinationText(data.text, "event text");
  const kind = oneOf(
    data.kind,
    ["note", "close", "reopen", "channel", "relations", "effect"] as const,
    "event change kind",
  );
  if (kind === "channel") {
    const channel = object(data.channel);
    return {
      kind,
      text,
      channel: {
        channelId: coordinationText(channel.channelId, "channelId", 200),
        summary: coordinationText(channel.summary, "channel summary", 1000),
        state: oneOf(channel.state, ["active", "ended", "abandoned"] as const, "channel state"),
      },
    };
  }
  if (kind === "effect") {
    const effect = object(data.effect);
    return {
      kind,
      text,
      effect: {
        id: coordinationText(effect.id, "effect id", 200),
        resource: coordinationText(effect.resource, "resource", 200),
        condition: coordinationText(effect.condition, "release condition", 1000, true),
        state: oneOf(effect.state, ["active", "released"] as const, "effect state"),
      },
    };
  }
  if (kind === "relations")
    return {
      kind,
      text,
      ...(data.participants === undefined
        ? {}
        : { participants: coordinationNames(data.participants, "participants") }),
      ...(data.resources === undefined
        ? {}
        : { resources: coordinationNames(data.resources, "resources") }),
      ...(data.dependencies === undefined
        ? {}
        : { dependencies: coordinationNames(data.dependencies, "dependencies") }),
    };
  return {
    kind,
    text,
    ...(data.outcome === undefined
      ? {}
      : { outcome: coordinationText(data.outcome, "outcome", 200) }),
  };
}

function applyEffect(
  effects: CoordinationEffect[],
  effect: Omit<CoordinationEffect, "owner">,
  actor: string,
): CoordinationEffect[] {
  const previous = effects.find((item) => item.id === effect.id);
  if (previous && previous.owner !== actor)
    throw new Error("Only the effect owner may change or release it");
  if (!previous && effect.state === "released") throw new Error("Cannot release an unknown effect");
  return [...effects.filter((item) => item.id !== effect.id), { ...effect, owner: actor }];
}

/** Pure domain transition: no scheduler, resource actuation or participant/task cleanup. */
export function applyCoordinationMutation(
  event: CoordinationEvent,
  change: CoordinationMutation,
  actor: string,
): CoordinationEvent {
  const next = structuredClone(event);
  if (change.kind === "channel") {
    if (next.status === "ended" && change.channel.state === "active")
      throw new Error("Reopen event before activating a channel");
    next.channels = next.channels.filter(
      (channel) => channel.channelId !== change.channel.channelId,
    );
    next.channels.push(change.channel);
  } else if (change.kind === "effect") {
    next.effects = applyEffect(next.effects, change.effect, actor);
  } else if (change.kind === "relations") {
    next.participants = [...new Set([...next.participants, ...(change.participants ?? [])])];
    next.resources = change.resources ?? next.resources;
    next.dependencies = change.dependencies ?? next.dependencies;
  } else if (change.kind === "close") {
    if (next.status === "ended") throw new Error("Event is already ended");
    next.status = "ended";
    next.outcome = change.outcome ?? null;
  } else if (change.kind === "reopen") {
    if (next.status === "active") throw new Error("Event is already active");
    next.status = "active";
    next.outcome = null;
    next.endedAt = null;
  }
  return next;
}
