#!/usr/bin/env node
/**
 * NMG hook for WorkBuddy (Claude Code-compatible hooks, Git Bash on Windows).
 *
 * Events handled (stdin JSON payload, stdout text attaches to context on exit 0):
 *   UserPromptSubmit — automatic recall (small-budget daemon search, compact
 *                      header projection injection) + agent identity
 *                      registration + task-board wake poll
 *   PreToolUse(Bash) — `git commit` in the command → remember nudge
 *
 * Recipe source: skills/nmg-memory/references/harness-adapters.md
 * ("Automatic recall (hook, optional but recommended)"). Model-visible text is
 * rendered by the shared Agent Surface (src/integration/agent-surface.ts) —
 * this hook never hand-builds candidate strings.
 *
 * The hook is deliberately passive: it never starts a daemon and only talks to
 * a live HTTP lease (<dataDir>/nmg.sqlite.server.json with an alive pid), so a
 * stopped memory layer never delays a user turn. All failures are silent —
 * exit 0 always. Recall dedup keeps a per-session id window in
 * <dataDir>/workbuddy-recall-state.json.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderCompactSearchSurface } from "../src/integration/agent-surface.ts";
import { compactSearchContext } from "../src/integration/search-projection.ts";
import type { MemoryContext } from "../src/core/types.ts";
import { assertDaemonProtocol } from "../src/cli/daemon-client.ts";
import type { NmgHelloResult } from "../src/cli/protocol.ts";

const NUDGE = [
  "<nmg_nudge>",
  "A code commit or task completion was just detected. NMG long-term memory is",
  "available: you may recall relevant decisions (nmg_search) or save this",
  "turn's key conclusions (nmg_remember) if useful. This is only a reminder;",
  "it does not affect the current work.",
  "</nmg_nudge>",
].join("\n");

const RECALL_PREAMBLE = [
  "[NMG automatic recall] Long-term memory headers for the current user turn (injected, not yet used).",
  "Decide which candidates matter. These are hints only: call nmg_search through",
  "the current tool session before nmg_get so exact disclosure gets a session-owned activeGraphId.",
  "Ignore headers that are irrelevant noise; no useful memory is a valid result.",
].join("\n");

const COMPLETION_PATTERN =
  /(?:完成了|收工|搞定|结束|提交了|committed|done|finished|wrapped\s+up)/iu;

// Automatic-recall budget per harness-adapters.md: limit ≈ 13, maxTier 1,
// graphHops 1, tiered disclosure.
const RECALL_LIMIT = 13;
const RECALL_MAX_TIER = 1;
const RECALL_GRAPH_HOPS = 1;
const RECALL_QUERY_CHARS = 400;
const RECALL_DEDUP_WINDOW = 60;
const RPC_TIMEOUT_MS = 2_000;

const WORLD_BOARD_ID = "default";
const FALSE_LIKE = new Set(["0", "false", "off", "no"]);
const BROADCAST_PREFIX = "[NMG board 协作广播]";
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

function dataDir(): string {
  return process.env.NMG_DATA_DIR?.trim() || join(homedir(), ".nmg");
}

function promptText(payload): string {
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

function isGitCommit(payload): boolean {
  const command = payload?.tool_input?.command;
  return typeof command === "string" && /\bgit\s+commit\b/u.test(command);
}

function shouldNudge(payload): boolean {
  const event = payload?.hook_event_name ?? payload?.event;
  if (event === "UserPromptSubmit") return COMPLETION_PATTERN.test(promptText(payload));
  if (event === "PreToolUse") {
    const toolName = payload?.tool_name ?? "";
    return /^(bash|shell|powershell)$/iu.test(toolName) && isGitCommit(payload);
  }
  return false;
}

function isPromptSubmit(payload): boolean {
  const event = payload?.hook_event_name ?? payload?.event;
  return event === "UserPromptSubmit";
}

function readJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path: string, value) {
  try {
    writeFileSync(path, JSON.stringify(value), "utf8");
  } catch {
    // best-effort; losing dedup state only means a header could re-notify
  }
}

function pidAlive(pid): boolean {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function liveLease(dir: string) {
  const lease = readJson(join(dir, "nmg.sqlite.server.json"));
  if (
    !lease ||
    lease.transport !== "http" ||
    lease.host !== "127.0.0.1" ||
    !Number.isInteger(lease.port) ||
    lease.port < 1 ||
    lease.port > 65_535 ||
    typeof lease.token !== "string" ||
    lease.token.length < 16
  )
    return null;
  return pidAlive(lease.pid) ? lease : null;
}

async function rpcCall(lease, method: string, params) {
  const response = await fetch(`http://${lease.host}:${lease.port}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${lease.token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`NMG HTTP ${response.status}`);
  const parsed = await response.json();
  if (parsed?.jsonrpc !== "2.0") throw new Error("invalid NMG JSON-RPC response");
  if (parsed.error) throw new Error(parsed.error.message ?? "rpc error");
  return parsed.result;
}

const verifiedLeaseByDirectory = new Map<string, Promise<ReturnType<typeof liveLease>>>();

async function compatibleLease(dir: string) {
  let pending = verifiedLeaseByDirectory.get(dir);
  if (!pending) {
    pending = (async () => {
      const lease = liveLease(dir);
      if (!lease) return null;
      try {
        const hello = (await rpcCall(lease, "hello", {})) as NmgHelloResult;
        assertDaemonProtocol(hello);
        if (!hello.capabilities.includes("session-active-graph")) return null;
        return lease;
      } catch {
        return null;
      }
    })();
    verifiedLeaseByDirectory.set(dir, pending);
  }
  return pending;
}

function agentIdentity(payload, environment = process.env) {
  const sessionId = payload?.session_id ?? payload?.sessionId ?? "workbuddy-hook";
  return {
    sessionId,
    agentId: environment.NMG_AGENT_ID?.trim() || sessionId,
    capabilities: environment.NMG_AGENT_CAPABILITIES?.trim() || undefined,
  };
}

/** Report WorkBuddy's stable identity whenever a user turn runs the hook.
 * Discovery belongs to the system layer; it never injects context or wakes
 * another model. */
export async function reportAgentPresence(
  payload,
  dir = dataDir(),
  environment = process.env,
): Promise<boolean> {
  const lease = await compatibleLease(dir);
  if (!lease) return false;
  const identity = agentIdentity(payload, environment);
  await rpcCall(lease, "taskBoard", {
    action: "registerAgent",
    id: identity.agentId,
    agentName: identity.agentId,
    capabilities: identity.capabilities,
    supportedInterfaces: "workbuddy-hook",
  });
  return true;
}

/** Small-budget automatic recall: one daemon search per user turn, compact
 * header projection from the shared Agent Surface, per-session id dedup.
 * Returns "" when there is nothing to inject. */
export async function recallHeaders(payload, dir = dataDir()): Promise<string> {
  const lease = await compatibleLease(dir);
  if (!lease) return "";
  const query = promptText(payload).trim().slice(0, RECALL_QUERY_CHARS);
  if (!query) return "";
  const { sessionId } = agentIdentity(payload);
  const recallSessionId = `workbuddy-hook:${sessionId}:${randomUUID()}`;
  let context: MemoryContext;
  try {
    context = (await rpcCall(lease, "search", {
      query,
      limit: RECALL_LIMIT,
      maxTier: RECALL_MAX_TIER,
      graphHops: RECALL_GRAPH_HOPS,
      tieredDisclosure: true,
      sessionId: recallSessionId,
      projectDir:
        typeof payload?.cwd === "string" && payload.cwd.trim() ? payload.cwd : process.cwd(),
    })) as MemoryContext;
  } finally {
    await rpcCall(lease, "sessionActiveGraph", {
      action: "release",
      sessionId: recallSessionId,
    }).catch(() => {});
  }
  const compact = compactSearchContext(context);
  if (compact.candidates.length === 0) return "";

  // Fold repeated ids within a per-session window: only unseen headers ride
  // this turn; a wholly-seen set injects nothing.
  const statePath = join(dir, "workbuddy-recall-state.json");
  const state = readJson(statePath) ?? {};
  const seen: string[] = Array.isArray(state[sessionId]) ? state[sessionId] : [];
  const seenSet = new Set(seen);
  const fresh = compact.candidates.filter((candidate) => !seenSet.has(candidate.id));
  if (fresh.length === 0) return "";
  const freshIds = fresh.map((candidate) => candidate.id);
  state[sessionId] = [...freshIds, ...seen].slice(0, RECALL_DEDUP_WINDOW);
  writeJson(statePath, state);

  const projected = {
    ...compact,
    candidates: fresh,
    activeGraphId: null,
    deferredMemoryIds: [],
    // The detached hook has released its projection; chain names remain useful
    // hints, but continuation counts and get guidance require a tool-side AG.
    logicalChainCount: 0,
  };
  const surface = renderCompactSearchSurface(projected, { emptyText: "" });
  return [RECALL_PREAMBLE, surface].join("\n");
}

/** Pure board-wake gate (same semantics as the Kimi hook). A claim suppresses
 * a notice only while its lease is live; notify-only kinds never wake. */
export function isBoardWakeCandidate(entry, { sessionId, agentId, now = Date.now() }): boolean {
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

/** Poll the task board for one undelivered open entry and format its wake
 * notice. Returns "" when there is nothing to say (or wake is off). */
export async function pollBoardWake(
  payload,
  dir = dataDir(),
  environment = process.env,
): Promise<string> {
  const config = readJson(join(dir, "board-wake.json")) ?? {};
  if (config.enabled === false) return "";

  const statePath = join(dir, "workbuddy-board-wake-state.json");
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

  const lease = await compatibleLease(dir);
  if (!lease) return "";
  const { sessionId, agentId } = agentIdentity(payload, environment);
  const rpc = (method: string, params) => rpcCall(lease, method, params);

  const candidates = [];
  const collect = (taskId: string, entries) => {
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

  const freshList = [];
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
        freshList.push(candidate);
      }
    }
  }
  if (freshList.length === 0) return "";

  freshList.sort(
    (left, right) =>
      (KIND_RANK[left.kind] ?? 9) - (KIND_RANK[right.kind] ?? 9) ||
      String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")),
  );
  const pick = freshList[0];
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

export async function runHook(
  payload,
  options: { dir?: string; environment?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const output: string[] = [];
  const dir = options.dir ?? dataDir();
  const environment = options.environment ?? process.env;
  const coordinationEnabled = !FALSE_LIKE.has(
    (environment.NMG_ENABLE_COORDINATION ?? "").trim().toLowerCase(),
  );
  if (shouldNudge(payload)) output.push(NUDGE);
  if (isPromptSubmit(payload)) {
    const recall = await recallHeaders(payload, dir).catch(() => "");
    if (recall) output.push(recall);
    if (coordinationEnabled) {
      await reportAgentPresence(payload, dir, environment).catch(() => false);
      const notice = await pollBoardWake(payload, dir, environment).catch(() => "");
      if (notice) output.push(notice);
    }
  }
  return output.join("\n");
}

async function runFromStdin(): Promise<void> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  try {
    const payload = JSON.parse(input || "{}");
    const output = await runHook(payload);
    if (output) process.stdout.write(output);
  } catch {
    // A hook must never break the session: stay silent on malformed input.
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runFromStdin();
}
