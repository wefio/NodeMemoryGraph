import type { InformationView, PreparedInformationOutput } from "../core/information-view.ts";
import type { CoordinationEvent } from "../core/coordination-events.ts";
import type { AgentProcessingState, AgentSessionActivity } from "../core/agent-activity.ts";
import { isCoordinationEventNotice } from "../core/coordination-events.ts";
import {
  isBoardDiscussionNotice,
  MAX_BOARD_DELIVERY_ENTRIES,
} from "../core/board-notifications.ts";
import { renderDiscussionNotice, renderEventNotice } from "./coordination-state.ts";
import { prepareInformationOutput } from "./information-output.ts";
import {
  filterUndelivered,
  maybeBroadcastToWorld,
  saveWakeState,
  BROADCAST_KINDS,
  type WakeCandidate,
  type BoardWakeConfig,
  type BoardWakeState,
} from "./board-wake.ts";

type Invoke = (method: string, params: unknown) => Promise<unknown>;
interface PhaseSnapshot {
  key: string;
  label: string;
}
const sending = new Set<string>();

function scopeKey(entry: WakeCandidate): string {
  return `${entry.eventId ?? ""}\n${entry.notificationChannelId ?? entry.taskId}`;
}

/** One oldest row per scope before another row from a busy scope. */
function fairOrder(entries: readonly WakeCandidate[]): WakeCandidate[] {
  const groups = new Map<string, WakeCandidate[]>();
  for (const entry of [...entries].sort(
    (a, b) =>
      String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) ||
      a.sequence - b.sequence ||
      a.id.localeCompare(b.id),
  )) {
    const key = scopeKey(entry);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const ordered: WakeCandidate[] = [];
  for (let offset = 0; ordered.length < entries.length; offset++)
    for (const group of groups.values()) if (group[offset]) ordered.push(group[offset]!);
  return ordered;
}

function entryBody(entry: WakeCandidate): string {
  if (isBoardDiscussionNotice(entry)) return renderDiscussionNotice(entry);
  if (isCoordinationEventNotice(entry)) return renderEventNotice(entry);
  const points = Array.from(entry.content);
  const preview = points.length > 1600 ? points.slice(0, 1599).join("") + "…" : entry.content;
  return `${preview}\nUse nmg_state to read this channel or claim actionable work.`;
}

export function prepareBoardWakeBatch(
  candidates: readonly WakeCandidate[],
  options: { maxCharacters?: number; phases?: ReadonlyMap<string, PhaseSnapshot> } = {},
): { information: PreparedInformationOutput; entries: WakeCandidate[] } {
  const unique = [...new Map(candidates.map((entry) => [entry.id, { ...entry }])).values()];
  const ordered = fairOrder(unique);
  const page = ordered.slice(0, MAX_BOARD_DELIVERY_ENTRIES);
  const views: InformationView[] = page.map((entry) => ({
    purpose: "material",
    source: { kind: "board", taskId: entry.taskId, entryId: entry.id },
    preview: true,
    requiredLabels: [
      `[notice=${entry.id} channel=${entry.notificationChannelId ?? entry.taskId} author=${entry.agentId}]`,
      ...(entry.eventId
        ? [options.phases?.get(entry.eventId)?.label ?? `[event=${entry.eventId} phase unknown]`]
        : []),
    ],
    body: entryBody(entry),
  }));
  const information = prepareInformationOutput(
    [
      {
        purpose: "guidance",
        body: "NMG board reply batch. Process available replies together. Discussion and event notices require no chat acknowledgement.",
      },
      ...(ordered.length > page.length
        ? [
            {
              purpose: "diagnostic" as const,
              body: `${ordered.length - page.length} additional sources remain pending beyond this transport page.`,
            },
          ]
        : []),
      ...views,
    ],
    { format: "context", maxCharacters: options.maxCharacters },
  );
  const admitted = new Set(
    information.included
      .filter((entry) => entry.source.kind === "board")
      .map((entry) => (entry.source.kind === "board" ? entry.source.entryId : "")),
  );
  return { information, entries: page.filter((entry) => admitted.has(entry.id)) };
}

async function phaseSnapshots(
  invoke: Invoke,
  entries: readonly WakeCandidate[],
  agentId: string,
): Promise<Map<string, PhaseSnapshot>> {
  const phases = new Map<string, PhaseSnapshot>();
  for (const eventId of new Set(
    entries.flatMap((entry) => (entry.eventId ? [entry.eventId] : [])),
  )) {
    const response = (await invoke("state", {
      space: "board",
      action: "read",
      operation: "eventRead",
      agentId,
      eventId,
      limit: 1,
    })) as { result?: { event?: CoordinationEvent } };
    const event = response?.result?.event;
    if (!event) throw Error("Board batch phase snapshot unavailable");
    const phase = event.collaboration;
    phases.set(eventId, {
      key: JSON.stringify([phase?.phase, phase?.phaseRevision, event.status]),
      label: `[event=${eventId} phase=${phase?.phase ?? "unspecified"} phaseRevision=${phase?.phaseRevision ?? 0} status=${event.status}; message phase provenance unknown]`,
    });
  }
  return phases;
}

export interface BoardWakeDispatchInput {
  invoke: Invoke;
  sendWake: (message: string) => void | Promise<unknown>;
  entries: readonly WakeCandidate[];
  dataDir: string;
  agentId: string;
  sessionId: string;
  maxCharacters?: number;
}
export interface BoardWakeBatchInput extends BoardWakeDispatchInput {
  config: BoardWakeConfig;
  state: BoardWakeState;
  now: number;
}

/** Concurrent ticks for a recipient share one dispatch boundary. Host idle gates
 * leave arrivals in the board until the next supported processing boundary. */
export async function deliverBoardWakeBatch(input: BoardWakeBatchInput): Promise<WakeCandidate[]> {
  const entries = await enqueueBoardWakeBatch(input);
  if (!entries.length) return [];
  input.state.budgetUsed++;
  input.state.lastWakeAt = input.now;
  saveWakeState(input.state, input.dataDir);
  if (input.config.worldBroadcast)
    for (const entry of entries)
      if (BROADCAST_KINDS.has(entry.kind))
        await maybeBroadcastToWorld({
          invoke: input.invoke,
          entry,
          agentId: input.agentId,
          sessionId: input.sessionId,
        });
  return entries;
}

export async function enqueueBoardWakeBatch(
  input: BoardWakeDispatchInput,
): Promise<WakeCandidate[]> {
  const key = `${input.dataDir}\n${input.sessionId}`;
  if (sending.has(key)) return [];
  sending.add(key);
  try {
    return await dispatchBatch(input);
  } finally {
    sending.delete(key);
  }
}

async function dispatchBatch(input: BoardWakeDispatchInput): Promise<WakeCandidate[]> {
  const batch = await preparePendingBoardWake(input);
  if (!batch.entries.length) return [];
  await input.sendWake(batch.information.text);
  await recordBoardWakeBatchDelivery(input.invoke, batch.entries, input.agentId, input.sessionId);
  return batch.entries;
}

export async function readBoardAgentActivity(
  invoke: Invoke,
  agentId: string,
  sessionId: string,
): Promise<AgentSessionActivity> {
  const result = (await invoke("state", {
    space: "board",
    action: "read",
    operation: "agentActivity",
    agentId,
    sessionId,
  })) as { result?: { agentActivity?: AgentSessionActivity } };
  if (!result?.result?.agentActivity) throw Error("Board agent activity unavailable");
  return result.result.agentActivity;
}

export async function reportHarnessActivity(
  invoke: Invoke,
  agentId: string,
  sessionId: string,
  state: AgentProcessingState,
  capabilities: string[],
): Promise<void> {
  await invoke("state", {
    space: "board",
    action: "write",
    operation: "agentActivity",
    agentId,
    sessionId,
    activity: { source: "harness", state, capabilities },
  });
}

export async function preparePendingBoardWake(
  input: Omit<BoardWakeDispatchInput, "sendWake">,
): Promise<ReturnType<typeof prepareBoardWakeBatch>> {
  const { invoke, agentId, sessionId } = input;
  if ((await readBoardAgentActivity(invoke, agentId, sessionId)).state === "busy")
    return prepareBoardWakeBatch([]);
  const fresh = await filterUndelivered(invoke, [...input.entries], { agentId, sessionId });
  const phases = await phaseSnapshots(invoke, fresh, agentId);
  const ready = await filterUndelivered(invoke, fresh, { agentId, sessionId });
  const batch = prepareBoardWakeBatch(ready, { maxCharacters: input.maxCharacters, phases });
  if (!batch.entries.length) return batch;
  const current = await phaseSnapshots(invoke, batch.entries, agentId);
  for (const [id, phase] of current)
    if (phase.key !== phases.get(id)?.key)
      throw Error("Board batch phase changed during preparation");
  if ((await readBoardAgentActivity(invoke, agentId, sessionId)).state === "busy")
    return prepareBoardWakeBatch([]);
  return batch;
}

/** Called only after a host accepts the exact prepared fragment. Older daemons
 * retain per-entry receipts and at-least-once retry after a partial failure. */
export async function recordBoardWakeBatchDelivery(
  invoke: Invoke,
  entries: readonly WakeCandidate[],
  agentId: string,
  sessionId: string,
): Promise<void> {
  if (!entries.length) return;
  const hello = (await invoke("hello", {})) as { capabilities?: string[] };
  if (hello?.capabilities?.includes("board-wake-batches")) {
    await invoke("taskBoard", {
      action: "recordDelivery",
      agentId,
      sessionId,
      entryIds: entries.map((entry) => entry.id),
      source: "wake-batch",
    });
    return;
  }
  for (const entry of entries)
    await invoke("taskBoard", {
      action: "recordDelivery",
      agentId,
      sessionId,
      entryId: entry.id,
      source: "wake-batch",
    });
}
