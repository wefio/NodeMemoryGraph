// NMG adapter for OpenCode (v2 plugin contract).
//
// HOST-ADAPTER BOUNDARY (shared layer rule): this plugin is a thin transport.
// Every NMG capability (recall staging, tool-flow gating, attribution,
// board wake, working state) lives in the SHARED layer — src/* modules and the
// daemon RPC surface — never implemented or forked here. Model-visible text is
// rendered by src/integration/agent-surface.ts; this adapter never hand-builds
// memory text.
//
// Verified against OpenCode 2.0.31 at build:
// - Plugins are `export default { id, setup }`, run inside the shared
//   background service; v1 `server()` hooks are ignored there (kept only for
//   co-loading compatibility outside this package).
// - ctx.session.hook("prompt") fires once per admitted user turn;
//   ctx.session.hook("context") fires per agent-loop request and exposes a
//   mutable `messages` list — appending `{role:"system", content:[{type:
//   "text"}]}` (parts array, NOT string content) is the verified injection.
// - ctx.tool.transform registers JSON-Schema tools (options `{namespace,
//   codemode}` map `name` → `nmg_<name>` in the Code Mode catalog);
//   ctx.tool.hook("execute.after") observes every tool result.
// - The tool executor context carries no project directory; the project is
//   learned from `session.created` events (data.location.directory).

import {
  AgentAttributionFlow,
  extractAnswerText,
  extractPromptText,
} from "../src/integration/agent-attribution.ts";
import {
  renderCompactSearchSurface,
  renderEvidenceSurface,
  renderRememberSurface,
  renderSearchSurface,
  renderTaskBoardSurface,
  type TaskBoardDirectoryEntry,
  type TaskBoardSurfaceResult,
} from "../src/integration/agent-surface.ts";
import {
  collectWakeCandidates,
  deliverBoardWake,
  filterUndelivered,
  loadWakeState,
  readWakeConfig,
  wakeBudgetGate,
} from "../src/integration/board-wake.ts";
import {
  configuredAutoRecallLimit,
  configuredAutoRecallTier,
  coordinationEnabled,
} from "../src/integration/config.ts";
import {
  loadOrCreateAgentIdentity,
  renameAgentIdentity,
} from "../src/integration/agent-identity.ts";
import {
  compactDisclosureEntries,
  compactSearchContext,
  memoryDisclosureEntries,
} from "../src/integration/search-projection.ts";
import { SessionRecallFlow } from "../src/integration/session-recall-flow.ts";
import { SessionTaskWindow } from "../src/integration/session-task-window.ts";
import {
  captureStateInvocation,
  COORDINATION_OPERATIONS,
  requireBoardEventCapability,
  renderStateOutput,
  stateOperation,
  STATE_OPERATIONS,
} from "../src/integration/state.ts";
import { assembleBoardStateParams, resolveBoardOperation } from "./state-args.ts";
import { COMMON_REMEMBER_ACTIONS } from "../src/integration/tool-contract.ts";
import type { TaskBoardToolResult } from "../src/integration/tool-contract.ts";
import {
  isMemorableToolResult,
  isSuccessfulCommit,
  messageText,
  summarizeToolResult,
} from "../src/integration/tool-observation.ts";
import type { MemoryContext, MemoryTier, RememberResult } from "../src/core/types.ts";
import { TASK_BOARD_VERDICTS, WORLD_BOARD_ID } from "../src/core/types.ts";
import { deriveAnswerOverlapMemoryIds } from "../src/core/feedback.ts";
import type { NmgStateResult, NmgSessionActiveGraphResult } from "../src/cli/protocol.ts";
import { recallInput } from "../src/core/recall-matcher.ts";
import { resolveNmgDataDir } from "../src/cli/data-path.ts";
import { loadPrompts, renderDisclosure } from "../src/prompts/load.ts";
import { invokeDaemon } from "./rpc.ts";

const prompts = loadPrompts();

// Automatic-recall budget per harness-adapters.md, applied on top of the
// daemon's decision (limit ≈ 13, maxTier 1, graphHops 1, tiered disclosure).
const PROMPT_BUDGET_MS = 1_500;
const RECALL_GRAPH_HOPS_CAP = 1;
const SESSION_ROWS_CAP = 64;
const PENDING_INJECTIONS_CAP = 32;
const WAKE_POOL_SIZE = 3;

interface PromptHookEvent {
  sessionID?: string;
  messageID?: string;
  prompt?: { text?: string };
  delivery?: string;
}

interface ContextHookEvent {
  sessionID?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
}

interface AfterToolEvent {
  tool?: string;
  sessionID?: string;
  status?: string;
  input?: unknown;
  result?: { content?: unknown };
}

interface SessionScopedHookEvent {
  sessionID?: string;
}

interface ToolContext {
  sessionID?: string;
  agent?: string;
  messageID?: string;
  progress?: (patch: unknown) => void;
  signal?: AbortSignal;
}

interface ToolRegistration {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
}

interface ToolEditor {
  add: (tool: ToolRegistration) => void;
}

interface SessionPromptApi {
  hook: (name: string, handler: (event: never) => unknown) => Promise<unknown>;
  prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>;
  context?: (input: { sessionID: string }) => Promise<unknown>;
}

interface HostEvent {
  type?: string;
  location?: { directory?: string };
  data?: { sessionID?: string; parentID?: string; location?: { directory?: string } };
}

interface PluginContext {
  session: SessionPromptApi;
  event: { subscribe: (input?: { signal?: AbortSignal }) => AsyncIterable<HostEvent> };
  tool: {
    transform: (
      transform: (editor: ToolEditor) => void,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
    hook: (
      name: "execute.before" | "execute.after",
      handler: (event: never) => unknown,
    ) => Promise<unknown>;
  };
}

interface SessionRecord {
  projectDir: string;
  child: boolean;
  lastPromptAt: number;
  lastIdleAt: number;
}

function eventText(value: unknown): string {
  return messageText(value);
}

function textOfPrompt(value: unknown): string {
  const prompt = value as { text?: unknown } | undefined;
  return eventText(prompt?.text);
}

/** Attrition-safe history source: v2's ctx.session.context() shape is not
 * contract-stable, so accept either raw messages or wrapped entries. */
function historyMessages(history: readonly unknown[] | null | undefined): Array<{
  role?: unknown;
  content?: unknown;
}> {
  if (!Array.isArray(history)) return [];
  return history
    .map((entry) => {
      const record = entry as {
        role?: unknown;
        content?: unknown;
        message?: Record<string, unknown>;
        info?: Record<string, unknown>;
      };
      return record?.message ?? record?.info ?? record;
    })
    .filter((message): message is { role?: unknown; content?: unknown } =>
      Boolean(message?.role ?? message?.content),
    );
}

/** Automatic recall must never hold the turn: one search round with per-call
 * lease timeouts, fenced by an overall prompt budget. */
function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | undefined> {
  return Promise.race([
    work.catch(() => undefined as T | undefined),
    new Promise<undefined>((resolve) => setTimeout(resolve, budgetMs, undefined)),
  ]);
}

function normalizeToolName(tool: string): string {
  return tool === "shell" ? "bash" : tool;
}

export default {
  id: "nmg",
  setup: async (ctx: PluginContext): Promise<(() => Promise<void>) | undefined> => {
    const dataDir = resolveNmgDataDir();
    const invoke = (method: string, params: unknown) =>
      invokeDaemon(method, params as Record<string, unknown>, { dataDir });

    const taskWindow = new SessionTaskWindow();
    const recallFlow = new SessionRecallFlow();
    const attribution = new AgentAttributionFlow(32);
    // Injection pass: prepared at prompt admission and delivered by context
    // requests. The staged body RETAINS for the whole execution — provider
    // retries rebuild the request context without the previously pushed
    // system message, so re-delivery is decided per request by content
    // (marker scan), and teardown happens at execution completion.
    const pendingInjections = new Map<string, string>();
    // sessionID → project layout (tool executor contexts carry no directory).
    const sessions = new Map<string, SessionRecord>();
    const commitNudges = new Set<string>();

    const onlineLearningActive = () => process.env.NMG_CONTEXT_ONLINE_LEARNING !== "0";
    const recallFeedbackAffordance = (graphId: string | null | undefined): string =>
      graphId && onlineLearningActive()
        ? renderDisclosure(prompts.recall_feedback_affordance, { graph_id: graphId })
        : "";

    const projectDirectory = (sessionId: string): string | undefined => {
      const override = process.env.NMG_PROJECT_DIR?.trim();
      if (override) return override;
      return sessions.get(sessionId)?.projectDir?.trim() || undefined;
    };

    const rememberSession = (sessionId: string, directory: string, child: boolean): void => {
      const existing = sessions.get(sessionId);
      sessions.set(sessionId, {
        projectDir: directory?.trim() || existing?.projectDir || "",
        child: child || (existing?.child ?? false),
        lastPromptAt: existing?.lastPromptAt ?? 0,
        lastIdleAt: existing?.lastIdleAt ?? 0,
      });
      while (sessions.size > SESSION_ROWS_CAP) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
    };

    // ---- Automatic recall + nudge staging (prompt hook) --------------------
    const RECALL_PREAMBLE = [
      "[NMG automatic recall] Long-term memory headers for the current user turn (injected, not yet used).",
      "Decide which candidates matter, then call nmg_search before nmg_get so exact",
      "disclosure lands on this shared session's active graph. Ignore noise; an empty",
      "match is a valid result.",
    ].join("\n");
    // First line doubles as the delivery marker: re-delivery dedup scans
    // system-role messages for exactly this header.
    const contextInjectionMarker = RECALL_PREAMBLE.split("\n")[0] ?? RECALL_PREAMBLE;

    const recallHeaders = async (
      sessionId: string,
      request: NonNullable<ReturnType<SessionTaskWindow["prepare"]>>,
    ): Promise<string> => {
      const projectDir = projectDirectory(sessionId);
      const context = (await invoke("search", {
        query: request.query,
        maxTier: Math.min(configuredAutoRecallTier(), request.maxTier) as MemoryTier,
        limit: Math.min(configuredAutoRecallLimit(), request.limit),
        graphHops: Math.min(RECALL_GRAPH_HOPS_CAP, request.graphHops),
        tieredDisclosure: true,
        // The daemon stages the injected graph for online learning behind the
        // scenes; explicit nmg_search runs stay unstaged.
        autoRecall: true,
        projectDir,
        sessionId,
      })) as MemoryContext;
      if (!context.results || context.results.length === 0) return "";
      const compact = compactSearchContext(context);
      const decision = (await invoke("sessionActiveGraph", {
        action: "disclose",
        sessionId,
        projectionId: compact.activeGraphId ?? undefined,
        disclosure: "header",
        entries: compactDisclosureEntries(compact),
      }).catch(() => null)) as { freshMemoryIds?: unknown } | null;
      const freshIds = new Set(
        Array.isArray(decision?.freshMemoryIds)
          ? (decision.freshMemoryIds as string[])
          : compact.candidates.map((candidate) => candidate.id),
      );
      const fresh = compact.candidates.filter((candidate) => freshIds.has(candidate.id));
      if (fresh.length === 0) return "";
      // Only the candidates this injection surfaces count as attribution
      // evidence — preparation is not provider transmission.
      attribution.note(sessionId, {
        ...context,
        results: context.results.filter((result) => freshIds.has(result.memory.id)),
      });
      return [
        RECALL_PREAMBLE,
        renderCompactSearchSurface({ ...compact, candidates: fresh }, { emptyText: "" }),
      ]
        .filter(Boolean)
        .join("\n");
    };

    const stagePromptRecall = async (event: PromptHookEvent): Promise<void> => {
      const sessionId = String(event?.sessionID ?? "");
      const prompt = textOfPrompt(event?.prompt);
      const turnKey = event?.messageID ? `message:${event.messageID}` : `prompt:${Date.now()}`;
      recallFlow.beginTurn(sessionId, turnKey);
      // A completion nudge from the previous turn's commit rides at most one
      // user turn ahead and is never forced onto the model.
      const nudge = commitNudges.has(sessionId)
        ? renderDisclosure(prompts.completion_nudge, {})
        : "";
      commitNudges.delete(sessionId);
      const projectDir = projectDirectory(sessionId);
      const handshake = (await invoke("sessionActiveGraph", {
        action: "beginDisclosureTurn",
        sessionId,
        projectDir,
        recall: { prompt: recallInput(prompt), projectDir, scheduled: false },
      }).catch(() => undefined)) as NmgSessionActiveGraphResult | undefined;
      const decision =
        handshake?.action === "beginDisclosureTurn" ? handshake.sessionRecall?.decision : undefined;
      const request = taskWindow.prepare(sessionId, prompt, decision);
      const surface = request ? await recallHeaders(sessionId, request).catch(() => "") : "";
      const body = [surface, nudge].filter(Boolean).join("\n\n");
      if (!body) return;
      pendingInjections.set(sessionId, body);
      while (pendingInjections.size > PENDING_INJECTIONS_CAP) {
        const oldest = pendingInjections.keys().next().value;
        if (oldest === undefined) break;
        pendingInjections.delete(oldest);
      }
    };

    await ctx.session.hook("prompt", async (raw: PromptHookEvent) => {
      const sessionId = String((raw as PromptHookEvent)?.sessionID ?? "");
      if (sessionId) {
        // OpenCode has no session.created on the plugin stream; a missing row
        // is a normal root session until a parentID event upgrades it (the
        // merge in rememberSession is sticky toward child=true).
        const existing = sessions.get(sessionId) ?? {
          projectDir: "",
          child: false,
          lastPromptAt: 0,
          lastIdleAt: 0,
        };
        sessions.set(sessionId, { ...existing, lastPromptAt: Date.now() });
      }
      await withBudget(stagePromptRecall(raw as PromptHookEvent), PROMPT_BUDGET_MS);
    });

    await ctx.session.hook("context", (raw: ContextHookEvent) => {
      const sessionId = String(raw?.sessionID ?? "");
      const messages = raw?.messages;
      if (!sessionId || !Array.isArray(messages)) return void undefined;
      const pending = pendingInjections.get(sessionId);
      if (!pending) return void undefined;
      // Keep the staged body until execution completion: after a provider
      // retry the host rebuilds this request from the transcript without the
      // previously pushed message, so re-delivery is decided by content, not
      // by one-shot consumption. The marker scan (system role only) prevents
      // duplicates on step-tool requests that already carry the injection.
      const carried = messages.some((message) => {
        if (message?.role !== "system") return false;
        const content = message.content;
        if (typeof content === "string") return content.includes(contextInjectionMarker);
        return (
          Array.isArray(content) &&
          content.some((part) =>
            String((part as { text?: unknown })?.text ?? "").includes(contextInjectionMarker),
          )
        );
      });
      if (carried) return void undefined;
      // OpenCode lowers message content itself; only parts arrays are safe
      // here (a bare string crashes provider lowering — probed).
      messages.push({ role: "system", content: [{ type: "text", text: pending }] });
    });

    await ctx.session.hook("compaction", async (raw: SessionScopedHookEvent) => {
      const sessionId = raw?.sessionID;
      if (!sessionId) return;
      await invoke("sessionActiveGraph", { action: "clearDisclosures", sessionId }).catch(
        () => undefined,
      );
      await invoke("sessionActiveGraph", { action: "activate", sessionId }).catch(() => undefined);
    });

    // ---- Tool observations + commit nudge (execute.after) -----------------
    const observeToolResult = async (event: AfterToolEvent): Promise<void> => {
      const sessionId = String(event?.sessionID ?? "");
      const toolId = String(event?.tool ?? "");
      if (!sessionId || !toolId) return;
      if (toolId.startsWith("nmg_")) return; // handled inside the tool executes
      const observation = {
        toolName: normalizeToolName(toolId),
        isError: event?.status === "error",
        content: event?.result?.content,
        input: event?.input,
      };
      if (isSuccessfulCommit(observation)) commitNudges.add(sessionId);
      if (!isMemorableToolResult(observation)) return;
      const summary = summarizeToolResult(observation);
      await invoke("sessionActiveGraph", {
        action: "observe",
        sessionId,
        sourceId: observation.toolName,
        sourceKind: observation.isError ? "tool_error" : "tool_result",
        nodeId: summary.nodeName,
        statement: summary.statement,
      }).catch(() => undefined);
    };

    await ctx.tool.hook("execute.after", (raw: AfterToolEvent) => {
      void observeToolResult(raw as AfterToolEvent).catch(() => undefined);
    });

    // ---- Shared disclosure projection ------------------------------------
    const disclosedContext = async (
      sessionId: string,
      context: MemoryContext,
      disclosure: "header" | "evidence",
    ): Promise<string> => {
      if (!context.results || context.results.length === 0) {
        return disclosure === "header" ? "No matching NMG memory found." : "";
      }
      try {
        const decision = (await invoke("sessionActiveGraph", {
          action: "disclose",
          sessionId,
          projectionId: context.activeGraph?.id,
          disclosure,
          entries: memoryDisclosureEntries(context, disclosure),
        })) as { freshMemoryIds?: unknown; foldedMemoryIds?: unknown };
        const fallback = context.results.map((entry) => entry.memory.id);
        const freshIds = new Set(
          Array.isArray(decision?.freshMemoryIds)
            ? (decision.freshMemoryIds as string[])
            : fallback,
        );
        const foldedIds = Array.isArray(decision?.foldedMemoryIds)
          ? (decision.foldedMemoryIds as string[])
          : [];
        const fresh = context.results.filter((entry) => freshIds.has(entry.memory.id));
        if (fresh.length === 0) {
          return disclosure === "header" ? "No new matching NMG memory." : "";
        }
        const visible = { ...context, results: fresh } as MemoryContext;
        return [
          disclosure === "header" ? renderSearchSurface(visible) : renderEvidenceSurface(visible),
          foldedIds.length > 0
            ? `${prompts.in_context_title}\n${foldedIds
                .map((memoryId) => `- memory=${memoryId}; already_in_context=true`)
                .join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
      } catch {
        // Daemon disclosure ledger unavailable: degrade to the raw surface.
        return disclosure === "header"
          ? renderSearchSurface(context)
          : renderEvidenceSurface(context);
      }
    };

    const toolSessionId = (context: ToolContext, toolName: string): string => {
      const sessionId = String(context?.sessionID ?? "");
      if (sessionId) return sessionId;
      throw new Error(
        `nmg_${toolName} has no session context (this tool must run inside an OpenCode agent loop)`,
      );
    };

    // ---- nmg_search -------------------------------------------------------
    const searchTool = (): ToolRegistration => ({
      name: "search",
      description: prompts.search_description,
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: prompts.search_query_parameter_description },
          limit: { type: "integer", minimum: 1, maximum: 50 },
          maxTier: { type: "integer", minimum: 0, maximum: 3 },
          nodeName: { type: "string" },
          scope: { type: "object", additionalProperties: { type: "string" } },
          includeHistorical: { type: "boolean" },
          graphHops: { type: "integer", minimum: 0, maximum: 3 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const sessionId = toolSessionId(context, "search");
        if (!recallFlow.allowSearch(sessionId)) {
          const reason = recallFlow.searchBlockReason(sessionId);
          return {
            content: `${prompts.search_progression_required} (reason=${reason ?? "gated"})`,
          };
        }
        const result = (await invoke("search", {
          query: args.query,
          limit: args.limit,
          maxTier: args.maxTier ?? 3,
          nodeName: args.nodeName,
          scope: args.scope,
          includeHistorical: args.includeHistorical === true,
          graphHops: args.graphHops,
          projectDir: projectDirectory(sessionId),
          sessionId,
        })) as MemoryContext;
        recallFlow.recordSearch(
          sessionId,
          result.results.map((entry) => entry.memory.id),
        );
        attribution.note(sessionId, result);
        const surface = await disclosedContext(sessionId, result, "header");
        return {
          content: [surface, recallFeedbackAffordance(result.activeGraph?.id)]
            .filter(Boolean)
            .join("\n"),
        };
      },
    });

    // ---- nmg_get ----------------------------------------------------------
    const getTool = (): ToolRegistration => ({
      name: "get",
      description: prompts.get_description,
      input: {
        type: "object",
        properties: {
          memoryIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 50,
            description: "Memory IDs from nmg_search.",
          },
          activeGraphId: {
            type: "string",
            description: prompts.active_graph_id_parameter_description,
          },
          graphHops: { type: "integer", minimum: 0, maximum: 3 },
        },
        required: ["memoryIds"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const sessionId = toolSessionId(context, "get");
        const memoryIds = Array.isArray(args.memoryIds)
          ? (args.memoryIds as unknown[]).filter(
              (id): id is string => typeof id === "string" && id.trim().length > 0,
            )
          : [];
        if (memoryIds.length === 0) return { content: "nmg_get requires memoryIds." };
        if (!recallFlow.allowGet(sessionId)) {
          return {
            content:
              "Recall tool budget exhausted for this user turn. Answer from the evidence already " +
              "on the surface, or state what remains uncertain.",
          };
        }
        const activeGraphId =
          (typeof args.activeGraphId === "string" && args.activeGraphId.trim()) ||
          attribution.latestActiveGraphIdForMemories(sessionId, memoryIds) ||
          undefined;
        const result = (await invoke("get", {
          memoryIds,
          activeGraphId,
          graphHops: args.graphHops,
          projectDir: projectDirectory(sessionId),
          sessionId,
        })) as MemoryContext & { missingMemoryIds?: string[] };
        recallFlow.recordGet(
          sessionId,
          result.results.map((entry) => entry.memory.id),
        );
        attribution.note(sessionId, result);
        const missing = Array.isArray(result.missingMemoryIds) ? result.missingMemoryIds : [];
        const surface = await disclosedContext(sessionId, result, "evidence");
        return {
          content: [surface, missing.length > 0 ? `MISSING: ${missing.join(", ")}` : ""]
            .filter(Boolean)
            .join("\n"),
        };
      },
    });

    // ---- nmg_remember -----------------------------------------------------
    const rememberTool = (): ToolRegistration => ({
      name: "remember",
      description: prompts.remember_description,
      input: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [...COMMON_REMEMBER_ACTIONS],
            description: prompts.remember_action_parameter_description,
          },
          memoryId: {
            type: "string",
            description: prompts.remember_memory_id_parameter_description,
          },
          newMemoryId: {
            type: "string",
            description: prompts.remember_new_memory_id_parameter_description,
          },
          supersededMemoryId: {
            type: "string",
            description: prompts.remember_superseded_memory_id_parameter_description,
          },
          relatedMemoryId: {
            type: "string",
            description: prompts.remember_related_memory_id_parameter_description,
          },
          relatedMemoryIds: { type: "array", items: { type: "string" } },
          relationJudgement: {
            type: "string",
            enum: ["conflict", "distinct", "refines", "related", "same_entity"],
            description: prompts.remember_relation_judgement_parameter_description,
          },
          relationConfidence: { type: "number", minimum: 0, maximum: 1 },
          resolutionReason: { type: "string" },
          activeGraphId: {
            type: "string",
            description: prompts.active_graph_id_parameter_description,
          },
          taskSuccess: {
            type: "boolean",
            description: prompts.feedback_label_parameter_description,
          },
          userCorrection: {
            type: "boolean",
            description: prompts.feedback_label_parameter_description,
          },
          evidenceSufficient: {
            type: "boolean",
            description: prompts.feedback_label_parameter_description,
          },
          expansionUseful: {
            type: "boolean",
            description: prompts.feedback_label_parameter_description,
          },
          excessiveNoise: {
            type: "boolean",
            description: prompts.feedback_label_parameter_description,
          },
          noMemoryNeeded: {
            type: "boolean",
            description: prompts.feedback_label_parameter_description,
          },
          memoryMisleading: {
            type: "boolean",
            description: prompts.feedback_misleading_parameter_description,
          },
          feedbackNote: {
            type: "string",
            description: prompts.feedback_note_parameter_description,
          },
          statement: { type: "string" },
          nodeName: { type: "string", description: prompts.node_name_parameter_description },
          recallTriggers: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 80 },
            maxItems: 16,
            description: prompts.recall_triggers_parameter_description,
          },
          memoryType: {
            type: "string",
            enum: ["constraint", "event", "fact", "preference", "state", "strategy"],
          },
          eventTime: { type: "string" },
          expiresAt: { type: "string" },
          truthStatus: {
            type: "string",
            enum: ["asserted", "inferred", "unverified", "verified"],
          },
          sourceActor: {
            type: "string",
            enum: ["assistant", "system", "tool", "user"],
            description: prompts.source_actor_parameter_description,
          },
          evidence: { type: "string", description: prompts.evidence_parameter_description },
          writeReason: { type: "string" },
          tier: { type: "integer", minimum: 0, maximum: 3 },
          importance: { type: "number", minimum: 0, maximum: 1 },
          scope: { type: "object", additionalProperties: { type: "string" } },
          unsafe: { type: "boolean" },
          externalSource: {
            type: "object",
            properties: {
              source: {
                type: "string",
                description: prompts.external_source_parameter_description,
              },
              retrievedAt: { type: "string" },
              hash: { type: "string" },
            },
            required: ["source"],
            additionalProperties: false,
          },
          boardSource: {
            type: "object",
            properties: { taskId: { type: "string" }, entryId: { type: "string" } },
            required: ["taskId", "entryId"],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const sessionId = toolSessionId(context, "remember");
        const projectDir = projectDirectory(sessionId);
        const action = typeof args.action === "string" ? args.action : "save";
        if (!COMMON_REMEMBER_ACTIONS.includes(action as (typeof COMMON_REMEMBER_ACTIONS)[number])) {
          return { content: `Unsupported remember action: ${action}` };
        }
        if (action === "claim_outcome") {
          return {
            content:
              "action=claim_outcome needs exact-match evidence binding, which the OpenCode host " +
              "cannot derive from session history. Record the outcome through a harness with " +
              "evidence selection (Pi) or the daemon CLI instead.",
          };
        }
        if (action === "feedback") {
          const labels = {
            taskSuccess: args.taskSuccess,
            userCorrection: args.userCorrection,
            evidenceSufficient: args.evidenceSufficient,
            expansionUseful: args.expansionUseful,
            excessiveNoise: args.excessiveNoise,
            noMemoryNeeded: args.noMemoryNeeded,
            memoryMisleading: args.memoryMisleading,
            note: args.feedbackNote,
          };
          if (Object.values(labels).every((value) => value === undefined)) {
            return { content: "action=feedback requires at least one label or feedbackNote" };
          }
          try {
            await invoke("recordFeedback", {
              activeGraphId: args.activeGraphId,
              sessionId,
              ...labels,
            });
            return { content: "Retrieval feedback processed." };
          } catch {
            return { content: "Retrieval feedback processed (daemon unavailable; skipped)." };
          }
        }
        if (action === "forget") {
          if (!args.memoryId) return { content: "action=forget requires memoryId" };
          await invoke("resolveRemember", {
            action: "forget",
            memoryId: args.memoryId,
            projectDir,
            sessionId,
          });
          return {
            content:
              "Memory withdrawn from normal retrieval. The tombstone remains for audit; " +
              "this is not physical privacy erasure.",
          };
        }
        if (action === "resolve" || action === "reopen") {
          if (!args.memoryId) return { content: `action=${action} requires memoryId` };
          await invoke("resolveRemember", {
            action,
            memoryId: args.memoryId,
            relatedMemoryIds: Array.isArray(args.relatedMemoryIds)
              ? (args.relatedMemoryIds as unknown[]).filter(
                  (id): id is string => typeof id === "string",
                )
              : undefined,
            reason: args.resolutionReason,
            projectDir,
            sessionId,
          });
          return {
            content:
              action === "resolve"
                ? "Open memory marked resolved; it is now eligible for ordinary retention policy."
                : "Memory reopened and restored to indexed storage with its related evidence anchors.",
          };
        }
        if (action === "supersede") {
          if (!args.newMemoryId || !args.supersededMemoryId) {
            return { content: "action=supersede requires newMemoryId and supersededMemoryId" };
          }
          await invoke("resolveRemember", {
            action,
            newMemoryId: args.newMemoryId,
            supersededMemoryId: args.supersededMemoryId,
            reason: args.resolutionReason,
            projectDir,
            sessionId,
          });
          return { content: "Older memory superseded by the new value." };
        }
        if (action === "relate") {
          if (!args.newMemoryId || !args.relatedMemoryId || !args.relationJudgement) {
            return {
              content: "action=relate requires newMemoryId, relatedMemoryId, and relationJudgement",
            };
          }
          await invoke("resolveRemember", {
            action,
            newMemoryId: args.newMemoryId,
            relatedMemoryId: args.relatedMemoryId,
            relationJudgement: args.relationJudgement,
            confidence: args.relationConfidence,
            projectDir,
            sessionId,
          });
          return {
            content:
              "Semantic relation recorded as a reversible pending proposal; node identities remain separate.",
          };
        }
        // action=save
        const statement = typeof args.statement === "string" ? args.statement.trim() : "";
        const nodeName = typeof args.nodeName === "string" ? args.nodeName.trim() : "";
        if (!statement || !nodeName) {
          return { content: "saving a memory requires statement and nodeName" };
        }
        const external = args.externalSource as
          { source?: string; retrievedAt?: string; hash?: string } | undefined;
        if (external && !/^(?:file|web):.+/u.test(String(external.source ?? ""))) {
          return { content: "externalSource.source must start with web: or file:" };
        }
        const board = args.boardSource as { taskId?: string; entryId?: string } | undefined;
        const sourceActor = (
          typeof args.sourceActor === "string" ? args.sourceActor : "assistant"
        ) as "assistant" | "system" | "tool" | "user";
        // OpenCode exposes no exact-match session-history API, so a pasted
        // quote from a non-assistant actor degrades provenance instead of
        // pretending free text is a bound witness.
        const degradedProvenance =
          Boolean((args.evidence as string | undefined)?.trim()) &&
          sourceActor !== "assistant" &&
          !external;
        const markers: Array<{ kind: string; attributes: Record<string, unknown> }> = [
          ...(external
            ? [
                {
                  kind: "external_source",
                  attributes: {
                    source: String(external.source),
                    retrievedAt: external.retrievedAt ?? new Date().toISOString(),
                    ...(external.hash ? { hash: external.hash } : {}),
                  },
                },
              ]
            : []),
          ...(board
            ? [
                {
                  kind: "board_origin",
                  attributes: { taskId: board.taskId, entryId: board.entryId },
                },
              ]
            : []),
          ...(degradedProvenance
            ? [
                {
                  kind: "provenance_degraded",
                  attributes: {
                    provider: "opencode",
                    historyReferenceVersion: "opencode.plugin.v1",
                    reason: "session_history_api_unavailable",
                  },
                },
              ]
            : []),
        ];
        const remembered = (await invoke("remember", {
          statement,
          nodeName,
          recallTriggers: Array.isArray(args.recallTriggers)
            ? (args.recallTriggers as unknown[]).filter((t): t is string => typeof t === "string")
            : undefined,
          memoryType: args.memoryType,
          eventTime: args.eventTime,
          expiresAt: args.expiresAt,
          truthStatus: args.truthStatus,
          sourceActor,
          evidence: args.evidence,
          writeReason: args.writeReason,
          writeSource: "agent",
          tier: args.tier,
          importance: args.importance,
          scope: args.scope,
          ...(args.unsafe === true ? { unsafe: true } : {}),
          externalSource: external,
          markers: markers.length > 0 ? markers : undefined,
          projectDir,
          sessionId,
        })) as RememberResult;
        const markerNote =
          markers.length > 0 ? `(markers: ${markers.map((marker) => marker.kind).join(", ")})` : "";
        return { content: renderRememberSurface(remembered, { postamble: markerNote }) };
      },
    });

    // ---- nmg_state (working state + board channel) ------------------------
    const boardState = async (params: Record<string, unknown>): Promise<TaskBoardToolResult> => {
      const wrapped = (await invoke("state", params)) as NmgStateResult;
      return wrapped?.result as TaskBoardToolResult;
    };

    const renameBoardAgent = (
      sessionId: string,
      identity: { id: string; agentName: string },
      requestedName: string,
    ): string => {
      const newName = requestedName.trim();
      if (!newName) {
        return `当前 agent 名：${identity.agentName}（id=${identity.id}）。用法：nmg_state space=board action=write operation=rename agentName=<新名>`;
      }
      renameAgentIdentity({
        anchor: process.env.NMG_AGENT_ID?.trim() || sessionId,
        id: identity.id,
        agentName: newName,
      });
      return `已改名：${newName}（id=${identity.id}）——定向 to= 可用新名或 id。`;
    };

    const boardControlResult = async (
      sessionId: string,
      identity: { id: string; agentName: string },
      args: Record<string, unknown>,
    ): Promise<string | undefined> => {
      const operation = resolveBoardOperation(args);
      if (operation === "rename") {
        return renameBoardAgent(sessionId, identity, String(args.agentName ?? ""));
      }
      if (operation !== "subscribe" && operation !== "unsubscribe") return undefined;
      const result = await boardState({
        action: "write",
        space: "board",
        operation,
        taskId: String(args.taskId ?? WORLD_BOARD_ID),
        sessionId,
        agentId: identity.id,
      });
      const joined = result as { action: string; taskId?: string };
      return operation === "unsubscribe"
        ? `已退出频道 ${joined?.taskId ?? args.taskId}：不再接收该频道新条目的唤醒通知（重新加入用 nmg_state space=board action=write operation=subscribe）。`
        : `已加入频道 ${String(joined?.taskId ?? args.taskId)}：接收该频道新条目的唤醒通知（未订阅频道保持安静）。`;
    };

    const boardToolResult = async (
      sessionId: string,
      args: Record<string, unknown>,
    ): Promise<string> => {
      const identity = loadOrCreateAgentIdentity(sessionId, "opencode");
      const control = await boardControlResult(sessionId, identity, args);
      if (control !== undefined) return control;
      const taskId = String(args.taskId ?? "").trim() || WORLD_BOARD_ID;
      const params = assembleBoardStateParams(args, sessionId, identity);
      await requireBoardEventCapability(params, () => invoke("hello", {}));
      if (COORDINATION_OPERATIONS.has(String(params.operation)))
        return renderStateOutput((await invoke("state", params)) as NmgStateResult);
      const result = await boardState(params);
      const entries = result.entries ?? (result.entry ? [result.entry] : []);
      if (result.action === "read" && entries.length > 0) {
        await Promise.allSettled([
          ...entries.map((entry) =>
            invoke("sessionActiveGraph", {
              action: "observe",
              sessionId,
              kind: "board_projection",
              sourceId: `board:${taskId}:${entry.id}`,
              nodeId: `board:${taskId}`,
              statement: `[task-board ${taskId} #${entry.id} ${entry.kind} by ${entry.agentId}] ${entry.content}`,
            }),
          ),
          invoke("sessionActiveGraph", { action: "activate", sessionId }),
          // Reading is a delivery receipt for open entries — the wake loop
          // should not re-push what this session has already seen. Same echo
          // boundary as the loop: the poster's own entries are never pushed.
          ...entries
            .filter((entry) => entry.status === "open")
            .filter(
              (entry) => !(entry.sourceSessionId === sessionId || entry.agentId === identity.id),
            )
            .map((entry) =>
              invoke("taskBoard", {
                action: "recordDelivery",
                entryId: entry.id,
                sessionId,
                agentId: identity.id,
                source: "read",
              }),
            ),
        ]);
      }
      let directory: TaskBoardDirectoryEntry[] = [];
      if (result.action === "read" && taskId === WORLD_BOARD_ID) {
        const lobby = await boardState({
          action: "read",
          space: "board",
          operation: "list",
          agentId: identity.id,
        }).catch(() => null);
        directory = ((lobby as { boards?: TaskBoardDirectoryEntry[] } | null)?.boards ??
          []) as TaskBoardDirectoryEntry[];
      }
      return renderTaskBoardSurface(result as unknown as TaskBoardSurfaceResult, {
        taskId,
        directory,
      });
    };

    const stateTool = (): ToolRegistration => ({
      name: "state",
      description: prompts.state_description,
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "write"] },
          space: { type: "string", enum: ["ag", "board"] },
          operation: { type: "string", enum: [...STATE_OPERATIONS] },
          notification: {
            type: "object",
            additionalProperties: true,
            description:
              "Explicit notice: key, scopes [direct|channel|event], optional recipients (stable IDs), invite:true to enroll invitees and sender in taskId. Reuse key for retries.",
          },
          eventId: { type: "string" },
          event: {
            type: "object",
            additionalProperties: true,
            description:
              "Event create/mutation payload; updates require expectedRevision, kind and text.",
          },
          text: { type: "string" },
          reason: { type: "string" },
          ttlSeconds: { type: "integer", minimum: 60, maximum: 86400 },
          taskId: { type: "string", description: prompts.board_task_id_parameter_description },
          content: { type: "string", description: prompts.board_content_parameter_description },
          kind: {
            type: "string",
            enum: ["blocker", "decision", "goal", "handoff", "note", "question", "result"],
          },
          entryId: { type: "string" },
          resolution: { type: "string" },
          leaseSeconds: { type: "integer", minimum: 60, maximum: 86400 },
          digest: {
            type: "string",
            description: "deliver only: sha256 identity of the artifact you hand in",
          },
          ref: { type: "string", description: "deliver only: where the artifact can be read" },
          summary: { type: "string", description: "deliver only: what the artifact contains" },
          verdict: {
            type: "string",
            enum: [...TASK_BOARD_VERDICTS],
            description: "judge only: accepted | rejected | undecidable",
          },
          afterCursor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          includeResolved: { type: "boolean" },
          to: {
            type: "string",
            description: "定向投递：stable agent_name 只唤醒该 agent（discover 选人）",
          },
          need: { type: "string", description: "discover 的找人需求描述（可选）" },
          capabilities: { type: "string", description: "discover 按能力过滤（可选）" },
          agentName: { type: "string", description: "rename 的新显示名（id 不变）" },
        },
        required: ["action", "space"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const sessionId = toolSessionId(context, "state");
        if (args.space === "ag") {
          const operation = stateOperation({
            action: String(args.action),
            space: "ag",
            operation: args.operation === undefined ? undefined : String(args.operation),
          });
          const captured = await captureStateInvocation(
            {
              action: String(args.action),
              space: "ag",
              operation,
              text: args.text,
              reason: args.reason,
              ttlSeconds: args.ttlSeconds,
              sessionId,
              requester: "agent:opencode",
            },
            (boundSessionId: string) =>
              invoke("state", {
                action: "read",
                space: "ag",
                operation: "status",
                sessionId: boundSessionId,
              }),
          );
          const result = (await invoke("state", captured)) as NmgStateResult;
          return { content: renderStateOutput(result) };
        }
        if (!coordinationEnabled()) {
          return { content: "Board coordination is disabled (NMG_ENABLE_COORDINATION)." };
        }
        const action = String(args.action);
        if (
          (action === "deliver" && !args.digest) ||
          (action === "judge" && (!args.verdict || !args.reason))
        ) {
          return {
            content:
              action === "deliver"
                ? "deliver requires digest: the sha256 identity of the artifact being handed in"
                : "judge requires verdict (accepted|rejected|undecidable) and reason: the ruling is recorded in the entry and survives a restart",
          };
        }
        return { content: await boardToolResult(sessionId, args) };
      },
    });

    let registered: Promise<unknown>;
    const registerTools = (editor: ToolEditor): void => {
      editor.add(searchTool());
      editor.add(getTool());
      editor.add(rememberTool());
      editor.add(stateTool());
    };
    try {
      // namespace+nodemode lands these as nmg_<name> in the Code Mode catalog.
      registered = ctx.tool.transform(registerTools, { namespace: "nmg", codemode: true });
    } catch {
      // Defensive: if this v2 build rejects transform options, register plain.
      registered = ctx.tool.transform(registerTools);
    }
    await registered;

    // ---- Event stream: project mapping + idle attribution + heartbeat ----
    const flushAttributionAndHeartbeat = async (sessionId: string): Promise<void> => {
      const session = sessions.get(sessionId);
      if (session) sessions.set(sessionId, { ...session, lastIdleAt: Date.now() });
      if (!session?.child && coordinationEnabled()) {
        const identity = loadOrCreateAgentIdentity(sessionId, "opencode");
        await invoke("taskBoard", {
          action: "registerAgent",
          id: identity.id,
          agentName: identity.agentName,
          capabilities: process.env.NMG_AGENT_CAPABILITIES?.trim() || undefined,
          supportedInterfaces: "opencode",
        }).catch(() => undefined);
      }
      const pending = attribution.consume(sessionId);
      if (pending.length === 0) return;
      try {
        const history = (await ctx.session.context?.({ sessionID: sessionId })) as
          Array<unknown> | undefined | null;
        const answerText = extractAnswerText(historyMessages(history ?? []));
        const promptText = extractPromptText(historyMessages(history ?? []));
        if (!answerText) return; // no answer — never mislabel traces (pi parity)
        for (const trace of pending) {
          const attributedMemoryIds = deriveAnswerOverlapMemoryIds(
            answerText,
            trace.results,
            promptText,
          );
          await invoke("recordActiveGraphAttribution", {
            activeGraphId: trace.traceId,
            attributedMemoryIds,
            projectDir: projectDirectory(sessionId),
            sessionId,
          }).catch(() => undefined);
        }
      } catch {
        // Attribution is diagnostic; never break the host event loop.
      }
    };

    const abort = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        try {
          const type = event?.type ?? "";
          const sessionId = event?.data?.sessionID ?? "";
          if (sessionId) {
            rememberSession(
              sessionId,
              event?.data?.location?.directory ?? event?.location?.directory ?? "",
              Boolean(event?.data?.parentID),
            );
          }
          // OpenCode 2.0.32 never emits session.created or session.idle on the
          // plugin event stream; session.execution.succeeded marks the end of
          // a run (idle parity), so attribution flush, heartbeat, and staged
          // injection teardown hang off it. session.execution.failed ends
          // failed runs the same way for parity.
          if (
            (type === "session.idle" ||
              type === "session.execution.succeeded" ||
              type === "session.execution.failed") &&
            sessionId
          ) {
            pendingInjections.delete(sessionId);
            await flushAttributionAndHeartbeat(sessionId).catch(() => undefined);
          }
        } catch {
          // Never break the host event stream.
        }
      }
    })().catch(() => undefined);

    // ---- Board wake loop --------------------------------------------------
    // Shared with pi via src/integration/board-wake.ts (config/state/gating/
    // delivery semantics; board-wake.json / board-wake-state.json dataDir with
    // pi). Shape difference: this plugin serves every OpenCode session
    // machine-wide, so each tick selects from a small pool of recently-idle
    // sessions (never subagent children). NMG_WAKE_PROJECT narrows the pool to
    // one project directory when set.
    const wakePool = (): Array<{ sessionId: string; projectDir: string }> => {
      const scope = process.env.NMG_WAKE_PROJECT?.trim().toLowerCase();
      const now = Date.now();
      return [...sessions.entries()]
        .filter(([sessionId, record]) => {
          if (record.child || record.lastPromptAt === 0) return false;
          // Idle now, and not racing a session that just went idle.
          return (
            record.lastIdleAt >= record.lastPromptAt &&
            now - record.lastIdleAt > 1_000 &&
            sessionId.length > 0
          );
        })
        .filter(([, record]) => !scope || record.projectDir.toLowerCase() === scope)
        .sort((left, right) => right[1].lastIdleAt - left[1].lastIdleAt)
        .slice(0, WAKE_POOL_SIZE)
        .map(([sessionId, record]) => ({ sessionId, projectDir: record.projectDir }));
    };

    const scanBoardWake = async (): Promise<void> => {
      const config = readWakeConfig(dataDir);
      const state = loadWakeState(dataDir);
      const now = Date.now();
      if (!wakeBudgetGate(config, state, now)) return;
      for (const target of wakePool()) {
        const identity = loadOrCreateAgentIdentity(target.sessionId, "opencode");
        const candidates = await collectWakeCandidates(invoke, {
          agentId: identity.id,
          agentName: identity.agentName,
          sessionId: target.sessionId,
        });
        if (candidates.length === 0) continue;
        const fresh = await filterUndelivered(invoke, candidates, {
          agentId: identity.id,
          sessionId: target.sessionId,
        });
        if (fresh.length === 0) continue;
        const rank: Record<string, number> = {
          question: 0,
          blocker: 1,
          handoff: 2,
          goal: 3,
          note: 4,
          decision: 5,
          result: 6,
        };
        fresh.sort(
          (left, right) =>
            (rank[left.kind] ?? 9) - (rank[right.kind] ?? 9) ||
            String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")),
        );
        await deliverBoardWake({
          invoke,
          sendWake: (message) =>
            ctx.session.prompt?.({ sessionID: target.sessionId, text: message }),
          config,
          state,
          dataDir,
          now,
          agentId: identity.id,
          sessionId: target.sessionId,
          entry: fresh[0]!,
        });
        return; // one wake per tick — same budget discipline as pi
      }
    };

    const armWakeLoop = (): void => {
      const tick = (): void => {
        void scanBoardWake()
          .catch(() => undefined)
          .finally(() => {
            const timer = setTimeout(tick, readWakeConfig(dataDir).intervalMs);
            if (typeof (timer as { unref?: () => void })?.unref === "function") {
              (timer as { unref: () => void }).unref();
            }
          });
      };
      const first = setTimeout(tick, readWakeConfig(dataDir).intervalMs);
      if (typeof (first as { unref?: () => void })?.unref === "function") {
        (first as { unref: () => void }).unref();
      }
    };
    if (coordinationEnabled()) armWakeLoop();

    return async () => {
      abort.abort();
      pendingInjections.clear();
      commitNudges.clear();
      for (const sessionId of sessions.keys()) {
        taskWindow.clear(sessionId);
        recallFlow.clear(sessionId);
        attribution.clear(sessionId);
      }
      sessions.clear();
    };
  },
};
