import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { boardEntryView } from "../core/board-entry-view.ts";
import { WORLD_BOARD_ID } from "../core/types.ts";
import type { TaskBoardToolEntry, TaskBoardToolResult } from "./tool-contract.ts";

/** Board wake plumbing shared by every harness adapter: configuration/state
 * persistence under the data directory, the daily budget gate, the pure
 * wake-candidate predicate, and candidate collection / deliver-gating over
 * the daemon `taskBoard` RPC. Adapters inject their own transport (`invoke`)
 * and their wake emission (`sendWake`), so no host API appears here. */

export interface BoardWakeConfig {
  enabled: boolean;
  budget: number;
  cooldownMs: number;
  intervalMs: number;
  /** When on, a collaboration-kind entry that wakes this session is also
   * announced on the world channel so other agents can pull it in. */
  worldBroadcast: boolean;
}

export interface BoardWakeState {
  budgetDate: string;
  budgetUsed: number;
  lastWakeAt: number;
}

/** Live entries a single wake tick may consider, each pinned to its board. */
export type WakeCandidate = TaskBoardToolEntry & { taskId: string };

export function readWakeConfig(dataDir: string): BoardWakeConfig {
  try {
    const raw = JSON.parse(
      readFileSync(join(dataDir, "board-wake.json"), "utf8"),
    ) as Partial<BoardWakeConfig>;
    return {
      enabled: raw.enabled !== false,
      // 0 = unlimited: budget 0 disables the daily cap, cooldownMs 0 removes the cooldown.
      budget: raw.budget === 0 ? 0 : Math.max(1, Number(raw.budget) || 8),
      cooldownMs: raw.cooldownMs === 0 ? 0 : Math.max(30_000, Number(raw.cooldownMs) || 600_000),
      intervalMs: Math.max(5_000, Number(raw.intervalMs) || 60_000),
      worldBroadcast: raw.worldBroadcast === true,
    };
  } catch {
    return {
      enabled: true,
      budget: 8,
      cooldownMs: 600_000,
      intervalMs: 60_000,
      worldBroadcast: false,
    };
  }
}

export function writeWakeConfig(config: BoardWakeConfig, dataDir: string): void {
  try {
    writeFileSync(join(dataDir, "board-wake.json"), JSON.stringify(config, null, 2), "utf8");
  } catch {
    // best-effort; a read-only directory just means the toggle cannot persist
  }
}

export function loadWakeState(dataDir: string): BoardWakeState {
  try {
    return JSON.parse(
      readFileSync(join(dataDir, "board-wake-state.json"), "utf8"),
    ) as BoardWakeState;
  } catch {
    return { budgetDate: "", budgetUsed: 0, lastWakeAt: 0 };
  }
}

export function saveWakeState(state: BoardWakeState, dataDir: string): void {
  try {
    writeFileSync(join(dataDir, "board-wake-state.json"), JSON.stringify(state), "utf8");
  } catch {
    // best-effort; losing dedup state only means an entry could re-notify
  }
}

/** Wake budget gate: returns false when the tick should stop (disabled,
 * cooling, budget exhausted) and mutates `state` for the daily budget reset. */
export function wakeBudgetGate(
  config: BoardWakeConfig,
  state: BoardWakeState,
  now: number,
): boolean {
  if (!config.enabled) return false;
  if (config.cooldownMs > 0 && now - state.lastWakeAt < config.cooldownMs) return false;
  const today = new Date(now).toISOString().slice(0, 10);
  if (state.budgetDate !== today) {
    state.budgetDate = today;
    state.budgetUsed = 0;
  }
  if (config.budget > 0 && state.budgetUsed >= config.budget) return false;
  return true;
}

/** Sentinel deliveries-table session used to dedup world-channel broadcasts:
 * each entry is broadcast at most once, keyed on (entry, this sentinel). */
export const WORLD_BROADCAST_SESSION = "world-broadcast";

/** Content prefix marking a world-channel pull broadcast (meta: it announces
 * another entry). Entries carrying it are never re-broadcast — otherwise a
 * broadcast wakes a session, which broadcasts the broadcast, recursively
 * flooding the world channel (observed live: #12→#13→#16…). */
export const BROADCAST_PREFIX = "[NMG board 协作广播]";

/** Broadcasts are transient pull notices: they announce another entry and must
 * not outlive it. RAII: give them a short TTL so an unanswered broadcast is
 * recycled (with its receipts) instead of accumulating as permanent open dead
 * state on the world channel. */
export const BROADCAST_TTL_SECONDS = 86_400;

/** Collaboration kinds worth pulling other agents in on; note/result/decision
 * updates are not broadcast, to keep the world channel quiet. */
export const BROADCAST_KINDS = new Set(["question", "blocker", "handoff"]);

export function kindLabel(kind: string): string {
  switch (kind) {
    case "question":
      return "问题";
    case "blocker":
      return "阻塞";
    case "handoff":
      return "交接";
    case "goal":
      return "目标";
    case "note":
      return "记录";
    case "decision":
      return "决定";
    case "result":
      return "结果";
    default:
      return "条目";
  }
}

/** Pure wake-candidate predicate for the board wake loop (exported for unit
 * testing). An entry wakes a session when it is open, is not an echo of the
 * receiving session, has NO live claim, is not a broadcast pull announcement,
 * AND its kind asks for a response/action — the same set as BROADCAST_KINDS
 * (question/blocker/handoff). Notify-only kinds (note/result/decision/goal)
 * are SILENT: they record a fact and owe no reply, so waking on them is the
 * acknowledgement storm — N agents confirming one fact each emit a note, and
 * every note wakes every subscriber (observed live: #36/#37/#38/#39 were four
 * confirmations of the same fact). Notify-only entries are read on demand,
 * never pushed. Claim liveness matters: a lapsed claim (lease expired; holder
 * crashed or stopped, no sweeper clears the column) returns the entry to the
 * pool, so it must wake again rather than be permanently hidden from its
 * former holder (audit finding 2026-08-13). */
export function isBoardWakeCandidate(
  entry: TaskBoardToolEntry,
  input: { sessionId: string; agentId: string; agentName?: string; now?: Date },
): boolean {
  const now = input.now ?? new Date();
  const ownEcho =
    entry.sourceSessionId === input.sessionId ||
    (entry.sourceSessionId == null && entry.agentId === input.agentId);
  const liveClaim =
    entry.claimExpiresAt != null && new Date(entry.claimExpiresAt).getTime() > now.getTime();
  // Directed delivery (find→direct): an entry addressed to another agent
  // never wakes me — only the addressee's LLM is woken. Matched against the
  // stable id OR the mutable display name (both are the same agent). Everyone
  // else sees it on read but stays silent.
  const addressedToOther =
    entry.to != null && entry.to !== input.agentId && entry.to !== input.agentName;
  // Reply-gated serial handoff: only the outstanding actionable wakes; pending
  // entries sit in the queue (read-visible) until the outstanding one is
  // claimed ("回复=接手") or resolved, which promotes them. Directed entries are
  // exempt (serialState is null for them — parallel-safe).
  const serialQueued = entry.serialState === "pending";
  return (
    entry.status === "open" &&
    BROADCAST_KINDS.has(entry.kind) &&
    !ownEcho &&
    !liveClaim &&
    !addressedToOther &&
    !serialQueued &&
    !entry.content.startsWith(BROADCAST_PREFIX)
  );
}

/** Collect wake candidates from the world channel, the directed inbox, and
 * subscribed named channels. Point-to-point delivery is an inbox, not topic
 * membership: a target must receive a directed handoff even before it has
 * discovered or joined the sender's named channel. `invoke` is the adapter's
 * daemon transport (lease RPC or CLI fallback). */
export async function collectWakeCandidates(
  invoke: (method: string, params: unknown) => Promise<unknown>,
  input: { agentId: string; agentName: string; sessionId: string },
): Promise<WakeCandidate[]> {
  const candidates: WakeCandidate[] = [];
  const candidateIds = new Set<string>();
  const { agentId, agentName, sessionId } = input;
  const collect = (taskId: string, entries: TaskBoardToolEntry[] | undefined) => {
    for (const entry of entries ?? []) {
      if (
        !candidateIds.has(entry.id) &&
        isBoardWakeCandidate(entry, { sessionId, agentId, agentName })
      ) {
        candidateIds.add(entry.id);
        candidates.push({ ...entry, taskId });
      }
    }
  };
  const world = (await invoke("taskBoard", {
    action: "read",
    taskId: WORLD_BOARD_ID,
    agentId,
  })) as TaskBoardToolResult;
  collect(WORLD_BOARD_ID, world.entries);
  const directed = (await invoke("taskBoard", {
    action: "readDirected",
    agentId,
    agentName,
  })) as { action: "readDirected"; entries: TaskBoardToolEntry[] };
  for (const entry of directed.entries ?? []) {
    const taskId = entry.taskId?.trim();
    if (taskId) collect(taskId, [entry]);
  }
  // Named channels: only channels this session explicitly subscribed to are
  // scanned. Topic-based membership — a non-member never receives wake
  // notices for a named channel, no matter how active it is. Discovery of
  // new channels happens by reading the world channel lobby, then joining
  // with subscribe.
  const subs = (await invoke("taskBoard", {
    action: "listSubscriptions",
    agentId,
    sessionId,
  })) as { action: "listSubscriptions"; subscriptions: Array<{ taskId: string }> };
  for (const board of subs.subscriptions ?? []) {
    const read = (await invoke("taskBoard", {
      action: "read",
      taskId: board.taskId,
      agentId,
    })) as TaskBoardToolResult;
    collect(board.taskId, read.entries);
  }
  return candidates;
}

/** Delivery protocol: ask the daemon which candidates are already delivered to
 * this session and which channels are suppressed (do-not-send), then keep
 * only undelivered, non-suppressed ones. */
export async function filterUndelivered(
  invoke: (method: string, params: unknown) => Promise<unknown>,
  candidates: WakeCandidate[],
  input: { agentId: string; sessionId: string },
): Promise<WakeCandidate[]> {
  const fresh: WakeCandidate[] = [];
  for (const taskId of new Set(candidates.map((candidate) => candidate.taskId))) {
    const check = (await invoke("taskBoard", {
      action: "deliveryCheck",
      taskId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      entryIds: candidates
        .filter((candidate) => candidate.taskId === taskId)
        .map((candidate) => candidate.id),
    })) as { delivered: string[]; acked: string[]; suppressed: boolean };
    if (check.suppressed) continue; // unsubscribed channel — skip entirely
    const delivered = new Set(check.delivered);
    const acked = new Set(check.acked ?? []);
    for (const candidate of candidates) {
      if (candidate.taskId === taskId && !delivered.has(candidate.id) && !acked.has(candidate.id)) {
        fresh.push(candidate);
      }
    }
  }
  return fresh;
}

/** Post a collaboration-pull broadcast on the world channel for an open entry
 * that woke this session, so other agents notice and can pull it in.
 * Broadcast is broadcast-style (a pull announcement, never addressed); the
 * delivery receipt under WORLD_BROADCAST_SESSION dedups it (once per entry),
 * and the wake loop's echo filter (sourceSessionId === this session) stops the
 * broadcaster from waking on its own post. Returns true when a broadcast was
 * actually posted. Injected `invoke` keeps the function unit-testable. */
export async function maybeBroadcastToWorld(input: {
  invoke: (method: string, params: unknown) => Promise<unknown>;
  entry: TaskBoardToolEntry & { taskId: string };
  agentId: string;
  sessionId: string;
}): Promise<boolean> {
  const { invoke, entry, agentId, sessionId } = input;
  // A broadcast entry is meta — it announces another entry. Re-broadcasting it
  // is how broadcast storms start (broadcast → wake → broadcast → …). The
  // original entry gets one pull broadcast; the broadcast itself never does.
  if (entry.content.startsWith(BROADCAST_PREFIX)) return false;
  const worldCheck = (await invoke("taskBoard", {
    action: "deliveryCheck",
    taskId: WORLD_BOARD_ID,
    agentId,
    sessionId: WORLD_BROADCAST_SESSION,
    entryIds: [entry.id],
  })) as { delivered: string[]; suppressed: boolean };
  if (worldCheck.delivered.includes(entry.id)) return false;
  const excerpt = boardEntryView(entry.content, 140);
  const label = kindLabel(entry.kind);
  const broadcast = `[NMG board 协作广播] 频道 ${entry.taskId} 有 #${entry.id} 未认领的${label}（open）：${excerpt}。有空的 agent 可用 nmg_state space=board action=read taskId=${entry.taskId} 查看详情、action=write operation=claim 认领处理。`;
  await invoke("taskBoard", {
    action: "put",
    taskId: WORLD_BOARD_ID,
    agentId,
    sourceSessionId: sessionId,
    kind: "handoff",
    content: broadcast,
    // RAII: a broadcast is a transient pull notice — recycle it (with its
    // receipts) after a day rather than leaving permanent open dead state.
    ttlSeconds: BROADCAST_TTL_SECONDS,
  });
  await invoke("taskBoard", {
    action: "recordDelivery",
    entryId: entry.id,
    sessionId: WORLD_BROADCAST_SESSION,
    agentId,
    source: "wake-broadcast",
  });
  return true;
}

/** Wake the agent for the top-priority fresh entry, record the delivery
 * receipt, optionally broadcast to the world channel, and consume the budget.
 * `sendWake` is the host's emission primitive (pi.sendUserMessage,
 * ctx.session.prompt, …); `dataDir` locates the wake state file. */
export async function deliverBoardWake(input: {
  invoke: (method: string, params: unknown) => Promise<unknown>;
  sendWake: (message: string) => void;
  config: BoardWakeConfig;
  state: BoardWakeState;
  dataDir: string;
  now: number;
  agentId: string;
  sessionId: string;
  entry: WakeCandidate;
}): Promise<void> {
  const { invoke, sendWake, config, state, dataDir, now, agentId, sessionId, entry } = input;
  const preview = entry.content.length > 140 ? `${entry.content.slice(0, 140)}…` : entry.content;
  const label = kindLabel(entry.kind);
  sendWake(
    `[NMG board] 你订阅的频道 ${entry.taskId} 有新${label}：#${entry.id} — ${preview}（open，可认领）。需要的话用 nmg_state space=board action=read 查看详情、action=write operation=claim 认领处理。`,
  );
  // Delivery receipt: this session has been reached for this entry, so the
  // wake loop will not re-notify it (idempotent in the store).
  await invoke("taskBoard", {
    action: "recordDelivery",
    entryId: entry.id,
    sessionId,
    agentId,
    source: "wake",
  });
  // Optional world-channel pull broadcast: when enabled and the entry is a
  // collaboration kind, announce it on the world channel so OTHER agents
  // notice and can pull it in. Broadcast is broadcast-style (a pull
  // announcement, never addressed), deduped once per entry via the
  // deliveries table under the sentinel session so an unanswered entry does
  // not re-broadcast every tick. The loop's own echo filter (sourceSessionId
  // === this session) stops the broadcaster from waking on its own post.
  if (
    config.worldBroadcast &&
    BROADCAST_KINDS.has(entry.kind) &&
    !entry.content.startsWith(BROADCAST_PREFIX)
  ) {
    await maybeBroadcastToWorld({ invoke, entry, agentId, sessionId });
  }
  state.budgetUsed += 1;
  state.lastWakeAt = now;
  saveWakeState(state, dataDir);
}
