import type { NmgStore } from "../core/store.ts";
import {
  coordinationNames,
  coordinationText,
  parseCoordinationMutation,
} from "../core/coordination-events.ts";
import type {
  AgentWorkStatus,
  CoordinationEvent,
  CoordinationEventChange,
} from "../core/coordination-events.ts";
import type { InformationView, PreparedInformationOutput } from "../core/information-view.ts";
import { prepareInformationOutput } from "./information-output.ts";
import { loadPrompts, renderDisclosure } from "../prompts/load.ts";

export function renderDiscussionNotice(entry: {
  content: string;
  notificationChannelId?: string;
  notificationSourceId?: string;
  invitation?: boolean;
}): string {
  // Invitation bodies are validated at 3000 chars; ordinary channel posts can be much longer.
  const maximum = entry.invitation ? 4000 : 1600;
  const preview = entry.content.length > maximum;
  const body = renderDisclosure(loadPrompts().board_discussion_disclosure, {
    content: preview ? entry.content.slice(0, maximum) + "…" : entry.content,
    channelId: entry.notificationChannelId ?? "",
    enrollment: entry.invitation
      ? "Invitation: you and the organizer are subscribed to this channel; you may unsubscribe."
      : "Discussion notice; its direct/channel/event scopes remain independent.",
  });
  return prepareInformationOutput([
    {
      source:
        entry.notificationChannelId && entry.notificationSourceId
          ? {
              kind: "board",
              taskId: entry.notificationChannelId,
              entryId: entry.notificationSourceId,
            }
          : undefined,
      body,
      requiredLabels: [
        `[source channel=${entry.notificationChannelId ?? "?"} entry=${entry.notificationSourceId ?? "?"}]`,
        ...(preview ? ["[preview; read the original message for full content]"] : []),
      ],
      preview,
    },
  ]).text;
}

export function renderEventNotice(entry: { content: string; eventId?: string }): string {
  return renderDisclosure(loadPrompts().board_event_update_disclosure, {
    content: entry.content,
    eventId: entry.eventId ?? "",
  });
}

export const COORDINATION_READ_OPERATIONS = ["eventRead", "agentStatus"] as const;
export const COORDINATION_WRITE_OPERATIONS = [
  "eventCreate",
  "eventUpdate",
  "eventSubscribe",
  "eventUnsubscribe",
  "eventDelete",
  "agentStatus",
] as const;
export const COORDINATION_OPERATIONS: ReadonlySet<string> = new Set([
  ...COORDINATION_READ_OPERATIONS,
  ...COORDINATION_WRITE_OPERATIONS,
]);
export interface CoordinationEventSummary {
  id: string;
  title: string;
  status: CoordinationEvent["status"];
  revision: number;
  updatedAt: string;
  channelCount: number;
  activeEffects: number;
}
export interface CoordinationStateResult {
  action:
    (typeof COORDINATION_READ_OPERATIONS)[number] | (typeof COORDINATION_WRITE_OPERATIONS)[number];
  event?: CoordinationEvent;
  events?: CoordinationEventSummary[];
  changes?: CoordinationEventChange[];
  historyOnly?: boolean;
  nextRevision?: number;
  nextOffset?: number;
  members?: Array<{ agentId: string; subscribed: boolean; associated: boolean }>;
  channelDetails?: Array<{ channelId: string; available: boolean }>;
  eventId?: string;
  subscribed?: boolean;
  deleted?: boolean;
  agentStatus?: AgentWorkStatus;
}
export function coordinationSummary(event: CoordinationEvent): CoordinationEventSummary {
  return {
    id: event.id,
    title: event.title,
    status: event.status,
    revision: event.revision,
    updatedAt: event.updatedAt,
    channelCount: event.channels.length,
    activeEffects: event.effects.filter((effect) => effect.state === "active").length,
  };
}
function inputObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("event must be an object");
  return value as Record<string, unknown>;
}
function revision(value: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    throw new Error("event expectedRevision/afterRevision must be a safe integer");
  return Number(value);
}

/** One validation/dispatch owner for every native schema and CLI. */
export function executeCoordinationState(
  store: NmgStore,
  operation: string,
  params: Record<string, unknown>,
): CoordinationStateResult {
  const actor = coordinationText(params.agentId, "agentId", 200),
    data = inputObject(params.event);
  const id = () => coordinationText(params.eventId, "eventId", 200);
  if (operation === "agentStatus")
    return {
      action: operation,
      agentStatus:
        params.action === "write"
          ? store.setAgentStatusNote({
              agentId: actor,
              text: coordinationText(params.text, "status note", 500, true),
            })
          : store.getAgentWorkStatus(actor),
    };
  if (operation === "eventCreate")
    return {
      action: operation,
      event: store.createCoordinationEvent({
        agentId: actor,
        title: coordinationText(data.title, "event title", 200),
        summary: coordinationText(data.summary ?? "", "event summary", 3000, true),
        parentId:
          data.parentId === undefined
            ? undefined
            : coordinationText(data.parentId, "parentId", 200),
        participants: coordinationNames(data.participants, "participants"),
        resources: coordinationNames(data.resources, "resources"),
        dependencies: coordinationNames(data.dependencies, "dependencies"),
      }),
    };
  if (operation === "eventRead")
    return params.eventId === undefined
      ? listEvents(store, params, data)
      : {
          action: operation,
          historyOnly: data.historyOnly === true,
          ...store.readCoordinationEvent(id(), {
            afterRevision: data.afterRevision === undefined ? 0 : revision(data.afterRevision, 0),
            limit: typeof params.limit === "number" ? params.limit : undefined,
          }),
        };
  if (operation === "eventUpdate")
    return {
      action: operation,
      event: store.updateCoordinationEvent({
        eventId: id(),
        agentId: actor,
        expectedRevision: revision(data.expectedRevision),
        change: parseCoordinationMutation(data),
      }),
    };
  return subscriptionOrDelete(store, operation, id(), actor, data);
}
function listEvents(
  store: NmgStore,
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): CoordinationStateResult {
  const offset = data.offset === undefined ? 0 : revision(data.offset, 0);
  const limit = Math.min(params.limit === undefined ? 20 : revision(params.limit), 200);
  const events = store
    .listCoordinationEvents({ includeEnded: params.includeResolved === true, limit, offset })
    .map(coordinationSummary);
  return {
    action: "eventRead",
    events,
    ...(events.length === limit ? { nextOffset: offset + events.length } : {}),
  };
}

function subscriptionOrDelete(
  store: NmgStore,
  operation: string,
  eventId: string,
  agentId: string,
  data: Record<string, unknown>,
): CoordinationStateResult {
  if (operation === "eventDelete") {
    store.deleteCoordinationEvent({
      eventId,
      agentId,
      expectedRevision: revision(data.expectedRevision),
    });
    return { action: operation, eventId, deleted: true };
  }
  if (operation === "eventSubscribe") store.subscribeCoordinationEvent({ eventId, agentId });
  else if (operation === "eventUnsubscribe")
    store.unsubscribeCoordinationEvent({ eventId, agentId });
  else throw new Error("Unknown coordination operation");
  return { action: operation, eventId, subscribed: operation === "eventSubscribe" };
}

export function coordinationDirectoryViews(
  events: readonly CoordinationEventSummary[],
): InformationView[] {
  if (!events.length) return [];
  return [
    {
      body: "Event records (bounded list; ordinary world messages remain available; expand with state eventRead eventId):",
    },
    ...events.map((event) => ({
      source: {
        kind: "event" as const,
        eventId: event.id,
        revision: event.revision,
        part: "record" as const,
      },
      requiredLabels: [`event=${event.id} r${event.revision} [${event.status}]`],
      body: `${event.title}; channels=${event.channelCount}; activeEffects=${event.activeEffects}`,
    })),
  ];
}
export function agentStatusViews(status: AgentWorkStatus): InformationView[] {
  return [
    {
      source: { kind: "agent", agentId: status.agentId },
      requiredLabels: [`agent=${status.agentId} [${status.activity}] tasks=${status.taskCount}`],
      body:
        `${status.statusNote ? `Note: ${status.statusNote}\n` : ""}${status.tasks.map((task) => `${task.taskId} #${task.entryId}${task.eventId ? ` event=${task.eventId}` : ""}: ${task.summary}`).join("\n")}` ||
        "No registered active tasks.",
    },
  ];
}
function eventDetailViews(result: CoordinationStateResult): InformationView[] {
  const event = result.event;
  if (!event || result.historyOnly) return [];
  return [
    {
      source: { kind: "event", eventId: event.id, revision: event.revision, part: "record" },
      requiredLabels: [`event=${event.id} r${event.revision} [${event.status}]`],
      body: JSON.stringify(event),
    },
    ...(result.members ?? []).map((member): InformationView => ({
      purpose: "state",
      source: { kind: "agent", agentId: member.agentId },
      requiredLabels: [`event=${event.id} agent=${member.agentId}`],
      body: `Historical association=${member.associated}; subscribed=${member.subscribed}. Active work is shown separately by agentStatus/discover.`,
    })),
    ...(result.channelDetails ?? []).map((channel): InformationView => ({
      purpose: "diagnostic",
      body: channel.available
        ? `Channel ${channel.channelId} details available through ordinary board reads (TTL applies).`
        : `Channel ${channel.channelId} details unavailable (expired or absent); the coarse event summary remains.`,
    })),
  ];
}

export function prepareCoordinationSurface(
  result: CoordinationStateResult,
): PreparedInformationOutput {
  const views: InformationView[] = [];
  if (result.events) views.push(...coordinationDirectoryViews(result.events));
  if (result.agentStatus) views.push(...agentStatusViews(result.agentStatus));
  if (result.event)
    views.push({
      source: {
        kind: "event",
        eventId: result.event.id,
        revision: result.event.revision,
        part: "record",
      },
      preview: true,
      requiredLabels: [
        `event=${result.event.id} r${result.event.revision} [${result.event.status}] [current reference] [preview]`,
      ],
      body: `${result.event.title}; outcome=${result.event.outcome ?? "unspecified"}. Use event.historyOnly=true for history without repeating the full snapshot.`,
    });
  views.push(...eventDetailViews(result));
  for (const change of result.changes ?? [])
    views.push({
      source: {
        kind: "event",
        eventId: result.event!.id,
        revision: change.revision,
        part: "change",
      },
      requiredLabels: [
        `event=${result.event!.id} r${change.revision} ${change.kind} by ${change.actorId} at ${change.createdAt}`,
      ],
      body: JSON.stringify(change.payload),
    });
  if (result.nextOffset !== undefined)
    views.push({
      body: `nextOffset=${result.nextOffset}; continue eventRead with event.offset (directory pages are live views, not snapshots).`,
    });
  if (!views.length) views.push({ body: JSON.stringify(result) });
  views.push({ body: "Coordination declarations, not proof of success or resource availability." });
  const prepared = prepareInformationOutput(views);
  if (result.nextRevision !== undefined && prepared.omitted.length === 0)
    return prepareInformationOutput([...views, { body: `nextRevision=${result.nextRevision}` }]);
  return prepared;
}
