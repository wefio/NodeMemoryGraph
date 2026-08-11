import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  connectDaemon,
  invokeDaemon,
  shutdownOwnedDaemon,
  type DaemonConnection,
} from "../../../src/cli/daemon-client.ts";
import {
  archiveOrStage,
  archiveNodeName,
  archiveStatement,
  flushArchives,
  stagingDirFor,
} from "../../../src/cli/archive-staging.ts";
import { loadPrompts, renderDisclosure } from "../../../src/prompts/load.ts";
import type { MemoryContext, MemorySearchResult, MemoryTier } from "../../../src/core/types.ts";
import { searchPreview } from "../../../src/integration/search-projection.ts";
import { selectEvidence, type AgentHistoryMessage } from "../../../src/integration/evidence.ts";
import { ControllerShadowBridge } from "./controller-shadow.ts";

/**
 * NMG Pi extension.
 *
 * Transport: connects to the NMG daemon over JSON-RPC/HTTP via
 * `daemon-client.ts`. The client path is intentionally thin — it imports only
 * `http-client.ts` (Node built-in fetch) and never `service.ts` / the core
 * store. That keeps the store dependency tree out of every Pi startup. See
 * tests/cli/http-boundary.test.ts.
 */

function databasePath(): string {
  return join(process.env.NMG_DATA_DIR || join(homedir(), ".nmg"), "nmg.sqlite");
}

function projectDirectory(): string {
  return process.env.NMG_PROJECT_DIR || process.cwd();
}

export default function nmgExtension(pi: ExtensionAPI): void {
  let connectionPromise: Promise<DaemonConnection> | undefined;
  const injectionWindow = new SessionInjectionWindow();
  const taskWindow = new SessionTaskWindow();
  const recallFlow = new SessionRecallFlow();
  const toolTraceCapture = new SessionToolTraceCapture();
  const controllerShadow = new ControllerShadowBridge(
    process.env.NMG_DATA_DIR || join(homedir(), ".nmg"),
  );
  // Weak completion nudge: a git commit (or an explicit completion phrase) is a
  // low-signal hint that NMG memory is available — a reminder, never a forced
  // action. Set by the tool_result hook, consumed once by before_agent_start.
  let commitNudgePending = false;
  const popCompletionNudge = (prompt: string): string => {
    const triggered =
      commitNudgePending ||
      /(?:完成了|收工|搞定|结束|提交了|committed|done|finished|wrapped up)/u.test(prompt);
    commitNudgePending = false;
    if (!triggered) return "";
    return nmgPrompts.completion_nudge;
  };
  const connection = (): Promise<DaemonConnection> =>
    (connectionPromise ??= connectDaemon(databasePath()));
  const invoke = async (
    method: "get" | "remember" | "resolveRemember" | "search",
    params: Record<string, unknown>,
  ) => invokeDaemon(await connection(), method, params);

  // git commit via the bash tool is the strongest "milestone" signal available
  // to the extension; remember it so the next turn can offer NMG memory. The
  // detection moved from the pre-execution tool_call hook to tool_result so it
  // is success-aware (only a commit that actually landed nudges). The same
  // hook feeds low-priority PostToolUse memory (tool traces); those writes are
  // fire-and-forget so they never delay the tool result that just returned.
  pi.on("tool_result", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (isSuccessfulCommit(event)) commitNudgePending = true;
    const params = toolTraceRememberParams(event, sessionId, projectDirectory());
    if (!params) return;
    if (!toolTraceCapture.note(sessionId, event.toolName, String(params.statement))) return;
    void invoke("remember", params).catch(() => {
      // Fire-and-forget: a failed trace write must never block the agent loop.
    });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    injectionWindow.beginTurn(sessionId);
    recallFlow.beginTurn(sessionId, event.prompt);
    const nudge = popCompletionNudge(event.prompt);
    const recallQuery = taskWindow.prepare(sessionId, event.prompt);
    if (!recallQuery) {
      return { systemPrompt: composeNmgSystemPrompt(event.systemPrompt, "", "", nudge) };
    }
    try {
      const context = (await invoke("search", {
        query: recallQuery,
        projectDir: projectDirectory(),
        sessionId,
        maxTier: configuredAutoRecallTier(),
        limit: configuredAutoRecallLimit(),
        initialEvidenceTarget: configuredInitialTarget(),
        strongHitTopGap: configuredStrongHitTopGap(),
        strongHitInitialTarget: configuredStrongHitInitialTarget(),
        secondPass: true,
        graphHops: 1,
        tieredDisclosure: true,
      })) as MemoryContext;
      const recalled = injectionWindow.format(sessionId, context, "header");
      await controllerShadow.retrieval(context, sessionId, "automatic", recalled);
      return {
        systemPrompt: composeNmgSystemPrompt(event.systemPrompt, recalled, "", nudge),
      };
    } catch (error) {
      return {
        systemPrompt: composeNmgSystemPrompt(
          event.systemPrompt,
          "",
          `NMG unavailable: ${message(error)}`,
          nudge,
        ),
      };
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    // Flush archive entries staged by a previous session_shutdown. The daemon
    // is lazily started by the first invoke, so this cannot race teardown.
    // Failures keep the staging files for the next startup.
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      await flushArchives(stagingDirFor(projectDirectory()), async (entry) => {
        await invoke("remember", {
          statement: archiveStatement(entry),
          nodeName: archiveNodeName(entry),
          memoryType: "event",
          eventTime: entry.archivedAt,
          sourceActor: "system",
          truthStatus: "asserted",
          tier: 2,
          importance: 0.2,
          markers: [{ kind: "session_archive", attributes: { sessionId: entry.sessionId } }],
          scope: { project: projectDirectory() },
          writeReason: "session_archive_flush",
          projectDir: projectDirectory(),
          sessionId,
        });
      });
    } catch {
      // Daemon unavailable; staging files remain for the next startup.
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    await controllerShadow.outcome(ctx.sessionManager.getSessionId(), event.messages);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    injectionWindow.clear(sessionId);
    taskWindow.clear(sessionId);
    recallFlow.clear(sessionId);
    toolTraceCapture.clear(sessionId);
    controllerShadow.clear(sessionId);
    if (!connectionPromise) return;
    const active = await connectionPromise.catch(() => undefined);
    if (!active) {
      connectionPromise = undefined;
      return;
    }
    // Archive before teardown (daemon is still alive here); archiveOrStage has
    // a hard timeout and never throws, so daemon shutdown always runs.
    await archiveOrStage(
      stagingDirFor(projectDirectory()),
      {
        sessionId,
        sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
        projectDir: projectDirectory(),
        archivedAt: new Date().toISOString(),
        reason: event.reason,
      },
      async (params) =>
        invokeDaemon(active, "remember", {
          ...params,
          memoryType: "event",
          sourceActor: "system",
          truthStatus: "asserted",
          tier: 2,
          importance: 0.2,
          markers: [{ kind: "session_archive", attributes: { sessionId } }],
          scope: { project: projectDirectory() },
          writeReason: "session_archive_shutdown",
          projectDir: projectDirectory(),
          sessionId,
        }),
    );
    try {
      await shutdownOwnedDaemon(active);
    } catch {
      // shutdownOwnedDaemon already force-exits survivors; nothing more to do.
    } finally {
      connectionPromise = undefined;
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    injectionWindow.clear(sessionId);
    // Rescue the messages about to be compacted away before silent context
    // loss. Pi already computed the doomed span (preparation.messagesToSummarize);
    // we persist a bounded textual fragment as a low-tier event.
    const params = compactRescueRememberParams(
      event.preparation?.messagesToSummarize ?? [],
      sessionId,
      projectDirectory(),
      event.reason,
    );
    if (params) {
      void invoke("remember", params).catch(() => {
        // Fire-and-forget: compaction must proceed even if the rescue fails.
      });
    }
  });

  pi.registerTool({
    name: "nmg_remember",
    label: "Remember with NMG",
    description: nmgPrompts.remember_description,
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union(
          [
            Type.Literal("save"),
            Type.Literal("supersede"),
            Type.Literal("relate"),
            Type.Literal("forget"),
            Type.Literal("feedback"),
          ],
          { description: nmgPrompts.remember_action_parameter_description },
        ),
      ),
      memoryId: Type.Optional(
        Type.String({ description: nmgPrompts.remember_memory_id_parameter_description }),
      ),
      activeGraphId: Type.Optional(
        Type.String({ description: nmgPrompts.active_graph_id_parameter_description }),
      ),
      taskSuccess: Type.Optional(
        Type.Boolean({ description: nmgPrompts.feedback_label_parameter_description }),
      ),
      userCorrection: Type.Optional(
        Type.Boolean({ description: nmgPrompts.feedback_label_parameter_description }),
      ),
      evidenceSufficient: Type.Optional(
        Type.Boolean({ description: nmgPrompts.feedback_label_parameter_description }),
      ),
      expansionUseful: Type.Optional(
        Type.Boolean({ description: nmgPrompts.feedback_label_parameter_description }),
      ),
      excessiveNoise: Type.Optional(
        Type.Boolean({ description: nmgPrompts.feedback_label_parameter_description }),
      ),
      noMemoryNeeded: Type.Optional(
        Type.Boolean({ description: nmgPrompts.feedback_label_parameter_description }),
      ),
      feedbackNote: Type.Optional(
        Type.String({ description: nmgPrompts.feedback_note_parameter_description }),
      ),
      semanticTaskId: Type.Optional(
        Type.String({ description: nmgPrompts.semantic_task_id_parameter_description }),
      ),
      statement: Type.Optional(Type.String()),
      nodeName: Type.Optional(
        Type.String({ description: nmgPrompts.node_name_parameter_description }),
      ),
      newMemoryId: Type.Optional(
        Type.String({ description: nmgPrompts.remember_new_memory_id_parameter_description }),
      ),
      supersededMemoryId: Type.Optional(
        Type.String({
          description: nmgPrompts.remember_superseded_memory_id_parameter_description,
        }),
      ),
      relatedMemoryId: Type.Optional(
        Type.String({ description: nmgPrompts.remember_related_memory_id_parameter_description }),
      ),
      relationJudgement: Type.Optional(
        Type.Union(
          [
            Type.Literal("conflict"),
            Type.Literal("distinct"),
            Type.Literal("refines"),
            Type.Literal("related"),
            Type.Literal("same_entity"),
          ],
          { description: nmgPrompts.remember_relation_judgement_parameter_description },
        ),
      ),
      relationConfidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      resolutionReason: Type.Optional(Type.String()),
      memoryType: Type.Optional(
        Type.Union([
          Type.Literal("constraint"),
          Type.Literal("event"),
          Type.Literal("fact"),
          Type.Literal("preference"),
          Type.Literal("state"),
          Type.Literal("strategy"),
        ]),
      ),
      stateKey: Type.Optional(
        Type.String({
          description: nmgPrompts.state_key_parameter_description,
        }),
      ),
      eventTime: Type.Optional(Type.String()),
      sourceActor: Type.Optional(
        Type.Union([
          Type.Literal("assistant"),
          Type.Literal("system"),
          Type.Literal("tool"),
          Type.Literal("user"),
        ]),
      ),
      truthStatus: Type.Optional(
        Type.Union([
          Type.Literal("asserted"),
          Type.Literal("inferred"),
          Type.Literal("unverified"),
          Type.Literal("verified"),
        ]),
      ),
      evidence: Type.Optional(
        Type.String({ description: nmgPrompts.evidence_parameter_description }),
      ),
      writeReason: Type.Optional(Type.String()),
      tier: Type.Optional(
        Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
      ),
      importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      scope: Type.Optional(Type.Record(Type.String(), Type.String())),
      residence: Type.Optional(Type.Union([Type.Literal("ltg"), Type.Literal("stg")])),
      expiresAt: Type.Optional(Type.String()),
      externalSource: Type.Optional(
        Type.Object({
          source: Type.String({
            description: nmgPrompts.external_source_parameter_description,
          }),
          retrievedAt: Type.Optional(Type.String()),
          hash: Type.Optional(Type.String()),
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "feedback") {
        if (!params.activeGraphId) throw new Error("action=feedback requires activeGraphId");
        const labels = {
          taskSuccess: params.taskSuccess,
          userCorrection: params.userCorrection,
          evidenceSufficient: params.evidenceSufficient,
          expansionUseful: params.expansionUseful,
          excessiveNoise: params.excessiveNoise,
          noMemoryNeeded: params.noMemoryNeeded,
          note: params.feedbackNote,
          semanticTaskId: params.semanticTaskId,
        };
        if (Object.values(labels).every((value) => value === undefined)) {
          throw new Error("action=feedback requires at least one label or feedbackNote");
        }
        const recorded = await controllerShadow.feedback(
          params.activeGraphId,
          ctx.sessionManager.getSessionId(),
          labels,
        );
        return toolResult(
          { recorded, activeGraphId: params.activeGraphId },
          recorded
            ? "Retrieval feedback recorded for shadow calibration."
            : "Feedback was not recorded: controller shadow is disabled or the Active Graph belongs to another session.",
        );
      }
      if (params.action === "forget") {
        if (!params.memoryId) throw new Error("action=forget requires memoryId");
        const resolved = await invoke("resolveRemember", {
          action: "forget",
          memoryId: params.memoryId,
          projectDir: projectDirectory(),
          sessionId: ctx.sessionManager.getSessionId(),
        });
        return toolResult(
          resolved,
          "Memory withdrawn from normal retrieval. The tombstone remains for audit; this is not physical privacy erasure.",
        );
      }
      if (params.action === "supersede") {
        if (!params.newMemoryId || !params.supersededMemoryId) {
          throw new Error("action=supersede requires newMemoryId and supersededMemoryId");
        }
        const resolved = await invoke("resolveRemember", {
          action: "supersede",
          newMemoryId: params.newMemoryId,
          supersededMemoryId: params.supersededMemoryId,
          reason: params.resolutionReason,
          projectDir: projectDirectory(),
          sessionId: ctx.sessionManager.getSessionId(),
        });
        return toolResult(resolved, "Older memory superseded by the new value.");
      }
      if (params.action === "relate") {
        if (!params.newMemoryId || !params.relatedMemoryId || !params.relationJudgement) {
          throw new Error(
            "action=relate requires newMemoryId, relatedMemoryId, and relationJudgement",
          );
        }
        const resolved = await invoke("resolveRemember", {
          action: "relate",
          newMemoryId: params.newMemoryId,
          relatedMemoryId: params.relatedMemoryId,
          relationJudgement: params.relationJudgement,
          confidence: params.relationConfidence,
          projectDir: projectDirectory(),
          sessionId: ctx.sessionManager.getSessionId(),
        });
        return toolResult(
          resolved,
          "Semantic relation recorded as a reversible pending proposal; node identities remain separate.",
        );
      }
      if (!params.statement?.trim() || !params.nodeName?.trim()) {
        throw new Error("saving a memory requires statement and nodeName");
      }
      const { externalSource, ...memory } = params;
      delete memory.action;
      delete memory.memoryId;
      delete memory.newMemoryId;
      delete memory.supersededMemoryId;
      delete memory.relatedMemoryId;
      delete memory.relationJudgement;
      delete memory.relationConfidence;
      delete memory.resolutionReason;
      delete memory.activeGraphId;
      delete memory.taskSuccess;
      delete memory.userCorrection;
      delete memory.evidenceSufficient;
      delete memory.expansionUseful;
      delete memory.excessiveNoise;
      delete memory.noMemoryNeeded;
      delete memory.feedbackNote;
      delete memory.semanticTaskId;
      if (externalSource && !/^(?:file|web):.+/u.test(externalSource.source)) {
        throw new Error("externalSource.source must start with web: or file:");
      }
      const result = await invoke("remember", {
        ...memory,
        evidenceSource: selectPiEvidenceSource(
          ctx.sessionManager,
          params.evidence,
          params.sourceActor ?? "user",
        ),
        markers: externalSource
          ? [
              {
                kind: "external_source",
                attributes: {
                  source: externalSource.source,
                  retrievedAt: externalSource.retrievedAt ?? new Date().toISOString(),
                  ...(externalSource.hash ? { hash: externalSource.hash } : {}),
                },
              },
            ]
          : undefined,
        projectDir: projectDirectory(),
        sessionId: ctx.sessionManager.getSessionId(),
      });
      return toolResult(result, formatRememberResult(result));
    },
  });

  pi.registerTool({
    name: "nmg_get",
    label: "Get NMG evidence",
    description: nmgPrompts.get_description,
    parameters: Type.Object({
      memoryIds: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }),
      activeGraphId: Type.Optional(
        Type.String({
          description: nmgPrompts.active_graph_id_parameter_description,
        }),
      ),
      graphHops: Type.Optional(Type.Number({ minimum: 0, maximum: 3 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = (await invoke("get", {
        ...params,
        projectDir: projectDirectory(),
        sessionId: ctx.sessionManager.getSessionId(),
      })) as MemoryContext;
      recallFlow.recordGet(ctx.sessionManager.getSessionId());
      await controllerShadow.use(
        params.activeGraphId,
        ctx.sessionManager.getSessionId(),
        params.memoryIds,
        result.results.map((entry) => entry.memory.id),
      );
      const text = injectionWindow.format(ctx.sessionManager.getSessionId(), result, "evidence");
      return toolResult(result, text || "No active memory found.");
    },
  });

  pi.registerTool({
    name: "nmg_search",
    label: "Search NMG",
    description: nmgPrompts.search_description,
    parameters: Type.Object({
      query: Type.String({
        description: nmgPrompts.search_query_parameter_description,
      }),
      queries: Type.Optional(
        Type.Array(Type.String(), {
          description: nmgPrompts.search_queries_parameter_description,
        }),
      ),
      nodeName: Type.Optional(Type.String()),
      maxTier: Type.Optional(
        Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
      ),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      scope: Type.Optional(Type.Record(Type.String(), Type.String())),
      includeHistorical: Type.Optional(Type.Boolean()),
      graphHops: Type.Optional(Type.Number({ minimum: 0, maximum: 3 })),
      secondPass: Type.Optional(Type.Boolean()),
      initialEvidenceTarget: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      strongHitTopGap: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      strongHitInitialTarget: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      tieredDisclosure: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!recallFlow.allowSearch(sessionId)) {
        await controllerShadow.searchSuppressed(sessionId, params.query);
        return toolResult(
          { searchSuppressed: true, reason: "evidence_progression_required" },
          nmgPrompts.search_progression_required,
        );
      }
      const result = (await invoke("search", {
        ...params,
        // Automatic recall remains shallow. An explicit search is the agent's
        // request to look beyond that cache, so expose all tiers by default;
        // result/token budgets still bound what is returned.
        maxTier: params.maxTier ?? 3,
        projectDir: projectDirectory(),
        sessionId,
      })) as MemoryContext;
      const text = injectionWindow.format(sessionId, result, "header");
      await controllerShadow.retrieval(result, sessionId, "tool", text);
      return toolResult(result, text);
    },
  });
}

const EVIDENCE_SOURCE_WINDOW = 64;
export const PI_BRANCH_SHAPE_VERSION = "pi.branch.v1" as const;

export function projectPiBranch(value: unknown): {
  version: typeof PI_BRANCH_SHAPE_VERSION;
  supported: boolean;
  messages: AgentHistoryMessage[];
} {
  if (!Array.isArray(value)) {
    return { version: PI_BRANCH_SHAPE_VERSION, supported: false, messages: [] };
  }
  const messages: AgentHistoryMessage[] = [];
  for (const entry of value.slice(-EVIDENCE_SOURCE_WINDOW)) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { type?: unknown; id?: unknown; message?: unknown };
    if (candidate.type !== "message") continue;
    if (
      typeof candidate.id !== "string" ||
      !candidate.message ||
      typeof candidate.message !== "object" ||
      typeof (candidate.message as { role?: unknown }).role !== "string"
    ) {
      return { version: PI_BRANCH_SHAPE_VERSION, supported: false, messages: [] };
    }
    const projected = piHistoryMessage(entry);
    if (projected) messages.push(projected);
  }
  return { version: PI_BRANCH_SHAPE_VERSION, supported: true, messages };
}

export function selectPiEvidenceSource(
  sessionManager: {
    getSessionId(): string;
    getBranch?: () => unknown[];
  },
  evidence: string | undefined,
  sourceActor: "assistant" | "system" | "tool" | "user",
) {
  if (!evidence?.trim() || typeof sessionManager.getBranch !== "function") return undefined;
  const branch = projectPiBranch(sessionManager.getBranch());
  if (!branch.supported) return undefined;
  return selectEvidence(evidence, sourceActor, {
    sessionId: sessionManager.getSessionId(),
    sourceRef: `pi-session:${sessionManager.getSessionId()};shape=${branch.version}`,
    messages: branch.messages,
  });
}

function piHistoryMessage(value: unknown): AgentHistoryMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as {
    type?: unknown;
    id?: unknown;
    message?: { role?: unknown; content?: unknown };
  };
  if (entry.type !== "message" || typeof entry.id !== "string" || !entry.message) {
    return undefined;
  }
  const actor =
    entry.message.role === "user"
      ? "user"
      : entry.message.role === "assistant"
        ? "assistant"
        : entry.message.role === "toolResult"
          ? "tool"
          : undefined;
  if (!actor) return undefined;
  const content = messageText(entry.message.content);
  return content ? { id: entry.id, actor, content } : undefined;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

type DisclosureLevel = "header" | "exact" | "evidence";

interface InjectionEntry {
  contentHash: string;
  disclosure: DisclosureLevel;
  turn: number;
}

interface SessionInjectionState {
  turn: number;
  entries: Map<string, InjectionEntry>;
}

/** Small, session-local cache of memory content already placed in Pi's context. */
export class SessionInjectionWindow {
  readonly #sessions = new Map<string, SessionInjectionState>();
  readonly maxTurns: number;
  readonly maxEntries: number;

  constructor(maxTurns = 12, maxEntries = 128) {
    this.maxTurns = maxTurns;
    this.maxEntries = maxEntries;
  }

  beginTurn(sessionId: string): void {
    const state = this.#state(sessionId);
    state.turn += 1;
    for (const [memoryId, entry] of state.entries) {
      if (state.turn - entry.turn >= this.maxTurns) state.entries.delete(memoryId);
    }
  }

  clear(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  format(sessionId: string, context: MemoryContext, disclosure: DisclosureLevel): string {
    if (context.results.length === 0) {
      return disclosure === "header" ? "No matching NMG memory found." : "";
    }
    const state = this.#state(sessionId);
    const fresh = [];
    const folded = [];
    for (const result of context.results) {
      const contentHash = injectionHash(result);
      const previous = state.entries.get(result.memory.id);
      const alreadyAvailable =
        previous?.contentHash === contentHash &&
        disclosureRank(previous.disclosure) >= disclosureRank(disclosure);
      if (alreadyAvailable) folded.push(result);
      else {
        fresh.push(result);
        state.entries.delete(result.memory.id);
        state.entries.set(result.memory.id, { contentHash, disclosure, turn: state.turn });
      }
    }
    while (state.entries.size > this.maxEntries) {
      state.entries.delete(state.entries.keys().next().value!);
    }

    const sections = [];
    if (fresh.length > 0) {
      const visible = { ...context, results: fresh } as MemoryContext;
      sections.push(
        disclosure === "header" ? formatSearchHeaders(visible) : formatMemoryContext(visible),
      );
    }
    if (folded.length > 0) {
      sections.push(
        nmgPrompts.in_context_title +
          "\n" +
          folded.map(({ memory }) => `- memory=${memory.id}; already_in_context=true`).join("\n"),
      );
    }
    if (disclosure === "header" && fresh.length === 0) {
      const activeGraph = formatActiveGraph(context);
      if (activeGraph) sections.push(activeGraph);
    }
    return sections.join("\n");
  }

  #state(sessionId: string): SessionInjectionState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = { turn: 0, entries: new Map() };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }
}

interface SessionTaskState {
  anchors: string[];
}

/**
 * Bounded query-side task context for automatic recall. It does not inject
 * transcript text into the model and does not attempt semantic summarisation;
 * it only carries two recent substantive user task anchors across terse
 * continuation turns such as "reload 了，你试试".
 */
export class SessionTaskWindow {
  readonly #sessions = new Map<string, SessionTaskState>();
  readonly maxAnchors: number;
  readonly maxAnchorCharacters: number;

  constructor(maxAnchors = 2, maxAnchorCharacters = 480) {
    this.maxAnchors = Math.max(1, maxAnchors);
    this.maxAnchorCharacters = Math.max(80, maxAnchorCharacters);
  }

  prepare(sessionId: string, prompt: string): string | null {
    const normalized = normalizeTaskPrompt(prompt);
    if (!normalized) return null;
    const state = this.#state(sessionId);
    const explicitRecall = hasExplicitRecallIntent(normalized);
    const substantive = isSubstantiveTaskPrompt(normalized);
    const continuation = isTaskContinuation(normalized);
    const prior = state.anchors.join("\n");
    const shouldRecall = explicitRecall || substantive || (continuation && prior.length > 0);
    const usePriorContext = prior.length > 0 && (explicitRecall || continuation);
    const query = shouldRecall
      ? [normalized, usePriorContext ? `Recent task context:\n${prior}` : ""]
          .filter(Boolean)
          .join("\n")
      : null;

    if (substantive) {
      const anchor = excerpt(normalized, this.maxAnchorCharacters);
      if (state.anchors.at(-1) !== anchor) state.anchors.push(anchor);
      while (state.anchors.length > this.maxAnchors) state.anchors.shift();
    }
    return query;
  }

  clear(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  #state(sessionId: string): SessionTaskState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = { anchors: [] };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }
}

/**
 * Per-turn tool-flow guard. It does not cap retrieval depth or result count;
 * it prevents repeated paraphrased searches when the model has not consumed
 * any returned evidence. A successful get opens the search phase again.
 */
export class SessionRecallFlow {
  readonly #states = new Map<string, { turnKey: string; searches: number }>();
  readonly maxSearchesBeforeGet: number;

  constructor(maxSearchesBeforeGet = 2) {
    this.maxSearchesBeforeGet = Math.max(1, maxSearchesBeforeGet);
  }

  beginTurn(sessionId: string, turnKey: string): void {
    const current = this.#states.get(sessionId);
    if (current?.turnKey === turnKey) return;
    this.#states.set(sessionId, { turnKey, searches: 0 });
  }

  allowSearch(sessionId: string): boolean {
    const current = this.#states.get(sessionId) ?? { turnKey: "", searches: 0 };
    if (current.searches >= this.maxSearchesBeforeGet) return false;
    this.#states.set(sessionId, { ...current, searches: current.searches + 1 });
    return true;
  }

  recordGet(sessionId: string): void {
    const current = this.#states.get(sessionId) ?? { turnKey: "", searches: 0 };
    this.#states.set(sessionId, { ...current, searches: 0 });
  }

  clear(sessionId: string): void {
    this.#states.delete(sessionId);
  }
}

function disclosureRank(level: DisclosureLevel): number {
  return { header: 0, exact: 1, evidence: 2 }[level];
}

function injectionHash(result: MemoryContext["results"][number]): string {
  const content = `${result.memory.statement}\n${result.evidence.content}`;
  return createHash("sha256").update(content).digest("base64url");
}

export const MEMORY_POLICY = `<nmg_policy>\n${loadPrompts().memory_policy}\n</nmg_policy>`;

export function composeNmgSystemPrompt(
  baseSystemPrompt: string,
  automaticRecall = "",
  status = "",
  nudge = "",
): string {
  return [
    baseSystemPrompt,
    MEMORY_POLICY,
    automaticRecall ? `<nmg_automatic_recall>\n${automaticRecall}\n</nmg_automatic_recall>` : "",
    nudge ? `<nmg_nudge>\n${nudge}\n</nmg_nudge>` : "",
    status ? `<nmg_status>${status}</nmg_status>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function configuredAutoRecallTier(): MemoryTier {
  const value = Number(process.env.NMG_AUTO_RECALL_TIER ?? 1);
  return Math.max(0, Math.min(3, Number.isFinite(value) ? Math.floor(value) : 1)) as MemoryTier;
}

function configuredAutoRecallLimit(): number {
  const value = Number(process.env.NMG_AUTO_RECALL_LIMIT ?? 13);
  return Math.max(1, Math.min(50, Number.isFinite(value) ? Math.floor(value) : 13));
}

function configuredInitialTarget(): number {
  const value = Number(process.env.NMG_AUTO_RECALL_INITIAL_TARGET ?? 13);
  return Math.max(1, Math.min(50, Number.isFinite(value) ? Math.floor(value) : 13));
}

function configuredStrongHitTopGap(): number {
  const value = Number(process.env.NMG_AUTO_RECALL_STRONG_HIT_TOP_GAP ?? 0.05);
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.05));
}

function configuredStrongHitInitialTarget(): number {
  const value = Number(process.env.NMG_AUTO_RECALL_STRONG_HIT_INITIAL_TARGET ?? 3);
  return Math.max(1, Math.min(50, Number.isFinite(value) ? Math.floor(value) : 3));
}

function hasExplicitRecallIntent(normalized: string): boolean {
  return [
    /\b(previous(?:ly)?|before|earlier|last time|remember|recall|my preference|my project|we decided)\b/u,
    /(?:之前|以前|上次|还记得|回忆|记忆|我的偏好|我们决定|项目决定|当前状态)/u,
  ].some((pattern) => pattern.test(normalized));
}

function normalizeTaskPrompt(prompt: string): string {
  return prompt.replace(/\s+/gu, " ").trim();
}

function isSubstantiveTaskPrompt(prompt: string): boolean {
  if (prompt.length >= 40) return true;
  return /(?:[A-Za-z][\w.-]{2,}[-_/][\w./-]+|\b(?:fix|implement|debug|test|build|refactor|install|configure)\b|(?:修复|实现|测试|构建|重构|安装|配置|设计))/iu.test(
    prompt,
  );
}

function isTaskContinuation(prompt: string): boolean {
  if (prompt.length > 100) return false;
  return /(?:\b(?:continue|again|retry|reload|try|proceed|go on|fix it|test it)\b|(?:继续|再试|重试|试试|开始吧|接着|改吧|修一下|好了|可以了|然后呢))/iu.test(
    prompt,
  );
}

const nmgPrompts = loadPrompts();

export function formatSearchHeaders(context: MemoryContext): string {
  if (context.results.length === 0) return "No matching NMG memory found.";
  const nextStep = formatProgressiveDisclosure(context) || nmgPrompts.get_hint;
  return [
    renderDisclosure(nmgPrompts.search_disclosure, {
      count: String(context.results.length),
      next_step: nextStep,
      forget_hint: hasForgetMarker(context) ? nmgPrompts.forget_hint : "",
    }),
    nmgPrompts.headers_title,
    nmgPrompts.headers_fields,
    ...context.results.map(({ memory, node, recallReason: reason, hitTerms }) => {
      const forget = (memory.markers ?? []).some((marker) => marker.kind === "forget");
      return (
        `- ${(memory.markers ?? []).some((marker) => marker.kind === "external_source") ? "[external] " : ""}` +
        `memory=${memory.id}; node=${node.canonicalName}; type=${memory.memoryType}; ` +
        `${recallMatchLabel(reason, hitTerms)}` +
        `${recallTimeLabel(memory)}` +
        // Revoked records show their metadata but not their statement:
        // the model sees the revocation exists without content to cite.
        `preview=${forget ? nmgPrompts.forget_redacted : searchPreview(memory)}`
      );
    }),
    formatActiveGraph(context),
  ]
    .filter(Boolean)
    .join("\n");
}

function hasForgetMarker(context: MemoryContext): boolean {
  return (context.results ?? []).some((result) =>
    (result.memory.markers ?? []).some((marker) => marker.kind === "forget"),
  );
}

/** What the query actually matched, not why the record surfaced:
 *  literal query terms for lexical hits, otherwise the mechanism
 *  (semantic / graph route / hybrid) when no term is available. */
function recallMatchLabel(
  reason: MemorySearchResult["recallReason"],
  hitTerms: MemorySearchResult["hitTerms"],
): string {
  if (hitTerms && hitTerms.length > 0) return `matches=${hitTerms.join(",")}; `;
  const label =
    reason === "learned_route"
      ? "graph"
      : reason === "vector_match"
        ? "semantic"
        : (reason ?? "hybrid");
  return `matches=${label}; `;
}

/** Temporal anchors the agent can act on: the event's own time when
 *  recorded, and an expiry when the record stops being current. Dates only,
 *  omitted when absent. */
function recallTimeLabel(memory: MemorySearchResult["memory"]): string {
  const day = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null);
  const parts: string[] = [];
  const event = day(memory.eventTime);
  if (event) parts.push(`time=${event}`);
  const expires = day(memory.expiresAt ?? memory.validUntil);
  if (expires) parts.push(`expires=${expires}`);
  return parts.length > 0 ? `${parts.join("; ")}; ` : "";
}

function formatProgressiveDisclosure(context: MemoryContext): string {
  const disclosure = context.progressiveDisclosure;
  if (!disclosure || disclosure.deferredMemoryIds.length === 0) return "";
  return `${nmgPrompts.deferred_hint} Memory IDs: ${disclosure.deferredMemoryIds.join(",")}`;
}

function formatActiveGraph(context: MemoryContext): string {
  return context.activeGraph ? `AG activeGraphId=${context.activeGraph.id}` : "";
}

export function formatMemoryContext(context: MemoryContext): string {
  const records = context.results
    .map(({ memory, node, evidence }) => {
      const source =
        evidence.content.trim() !== memory.statement.trim()
          ? `\n  SOURCE=${excerpt(evidence.content, 320)}`
          : "";
      const external = (memory.markers ?? []).find((marker) => marker.kind === "external_source");
      const externalLabel = external ? `[external, ${memory.truthStatus}] ` : "";
      const externalSource = external?.attributes?.source
        ? `\n  EXTERNAL_SOURCE=${String(external.attributes.source)}; retrievedAt=${String(external.attributes.retrievedAt ?? "unknown")}`
        : "";
      return (
        `- ${externalLabel}${memory.statement}\n  memory=${memory.id}; node=${node.canonicalName}; ` +
        `type=${memory.memoryType}; truth=${memory.truthStatus}; scope=${JSON.stringify(memory.scope)}` +
        externalSource +
        source
      );
    })
    .join("\n");
  return [
    renderDisclosure(nmgPrompts.get_disclosure, {
      count: String(context.results.length),
      next_step: formatProgressiveDisclosure(context) || "",
    }),
    records,
  ]
    .filter(Boolean)
    .join("\n");
}

function toolResult(details: unknown, text: string) {
  return { content: [{ type: "text" as const, text }], details };
}

function formatRememberResult(value: unknown): string {
  const result = value as {
    memory?: { id?: string; statement?: string };
    duplicates?: Array<{ memoryId: string; statement: string; similarity?: number }>;
    supersedeCandidates?: Array<{
      memoryId: string;
      statement: string;
      supersedeSignal?: number;
    }>;
  };
  const memoryId = result.memory?.id;
  const lines = [`Memory saved${memoryId ? ` as ${memoryId}` : ""}.`];
  const supersede = (result.supersedeCandidates ?? []).slice(0, 3);
  if (supersede.length > 0 && memoryId) {
    lines.push(
      "NMG found possible older values. Similarity is only a candidate signal; decide semantically.",
    );
    for (const candidate of supersede) {
      lines.push(`- ${candidate.memoryId}: ${excerpt(candidate.statement, 180)}`);
    }
    lines.push(
      "If exactly one candidate is genuinely replaced in the same scope, call nmg_remember again with action=supersede, newMemoryId, supersededMemoryId, and a short reason. Otherwise do nothing.",
    );
  }
  const duplicates = (result.duplicates ?? []).filter(
    (candidate) => candidate.memoryId !== memoryId,
  );
  if (duplicates.length > 0) {
    lines.push("Possible semantic neighbours were retained as distinct nodes:");
    for (const candidate of duplicates.slice(0, 3)) {
      lines.push(`- ${candidate.memoryId}: ${excerpt(candidate.statement, 180)}`);
    }
    lines.push(
      "Only if a relationship is useful, call nmg_remember again with action=relate, newMemoryId, relatedMemoryId, and relationJudgement. Similarity alone is not identity; otherwise do nothing.",
    );
  }
  return lines.join("\n");
}

function excerpt(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * PostToolUse memory capture (first-principles: the tool result is the one
 * event that carries input + content + isError + per-tool details).
 */

/** True only when a git commit actually landed, so a failed or no-op commit
 *  never raises the completion nudge. */
export function isSuccessfulCommit(event: {
  toolName: string;
  isError: boolean;
  content: unknown;
  input?: unknown;
}): boolean {
  if (event.toolName !== "bash" || event.isError) return false;
  const command = String((event.input as { command?: unknown })?.command ?? "");
  if (!/\bgit\s+commit\b/.test(command)) return false;
  const output = messageText(event.content);
  return !/(?:nothing to commit|no changes added to commit|nothing added to commit)/iu.test(
    output,
  );
}

/** Only tool results with lasting information value are captured as traces. */
export function isMemorableToolResult(event: {
  toolName: string;
  isError: boolean;
  content: unknown;
  input?: unknown;
}): boolean {
  if (event.isError) return true;
  const text = messageText(event.content);
  switch (event.toolName) {
    case "bash": {
      const command = String((event.input as { command?: unknown })?.command ?? "");
      const testRun =
        /\b(?:npm|pnpm|yarn|bun|npx|node|deno)\s+(?:run\s+)?test\b|(?:vitest|jest|pytest|go\s+test|cargo\s+test)/iu.test(
          command,
        );
      return testRun || /(?:error|fail(?:ed|ure)?|fatal|warning|exception|✗|FAILED)/iu.test(text);
    }
    case "edit":
    case "write":
      // File mutations are structural changes; capture the path.
      return true;
    case "grep":
      return text.trim().length > 0;
    default:
      return false;
  }
}

export function summarizeToolResult(event: {
  toolName: string;
  isError: boolean;
  content: unknown;
  input?: unknown;
}): { statement: string; nodeName: string } {
  const input = event.input as Record<string, unknown> | undefined;
  if (event.toolName === "edit" || event.toolName === "write") {
    const path = String(input?.path ?? input?.filePath ?? "?");
    const verb = event.toolName === "write" ? "Wrote" : "Edited";
    return {
      statement: `${verb} ${path}${event.isError ? " (tool returned an error)" : ""}.`,
      nodeName: path,
    };
  }
  const text = excerpt(messageText(event.content), 400);
  const status = event.isError ? " [error]" : "";
  return {
    statement: `Tool ${event.toolName}${status}: ${text || "(no text output)"}`,
    nodeName: `tool:${event.toolName}`,
  };
}

/** The exact low-tier remember payload for a memorable tool result, or null. */
export function toolTraceRememberParams(
  event: {
    toolName: string;
    isError: boolean;
    content: unknown;
    input?: unknown;
  },
  sessionId: string,
  projectDir: string,
): Record<string, unknown> | null {
  if (!isMemorableToolResult(event)) return null;
  const { statement, nodeName } = summarizeToolResult(event);
  return {
    statement,
    nodeName,
    memoryType: "event",
    sourceActor: "system",
    truthStatus: "asserted",
    tier: 3,
    importance: 0.1,
    markers: [{ kind: "tool_trace", attributes: { tool: event.toolName } }],
    scope: { project: projectDir },
    writeReason: "post_tool_use",
    projectDir,
    sessionId,
  };
}

/**
 * Bounded per-session guard against redundant low-tier tool traces. Identical
 * (tool, statement) pairs are written at most once per session; NMG's own
 * exact-duplicate skip is the backstop for anything that slips past here.
 */
export class SessionToolTraceCapture {
  readonly #recent = new Map<string, Set<string>>();
  readonly maxPerSession: number;

  constructor(maxPerSession = 64) {
    this.maxPerSession = Math.max(1, maxPerSession);
  }

  /** Returns true when this (tool, statement) pair is new for the session. */
  note(sessionId: string, toolName: string, statement: string): boolean {
    const key = `${toolName}\u0000${toolTraceHash(statement)}`;
    let set = this.#recent.get(sessionId);
    if (!set) {
      set = new Set();
      this.#recent.set(sessionId, set);
    }
    if (set.has(key)) return false;
    set.add(key);
    if (set.size > this.maxPerSession) set.delete(set.values().next().value!);
    return true;
  }

  clear(sessionId: string): void {
    this.#recent.delete(sessionId);
  }
}

function toolTraceHash(statement: string): string {
  return createHash("sha256").update(statement).digest("base64url");
}

/**
 * PreCompact rescue (first-principles: session_before_compact is the only
 * place that can intercept silent context loss; Pi already computed the doomed
 * span as preparation.messagesToSummarize).
 */
export function summarizeSessionFragment(messages: readonly unknown[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const candidate = message as { role?: unknown; content?: unknown };
    const role = typeof candidate.role === "string" ? candidate.role : "?";
    const content = messageText(candidate.content);
    if (!content) continue;
    lines.push(`${role}: ${content}`);
  }
  return lines.join("\n");
}

export function compactRescueStatement(
  messages: readonly unknown[],
  maxLength = 4000,
): string {
  return excerpt(summarizeSessionFragment(messages), maxLength);
}

/** The exact low-tier remember payload for a compact rescue, or null. */
export function compactRescueRememberParams(
  messages: readonly unknown[],
  sessionId: string,
  projectDir: string,
  reason: string,
): Record<string, unknown> | null {
  const statement = compactRescueStatement(messages);
  if (!statement.trim()) return null;
  return {
    statement,
    nodeName: `session:${sessionId}`,
    memoryType: "event",
    sourceActor: "system",
    truthStatus: "asserted",
    tier: 2,
    importance: 0.3,
    markers: [{ kind: "compact_rescue", attributes: { sessionId, reason } }],
    scope: { project: projectDir },
    writeReason: "pre_compact_rescue",
    projectDir,
    sessionId,
  };
}
