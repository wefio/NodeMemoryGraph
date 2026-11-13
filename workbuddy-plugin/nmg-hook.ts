#!/usr/bin/env node
import { assembleAdapterCapabilities } from "../src/integration/adapter-capability-assembly.ts";
import { ADAPTER_CAPABILITY_CATALOG } from "../src/integration/adapter-capability-catalog.ts";
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
 * exit 0 always. Prepared stdout is not a disclosure confirmation; this hook
 * does not fold later recall on the assumption that stdout reached the model.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compatibleLease, liveLease, rpcCall } from "../src/integration/lease-transport.ts";
import { RecallBudget } from "../src/integration/recall-budget.ts";
import {
  readWakeConfig,
  wakeBudgetGate,
  type BoardWakeState,
} from "../src/integration/board-wake.ts";
import { compactSearchContext } from "../src/integration/search-projection.ts";
import type { MemoryContext } from "../src/core/types.ts";

interface HookPayload {
  prompt?: unknown;
  hook_event_name?: string;
  event?: string;
  tool_name?: string;
  tool_input?: { command?: unknown };
  session_id?: string;
  sessionId?: string;
  cwd?: string;
}

// The lease transport (liveLease/rpcCall/compatibleLease) moved to
// src/integration/lease-transport.ts. liveLease is re-exported for tests.
export { liveLease };

interface WakeEntry {
  id: string;
  taskId: string;
  kind: string;
  content: string;
  sequence?: number;
  status?: string;
  sourceSessionId?: string | null;
  agentId?: string | null;
  claimExpiresAt?: string | null;
  to?: string | null;
  serialState?: string | null;
  createdAt?: string | null;
}

let prepareAutomaticRecallSurface: typeof import("../src/integration/agent-surface.ts").prepareAutomaticRecallSurface;
let prepareNudge: typeof import("../src/integration/completion-nudge.ts").promptCompletionNudge;
let collectWakeCandidates: typeof import("../src/integration/board-wake.ts").collectWakeCandidates;
let preparePendingBoardWake: typeof import("../src/integration/board-wake-batch.ts").preparePendingBoardWake;
let recordBoardWakeBatchDelivery: typeof import("../src/integration/board-wake-batch.ts").recordBoardWakeBatchDelivery;
let reportHarnessActivity: typeof import("../src/integration/board-wake-batch.ts").reportHarnessActivity;
const capabilityAssembly = assembleAdapterCapabilities(
  ADAPTER_CAPABILITY_CATALOG.workbuddy.capabilities,
  {
    "board-delivery": ({ collect, prepare, record, activity }) => {
      collectWakeCandidates = collect;
      preparePendingBoardWake = prepare;
      recordBoardWakeBatchDelivery = record;
      reportHarnessActivity = activity;
    },
    "automatic-recall": ({ prepare }) => {
      prepareAutomaticRecallSurface = prepare;
    },
    "completion-nudge": ({ prepare }) => {
      prepareNudge = prepare;
    },
  },
);

const RECALL_PREAMBLE = [
  "[NMG automatic recall] Long-term memory headers for the current user turn (injected, not yet used).",
  "Decide which candidates matter. These are hints only: call nmg_search through",
  "the current tool session before nmg_get so exact disclosure gets a session-owned activeGraphId.",
  "Ignore headers that are irrelevant noise; no useful memory is a valid result.",
].join("\n");

// Automatic-recall budget per harness-adapters.md: limit ≈ 13, maxTier 1,
// graphHops 1, tiered disclosure.
const RECALL_LIMIT = 13;
const RECALL_MAX_TIER = 1;
const RECALL_GRAPH_HOPS = 1;
const RECALL_QUERY_CHARS = 400;

const FALSE_LIKE = new Set(["0", "false", "off", "no"]);
const BROADCAST_PREFIX = "[NMG board 协作广播]";
const WAKE_KINDS = new Set(["question", "blocker", "handoff"]);

function dataDir(): string {
  return process.env.NMG_DATA_DIR?.trim() || join(homedir(), ".nmg");
}

function promptText(payload: HookPayload): string {
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

function isPromptSubmit(payload: HookPayload): boolean {
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

function writeJson(path: string, value: unknown) {
  try {
    writeFileSync(path, JSON.stringify(value), "utf8");
  } catch {
    // best-effort; losing dedup state only means a header could re-notify
  }
}

function agentIdentity(payload: HookPayload, environment = process.env) {
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
  payload: HookPayload,
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
export async function recallHeaders(payload: HookPayload, dir = dataDir()): Promise<string> {
  const budget = new RecallBudget();
  let timelySurface = "";
  try {
    const lease = await budget.run("hello", () => compatibleLease(dir));
    if (!lease) return "";
    const query = promptText(payload).trim().slice(0, RECALL_QUERY_CHARS);
    if (!query) return "";
    const { sessionId } = agentIdentity(payload);
    const recallSessionId = `workbuddy-hook:${sessionId}`;
    await budget
      .run("disclosure.begin", (signal) =>
        rpcCall(
          lease,
          "sessionActiveGraph",
          {
            action: "beginDisclosureTurn",
            sessionId: recallSessionId,
            prompt: query,
            projectDir: payload.cwd,
          },
          signal,
        ),
      )
      .catch(() => undefined);
    const context = (await budget.run("search", (signal) =>
      rpcCall(
        lease,
        "search",
        {
          query,
          limit: RECALL_LIMIT,
          maxTier: RECALL_MAX_TIER,
          graphHops: RECALL_GRAPH_HOPS,
          tieredDisclosure: true,
          autoRecall: true,
          autoRecallBudgetMs: Math.max(1, Math.floor(Math.min(4_500, budget.remainingMs - 100))),
          sessionId: recallSessionId,
          projectDir:
            typeof payload?.cwd === "string" && payload.cwd.trim() ? payload.cwd : process.cwd(),
        },
        signal,
      ),
    )) as MemoryContext;
    const compact = compactSearchContext(context);
    if (compact.candidates.length === 0) return "";
    timelySurface = prepareAutomaticRecallSurface(compact, { preamble: RECALL_PREAMBLE }).text;
    // stdout admission has no final host-input witness. Never reserve/fold a
    // disclosure here: the hook may exit without its output reaching a model.
    return timelySurface;
  } catch {
    return timelySurface;
  } finally {
    budget.close();
  }
}

/** Pure board-wake gate (same semantics as the Kimi hook). A claim suppresses
 * a notice only while its lease is live; notify-only kinds never wake. */
export function isBoardWakeCandidate(
  entry: WakeEntry,
  { sessionId, agentId, now = Date.now() }: { sessionId: string; agentId: string; now?: number },
): boolean {
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

/** Prepared output and its host-acceptance confirmation. */
interface HookBoardBatch {
  text: string;
  confirm?: () => Promise<void>;
}

async function prepareHookBoardWake(
  payload: HookPayload,
  dir: string,
  environment: NodeJS.ProcessEnv,
): Promise<HookBoardBatch> {
  const config = readWakeConfig(dir);
  const statePath = join(dir, "workbuddy-board-wake-state.json");
  const state: BoardWakeState = readJson(statePath) ?? {
    budgetDate: "",
    budgetUsed: 0,
    lastWakeAt: 0,
  };
  const now = Date.now();
  if (!wakeBudgetGate(config, state, now)) return { text: "" };
  const lease = await compatibleLease(dir);
  if (!lease) return { text: "" };
  const { sessionId, agentId } = agentIdentity(payload, environment);
  const rpc = (method: string, params: unknown) => rpcCall(lease, method, params);
  await reportHarnessActivity(rpc, agentId, sessionId, "unknown", ["stdout-context"]);
  const candidates = await collectWakeCandidates(rpc, { agentId, agentName: agentId, sessionId });
  const batch = await preparePendingBoardWake({
    invoke: rpc,
    entries: candidates,
    dataDir: dir,
    agentId,
    sessionId,
  });
  if (!batch.entries.length) return { text: "" };
  return {
    text: batch.information.text,
    confirm: async () => {
      await recordBoardWakeBatchDelivery(rpc, batch.entries, agentId, sessionId);
      state.budgetUsed += 1;
      state.lastWakeAt = now;
      writeJson(statePath, state);
    },
  };
}

/** Preparation-only callers can inspect text without recording host delivery. */
export async function pollBoardWake(
  payload: HookPayload,
  dir = dataDir(),
  environment = process.env,
): Promise<string> {
  return (await prepareHookBoardWake(payload, dir, environment)).text;
}

export async function runHook(
  payload: HookPayload,
  options: {
    dir?: string;
    environment?: NodeJS.ProcessEnv;
    writeOutput?: (text: string) => Promise<void>;
  } = {},
): Promise<string> {
  const output: string[] = [];
  let confirmBoard: (() => Promise<void>) | undefined;
  const dir = options.dir ?? dataDir();
  const environment = options.environment ?? process.env;
  const coordinationEnabled = !FALSE_LIKE.has(
    (environment.NMG_ENABLE_COORDINATION ?? "").trim().toLowerCase(),
  );
  await capabilityAssembly.ready;
  const nudge = prepareNudge({
    ...payload,
    tool_name: payload.tool_name === "powershell" ? "shell" : payload.tool_name,
  });
  if (nudge) output.push(nudge);
  if (isPromptSubmit(payload)) {
    const recall = await recallHeaders(payload, dir).catch(() => "");
    if (recall) output.push(recall);
    if (coordinationEnabled) {
      await reportAgentPresence(payload, dir, environment).catch(() => false);
      const batch = await prepareHookBoardWake(payload, dir, environment).catch(
        () => ({ text: "" }) as HookBoardBatch,
      );
      if (batch.text) {
        output.push(batch.text);
        confirmBoard = batch.confirm;
      }
    }
  }
  const text = output.join("\n");
  if (text && options.writeOutput) {
    await options.writeOutput(text);
    await confirmBoard?.();
  }
  return text;
}

async function runFromStdin(): Promise<void> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  try {
    const payload = JSON.parse(input || "{}");
    await runHook(payload, {
      writeOutput: (text) =>
        new Promise<void>((done, reject) => {
          process.stdout.write(text, (error) => (error ? reject(error) : done()));
        }),
    });
  } catch {
    // A hook must never break the session: stay silent on malformed input.
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runFromStdin();
}
