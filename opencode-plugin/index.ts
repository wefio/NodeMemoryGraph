import {
  assembleAdapterCapabilities,
  disabledBoardCapability,
  type AdapterCapabilityBindings,
} from "../src/integration/adapter-capability-assembly.ts";
import { ADAPTER_CAPABILITY_CATALOG } from "../src/integration/adapter-capability-catalog.ts";
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
  type AgentAttributionFlow,
  extractAnswerText,
  extractPromptText,
} from "../src/integration/agent-attribution.ts";
import { loadWakeState, readWakeConfig, wakeBudgetGate } from "../src/integration/board-wake.ts";
import {
  configuredAutoRecallLimit,
  configuredAutoRecallTier,
  coordinationEnabled,
} from "../src/integration/config.ts";
import {
  loadOrCreateAgentIdentity,
  renameAgentIdentity,
} from "../src/integration/agent-identity.ts";
import { compactSearchContext } from "../src/integration/search-projection.ts";
import { SessionRecallFlow } from "../src/integration/session-recall-flow.ts";
import { RecallBudget } from "../src/integration/recall-budget.ts";
import { prepareInformationOutput } from "../src/integration/information-output.ts";
import type { PreparedInformationOutput } from "../src/core/information-view.ts";
import { SessionTaskWindow } from "../src/integration/session-task-window.ts";
import { probeAdapterEndpoint } from "../src/integration/lease-transport.ts";
import { messageText } from "../src/integration/tool-observation.ts";
import type { MemoryContext, MemoryTier } from "../src/core/types.ts";
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
  get?: (input: { sessionID: string }) => Promise<{
    id: string;
    parentID?: string;
    location?: { directory?: string };
  }>;
}

interface HostEvent {
  type?: string;
  location?: { directory?: string };
  data?: { sessionID?: string; parentID?: string; location?: { directory?: string } };
}

interface PluginContext {
  location?: { directory?: string };
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

function normalizeToolName(tool: string): string {
  return tool === "shell" ? "bash" : tool;
}

export default {
  id: "nmg",
  setup: async (ctx: PluginContext): Promise<(() => Promise<void>) | undefined> => {
    let prepareAutomaticRecallSurface: typeof import("../src/integration/agent-surface.ts").prepareAutomaticRecallSurface;
    let contextStateViews: typeof import("../src/integration/context-information.ts").contextStateViews;
    let collectWakeCandidates: typeof import("../src/integration/board-wake.ts").collectWakeCandidates;
    let deliverBoardWakeBatch: typeof import("../src/integration/board-wake-batch.ts").deliverBoardWakeBatch;
    let reportHarnessActivity: typeof import("../src/integration/board-wake-batch.ts").reportHarnessActivity;
    const capabilityBindings: AdapterCapabilityBindings = {
      "answer-attribution": ({ create }) => {
        attribution = create(32);
      },
      "board-delivery": ({ collect, deliver, activity }) => {
        collectWakeCandidates = collect;
        deliverBoardWakeBatch = deliver;
        reportHarnessActivity = activity;
      },
      "state-context": ({ views }) => {
        contextStateViews = views;
      },
    };
    const dataDir = resolveNmgDataDir();
    const invoke = (method: string, params: unknown) =>
      invokeDaemon(method, params as Record<string, unknown>, { dataDir });

    const taskWindow = new SessionTaskWindow();
    const recallFlow = new SessionRecallFlow();
    let attribution: AgentAttributionFlow;
    // Injection pass: prepared at prompt admission and delivered by context
    // requests. The staged body RETAINS for the whole execution — provider
    // retries rebuild the request context without the previously pushed
    // system message, so re-delivery is decided per request by content
    // (exact fragment match), and teardown happens at execution completion.
    const pendingInjections = new Map<
      string,
      {
        output: PreparedInformationOutput;
        context?: MemoryContext;
      }
    >();
    const preparations = new Map<string, AbortController>();
    const stageInjection = (
      sessionId: string,
      pending: { output: PreparedInformationOutput; context?: MemoryContext },
    ) => {
      pendingInjections.set(sessionId, pending);
      while (pendingInjections.size > PENDING_INJECTIONS_CAP) {
        const oldest = pendingInjections.keys().next().value;
        if (oldest === undefined) break;
        pendingInjections.delete(oldest);
      }
    };
    const cancelRecall = (sessionId: string) => {
      preparations.get(sessionId)?.abort();
      preparations.delete(sessionId);
      pendingInjections.delete(sessionId);
    };
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
      return (
        sessions.get(sessionId)?.projectDir?.trim() || ctx.location?.directory?.trim() || undefined
      );
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

    const scopedSessions = new Set<string>();
    const resolveNativeSession = async (sessionId: string, signal: AbortSignal): Promise<void> => {
      if (scopedSessions.has(sessionId) || !ctx.session.get) return;
      const session = await ctx.session.get({ sessionID: sessionId }).catch(() => undefined);
      signal.throwIfAborted();
      if (session?.id !== sessionId) return;
      rememberSession(sessionId, session.location?.directory ?? "", Boolean(session.parentID));
      scopedSessions.add(sessionId);
    };

    // ---- Automatic recall + nudge staging (prompt hook) --------------------
    const RECALL_PREAMBLE = [
      "[NMG automatic recall] Long-term memory headers for the current user turn (injected, not yet used).",
      "Decide which candidates matter, then call nmg_search before nmg_get so exact",
      "disclosure lands on this shared session's active graph. Ignore noise; an empty",
      "match is a valid result.",
    ].join("\n");
    const recallHeaders = async (
      sessionId: string,
      request: NonNullable<ReturnType<SessionTaskWindow["prepare"]>>,
      searchBudgetMs: number,
    ): Promise<MemoryContext | undefined> => {
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
        autoRecallBudgetMs: searchBudgetMs,
        projectDir,
        sessionId,
      })) as MemoryContext;
      return context.results?.length ? context : undefined;
    };

    const readStateViews = async (sessionId: string, signal: AbortSignal) => {
      const state = (await invoke("state", { action: "read", space: "ag", sessionId }).catch(
        () => undefined,
      )) as NmgStateResult | undefined;
      signal.throwIfAborted();
      try {
        return state?.space === "ag" && state.result.action === "snapshot"
          ? contextStateViews(state.result.snapshot, sessionId)
          : [];
      } catch {
        // Foreign or malformed owner state never becomes model input.
        return [];
      }
    };

    const stagePromptRecall = async (
      event: PromptHookEvent,
      budget: RecallBudget,
      retainState: (output: PreparedInformationOutput) => void,
    ) => {
      const { signal } = budget;
      const sessionId = String(event?.sessionID ?? "");
      await resolveNativeSession(sessionId, signal);
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
      signal.throwIfAborted();
      const base = await readStateViews(sessionId, signal);
      retainState(prepareInformationOutput(base, { format: "context" }));
      const request = taskWindow.prepare(sessionId, prompt, decision);
      const context = request
        ? await recallHeaders(sessionId, request, budget.searchBudgetMs()).catch(() => undefined)
        : undefined;
      signal.throwIfAborted();
      const output = context
        ? prepareAutomaticRecallSurface(compactSearchContext(context), {
            preamble: RECALL_PREAMBLE,
            postamble: nudge,
          })
        : prepareInformationOutput([{ purpose: "guidance", body: nudge }], { format: "context" });
      return {
        output: prepareInformationOutput([...base, ...output.views], { format: "context" }),
        context,
      };
    };

    const preparePromptRecall = async (event: PromptHookEvent, sessionId: string) => {
      cancelRecall(sessionId);
      const controller = new AbortController();
      const budget = new RecallBudget(PROMPT_BUDGET_MS, controller.signal);
      preparations.set(sessionId, controller);
      try {
        const pending = await budget.run("automatic.context", () =>
          stagePromptRecall(event, budget, (output) => {
            if (preparations.get(sessionId) === controller && output.text)
              stageInjection(sessionId, { output });
          }),
        );
        if (preparations.get(sessionId) !== controller || !pending.output.text) return;
        stageInjection(sessionId, pending);
      } catch {
        // A cancelled or late preparation never becomes an injection.
      } finally {
        budget.close();
        if (preparations.get(sessionId) === controller) preparations.delete(sessionId);
      }
    };

    capabilityBindings["automatic-recall"] = ({ prepare }) => {
      prepareAutomaticRecallSurface = prepare;
      return ctx.session
        .hook("prompt", async (raw: PromptHookEvent) => {
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
          if (sessionId) await preparePromptRecall(raw as PromptHookEvent, sessionId);
        })
        .then(() => undefined);
    };

    await ctx.session.hook("context", (raw: ContextHookEvent) => {
      const sessionId = String(raw?.sessionID ?? "");
      const messages = raw?.messages;
      if (!sessionId || !Array.isArray(messages)) return void undefined;
      const pending = pendingInjections.get(sessionId);
      if (!pending) return void undefined;
      // Keep the staged body until execution completion: after a provider
      // retry the host rebuilds this request from the transcript without the
      // previously pushed message, so re-delivery is decided by content, not
      // by one-shot consumption. Exact text matching (system role only) prevents
      // duplicates on step-tool requests that already carry the injection.
      const carried = messages.some((message) => {
        if (message?.role !== "system") return false;
        const content = message.content;
        if (typeof content === "string") return content === pending.output.text;
        return (
          Array.isArray(content) &&
          content.some(
            (part) => String((part as { text?: unknown })?.text ?? "") === pending.output.text,
          )
        );
      });
      if (carried) return void undefined;
      // OpenCode lowers message content itself; only parts arrays are safe
      // here (a bare string crashes provider lowering — probed).
      messages.push({ role: "system", content: [{ type: "text", text: pending.output.text }] });
      if (pending.context) {
        const ids = new Set(
          pending.output.included.flatMap((entry) =>
            entry.source.kind === "memory" ? [entry.source.memoryId] : [],
          ),
        );
        attribution.note(sessionId, {
          ...pending.context,
          results: pending.context.results.filter((result) => ids.has(result.memory.id)),
        });
      }
      // Assembly is not final provider delivery; no disclosure-ledger write.
    });

    await ctx.session.hook("compaction", async (raw: SessionScopedHookEvent) => {
      const sessionId = raw?.sessionID;
      if (!sessionId) return;
      cancelRecall(sessionId);
      await invoke("sessionActiveGraph", { action: "clearDisclosures", sessionId }).catch(
        () => undefined,
      );
      await invoke("sessionActiveGraph", { action: "activate", sessionId }).catch(() => undefined);
    });

    // ---- Tool observations + commit nudge (execute.after) -----------------
    capabilityBindings["tool-observation"] = ({ observe }) =>
      ctx.tool
        .hook("execute.after", (event: AfterToolEvent) => {
          const sessionId = String(event?.sessionID ?? "");
          const toolId = String(event?.tool ?? "");
          if (!sessionId || !toolId) return;
          void observe({
            sessionId,
            event: {
              toolName: normalizeToolName(toolId),
              isError: event?.status === "error",
              content: event?.result?.content,
              input: event?.input,
            },
            invoke,
            onCommit: () => {
              commitNudges.add(sessionId);
            },
          }).catch(() => undefined);
        })
        .then(() => undefined);

    const toolSessionId = (context: ToolContext, toolName: string): string => {
      const sessionId = String(context?.sessionID ?? "");
      if (sessionId) return sessionId;
      throw new Error(
        `nmg_${toolName} has no session context (this tool must run inside an OpenCode agent loop)`,
      );
    };

    // The SDK retains transform callbacks and applies them per request. Resolve
    // shared capabilities during setup; the callback only publishes native tools.
    const toolDefinitions: ToolRegistration[] = [];
    const capabilityAssembly = assembleAdapterCapabilities(
      ADAPTER_CAPABILITY_CATALOG.opencode.capabilities,
      {
        ...capabilityBindings,
        rememberOptions: { allowUnsafe: true, claimOutcome: "disabled" },
        registerTool: (tool) => {
          toolDefinitions.push({
            name: tool.name,
            description: tool.description,
            input: tool.inputSchema,
            async execute(args, context) {
              const sessionId = toolSessionId(context, tool.name.slice(4));
              const output = await tool.execute(args, {
                sessionId,
                requester: "agent:opencode",
                invoke: (method, params, cliFallback) =>
                  invokeDaemon(method, params, { dataDir, fallbackArgs: cliFallback ?? null }),
                legacyBoardVerbs: true,
                memory: {
                  projectDir: projectDirectory(sessionId),
                  recallFlow,
                  attribution,
                  search: { defaultTier: 3, feedback: recallFeedbackAffordance },
                  remember: {
                    latestFeedback: true,
                    provenance: {
                      provider: "opencode",
                      lookup: (_evidence, actor) =>
                        actor === "assistant"
                          ? undefined
                          : {
                              version: "opencode.plugin.v1",
                              reason: "session_history_api_unavailable",
                            },
                    },
                  },
                },
                boardReads: "project",
                boardIdentity: () => {
                  const identity = loadOrCreateAgentIdentity(sessionId, "opencode");
                  return {
                    ...identity,
                    saveName: (agentName) =>
                      renameAgentIdentity({
                        anchor: process.env.NMG_AGENT_ID?.trim() || sessionId,
                        id: identity.id,
                        agentName,
                      }),
                  };
                },
              });
              return { content: output.text };
            },
          });
        },
      },
      {
        endpoint: probeAdapterEndpoint(dataDir),
        disabled: disabledBoardCapability(coordinationEnabled()),
      },
    );
    await capabilityAssembly.ready;
    let registered: Promise<unknown>;
    const registerTools = (editor: ToolEditor): void => {
      for (const definition of toolDefinitions) editor.add(definition);
    };
    try {
      // Names are explicit: this SDK does not apply an options.namespace prefix.
      registered = ctx.tool.transform(registerTools, { codemode: true });
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
            cancelRecall(sessionId);
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
    let wakePoolOffset = 0;
    const wakePool = (): Array<{ sessionId: string; projectDir: string }> => {
      const scope = process.env.NMG_WAKE_PROJECT?.trim().toLowerCase();
      const now = Date.now();
      const eligible = [...sessions.entries()]
        .filter(([sessionId, record]) => {
          if (record.child || record.lastPromptAt === 0) return false;
          // Let the shared activity reports decide whether this session can receive.
          return (
            now - Math.max(record.lastIdleAt, record.lastPromptAt) > 1_000 && sessionId.length > 0
          );
        })
        .filter(([, record]) => !scope || record.projectDir.toLowerCase() === scope)
        .sort((left, right) => right[1].lastIdleAt - left[1].lastIdleAt)
        .map(([sessionId, record]) => ({ sessionId, projectDir: record.projectDir }));
      if (!eligible.length) return [];
      const count = Math.min(WAKE_POOL_SIZE, eligible.length);
      const start = wakePoolOffset % eligible.length;
      wakePoolOffset = (start + count) % eligible.length;
      return Array.from(
        { length: count },
        (_, offset) => eligible[(start + offset) % eligible.length]!,
      );
    };

    const scanBoardWake = async (): Promise<void> => {
      const config = readWakeConfig(dataDir);
      const state = loadWakeState(dataDir);
      const now = Date.now();
      if (!wakeBudgetGate(config, state, now)) return;
      for (const target of wakePool()) {
        const identity = loadOrCreateAgentIdentity(target.sessionId, "opencode");
        const observed = sessions.get(target.sessionId)!;
        await reportHarnessActivity(
          invoke,
          identity.id,
          target.sessionId,
          observed.lastIdleAt >= observed.lastPromptAt ? "idle" : "busy",
          ["batch-enqueue", "processing-observation", "idle-boundary"],
        );
        const candidates = await collectWakeCandidates(invoke, {
          agentId: identity.id,
          agentName: identity.agentName,
          sessionId: target.sessionId,
        });
        if (candidates.length === 0) continue;
        const delivered = await deliverBoardWakeBatch({
          invoke,
          sendWake: async (message) => {
            if (!ctx.session.prompt) throw new Error("OpenCode session prompt is unavailable");
            await ctx.session.prompt({ sessionID: target.sessionId, text: message });
          },
          config,
          state,
          dataDir,
          now,
          agentId: identity.id,
          sessionId: target.sessionId,
          entries: candidates,
        });
        if (delivered.length > 0) return; // Charge at most one accepted wake per tick.
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
      for (const controller of preparations.values()) controller.abort();
      preparations.clear();
      pendingInjections.clear();
      commitNudges.clear();
      for (const sessionId of sessions.keys()) {
        taskWindow.clear(sessionId);
        recallFlow.clear(sessionId);
        attribution.clear(sessionId);
      }
      sessions.clear();
      scopedSessions.clear();
      await capabilityAssembly?.dispose();
    };
  },
};
