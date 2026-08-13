#!/usr/bin/env node
/**
 * NMG hook for Kimi Code CLI.
 *
 * Kimi Code hooks receive one JSON payload on stdin; for events that affect
 * the main flow (PreToolUse, Stop, UserPromptSubmit) stdout text is attached
 * to the context on exit 0. PostToolUse is observational — its output is
 * ignored — so the git-commit nudge must hook PreToolUse instead.
 *
 * Events handled:
 *   UserPromptSubmit — completion keywords (done/完成了/收工/…) → nudge
 *                      + task-board wake poll (see below)
 *   PreToolUse(Bash) — `git commit` in the command              → nudge
 *
 * Board wake (degraded equivalent of the Pi extension's wake loop): Kimi
 * hooks are event-driven with no background timer, so instead of pushing
 * notices while idle, each UserPromptSubmit polls the daemon for new open
 * entries on the world channel plus explicitly subscribed channels. Same
 * protocol as Pi: own-echo entries are skipped, LIVE claims suppress the
 * entry (a lapsed claim returns it to the pool and wakes again — matching the
 * e68ce7b isBoardWakeCandidate fix), broadcast entries are never pushed,
 * and only actionable kinds wake (question/blocker/handoff — matching the
 * 3f9d62b notify-only-is-silent fix; pushing note/result/decision/goal is
 * the acknowledgement storm, since every confirmation note would wake every
 * session). deliveryCheck filters already-notified ones, and a
 * recordDelivery receipt is written for the picked entry so it never
 * re-notifies. Budget and
 * cooldown come from the shared <dataDir>/board-wake.json (enabled defaults
 * to off); dedup state is per-host in kimi-board-wake-state.json.
 *
 * The hook is deliberately passive: it never starts a daemon. It only polls
 * when a live HTTP lease exists (<dataDir>/nmg.sqlite.server.json with an
 * alive pid). All failures are silent — exit 0 always.
 *
 * Payload shapes are defensive: the prompt may be a plain string or a
 * ContentPart[] array ({type:"text", text}); both are handled.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const NUDGE = [
  "<nmg_nudge>",
  "A code commit or task completion was just detected. NMG long-term memory is",
  "available: you may recall relevant decisions (nmg_search) or save this",
  "turn's key conclusions (nmg_remember) if useful. This is only a reminder;",
  "it does not affect the current work.",
  "</nmg_nudge>",
].join("\n");

const COMPLETION_PATTERN =
  /(?:完成了|收工|搞定|结束|提交了|committed|done|finished|wrapped\s+up)/iu;

const WORLD_BOARD_ID = "default";
const BROADCAST_PREFIX = "[NMG board 协作广播]";
// Wake routing: only kinds that ask for a response/action may push. The
// notify-only kinds (goal/note/decision/result) are silent by convention —
// same set as the Pi extension's BROADCAST_KINDS.
const WAKE_KINDS = new Set(["question", "blocker", "handoff"]);
const KIND_RANK = { question: 0, blocker: 1, handoff: 2 };
const KIND_LABEL = {
  question: "问题",
  blocker: "阻塞",
  handoff: "交接",
  goal: "目标",
  note: "记录",
  decision: "决定",
  result: "结果",
};
// Per-call ceiling: the UserPromptSubmit hook timeout is 5s and the poll is
// several sequential RPCs, so each call gets a tight budget.
const RPC_TIMEOUT_MS = 2_000;

function promptText(payload) {
  const prompt = payload?.prompt;
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function isGitCommit(payload) {
  const command = payload?.tool_input?.command;
  return typeof command === "string" && /\bgit\s+commit\b/u.test(command);
}

function shouldNudge(payload) {
  const event = payload?.hook_event_name ?? payload?.event;
  if (event === "UserPromptSubmit") return COMPLETION_PATTERN.test(promptText(payload));
  if (event === "PreToolUse") {
    const toolName = payload?.tool_name ?? "";
    return /^(bash|shell)$/iu.test(toolName) && isGitCommit(payload);
  }
  return false;
}

function isPromptSubmit(payload) {
  const event = payload?.hook_event_name ?? payload?.event;
  return event === "UserPromptSubmit";
}

/** Pure board-wake gate shared by the poller and tests. A claim suppresses a
 * notice only while its lease is live; stale claim columns are lazy-expired by
 * design and must return to the candidate pool. Notify-only kinds never wake. */
export function isBoardWakeCandidate(entry, { sessionId, agentId, now = Date.now() }) {
  const ownEcho =
    entry.sourceSessionId === sessionId ||
    (entry.sourceSessionId == null && entry.agentId === agentId);
  const liveClaim = entry.claimExpiresAt != null && new Date(entry.claimExpiresAt).getTime() > now;
  const addressedToOther = entry.to != null && entry.to !== agentId;
  const serialQueued = entry.serialState === "pending";
  return (
    entry.status === "open" &&
    WAKE_KINDS.has(entry.kind) &&
    !ownEcho &&
    !liveClaim &&
    !addressedToOther &&
    !serialQueued &&
    !String(entry.content ?? "").startsWith(BROADCAST_PREFIX)
  );
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  try {
    writeFileSync(path, JSON.stringify(value), "utf8");
  } catch {
    // best-effort; losing dedup state only means an entry could re-notify
  }
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function rpcCall(lease, method, params) {
  const response = await fetch(`http://${lease.host}:${lease.port}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${lease.token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  const parsed = await response.json();
  if (parsed.error) throw new Error(parsed.error.message ?? "rpc error");
  return parsed.result;
}

function liveLease(dataDir) {
  const lease = readJson(join(dataDir, "nmg.sqlite.server.json"));
  if (!lease || lease.transport !== "http" || !lease.host || !lease.port || !lease.token) return null;
  return pidAlive(lease.pid) ? lease : null;
}

export function kimiAgentIdentity(payload, environment = process.env) {
  const sessionId = payload?.session_id ?? payload?.sessionId ?? "kimi-hook";
  return {
    sessionId,
    agentId: environment.NMG_AGENT_ID?.trim() || sessionId,
    capabilities: environment.NMG_AGENT_CAPABILITIES?.trim() || undefined,
  };
}

/** Report Kimi's stable identity whenever a user turn gives the passive hook a
 * chance to run. This is independent of wake being enabled: discovery belongs
 * to the system layer and never injects context or wakes another model. */
export async function reportAgentPresence(payload, options = {}) {
  const dataDir = options.dataDir ?? process.env.NMG_DATA_DIR?.trim() ?? join(homedir(), ".nmg");
  const lease = options.lease ?? liveLease(dataDir);
  if (!lease && !options.rpc) return false;
  const rpc = options.rpc ?? ((method, params) => rpcCall(lease, method, params));
  const identity = kimiAgentIdentity(payload, options.environment ?? process.env);
  await rpc("taskBoard", {
    action: "registerAgent",
    agentName: identity.agentId,
    capabilities: identity.capabilities,
    supportedInterfaces: "kimi-hook",
  });
  return true;
}

/**
 * Poll the task board for one undelivered open entry and format its wake
 * notice. Returns "" when there is nothing to say (or wake is off).
 */
async function pollBoardWake(payload) {
  const dataDir = process.env.NMG_DATA_DIR?.trim() || join(homedir(), ".nmg");
  const config = readJson(join(dataDir, "board-wake.json"));
  if (config?.enabled !== true) return "";

  const statePath = join(dataDir, "kimi-board-wake-state.json");
  const state = readJson(statePath) ?? { budgetDate: "", budgetUsed: 0, lastWakeAt: 0 };
  const now = Date.now();
  const cooldownMs =
    config.cooldownMs === 0 ? 0 : Math.max(30_000, Number(config.cooldownMs) || 600_000);
  if (cooldownMs > 0 && now - Number(state.lastWakeAt || 0) < cooldownMs) return "";
  const budget = config.budget === 0 ? 0 : Math.max(1, Number(config.budget) || 8);
  const today = new Date(now).toISOString().slice(0, 10);
  if (state.budgetDate !== today) {
    state.budgetDate = today;
    state.budgetUsed = 0;
  }
  if (budget > 0 && state.budgetUsed >= budget) return "";

  const lease = liveLease(dataDir);
  if (!lease) return "";

  // Kimi hook payloads carry session_id on Claude-compatible events; the
  // "kimi-hook" fallback intentionally shares receipts across sessions
  // rather than fragmenting dedup per process.
  const { sessionId, agentId } = kimiAgentIdentity(payload);
  const rpc = (method, params) => rpcCall(lease, method, params);

  const candidates = [];
  const collect = (taskId, entries) => {
    for (const entry of entries ?? []) {
      if (isBoardWakeCandidate(entry, { sessionId, agentId, now })) {
        candidates.push({ ...entry, taskId });
      }
    }
  };
  const world = await rpc("taskBoard", { action: "read", taskId: WORLD_BOARD_ID, agentId });
  collect(WORLD_BOARD_ID, world?.entries);
  const subs = await rpc("taskBoard", { action: "listSubscriptions", agentId, sessionId });
  for (const board of subs?.subscriptions ?? []) {
    if (!board.taskId || board.taskId === WORLD_BOARD_ID) continue;
    const read = await rpc("taskBoard", { action: "read", taskId: board.taskId, agentId });
    collect(board.taskId, read?.entries);
  }
  if (candidates.length === 0) return "";

  const fresh = [];
  for (const taskId of new Set(candidates.map((candidate) => candidate.taskId))) {
    const check = await rpc("taskBoard", {
      action: "deliveryCheck",
      taskId,
      agentId,
      sessionId,
      entryIds: candidates.filter((candidate) => candidate.taskId === taskId).map((c) => c.id),
    });
    if (check?.suppressed) continue;
    const delivered = new Set(check?.delivered ?? []);
    const acked = new Set(check?.acked ?? []);
    for (const candidate of candidates) {
      if (candidate.taskId === taskId && !delivered.has(candidate.id) && !acked.has(candidate.id)) {
        fresh.push(candidate);
      }
    }
  }
  if (fresh.length === 0) return "";

  fresh.sort(
    (left, right) =>
      (KIND_RANK[left.kind] ?? 9) - (KIND_RANK[right.kind] ?? 9) ||
      String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")),
  );
  const pick = fresh[0];
  // Receipt first: at-least-once notification beats a lost dedup write.
  await rpc("taskBoard", {
    action: "recordDelivery",
    entryId: pick.id,
    sessionId,
    agentId,
    source: "wake",
  }).catch(() => {});
  state.budgetUsed += 1;
  state.lastWakeAt = now;
  writeJson(statePath, state);

  const excerpt = pick.content.length > 140 ? `${pick.content.slice(0, 140)}…` : pick.content;
  const label = KIND_LABEL[pick.kind] ?? "条目";
  return `[NMG board] 你订阅的频道 ${pick.taskId} 有新${label}：#${pick.sequence} — ${excerpt}（open，可认领）。需要的话用 nmg_board read 查看详情、claim 认领处理。`;
}

async function runFromStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  try {
    const payload = JSON.parse(input || "{}");
    const output = [];
    if (shouldNudge(payload)) {
      // Plain stdout text is attached to the context; exit 0 = allow.
      output.push(NUDGE);
    }
    if (isPromptSubmit(payload)) {
      await reportAgentPresence(payload).catch(() => false);
      const notice = await pollBoardWake(payload).catch(() => "");
      if (notice) output.push(notice);
    }
    if (output.length > 0) process.stdout.write(output.join("\n"));
  } catch {
    // A hook must never break the session: stay silent on malformed input.
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runFromStdin();
}
