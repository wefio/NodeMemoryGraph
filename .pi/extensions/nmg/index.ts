// Pi host adapter for NMG.
//
// HOST-ADAPTER BOUNDARY (shared layer rule): this extension is a thin transport
// only. Every NMG capability (recall staging, context-use feedback / online
// learning, shadow events, nudges, …) lives in the SHARED layer — src/* core
// modules and the daemon RPC surface (NmgService methods) — never implemented
// or forked here. A capability that works in one adapter (pi / dsh / …) but not
// another is a defect: add it to src/ + the daemon, then have every adapter
// forward the same RPC. Duplicating logic adapter-side drifts and goes stale.

import { observeRecallPreparation, registerFirstResponseTiming } from "./first-response-timing.ts";
import { registerWorkingStateView } from "./working-state-view.ts";

import { join } from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  captureStateInvocation,
  COORDINATION_OPERATIONS,
  stateOperation,
  renderStateOutput,
  STATE_BOARD_READ_OPERATIONS,
} from "../../../src/integration/state.ts";
import type {
  NmgStateResult,
  NmgSessionActiveGraphResult,
  NmgSearchParams,
} from "../../../src/cli/protocol.ts";
import {
  canProposeSessionRecallCue,
  matchSessionRecallCue,
} from "../../../src/core/session-recall.ts";
import { decideMemoryLoad } from "../../../src/core/gate.ts";
import { recallInput } from "../../../src/core/recall-matcher.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

import {
  connectDaemon,
  invokeDaemon,
  shutdownOwnedDaemon,
  type DaemonConnection,
} from "../../../src/cli/daemon-client.ts";
import { resolveNmgDataDir } from "../../../src/cli/data-path.ts";
import type { HttpCallOptions } from "../../../src/cli/http-client.ts";
import { RecallBudget, RecallDeadlineExceeded } from "../../../src/integration/recall-budget.ts";
import {
  archiveOrStage,
  archiveNodeName,
  archiveStatement,
  flushArchives,
  stagingDirFor,
} from "../../../src/cli/archive-staging.ts";
import { loadPrompts, renderDisclosure } from "../../../src/prompts/load.ts";
import { memoryDisclosureEntries } from "../../../src/integration/search-projection.ts";
import { PI_BOARD_ACTIONS, PI_REMEMBER_ACTIONS } from "../../../src/integration/tool-contract.ts";
import type { TaskBoardToolResult } from "../../../src/integration/tool-contract.ts";
import {
  type BoardWakeConfig,
  type BoardWakeState,
  collectWakeCandidates,
  deliverBoardWake,
  filterUndelivered,
  loadWakeState as loadWakeStateShared,
  readWakeConfig as readWakeConfigShared,
  wakeBudgetGate,
  writeWakeConfig as writeWakeConfigShared,
} from "../../../src/integration/board-wake.ts";
import {
  loadOrCreateAgentIdentity,
  renameAgentIdentity,
} from "../../../src/integration/agent-identity.ts";
import {
  AgentAttributionFlow,
  extractAnswerText,
  extractPromptText,
} from "../../../src/integration/agent-attribution.ts";
import { SessionRecallFlow } from "../../../src/integration/session-recall-flow.ts";
import {
  type SessionRecallRequest,
  SessionTaskWindow,
} from "../../../src/integration/session-task-window.ts";
import {
  isMemorableToolResult,
  isSuccessfulCommit,
  messageText,
  summarizeToolResult,
} from "../../../src/integration/tool-observation.ts";
import { renderLabOutput } from "../../../src/integration/lab-capabilities.ts";
import { TASK_BOARD_VERDICTS } from "../../../src/core/types.ts";
import { resolveSkillOptPolicyChannels } from "../../../src/lab/skillopt-policy.ts";
import type { ActiveGraphBudget, MemoryContext, MemoryTier } from "../../../src/core/types.ts";
import { WORLD_BOARD_ID } from "../../../src/core/types.ts";
import {
  configuredAutoRecallLimit,
  configuredAutoRecallTier,
  configuredControllerRerankMode,
  configuredInitialTarget,
  configuredQpp1Mode,
  configuredQpp2Mode,
  configuredQpp2RetainedMass,
  configuredSearchRecommendationMode,
  configuredStrongHitInitialTarget,
  configuredStrongHitTopGap,
  coordinationEnabled,
  type SearchRecommendationMode,
} from "../../../src/integration/config.ts";
import {
  renderEvidenceSurface,
  renderRememberSurface,
  renderSearchSurface,
  searchInformationViews,
  renderTaskBoardSurface,
} from "../../../src/integration/agent-surface.ts";
import {
  selectEvidence,
  type AgentHistoryMessage,
  type SelectedEvidence,
} from "../../../src/integration/evidence.ts";
import type {
  InformationView,
  PreparedInformationOutput,
} from "../../../src/core/information-view.ts";
import { prepareInformationOutput } from "../../../src/integration/information-output.ts";
import {
  checkpointInformationViews,
  contextBoardEntries,
  contextNotice,
  contextStateViews,
} from "../../../src/integration/context-information.ts";
import { deriveAnswerOverlapMemoryIds } from "../../../src/core/feedback.ts";
import {
  REASONING_EDGE_KINDS,
  REASONING_NODE_KINDS,
  REASONING_STATUSES,
  type ReasoningCheckpoint,
} from "../../../src/lab/reasoning-workspace.ts";
import {
  ControllerShadowBridge,
  shadowCollectionOrigin,
  shadowEnabled,
} from "./controller-shadow.ts";

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
  return join(resolveNmgDataDir(), "nmg.sqlite");
}

function projectDirectory(): string {
  return process.env.NMG_PROJECT_DIR || process.cwd();
}

/** Name what a board verb is missing before the call leaves this process: the
 *  daemon refuses the same calls, but a named local refusal is what an agent can
 *  act on. Kept out of the tool's `execute` so the handler stays under the
 *  complexity ceiling (the repo extracts, it does not exempt). */
function assertBoardVerbCall(params: {
  action?: string;
  digest?: string | undefined;
  verdict?: string | undefined;
  reason?: string | undefined;
}): void {
  if (params.action === "deliver" && !params.digest) {
    throw new Error("deliver requires digest: the sha256 identity of the artifact being handed in");
  }
  if (params.action === "judge" && !params.verdict) {
    throw new Error("judge requires verdict: accepted | rejected | undecidable");
  }
  if (params.action === "judge" && !params.reason) {
    throw new Error(
      "judge requires reason: the ruling is recorded in the entry and survives a restart",
    );
  }
}

export default function nmgExtension(pi: ExtensionAPI): void {
  const firstResponseTiming = registerFirstResponseTiming(pi);
  let connectionPromise: Promise<DaemonConnection> | undefined;
  let latestRecallTiming: ReturnType<RecallBudget["timing"]> | undefined;
  const taskWindow = new SessionTaskWindow();
  const recallFlow = new SessionRecallFlow();
  const agentAttributionFlow = new AgentAttributionFlow(32);
  const qpp1Mode = configuredQpp1Mode();
  const qpp2Mode = configuredQpp2Mode();
  const qpp2RetainedMass = configuredQpp2RetainedMass();
  const controllerRerankMode = configuredControllerRerankMode();
  const recommendationMode = configuredSearchRecommendationMode();
  const controllerShadow = new ControllerShadowBridge(
    resolveNmgDataDir(),
    shadowEnabled() || qpp1Mode !== "off" || qpp2Mode !== "off" || controllerRerankMode !== "off",
  );
  // Online learning is DAEMON-OWNED (shared layer): the daemon stages every
  // search that surfaced a disclosure graph (auto recall and explicit search
  // alike) and persists the router at <dataDir>/context-router-online.json.
  // This adapter only attaches the feedback affordance to recall output and
  // forwards feedback — no learner logic or ask-scheduling lives here.
  const labToolsEnabled = process.env.NMG_ENABLE_LAB_TOOLS === "1";
  const coordinationToolsEnabled = coordinationEnabled();
  // Wake config/state persistence lives in src/integration/board-wake.ts; the
  // adapter only binds the data directory once so the /nmg UI below keeps its
  // one-argument surface without duplicating any load/save/gating logic.
  const wakeDataDir = resolveNmgDataDir();
  const readWakeConfig = (): BoardWakeConfig => readWakeConfigShared(wakeDataDir);
  const writeWakeConfig = (config: BoardWakeConfig): void =>
    writeWakeConfigShared(config, wakeDataDir);
  const loadWakeState = (): BoardWakeState => loadWakeStateShared(wakeDataDir);
  // The online-learning gate is inlined here because the pi package cannot
  // import the learner module — it pulls node:fs + the learner dep tree across
  // the thin-extension pack boundary. The daemon owns the real gate; this only
  // avoids attaching a meaningless affordance when learning is disabled.
  const onlineLearningActive = () => process.env.NMG_CONTEXT_ONLINE_LEARNING !== "0";
  // Feedback affordance: recall output itself carries the ask, so it is allowed
  // on every recall (automatic pre-turn injection and the model's own nmg_search
  // results alike). The consumer rates the recall it is looking at, naming the
  // activeGraphId shown right there — no one-shot next-turn scheduler, which
  // missed recalls that never armed it and silently suppressed the ask.
  const recallFeedbackAffordance = (graphId: string | null | undefined): string => {
    if (!graphId || !onlineLearningActive()) return "";
    return renderDisclosure(nmgPrompts.recall_feedback_affordance, {
      graph_id: graphId,
    });
  };
  // Most recent event context, used by the board wake loop to test isIdle and
  // to resolve the current session id outside an event handler.
  let latestAgentCtx: ExtensionContext | undefined;
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
    method:
      | "get"
      | "remember"
      | "rememberBatch"
      | "resolveRemember"
      | "search"
      | "sessionActiveGraph"
      | "taskBoard"
      | "state"
      | "lab"
      | "recordActiveGraphAttribution"
      | "recordClaimOutcomes"
      | "recordFeedback",
    params: Record<string, unknown>,
    options: HttpCallOptions = {},
  ) => invokeDaemon(await connection(), method, params, options);

  const workingStateView = registerWorkingStateView(pi, async (sessionId) => {
    const result = (await invoke("sessionActiveGraph", {
      action: "snapshot",
      sessionId,
    })) as {
      snapshot:
        import("../../../src/core/session-active-graph.ts").SessionActiveGraphSnapshot | null;
    };
    return result.snapshot;
  });

  const formatDisclosedContext = async (
    sessionId: string,
    context: MemoryContext,
    disclosure: DisclosureLevel,
    options: HttpCallOptions = {},
  ): Promise<string> => {
    if (context.results.length === 0) {
      return disclosure === "header" ? "No matching NMG memory found." : "";
    }
    try {
      const decision = (await invoke(
        "sessionActiveGraph",
        {
          action: "disclose",
          sessionId,
          projectionId: context.activeGraph?.id,
          disclosure,
          entries: memoryDisclosureEntries(context, disclosure),
        },
        options,
      )) as { freshMemoryIds: string[]; foldedMemoryIds: string[] };
      const freshIds = new Set(decision.freshMemoryIds);
      const foldedIds = new Set(decision.foldedMemoryIds);
      const fresh = context.results.filter((result) => freshIds.has(result.memory.id));
      const folded = context.results.filter((result) => foldedIds.has(result.memory.id));
      const sections: string[] = [];
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
    } catch {
      return disclosure === "header" ? formatSearchHeaders(context) : formatMemoryContext(context);
    }
  };
  type RecallHandshake = Extract<NmgSessionActiveGraphResult, { action: "beginDisclosureTurn" }>;
  let recallTurn:
    | {
        sessionId: string;
        projectDir: string;
        prompt: string;
        skipped: boolean;
        gate: NonNullable<RecallHandshake["recallGate"]>;
      }
    | undefined;
  let retainedHandshake:
    { sessionId: string; prompt?: string; result?: RecallHandshake } | undefined;
  const beginDisclosureTurn = async (
    sessionId: string,
    enabled: boolean,
    options: HttpCallOptions = {},
    prompt?: string,
  ): Promise<RecallHandshake | undefined> => {
    if (
      !enabled &&
      retainedHandshake?.sessionId === sessionId &&
      retainedHandshake.prompt === prompt
    )
      return retainedHandshake.result;
    recallTurn = undefined;
    const result = (await invoke(
      "sessionActiveGraph",
      {
        action: "beginDisclosureTurn",
        sessionId,
        projectDir: projectDirectory(),
        ...(prompt !== undefined
          ? {
              recall: {
                prompt: recallInput(prompt),
                projectDir: projectDirectory(),
                scheduled: false,
              },
            }
          : {}),
      },
      options,
    ).catch(() => undefined)) as NmgSessionActiveGraphResult | undefined;
    const handshake = result?.action === "beginDisclosureTurn" ? result : undefined;
    retainedHandshake = { sessionId, prompt, result: handshake };
    return handshake;
  };
  const searchCueParams = (
    sessionId: string,
    phrase?: string,
    revision?: number,
  ): Pick<NmgSearchParams, "recallCue" | "recallRevision" | "recallSource"> => {
    if (!phrase) return {};
    if (revision !== undefined) return { recallCue: phrase, recallRevision: revision };
    const current = recallTurn;
    if (
      !current?.skipped ||
      current.sessionId !== sessionId ||
      current.projectDir !== projectDirectory()
    )
      return {};
    if (
      Date.parse(current.gate.expiresAt) <= Date.now() ||
      !canProposeSessionRecallCue(current.prompt, phrase)
    )
      return {};
    current.skipped = false; // At most one native proposal attempt per user turn.
    return {
      recallCue: phrase,
      recallSource: {
        prompt: current.prompt,
        generation: current.gate.generation,
        turn: current.gate.turn,
      },
    };
  };

  // git commit via the bash tool is the strongest "milestone" signal available
  // to the extension; remember it so the next turn can offer NMG memory. The
  // detection moved from the pre-execution tool_call hook to tool_result so it
  // is success-aware (only a commit that actually landed nudges). Memorable
  // tool outcomes stay in the session-local runtime AG; they are working state,
  // not durable memories.
  pi.on("tool_result", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (isSuccessfulCommit(event)) commitNudgePending = true;
    if (!isMemorableToolResult(event)) return;
    const observation = summarizeToolResult(event);
    try {
      await invoke("sessionActiveGraph", {
        action: "observe",
        sessionId,
        sourceId: event.toolName,
        sourceKind: event.isError ? "tool_error" : "tool_result",
        nodeId: observation.nodeName,
        statement: observation.statement,
      });
    } catch {
      // Temporary working state must never break the host tool lifecycle.
    }
  });

  const recallNudges = async (
    budget: RecallBudget,
    sessionId: string,
    isNewUserTurn: boolean,
    prompt: string,
  ) => {
    const completionNudge = popCompletionNudge(prompt);
    // Tool-loop re-entry must not consume a review intended for the next user turn.
    const pendingFeedback = isNewUserTurn ? controllerShadow.pendingFeedback(sessionId) : null;
    if (pendingFeedback)
      await budget.run("feedback.nudge", () =>
        controllerShadow.feedbackNudgeShown(sessionId, pendingFeedback),
      );
    const feedbackNudge = pendingFeedback
      ? renderDisclosure(nmgPrompts.shadow_feedback_nudge, {
          active_graph_id: pendingFeedback.activeGraphId,
          semantic_task_id: pendingFeedback.semanticTaskId,
        })
      : "";
    const pendingClaimOutcome = isNewUserTurn
      ? controllerShadow.pendingClaimOutcome(sessionId)
      : null;
    if (pendingClaimOutcome) {
      await budget.run("claim.nudge", () =>
        controllerShadow.claimOutcomeNudgeShown(sessionId, pendingClaimOutcome),
      );
    }
    const claimOutcomeNudge = pendingClaimOutcome
      ? renderDisclosure(nmgPrompts.shadow_claim_outcome_nudge, {
          active_graph_id: pendingClaimOutcome.activeGraphId,
          semantic_task_id: pendingClaimOutcome.semanticTaskId,
          memory_ids: pendingClaimOutcome.memoryIds.join(","),
        })
      : "";
    return [completionNudge, feedbackNudge, claimOutcomeNudge].flatMap((body) =>
      contextNotice(body),
    );
  };
  const reasoningCheckpointFor = async (
    budget: RecallBudget,
    sessionId: string,
  ): Promise<InformationView[]> => {
    if (labToolsEnabled) {
      try {
        const status = (await budget.run("reasoning.status", async (signal) =>
          invokeDaemon(
            await connection(),
            "lab",
            {
              action: "status",
              capability: "reasoning_workspace",
              sessionId,
            },
            { signal },
          ),
        )) as { activation?: unknown };
        if (status.activation) {
          const consumed = (await budget.run("reasoning.checkpoint", async (signal) =>
            invokeDaemon(
              await connection(),
              "lab",
              {
                action: "invoke",
                capability: "reasoning_workspace",
                sessionId,
                operation: "consume_checkpoint",
                input: { maxNodes: 24, maxChars: 6_000 },
              },
              { signal },
            ),
          )) as { output?: ReasoningCheckpoint | null };
          return checkpointInformationViews(consumed.output ?? null, sessionId);
        }
      } catch (error) {
        return contextNotice(`Reasoning workspace unavailable: ${message(error)}`, "diagnostic");
      }
    }
    return [];
  };

  // One typed state read per turn; no model-tool round trip or rendered-text parser.
  const readTurnAgContext = async (
    budget: RecallBudget,
    sessionId: string,
  ): Promise<readonly InformationView[]> => {
    try {
      const result = (await budget.run("state.read", (signal) =>
        invoke("state", { action: "read", space: "ag", sessionId }, { signal }),
      )) as NmgStateResult;
      if (result.space !== "ag" || result.result.action !== "snapshot")
        throw new Error("Invalid AG state result");
      return contextStateViews(result.result.snapshot, sessionId);
    } catch (error) {
      return contextNotice(`AG context unavailable: ${message(error)}`, "diagnostic");
    }
  };

  observeRecallPreparation(pi, firstResponseTiming, async (event, ctx) => {
    const budget = new RecallBudget(undefined, ctx.signal);
    const sessionId = ctx.sessionManager.getSessionId();
    const partial = {
      base: [] as InformationView[],
      candidates: [] as InformationView[],
      hints: [] as InformationView[],
      context: undefined as MemoryContext | undefined,
    };
    const automaticInvoke = (
      method: Parameters<typeof invoke>[0],
      params: Record<string, unknown>,
    ) =>
      budget.run(
        `${method}${typeof params.action === "string" ? `.${params.action}` : ""}`,
        (signal) => invoke(method, params, { signal }),
      );
    const currentOutput = (diagnostic = "") =>
      prepareInformationOutput(
        [
          ...partial.base,
          ...partial.candidates,
          ...partial.hints,
          ...contextNotice(diagnostic, "diagnostic"),
        ],
        { format: "context" },
      );
    const includedMemoryIds = (output: PreparedInformationOutput) =>
      output.included.flatMap((entry) =>
        entry.source.kind === "memory" ? [entry.source.memoryId] : [],
      );
    const surfaceResult = (output: PreparedInformationOutput) => {
      const context = partial.context;
      if (context) {
        const ids = new Set(includedMemoryIds(output));
        agentAttributionFlow.note(sessionId, {
          ...context,
          results: context.results.filter((result) => ids.has(result.memory.id)),
        });
      }
      return persistedContextResult(output, event.systemPrompt);
    };
    let recallRequest: SessionRecallRequest | null = null;
    const prepare = async () => {
      const isNewUserTurn = recallFlow.beginTurn(
        sessionId,
        piUserTurnKey(ctx.sessionManager, event.prompt),
      );
      await budget.run("connection", () => connection());
      const handshake = await budget.run("disclosure.begin", (signal) =>
        beginDisclosureTurn(sessionId, isNewUserTurn, { signal }, event.prompt),
      );
      recallRequest = taskWindow.prepare(
        sessionId,
        event.prompt,
        handshake?.sessionRecall?.decision,
      );
      if (handshake?.recallGate && event.prompt.length <= 4096) {
        recallTurn = {
          sessionId,
          projectDir: projectDirectory(),
          prompt: event.prompt,
          skipped: !recallRequest,
          gate: handshake.recallGate,
        };
        if (
          !handshake.sessionRecall &&
          !recallRequest &&
          matchSessionRecallCue(event.prompt, handshake.recallGate.phrases)
        ) {
          const decision = decideMemoryLoad(event.prompt, { sessionCue: true });
          if (decision.mode === "cue") {
            recallRequest = { ...decision, mode: "cue", query: event.prompt };
            recallTurn.skipped = false;
          }
        }
      }
      partial.base.push(...(await recallNudges(budget, sessionId, isNewUserTurn, event.prompt)));
      // Each completed typed stage survives later optional work or a deadline.
      partial.base.unshift(...(await reasoningCheckpointFor(budget, sessionId)));
      partial.base.push(...(await readTurnAgContext(budget, sessionId)));
    };
    const automatic = async () => {
      await prepare();
      const demand = recallRequest;
      if (!demand) return surfaceResult(currentOutput());
      let context = (await automaticInvoke("search", {
        query: demand.query,
        autoRecallBudgetMs: Math.max(1, Math.floor(Math.min(4_500, budget.remainingMs - 100))),
        projectDir: projectDirectory(),
        sessionId,
        maxTier: Math.min(configuredAutoRecallTier(), demand.maxTier) as MemoryTier,
        limit: Math.min(configuredAutoRecallLimit(), demand.limit),
        initialEvidenceTarget: configuredInitialTarget(),
        strongHitTopGap: configuredStrongHitTopGap(),
        strongHitInitialTarget: configuredStrongHitInitialTarget(),
        secondPass: qpp2Mode === "active",
        graphHops: Math.min(1, demand.graphHops),
        tieredDisclosure: true,
        autoRecall: true,
      })) as MemoryContext;
      partial.context = context;
      partial.candidates = searchInformationViews(context);
      if (controllerRerankMode === "active") {
        context = await budget.run("controller.rerank", () => controllerShadow.rerank(context));
        partial.context = context;
        partial.candidates = searchInformationViews(context);
      }
      const fullContext = context;
      if (qpp2Mode === "active") {
        context = await budget.run("controller.fold", () =>
          applyLearnedFold(context, controllerShadow, qpp2RetainedMass, false),
        );
        partial.candidates = searchInformationViews(context);
      }
      partial.hints = [
        formatSearchRecommendation(context, recommendationMode),
        formatProgressiveDisclosure(context),
        context.results.length > 0 ? recallFeedbackAffordance(fullContext.activeGraph?.id) : "",
      ].flatMap((body) => contextNotice(body));
      const output = currentOutput();
      await budget.run("controller.telemetry", () =>
        controllerShadow.retrieval(
          fullContext,
          sessionId,
          "automatic",
          includedMemoryIds(output)
            .map((id) => `memory=${id}`)
            .join("\n"),
        ),
      );
      return surfaceResult(output);
    };
    try {
      const result = await budget.run("automatic.context", automatic);
      return {
        ...result,
        ...(result.message
          ? {
              message: {
                ...result.message,
                details: {
                  ...result.message.details,
                  recallTiming: budget.timing(),
                },
              },
            }
          : {}),
      };
    } catch (error) {
      const diagnostic =
        error instanceof RecallDeadlineExceeded
          ? "NMG automatic recall reached its 5-second budget; late work was ignored."
          : `NMG unavailable: ${message(error)}`;
      const result = surfaceResult(currentOutput(diagnostic));
      return {
        ...result,
        ...(result.message
          ? {
              message: {
                ...result.message,
                details: {
                  ...result.message.details,
                  recallTiming: budget.timing(),
                },
              },
            }
          : {}),
      };
    } finally {
      latestRecallTiming = budget.timing();
      budget.close();
    }
  });

  // TUI 折叠开关：nmg-context 默认折叠为一个 [nmg-context] chip，避免每轮刷屏。
  // /nmg-recall 切换展开（走 pi 默认渲染：label + 全文）。状态只影响后续渲染
  // 与重开会话后的历史恢复；已渲染的历史消息不重绘（pi 无公开 force-rerender）。
  let recallCollapsed = true;
  pi.registerMessageRenderer<{ count?: number }>("nmg-context", (message, options, theme) => {
    if (!recallCollapsed) return undefined;
    const count = (message.details as { count?: number } | undefined)?.count;
    const label = theme.fg("customMessageLabel", "\x1b[1m[nmg-context]\x1b[22m");
    const hint = theme.fg(
      "dim",
      count ? `  ${count} 条召回 · /nmg recall 展开` : "  /nmg recall 展开",
    );
    const box = new Box(options.outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(`${label}${hint}`, 0, 0));
    return box;
  });
  // NMG 总二级/三级菜单。早期只有独立的 /nmg-recall 命令；现在统一收编到
  // /nmg 下，保留 /nmg-recall 作为别名。状态只影响后续渲染与重开会话后的
  // 历史恢复；已渲染的历史消息不重绘（pi 无公开 force-rerender）。
  const recallCommand = (args: readonly string[], ctx: ExtensionCommandContext): void => {
    if (args[0] === "timing") {
      ctx.ui.notify(
        latestRecallTiming
          ? JSON.stringify(latestRecallTiming, null, 2)
          : "本会话尚无自动召回耗时记录",
        "info",
      );
      return;
    }
    recallCollapsed = !recallCollapsed;
    ctx.ui.notify(
      recallCollapsed
        ? "nmg-context 已折叠（只显示 [nmg-context] chip）"
        : "nmg-context 已展开（显示召回全文）",
      "info",
    );
  };
  const nmgMenuHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const [sub, ...rest] = parts;
    const restText = rest.join(" ");
    switch (sub) {
      case "recall": {
        recallCommand(rest, ctx);
        return;
      }
      case "wake": {
        const current = readWakeConfig();
        const [wcmd, wvalRaw] = restText.split(/\s+/);
        const wval = Number(wvalRaw);
        switch (wcmd) {
          case "on":
            writeWakeConfig({ ...current, enabled: true });
            ctx.ui.notify("黑板唤醒已开启（世界频道+活跃频道有新 open 条目会唤醒）", "info");
            return;
          case "off":
            writeWakeConfig({ ...current, enabled: false });
            ctx.ui.notify("黑板唤醒已关闭", "info");
            return;
          case "status": {
            const budgetText = current.budget === 0 ? "不限制" : `${current.budget}/天`;
            const cooldownText =
              current.cooldownMs === 0 ? "无" : `${Math.round(current.cooldownMs / 60_000)} 分`;
            ctx.ui.notify(
              `黑板唤醒：${current.enabled ? "开" : "关"} · 预算 ${budgetText} · 冷却 ${cooldownText} · 轮询 ${Math.round(current.intervalMs / 1_000)} 秒 · 世界广播 ${current.worldBroadcast ? "开" : "关"}`,
              "info",
            );
            return;
          }
          case "budget": {
            if (!Number.isFinite(wval)) {
              ctx.ui.notify("用法：/nmg wake budget N（0=不限制）", "warning");
              return;
            }
            const budget = Math.max(0, Math.min(100, Math.round(wval)));
            writeWakeConfig({ ...current, budget });
            ctx.ui.notify(`黑板唤醒预算已设为 ${budget === 0 ? "不限制" : `${budget}/天`}`, "info");
            return;
          }
          case "cooldown": {
            if (!Number.isFinite(wval)) {
              ctx.ui.notify("用法：/nmg wake cooldown M（0=无冷却）", "warning");
              return;
            }
            const cooldownMs = wval === 0 ? 0 : Math.max(30_000, Math.round(wval * 60_000));
            writeWakeConfig({ ...current, cooldownMs });
            ctx.ui.notify(
              `黑板唤醒冷却已设为 ${cooldownMs === 0 ? "无" : `${Math.round(cooldownMs / 60_000)} 分钟`}`,
              "info",
            );
            return;
          }
          case "interval": {
            if (!Number.isFinite(wval)) {
              ctx.ui.notify("用法：/nmg wake interval S（秒，最小 5）", "warning");
              return;
            }
            const intervalMs = Math.max(5_000, Math.round(wval * 1_000));
            writeWakeConfig({ ...current, intervalMs });
            ctx.ui.notify(`黑板唤醒轮询已设为 ${Math.round(intervalMs / 1_000)} 秒`, "info");
            return;
          }
          case "world": {
            // 无参切换；0 关、1 开。
            const world =
              wvalRaw === "0" ? false : wvalRaw === "1" ? true : !current.worldBroadcast;
            writeWakeConfig({ ...current, worldBroadcast: world });
            ctx.ui.notify(
              world
                ? "已开启世界频道协作广播：协作类新条目会同时发到世界频道拉其他 agent"
                : "已关闭世界频道协作广播",
              "info",
            );
            return;
          }
          default: {
            const enabled = !current.enabled;
            writeWakeConfig({ ...current, enabled });
            ctx.ui.notify(enabled ? "黑板唤醒已开启" : "黑板唤醒已关闭", "info");
          }
        }
        return;
      }
      default: {
        // 无参数 → 交互式选择菜单（可上下键选，不用手敲）；未知子命令 → 总览提示。
        if (parts.length === 0) {
          await nmgInteractiveMenu(ctx);
          return;
        }
        const wake = readWakeConfig();
        const budgetText = wake.budget === 0 ? "不限制" : `${wake.budget}/天`;
        const cooldownText =
          wake.cooldownMs === 0 ? "无" : `${Math.round(wake.cooldownMs / 60_000)} 分`;
        ctx.ui.notify(
          `NMG 菜单：/nmg recall（召回折叠 ${recallCollapsed ? "开" : "关"}） · /nmg wake on|off|status|budget N|cooldown M|interval S（唤醒 ${wake.enabled ? "开" : "关"}，预算 ${budgetText}，冷却 ${cooldownText}，轮询 ${Math.round(wake.intervalMs / 1_000)} 秒）`,
          "info",
        );
      }
    }
  };
  // 交互式选择菜单：/nmg（无参数）弹出可上下键选的列表，避免手敲。带参数的
  // 形式（/nmg recall、/nmg wake on 等）仍保留，供脚本/快捷路径直接调用。
  // 挡位选择（select 预设值，避免随意输入溢出/无效）；自由数字只走命令形式
  // （/nmg wake budget N 等，已有 clamp）。
  const nmgWakeParamMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    const param = await ctx.ui.select("唤醒参数", ["每日上限", "冷却", "轮询"]);
    if (!param) return;
    const current = readWakeConfig();
    if (param === "每日上限") await nmgWakeBudgetMenu(current, ctx);
    else if (param === "冷却") await nmgWakeCooldownMenu(current, ctx);
    else if (param === "轮询") await nmgWakeIntervalMenu(current, ctx);
  };
  const nmgWakeBudgetMenu = async (
    current: ReturnType<typeof readWakeConfig>,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    const option = await ctx.ui.select("每日唤醒上限", ["不限制", "3/天", "8/天", "15/天"]);
    if (!option) return;
    const budget = option === "不限制" ? 0 : Number(option.split("/")[0]);
    writeWakeConfig({ ...current, budget });
    ctx.ui.notify(`黑板唤醒预算已设为 ${budget === 0 ? "不限制" : `${budget}/天`}`, "info");
  };
  const nmgWakeCooldownMenu = async (
    current: ReturnType<typeof readWakeConfig>,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    const option = await ctx.ui.select("冷却", ["无", "10 分钟", "30 分钟", "1 小时"]);
    if (!option) return;
    const cooldownMs =
      option === "无"
        ? 0
        : option === "10 分钟"
          ? 600_000
          : option === "30 分钟"
            ? 1_800_000
            : 3_600_000;
    writeWakeConfig({ ...current, cooldownMs });
    ctx.ui.notify(
      `黑板唤醒冷却已设为 ${cooldownMs === 0 ? "无" : `${Math.round(cooldownMs / 60_000)} 分钟`}`,
      "info",
    );
  };
  const nmgWakeIntervalMenu = async (
    current: ReturnType<typeof readWakeConfig>,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    const option = await ctx.ui.select("轮询", ["5 秒", "30 秒", "60 秒", "5 分钟"]);
    if (!option) return;
    const intervalMs =
      option === "5 秒"
        ? 5_000
        : option === "30 秒"
          ? 30_000
          : option === "60 秒"
            ? 60_000
            : 300_000;
    writeWakeConfig({ ...current, intervalMs });
    ctx.ui.notify(`黑板唤醒轮询已设为 ${Math.round(intervalMs / 1_000)} 秒`, "info");
  };
  // 状态预览的菜单入口：只切显示，不改状态、不改携带。
  const nmgStatePreviewMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    const onOff = await ctx.ui.select("NMG 当前工作状态预览", ["显示", "隐藏"]);
    if (!onOff) return;
    await workingStateView.setPreview(onOff === "显示", ctx);
    ctx.ui.notify(onOff === "显示" ? "状态预览已显示" : "状态预览已隐藏（状态本身不变）", "info");
  };
  const nmgInteractiveMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
      ctx.ui.notify(
        "当前模式不支持交互菜单，可用：/nmg recall、/nmg state on|off、/nmg wake on|off|status|budget N|cooldown M|interval S",
        "warning",
      );
      return;
    }
    const choice = await ctx.ui.select(
      "NMG 控制台",
      nmgMenuOptions(recallCollapsed, readWakeConfig()),
    );
    if (!choice) return; // 用户取消
    if (choice.startsWith("召回")) {
      await nmgMenuHandler("recall", ctx);
      return;
    }
    if (choice.startsWith("唤醒：开启/关闭")) {
      const onOff = await ctx.ui.select("黑板唤醒", ["开启", "关闭"]);
      if (!onOff) return;
      const current = readWakeConfig();
      writeWakeConfig({ ...current, enabled: onOff === "开启" });
      ctx.ui.notify(onOff === "开启" ? "黑板唤醒已开启" : "黑板唤醒已关闭", "info");
      return;
    }
    if (choice.startsWith("唤醒：世界广播")) {
      const onOff = await ctx.ui.select("世界频道协作广播", ["开启", "关闭"]);
      if (!onOff) return;
      const current = readWakeConfig();
      writeWakeConfig({ ...current, worldBroadcast: onOff === "开启" });
      ctx.ui.notify(
        onOff === "开启"
          ? "已开启世界频道协作广播：协作类新条目会同时发到世界频道拉其他 agent"
          : "已关闭世界频道协作广播",
        "info",
      );
      return;
    }
    if (choice.startsWith("唤醒：参数设置")) {
      await nmgWakeParamMenu(ctx);
      return;
    }
    if (choice.startsWith("当前状态：查看完整正文")) {
      await workingStateView.readForUser(ctx);
      return;
    }
    if (choice.startsWith("当前状态：显示/隐藏预览")) {
      await nmgStatePreviewMenu(ctx);
      return;
    }
    {
      const wake = readWakeConfig();
      const budgetText = wake.budget === 0 ? "不限制" : `${wake.budget}/天`;
      const cooldownText =
        wake.cooldownMs === 0 ? "无" : `${Math.round(wake.cooldownMs / 60_000)} 分`;
      ctx.ui.notify(
        `NMG：召回折叠 ${recallCollapsed ? "开" : "关"} · 唤醒 ${wake.enabled ? "开" : "关"}（预算 ${budgetText}，冷却 ${cooldownText}，轮询 ${Math.round(wake.intervalMs / 1_000)} 秒）`,
        "info",
      );
    }
  };
  // `/nmg state [on|off]` is the read-only state view and its preview switch.
  // It dispatches before the menu handler so that handler keeps its own shape.
  const nmgStateCommand = async (rest: string[], ctx: ExtensionCommandContext): Promise<void> => {
    const [action] = rest;
    if (action === "on" || action === "off") {
      await workingStateView.setPreview(action === "on", ctx);
      ctx.ui.notify(
        action === "on"
          ? "NMG 当前工作状态预览已显示"
          : "NMG 当前工作状态预览已隐藏（状态本身不变，/nmg state 仍可查看）",
        "info",
      );
      return;
    }
    await workingStateView.readForUser(ctx);
  };
  const nmgCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (sub === "state") return nmgStateCommand(rest, ctx);
    return nmgMenuHandler(args, ctx);
  };
  // 菜单项带当前状态，进子菜单前就看得见：召回折叠/展开、唤醒开/关、参数当前值。
  // 预算/冷却支持 0（不限制/无），轮询保持最小 5 秒（0 无意义）。
  const nmgMenuOptions = (
    recallCollapsed: boolean,
    wake: ReturnType<typeof readWakeConfig>,
  ): string[] => {
    const budgetText = wake.budget === 0 ? "不限制" : `${wake.budget}/天`;
    const cooldownText =
      wake.cooldownMs === 0 ? "无" : `${Math.round(wake.cooldownMs / 60_000)} 分`;
    return [
      `召回：折叠/展开（当前 ${recallCollapsed ? "折叠" : "展开"}）`,
      `唤醒：开启/关闭（当前 ${wake.enabled ? "开" : "关"}）`,
      `唤醒：世界广播（当前 ${wake.worldBroadcast ? "开" : "关"}）`,
      `唤醒：参数设置（预算 ${budgetText} · 冷却 ${cooldownText} · 轮询 ${Math.round(wake.intervalMs / 1_000)} 秒）`,
      ...nmgStateMenuLabels(),
      "查看状态",
    ];
  };
  const nmgStateMenuLabels = (): string[] => [
    "当前状态：查看完整正文",
    `当前状态：显示/隐藏预览（当前 ${workingStateView.previewEnabled() ? "显示" : "隐藏"}）`,
  ];
  pi.registerCommand("nmg", {
    description:
      "NMG 菜单：/nmg recall · state [on|off] · wake on/off/status/world · wake budget N · wake cooldown M · wake interval S",
    getArgumentCompletions: (prefix) => {
      const items: AutocompleteItem[] = [
        {
          value: "recall",
          label: "recall",
          description: "切换 nmg-context 召回折叠/展开",
        },
        {
          value: "state",
          label: "state",
          description: "查看完整当前工作状态（只读）",
        },
        { value: "state on", label: "state on", description: "显示状态预览" },
        {
          value: "state off",
          label: "state off",
          description: "隐藏状态预览（不改状态）",
        },
        { value: "wake", label: "wake", description: "黑板唤醒开关/配置" },
        { value: "wake on", label: "wake on", description: "开启黑板唤醒" },
        { value: "wake off", label: "wake off", description: "关闭黑板唤醒" },
        {
          value: "wake status",
          label: "wake status",
          description: "显示唤醒配置",
        },
        {
          value: "wake budget ",
          label: "wake budget N",
          description: "每日唤醒上限（0=不限制）",
        },
        {
          value: "wake cooldown ",
          label: "wake cooldown M",
          description: "冷却分钟（0=无）",
        },
        {
          value: "wake interval ",
          label: "wake interval S",
          description: "轮询秒（最小 5）",
        },
        {
          value: "wake world",
          label: "wake world",
          description: "切换世界频道协作广播（1/0 开/关）",
        },
      ];
      const normalized = prefix.trim();
      return items.filter((item) => item.value.startsWith(normalized));
    },
    handler: nmgCommand,
  });

  pi.on("session_start", async (_event, ctx) => {
    latestAgentCtx = ctx;
    // Flush archive entries staged by a previous session_shutdown. The daemon
    // is lazily started by the first invoke, so this cannot race teardown.
    // Failures keep the staging files for the next startup.
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      await flushArchives(stagingDirFor(projectDirectory()), async (entries) => {
        const items = entries.map((entry) => ({
          statement: archiveStatement(entry),
          nodeName: archiveNodeName(entry),
          memoryType: "event",
          writeSource: "automatic",
          eventTime: entry.archivedAt,
          sourceActor: "system",
          truthStatus: "asserted",
          tier: 2,
          importance: 0.2,
          markers: [
            {
              kind: "session_archive",
              attributes: { sessionId: entry.sessionId },
            },
          ],
          scope: { project: projectDirectory() },
          writeReason: "session_archive_flush",
          projectDir: projectDirectory(),
          sessionId,
        }));
        const active = await connection();
        const supportsBatch =
          active.capabilities.has("batch-remember") &&
          (active.methods === undefined || active.methods.has("rememberBatch"));
        if (supportsBatch) {
          await invokeDaemon(active, "rememberBatch", { items });
        } else {
          for (const item of items) await invokeDaemon(active, "remember", item);
        }
      });
    } catch {
      // Daemon unavailable; staging files remain for the next startup.
    }
    // System-layer identity registration (A2A AgentCard local edition): report
    // this agent on session start so discover() can find it (the wake loop also
    // heartbeats it each tick). Never wakes an LLM. Capabilities come from
    // NMG_AGENT_CAPABILITIES (comma-separated) when set.
    try {
      const identity = loadOrCreateAgentIdentity(sessionId, "pi");
      await invoke("taskBoard", {
        action: "registerAgent",
        id: identity.id,
        agentName: identity.agentName,
        capabilities: process.env.NMG_AGENT_CAPABILITIES?.trim() || undefined,
        supportedInterfaces: "pi",
      });
    } catch {
      // best-effort: a daemon without registerAgent just skips registration.
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    latestAgentCtx = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    await controllerShadow.outcome(sessionId, event.messages);
    // Diagnostic answer-overlap attribution (independent of the SkillOpt shadow
    // bridge): derive which recalled memories visibly surfaced in the final
    // answer. Provider/model behaviour may drift, so this signal is stored only
    // as attributed_memory_ids and never trains QPP, topology, or the controller.
    try {
      const answerText = extractAnswerText(event.messages);
      const promptText = extractPromptText(event.messages);
      // Always consume: a pending trace whose turn produced no assistant text
      // must not be carried into the next turn (its label would be matched
      // against the WRONG answer). Consuming drops it — better to lose a
      // sample than to mislabel one.
      const pending = agentAttributionFlow.consume(sessionId);
      if (pending.length > 0 && answerText) {
        const active = connectionPromise
          ? await connectionPromise.catch(() => undefined)
          : undefined;
        for (const { traceId, results } of pending) {
          const requestedMemoryIds = results.map((entry) => entry.memory.id);
          const attributedMemoryIds = deriveAnswerOverlapMemoryIds(answerText, results, promptText);
          // The shadow log mirrors the same heuristic diagnostic. An empty set is
          // still useful for coverage analysis, but is not a training negative.
          await controllerShadow.attribution(
            traceId,
            sessionId,
            requestedMemoryIds,
            attributedMemoryIds,
          );
          if (active) {
            try {
              await invoke("recordActiveGraphAttribution", {
                activeGraphId: traceId,
                attributedMemoryIds,
                projectDir: projectDirectory(),
                sessionId,
              });
            } catch {
              // One trace failing must not stop the rest.
            }
          }
        }
      }
    } catch {
      // Implicit feedback must never break agent completion.
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    taskWindow.clear(sessionId);
    recallFlow.clear(sessionId);
    recallTurn = undefined;
    retainedHandshake = undefined;
    agentAttributionFlow.clear(sessionId);
    controllerShadow.clear(sessionId);
    if (!connectionPromise) return;
    const active = await connectionPromise.catch(() => undefined);
    if (!active) {
      connectionPromise = undefined;
      return;
    }
    try {
      await invokeDaemon(active, "sessionActiveGraph", {
        action: "release",
        sessionId,
      });
    } catch {
      // Process teardown below is the final cleanup fallback.
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

  pi.on("session_before_compact", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    await invoke("sessionActiveGraph", {
      action: "clearDisclosures",
      sessionId,
    }).catch(() => undefined);
    try {
      await invoke("sessionActiveGraph", { action: "activate", sessionId });
    } catch {
      // Compaction remains owned by Pi when the optional AG projection is unavailable.
    }
    if (labToolsEnabled) {
      try {
        const status = (await invokeDaemon(await connection(), "lab", {
          action: "status",
          capability: "reasoning_workspace",
          sessionId,
        })) as { activation?: unknown };
        if (status.activation) {
          await invokeDaemon(await connection(), "lab", {
            action: "invoke",
            capability: "reasoning_workspace",
            sessionId,
            operation: "mark_compacted",
          });
        }
      } catch {
        // Optional Lab state must never block Pi compaction.
      }
    }
    // Pi owns conversational compaction. The runtime AG remains in memory and
    // is injected again on the next turn; compaction alone never promotes
    // temporary state into durable NMG storage.
  });

  if (labToolsEnabled) {
    pi.registerTool({
      name: "nmg_reason",
      label: "NMG Reasoning Scratchpad",
      description: nmgPrompts.reason_description,
      parameters: Type.Object({
        action: Type.Union(
          [
            Type.Literal("add"),
            Type.Literal("update"),
            Type.Literal("link"),
            Type.Literal("checkpoint"),
            Type.Literal("clear"),
          ],
          { description: nmgPrompts.reason_action_parameter_description },
        ),
        nodeId: Type.Optional(
          Type.String({
            description: nmgPrompts.reason_node_id_parameter_description,
          }),
        ),
        kind: Type.Optional(
          Type.Union(
            REASONING_NODE_KINDS.map((kind) => Type.Literal(kind)),
            { description: nmgPrompts.reason_kind_parameter_description },
          ),
        ),
        content: Type.Optional(
          Type.String({
            description: nmgPrompts.reason_content_parameter_description,
          }),
        ),
        status: Type.Optional(
          Type.Union(
            REASONING_STATUSES.map((status) => Type.Literal(status)),
            { description: nmgPrompts.reason_status_parameter_description },
          ),
        ),
        importance: Type.Optional(
          Type.Number({
            minimum: 0,
            maximum: 1,
            description: nmgPrompts.reason_importance_parameter_description,
          }),
        ),
        evidenceRefs: Type.Optional(
          Type.Array(Type.String(), {
            description: nmgPrompts.reason_evidence_refs_parameter_description,
          }),
        ),
        sourceId: Type.Optional(
          Type.String({
            description: nmgPrompts.reason_source_id_parameter_description,
          }),
        ),
        targetId: Type.Optional(
          Type.String({
            description: nmgPrompts.reason_target_id_parameter_description,
          }),
        ),
        relation: Type.Optional(
          Type.Union(
            REASONING_EDGE_KINDS.map((relation) => Type.Literal(relation)),
            { description: nmgPrompts.reason_relation_parameter_description },
          ),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        const status = (await invokeDaemon(await connection(), "lab", {
          action: "status",
          capability: "reasoning_workspace",
          sessionId,
        })) as { activation?: unknown };
        if (!status.activation) {
          await invokeDaemon(await connection(), "lab", {
            action: "enable",
            capability: "reasoning_workspace",
            scope: "session",
            sessionId,
            requester: "agent:pi",
            reason: "nmg_reason requested a session scratchpad",
          });
        }
        const input =
          params.action === "link"
            ? {
                sourceId: params.sourceId,
                targetId: params.targetId,
                type: params.relation,
              }
            : params.action === "update"
              ? {
                  nodeId: params.nodeId,
                  content: params.content,
                  status: params.status,
                  importance: params.importance,
                  evidenceRefs: params.evidenceRefs,
                }
              : params.action === "add"
                ? {
                    kind: params.kind,
                    content: params.content,
                    status: params.status,
                    importance: params.importance,
                    evidenceRefs: params.evidenceRefs,
                  }
                : {};
        const invoked = await invokeDaemon(await connection(), "lab", {
          action: "invoke",
          capability: "reasoning_workspace",
          sessionId,
          operation: params.action === "checkpoint" ? "checkpoint" : params.action,
          input,
        });
        if (params.action === "clear") return toolResult(invoked, "Reasoning scratchpad cleared.");
        const checkpoint =
          params.action === "checkpoint"
            ? invoked
            : await invokeDaemon(await connection(), "lab", {
                action: "invoke",
                capability: "reasoning_workspace",
                sessionId,
                operation: "checkpoint",
              });
        return toolResult({ invoked, checkpoint }, JSON.stringify(checkpoint, null, 2));
      },
    });
  }

  pi.registerTool({
    name: "nmg_lab",
    label: "NMG Lab capabilities",
    description: nmgPrompts.lab_description,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("status"),
        Type.Literal("enable"),
        Type.Literal("disable"),
        Type.Literal("invoke"),
      ]),
      capability: Type.Optional(
        Type.Union([
          Type.Literal("reasoning_workspace"),
          Type.Literal("recall_gate"),
          Type.Literal("memory_graph_reasoner"),
          Type.Literal("controller_shadow"),
          Type.Literal("controller_controlled"),
          Type.Literal("controller_active"),
        ]),
      ),
      reason: Type.Optional(Type.String()),
      ttlSeconds: Type.Optional(Type.Number({ minimum: 60, maximum: 86400 })),
      operation: Type.Optional(Type.String()),
      input: Type.Optional(Type.Unknown()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (String(params.capability) === "working_state")
        throw new Error("Working state uses nmg_state");
      if (params.action !== "list" && !params.capability) {
        throw new Error(`${params.action} requires capability`);
      }
      if (params.action === "enable" && !params.reason) throw new Error("enable requires reason");
      if (params.action === "invoke" && !params.operation)
        throw new Error("invoke requires operation");
      if (
        params.capability === "recall_gate" &&
        ["enable", "disable", "clear", "correct", "remove"].includes(
          params.action === "invoke" ? (params.operation ?? "") : params.action,
        )
      ) {
        recallTurn = undefined;
        retainedHandshake = undefined;
      }
      const active = await connection();
      const result = await invokeDaemon(active, "lab", {
        action: params.action,
        capability: params.capability,
        sessionId,
        scope: params.action === "enable" ? "session" : undefined,
        requester: params.action === "enable" ? "agent:pi" : undefined,
        reason: params.reason,
        ttlSeconds: params.ttlSeconds,
        operation: params.operation,
        input: params.input,
      });
      return toolResult(result, renderLabOutput(result));
    },
  });

  pi.registerTool({
    name: "nmg_remember",
    label: "Remember with NMG",
    description: nmgPrompts.remember_description,
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union(
          PI_REMEMBER_ACTIONS.map((action) => Type.Literal(action)),
          { description: nmgPrompts.remember_action_parameter_description },
        ),
      ),
      memoryId: Type.Optional(
        Type.String({
          description: nmgPrompts.remember_memory_id_parameter_description,
        }),
      ),
      activeGraphId: Type.Optional(
        Type.String({
          description: nmgPrompts.active_graph_id_parameter_description,
        }),
      ),
      taskSuccess: Type.Optional(
        Type.Boolean({
          description: nmgPrompts.feedback_label_parameter_description,
        }),
      ),
      userCorrection: Type.Optional(
        Type.Boolean({
          description: nmgPrompts.feedback_label_parameter_description,
        }),
      ),
      evidenceSufficient: Type.Optional(
        Type.Boolean({
          description: nmgPrompts.feedback_label_parameter_description,
        }),
      ),
      expansionUseful: Type.Optional(
        Type.Boolean({
          description: nmgPrompts.feedback_label_parameter_description,
        }),
      ),
      excessiveNoise: Type.Optional(
        Type.Boolean({
          description: nmgPrompts.feedback_label_parameter_description,
        }),
      ),
      noMemoryNeeded: Type.Optional(
        Type.Boolean({
          description: nmgPrompts.feedback_label_parameter_description,
        }),
      ),
      memoryMisleading: Type.Optional(
        Type.Boolean({
          description: nmgPrompts.feedback_misleading_parameter_description,
        }),
      ),
      feedbackNote: Type.Optional(
        Type.String({
          description: nmgPrompts.feedback_note_parameter_description,
        }),
      ),
      semanticTaskId: Type.Optional(
        Type.String({
          description: nmgPrompts.semantic_task_id_parameter_description,
        }),
      ),
      claimOutcome: Type.Optional(
        Type.Union([Type.Literal("supported"), Type.Literal("contradicted")], {
          description: nmgPrompts.claim_outcome_parameter_description,
        }),
      ),
      claimOutcomeSource: Type.Optional(
        Type.Union([Type.Literal("user"), Type.Literal("tool"), Type.Literal("task")], {
          description: nmgPrompts.claim_outcome_source_parameter_description,
        }),
      ),
      claimSourceLineage: Type.Optional(
        Type.String({
          description: nmgPrompts.claim_source_lineage_parameter_description,
        }),
      ),
      claimIndexes: Type.Optional(
        Type.Array(Type.Number({ minimum: 0 }), {
          description: nmgPrompts.claim_indexes_parameter_description,
        }),
      ),
      claimWeight: Type.Optional(Type.Number({ minimum: 0.000001, maximum: 1 })),
      statement: Type.Optional(Type.String()),
      nodeName: Type.Optional(
        Type.String({
          description: nmgPrompts.node_name_parameter_description,
        }),
      ),
      recallTriggers: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
          maxItems: 16,
          description: nmgPrompts.recall_triggers_parameter_description,
        }),
      ),
      newMemoryId: Type.Optional(
        Type.String({
          description: nmgPrompts.remember_new_memory_id_parameter_description,
        }),
      ),
      supersededMemoryId: Type.Optional(
        Type.String({
          description: nmgPrompts.remember_superseded_memory_id_parameter_description,
        }),
      ),
      relatedMemoryId: Type.Optional(
        Type.String({
          description: nmgPrompts.remember_related_memory_id_parameter_description,
        }),
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
          {
            description: nmgPrompts.remember_relation_judgement_parameter_description,
          },
        ),
      ),
      relationConfidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      resolutionReason: Type.Optional(Type.String()),
      resolution: Type.Optional(
        Type.Union([Type.Literal("open"), Type.Literal("resolved"), Type.Literal("reopened")]),
      ),
      openedAt: Type.Optional(Type.String()),
      relatedMemoryIds: Type.Optional(Type.Array(Type.String())),
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
        Type.Union(
          [
            Type.Literal("assistant"),
            Type.Literal("system"),
            Type.Literal("tool"),
            Type.Literal("user"),
          ],
          { description: nmgPrompts.source_actor_parameter_description },
        ),
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
      unsafe: Type.Optional(
        Type.Boolean({
          description:
            "Rust-unsafe-style escape hatch (docs §3.6): explicitly opt out of " +
            "the transient/instruction write policy (e.g. a genuine persistent " +
            "preference whose wording trips the transient-word filter). Secrets " +
            "are never bypassable.",
        }),
      ),
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
      boardSource: Type.Optional(
        Type.Object(
          {
            taskId: Type.String({
              description: "Task board channel the content came from",
            }),
            entryId: Type.String({
              description: "Task board entry the content came from",
            }),
          },
          {
            description: nmgPrompts.remember_board_source_parameter_description,
          },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "claim_outcome") {
        if (
          !params.memoryId ||
          !params.claimOutcome ||
          !params.claimOutcomeSource ||
          !params.semanticTaskId?.trim()
        ) {
          throw new Error(
            "action=claim_outcome requires memoryId, claimOutcome, claimOutcomeSource, and semanticTaskId",
          );
        }
        if (params.claimIndexes?.some((index) => !Number.isInteger(index))) {
          throw new Error("claimIndexes must contain only non-negative integers");
        }
        const sessionId = ctx.sessionManager.getSessionId();
        const evidenceSource =
          params.claimOutcomeSource === "user" || params.claimOutcomeSource === "tool"
            ? selectPiEvidenceSource(ctx.sessionManager, params.evidence, params.claimOutcomeSource)
            : undefined;
        if (
          (params.claimOutcomeSource === "user" || params.claimOutcomeSource === "tool") &&
          !evidenceSource
        ) {
          throw new Error(
            `claimOutcomeSource=${params.claimOutcomeSource} requires an exact matching evidence excerpt from the current Pi session`,
          );
        }
        const sourceLineage = evidenceSource?.sourceMessageId ?? params.claimSourceLineage?.trim();
        if (!sourceLineage) {
          throw new Error("claimOutcomeSource=task requires claimSourceLineage");
        }
        const activeGraphId =
          params.activeGraphId ??
          controllerShadow.latestActiveGraphIdForMemory(sessionId, params.memoryId) ??
          agentAttributionFlow.latestActiveGraphIdForMemories(sessionId, [params.memoryId]) ??
          undefined;
        const result = await invoke("recordClaimOutcomes", {
          semanticTaskId: params.semanticTaskId,
          activeGraphId,
          sessionId,
          projectDir: projectDirectory(),
          collectionOrigin: shadowCollectionOrigin(),
          votes: [
            {
              memoryId: params.memoryId,
              claimIndexes: params.claimIndexes,
              outcome: params.claimOutcome,
              source: params.claimOutcomeSource,
              sourceLineage,
              evidenceSource: evidenceSource
                ? {
                    actor: evidenceSource.actor,
                    content: evidenceSource.content,
                    sessionId,
                    sourceMessageId: evidenceSource.sourceMessageId,
                    sourceRef: evidenceSource.sourceRef,
                  }
                : undefined,
              weight: params.claimWeight,
            },
          ],
        });
        const insertedEvents = (result as { events?: unknown[] }).events ?? [];
        // Only independently attributable user/tool outcomes become evidence
        // targets. A model-authored task label may update its explicit posterior,
        // but cannot silently supervise the retrieval controller.
        if (
          insertedEvents.length > 0 &&
          (params.claimOutcomeSource === "user" || params.claimOutcomeSource === "tool")
        ) {
          await controllerShadow.verifiedClaimOutcome(
            activeGraphId,
            sessionId,
            params.memoryId,
            params.claimOutcome,
          );
        }
        return toolResult(
          result,
          "Explicit attributable claim outcome recorded. Retrieval or answer use alone was not treated as support.",
        );
      }
      if (params.action === "feedback") {
        const sessionId = ctx.sessionManager.getSessionId();
        const labels = {
          taskSuccess: params.taskSuccess,
          userCorrection: params.userCorrection,
          evidenceSufficient: params.evidenceSufficient,
          expansionUseful: params.expansionUseful,
          excessiveNoise: params.excessiveNoise,
          noMemoryNeeded: params.noMemoryNeeded,
          memoryMisleading: params.memoryMisleading,
          note: params.feedbackNote,
          semanticTaskId: params.semanticTaskId,
        };
        if (Object.values(labels).every((value) => value === undefined)) {
          throw new Error("action=feedback requires at least one label or feedbackNote");
        }
        // Pi's own natural shadow-events dataset is best-effort and only records
        // when the controller shadow is enabled. It does NOT gate online learning.
        let recorded = false;
        let shadowGraphId: string | null = null;
        try {
          shadowGraphId = params.activeGraphId ?? controllerShadow.latestActiveGraphId(sessionId);
          if (shadowGraphId) {
            recorded = await controllerShadow.feedback(shadowGraphId, sessionId, labels);
          }
        } catch {
          recorded = false;
        }
        // Online learning is DAEMON-OWNED (shared layer): forward thin. The
        // daemon resolves the staged graph (explicit activeGraphId, else the
        // session's latest) and runs the single observed-action update.
        let online: string;
        let daemonGraphId: string | null = null;
        try {
          const raw = await invoke("recordFeedback", {
            activeGraphId: params.activeGraphId,
            sessionId,
            taskSuccess: params.taskSuccess,
            userCorrection: params.userCorrection,
            evidenceSufficient: params.evidenceSufficient,
            expansionUseful: params.expansionUseful,
            excessiveNoise: params.excessiveNoise,
            noMemoryNeeded: params.noMemoryNeeded,
            memoryMisleading: params.memoryMisleading,
            note: params.feedbackNote,
          });
          const result = raw as
            | {
                trained?: boolean;
                reward?: number;
                loss?: number;
                activeGraphId?: string | null;
              }
            | null
            | undefined;
          daemonGraphId = result?.activeGraphId ?? null;
          online =
            result && result.trained
              ? ` Online router updated (reward=${result.reward}, loss=${result.loss?.toFixed(4)}).`
              : result
                ? " (no staged decision or no usable label; skipped)."
                : " (daemon unavailable; skipped).";
        } catch {
          online = " (online update skipped).";
        }
        // Any real feedback addressed the recall it names; nothing to clear here
        // (the affordance rides with recall output, it is not scheduled).
        return toolResult(
          {
            recorded,
            activeGraphId: params.activeGraphId ?? shadowGraphId ?? daemonGraphId,
          },
          `Retrieval feedback processed.${online}${recorded ? "" : " Shadow log not recorded (set NMG_CONTROLLER_SHADOW=1 to also record natural shadow events)."}`,
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
      if (params.action === "resolve" || params.action === "reopen") {
        if (!params.memoryId) throw new Error(`action=${params.action} requires memoryId`);
        const resolved = await invoke("resolveRemember", {
          action: params.action,
          memoryId: params.memoryId,
          relatedMemoryIds: params.relatedMemoryIds,
          reason: params.resolutionReason,
          projectDir: projectDirectory(),
          sessionId: ctx.sessionManager.getSessionId(),
        });
        return toolResult(
          resolved,
          params.action === "resolve"
            ? "Open memory marked resolved; it is now eligible for ordinary retention policy."
            : "Memory reopened and restored to indexed storage with its related evidence anchors.",
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
      const { externalSource, boardSource, ...memory } = params;
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
      delete memory.claimOutcome;
      delete memory.claimOutcomeSource;
      delete memory.claimSourceLineage;
      delete memory.claimIndexes;
      delete memory.claimWeight;
      if (externalSource && !/^(?:file|web):.+/u.test(externalSource.source)) {
        throw new Error("externalSource.source must start with web: or file:");
      }
      const sourceActor = params.sourceActor ?? "assistant";
      const evidenceResolution = resolvePiEvidenceSource(
        ctx.sessionManager,
        params.evidence,
        sourceActor,
      );
      const evidenceSource = evidenceResolution.source;
      if (sourceActor !== "assistant" && !evidenceSource && !externalSource) {
        throw new Error(
          `sourceActor=${sourceActor} requires an exact matching evidence excerpt from the current Pi session or an explicit externalSource`,
        );
      }
      const markers = [
        ...(externalSource
          ? [
              {
                kind: "external_source",
                attributes: {
                  source: externalSource.source,
                  retrievedAt: externalSource.retrievedAt ?? new Date().toISOString(),
                  ...(externalSource.hash ? { hash: externalSource.hash } : {}),
                },
              } as const,
            ]
          : []),
        ...(boardSource
          ? [
              {
                kind: "board_origin",
                attributes: {
                  taskId: boardSource.taskId,
                  entryId: boardSource.entryId,
                },
              } as const,
            ]
          : []),
        ...(params.evidence?.trim() && !evidenceSource && !externalSource
          ? [
              {
                kind: "provenance_degraded",
                attributes: {
                  provider: "pi",
                  historyReferenceVersion: evidenceResolution.version,
                  reason: evidenceResolution.reason ?? "unbound_source",
                },
              } as const,
            ]
          : []),
      ];
      const result = await invoke("remember", {
        ...memory,
        sourceActor,
        writeSource: "agent",
        evidenceSource,
        markers: markers.length ? markers : undefined,
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
      const sessionId = ctx.sessionManager.getSessionId();
      if (!recallFlow.allowGet(sessionId)) {
        return toolResult(
          { getSuppressed: true, reason: "recall_tool_budget_exhausted" },
          "Recall tool budget exhausted for this user turn. Answer from the evidence already loaded or state what remains uncertain.",
        );
      }
      const activeGraphId =
        params.activeGraphId ??
        agentAttributionFlow.latestActiveGraphIdForMemories(sessionId, params.memoryIds) ??
        undefined;
      const result = (await invoke("get", {
        ...params,
        activeGraphId,
        projectDir: projectDirectory(),
        sessionId,
      })) as MemoryContext;
      recallFlow.recordGet(
        sessionId,
        result.results.map((entry) => entry.memory.id),
      );
      await controllerShadow.disclosure(
        activeGraphId,
        sessionId,
        params.memoryIds,
        result.results.map((entry) => entry.memory.id),
      );
      agentAttributionFlow.note(ctx.sessionManager.getSessionId(), result);
      const text = await formatDisclosedContext(
        ctx.sessionManager.getSessionId(),
        result,
        "evidence",
      );
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
      recallCue: Type.Optional(
        Type.String({ description: nmgPrompts.search_recall_cue_parameter_description }),
      ),
      recallRevision: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: nmgPrompts.search_recall_revision_parameter_description,
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
        const reason = recallFlow.searchBlockReason(sessionId);
        return toolResult(
          { searchSuppressed: true, reason },
          nmgPrompts.search_progression_required,
        );
      }
      const { recallCue, recallRevision, ...searchParams } = params;
      const baseParams = {
        ...searchParams,
        // Unknown model-supplied properties cannot impersonate a native observation.
        recallSource: undefined,
        // Automatic recall remains shallow. An explicit search is the agent's
        // request to look beyond that cache, so expose all tiers by default;
        // result/token budgets still bound what is returned.
        maxTier: params.maxTier ?? 3,
        projectDir: projectDirectory(),
        sessionId,
      };
      let activeGraphBudget: ActiveGraphBudget | undefined;
      if (qpp1Mode === "active" && params.limit === undefined) {
        const probe = (await invoke("search", {
          ...baseParams,
          limit: 20,
          secondPass: false,
          persistTrace: false,
        })) as MemoryContext;
        const envelopes = controllerBudgetEnvelopes(probe);
        activeGraphBudget = (
          await controllerShadow.allocate(
            probe,
            envelopes.minimum,
            envelopes.normalMaximum,
            envelopes.expandedMaximum,
          )
        )?.budget;
      }
      let result = (await invoke("search", {
        ...baseParams,
        ...searchCueParams(sessionId, recallCue, recallRevision),
        secondPass: params.secondPass ?? qpp2Mode === "active",
        ...(activeGraphBudget ? { activeGraphBudget, limit: activeGraphBudget.maxEvidence } : {}),
      })) as MemoryContext;
      if (controllerRerankMode === "active") {
        result = await controllerShadow.rerank(result);
      }
      const fullResult = result;
      if (qpp2Mode === "active") {
        result = await applyLearnedFold(
          result,
          controllerShadow,
          qpp2RetainedMass,
          params.limit !== undefined,
        );
      }
      recallFlow.recordSearch(
        sessionId,
        result.results.map((entry) => entry.memory.id),
      );
      const text = await formatDisclosedContext(sessionId, result, "header");
      const surfaced = [text, recallFeedbackAffordance(fullResult.activeGraph?.id)]
        .filter(Boolean)
        .join("\n");
      await controllerShadow.retrieval(fullResult, sessionId, "tool", surfaced);
      agentAttributionFlow.note(sessionId, fullResult);
      return toolResult(result, surfaced);
    },
  });

  const invokeStateBoard = async (params: Record<string, unknown>) => {
    const operation = String(params.action);
    const action = (STATE_BOARD_READ_OPERATIONS as readonly string[]).includes(operation)
      ? "read"
      : "write";
    const result = (await invoke("state", {
      ...params,
      action,
      space: "board",
      operation,
    })) as NmgStateResult;
    return result.result;
  };

  async function renameBoardAgent(
    sessionId: string,
    agentId: string,
    agentName: string,
    requestedName?: string,
  ) {
    const newName = String(requestedName ?? "").trim();
    if (!newName) {
      return toolResult(
        { action: "rename", agentName, id: agentId },
        `当前 agent 名：${agentName}（id=${agentId}）。用法：nmg_state action=write space=board operation=rename agentName=<新名>`,
      );
    }
    const anchor = process.env.NMG_AGENT_ID?.trim() || sessionId || `pi:${process.pid}`;
    renameAgentIdentity({ anchor, id: agentId, agentName: newName });
    const result = (await invokeStateBoard({
      action: "rename",
      id: agentId,
      agentName: newName,
    })) as { action: "rename"; agentName: string; id: string };
    return toolResult(
      result,
      `已改名：${result.agentName}（id=${result.id}）——reload 后保持；定向 to= 可用新名或 id。`,
    );
  }

  const boardParameters = Type.Object({
    action: Type.Union(
      PI_BOARD_ACTIONS.map((action) => Type.Literal(action)),
      { description: nmgPrompts.board_action_parameter_description },
    ),
    taskId: Type.Optional(
      Type.String({
        description: nmgPrompts.board_task_id_parameter_description,
      }),
    ),
    content: Type.Optional(
      Type.String({
        description: nmgPrompts.board_content_parameter_description,
      }),
    ),
    kind: Type.Optional(
      Type.Union([
        Type.Literal("blocker"),
        Type.Literal("decision"),
        Type.Literal("goal"),
        Type.Literal("handoff"),
        Type.Literal("note"),
        Type.Literal("question"),
        Type.Literal("result"),
      ]),
    ),
    entryId: Type.Optional(Type.String()),
    resolution: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    leaseSeconds: Type.Optional(Type.Number({ minimum: 60, maximum: 86_400 })),
    digest: Type.Optional(
      Type.String({
        description:
          "deliver only: the sha256 identity of the artifact you are handing in; the judge recomputes it",
      }),
    ),
    ref: Type.Optional(
      Type.String({
        description:
          "deliver only: where the artifact can be read (a path or URL the judge can open)",
      }),
    ),
    summary: Type.Optional(
      Type.String({
        description: "deliver only: what the artifact contains, in one line",
      }),
    ),
    verdict: Type.Optional(
      Type.Union(
        TASK_BOARD_VERDICTS.map((value) => Type.Literal(value)),
        {
          description:
            "judge only: your ruling on someone else's deliverable. The deliverer can never judge it",
        },
      ),
    ),
    afterCursor: Type.Optional(
      Type.String({
        description: "不透明游标：上一条已读 entry 的 id（增量读续点）",
      }),
    ),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    includeResolved: Type.Optional(Type.Boolean()),
    ttlSeconds: Type.Optional(Type.Number({ minimum: 60, maximum: 2_592_000 })),
    // A2A find→direct: put with to=<stable agent_name> wakes only that
    // agent's LLM (others read-but-stay-silent). discover lists online
    // agents so the caller can pick a to= target.
    to: Type.Optional(
      Type.String({
        description:
          "定向投递：stable agent_name 只唤醒该 agent；其他订阅者 read 可见但静默（需先 discover 选人）",
      }),
    ),
    need: Type.Optional(Type.String({ description: "discover 的找人需求描述（可选）" })),
    capabilities: Type.Optional(
      Type.String({
        description: "discover 按能力过滤（可选，如 'stg,audit'）",
      }),
    ),
    agentName: Type.Optional(
      Type.String({
        description: "rename 的新显示名（id 不变，reload 后保持）",
      }),
    ),
  });
  const boardTool = defineTool({
    name: "nmg_board",
    label: "NMG Task Board",
    description: nmgPrompts.board_description,
    parameters: boardParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      // Identity chain: explicit NMG_AGENT_ID wins, then the session id (stable
      // across a session), then the pid as a last resort. A pid alone would
      // change every launch and fragment cross-session attribution.
      const identity = loadOrCreateAgentIdentity(sessionId, "pi");
      const agentId = identity.id;
      const agentName = identity.agentName;
      assertBoardVerbCall(params);
      // taskId is optional: without one, entries land on the shared world
      // channel (the lobby), which every Agent reads by default — no channel
      // name needs to be agreed on in advance. Explicit taskIds open named
      // channels that are surfaced in the world channel's lobby.
      const taskId = params.taskId?.trim() || WORLD_BOARD_ID;
      // Runtime rename: change this agent's display name (id unchanged — it is
      // the stable routing key). Persisted in the per-agent identity file so
      // it survives reload; mirrored to the registry so discover shows it.
      if (params.action === "rename") {
        return renameBoardAgent(sessionId, agentId, agentName, params.agentName);
      }
      // Unsubscribe/subscribe are session-scoped (whether THIS session keeps
      // getting wake notices for a channel), handled apart from entry reads.
      // Topic-based membership: subscribe joins a channel (named channels only
      // notify their members), unsubscribe leaves it. The world channel is the
      // default member channel; unsubscribe there mutes the world channel.
      if (params.action === "unsubscribe" || params.action === "subscribe") {
        const result = (await invokeStateBoard({
          action: params.action,
          taskId,
          sessionId,
          agentId,
        })) as { action: "unsubscribe" | "subscribe"; taskId: string };
        return toolResult(
          result,
          params.action === "unsubscribe"
            ? `已退出频道 ${result.taskId}：不再接收该频道新条目的唤醒通知（用 nmg_state action=write space=board operation=subscribe 重新加入）。`
            : `已加入频道 ${result.taskId}：接收该频道新条目的唤醒通知（未订阅的频道不会打扰你）。`,
        );
      }
      const result = (await invokeStateBoard({
        ...params,
        taskId,
        agentId,
        sourceSessionId: sessionId,
      })) as TaskBoardToolResult;
      const entries = result.entries ?? (result.entry ? [result.entry] : []);
      if (result.action === "read") {
        const projectedEntries = contextBoardEntries(entries, params.includeResolved === true);
        await Promise.allSettled(
          projectedEntries.map((entry) =>
            invoke("sessionActiveGraph", {
              action: "observe",
              sessionId,
              kind: "board_projection",
              sourceId: `board:${taskId}:${entry.id}`,
              nodeId: `board:${taskId}`,
              statement: `[task-board ${taskId} #${entry.id} ${entry.kind} by ${entry.agentId}] ${entry.content}`,
            }),
          ),
        );
        if (projectedEntries.length > 0) {
          await invoke("sessionActiveGraph", {
            action: "activate",
            sessionId,
          }).catch(() => undefined);
        }
        // Reading is a delivery: write a receipt for every open, non-own-echo
        // entry returned, so the wake loop does not re-push entries this
        // session has already seen (flow constraint — 'already read' never
        // re-wakes, per cross-agent feedback on world #9). Same echo boundary
        // as the loop: the poster's own entries are never pushed anyway.
        // await allSettled so receipts are durable before the read returns;
        // a transient failure just risks one extra push (at-least-once).
        const receipts = entries
          .filter((entry) => {
            if (entry.status !== "open") return false;
            return !(
              entry.sourceSessionId === sessionId ||
              (entry.sourceSessionId == null && entry.agentId === agentId)
            );
          })
          .map((entry) =>
            invoke("taskBoard", {
              action: "recordDelivery",
              entryId: entry.id,
              sessionId,
              agentId,
              source: "read",
            }),
          );
        await Promise.allSettled(receipts);
      }
      // Reading the world channel surfaces the lobby: the directory of active
      // named channels, so an Agent that knows no channel name can discover
      // and join one.
      let directory: Array<{
        taskId: string;
        entryCount: number;
        lastUpdatedAt: string;
      }> = [];
      if (result.action === "read" && taskId === WORLD_BOARD_ID) {
        const lobby = (await invokeStateBoard({ action: "list", agentId })) as {
          action: "list";
          boards: Array<{
            taskId: string;
            entryCount: number;
            lastUpdatedAt: string;
          }>;
        };
        directory = lobby.boards ?? [];
      }
      return toolResult(result, formatTaskBoardResult(result, taskId, directory));
    },
  });

  pi.registerTool({
    name: "nmg_state",
    label: "NMG state",
    description: nmgPrompts.state_description,
    parameters: Type.Object({
      ...boardParameters.properties,
      action: Type.Union([Type.Literal("read"), Type.Literal("write")]),
      space: Type.Union([Type.Literal("ag"), Type.Literal("board")]),
      operation: Type.Optional(Type.String()),
      notification: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            "Explicit notice: key, scopes [direct|channel|event], optional recipients (stable IDs), invite:true to subscribe invitees and sender to taskId. Reuse key on retries.",
        }),
      ),
      eventId: Type.Optional(Type.String()),
      event: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      text: Type.Optional(Type.String()),
    }),
    async execute(id, args, signal, onUpdate, ctx) {
      const operation = stateOperation(args);
      if (args.space === "ag") {
        const sessionId = ctx.sessionManager.getSessionId();
        const active = await connection();
        const captured = await captureStateInvocation(
          {
            action: args.action,
            space: "ag",
            operation,
            text: args.text,
            reason: args.reason,
            ttlSeconds: args.ttlSeconds,
            sessionId,
            requester: "agent:pi",
          },
          (sessionId) =>
            invokeDaemon(active, "state", {
              action: "read",
              space: "ag",
              operation: "status",
              sessionId,
            }),
        );
        const result = (await invokeDaemon(active, "state", captured)) as NmgStateResult;
        const details = {
          ...result,
          ...(result.result.action === "invoke" ? { output: result.result.output } : {}),
          workingStateBinding: captured.workingStateBinding,
        };
        return toolResult(details, renderStateOutput(result));
      }
      if (!coordinationToolsEnabled) throw new Error("Board coordination is disabled");
      if (COORDINATION_OPERATIONS.has(operation)) {
        const sessionId = ctx.sessionManager.getSessionId();
        const identity = loadOrCreateAgentIdentity(sessionId);
        const result = (await invoke("state", {
          ...args,
          operation,
          agentId: identity.id,
          sessionId,
          sourceSessionId: sessionId,
        })) as NmgStateResult;
        return toolResult(result, renderStateOutput(result));
      }
      return boardTool.execute(
        id,
        {
          ...args,
          action: operation as Static<typeof boardParameters>["action"],
        },
        signal,
        onUpdate,
        ctx,
      );
    },
  });

  // ---- Board wake loop ----------------------------------------------
  // Notification for an idle Agent: poll the subscribed spaces (the world
  // channel plus active named channels), and when a new open entry appears
  // that has not already been surfaced, wake the Agent with a broadcast-style
  // pi.sendUserMessage ("your subscribed channel has a new question") — never
  // addressing a specific recipient. This is the notification half of the
  // claim+notify design: claims decide who works, notifications decide who
  // knows. Enabled and tuned via ~/.nmg/board-wake.json (edited by hand or
  // toggled with /nmg, which persists to the same file); dedup state is
  // kept in board-wake-state.json. Coordination is available by default and
  // this second-layer switch can explicitly silence automatic wake delivery.
  // Config/state persistence, the budget gate, candidate collection, delivery
  // filtering, and world broadcasts live in src/integration/board-wake.ts —
  // the adapter only binds its transport and emission primitives.
  const wakeInvoke = invoke as (method: string, params: unknown) => Promise<unknown>;

  // Live session gate: a captured ctx goes stale after session replacement/
  // reload; isIdle and getSessionId on a stale ctx throw, which must never
  // crash the host. Returns the session id, or "" to skip this tick.
  const liveSessionId = (): string => {
    try {
      if (latestAgentCtx?.isIdle && !latestAgentCtx.isIdle()) return "";
      return latestAgentCtx?.sessionManager.getSessionId() ?? "";
    } catch {
      return ""; // stale ctx — skip this tick, retry later
    }
  };

  const scanBoardWake = async (): Promise<void> => {
    const config = readWakeConfig();
    const state = loadWakeState();
    const now = Date.now();
    if (!wakeBudgetGate(config, state, now)) return;
    const sessionId = liveSessionId();
    if (!sessionId) return;
    const identity = loadOrCreateAgentIdentity(sessionId, "pi");
    const agentId = identity.id;
    const agentName = identity.agentName;
    // System-layer identity heartbeat (A2A AgentCard local edition): refresh
    // this agent's registry row each tick so discover() can find it. Never
    // wakes an LLM — the registry is read on demand via discover. Capabilities
    // come from NMG_AGENT_CAPABILITIES (comma-separated) when set.
    try {
      await invoke("taskBoard", {
        action: "registerAgent",
        id: identity.id,
        agentName: identity.agentName,
        capabilities: process.env.NMG_AGENT_CAPABILITIES?.trim() || undefined,
        supportedInterfaces: "pi",
      });
    } catch {
      // best-effort: a daemon without the registerAgent method just skips it.
    }
    try {
      const candidates = await collectWakeCandidates(wakeInvoke, {
        agentId,
        agentName,
        sessionId,
      });
      if (candidates.length === 0) return;
      const fresh = await filterUndelivered(wakeInvoke, candidates, { agentId, sessionId });
      if (fresh.length === 0) return;
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
        invoke: wakeInvoke,
        sendWake: (message: string) => pi.sendUserMessage(message),
        config,
        state,
        dataDir: wakeDataDir,
        now,
        agentId,
        sessionId,
        entry: fresh[0]!,
      });
    } catch {
      // daemon unavailable or transient failure — retry next tick
    }
  };
  // Wake 配置/开关通过总菜单 /nmg wake ... 操作（见 /nmg 命令注册），
  // 写入 board-wake.json，与手改文件等价、重启保留。
  // Re-arm with the configured interval so a hand edit to intervalMs applies.
  // unref() keeps the timer from pinning the process alive — pi is resident so
  // the loop still fires there, while test harnesses that load the extension
  // can exit normally.
  const wakeLoop = (): void => {
    void scanBoardWake()
      .catch(() => {
        // never leak an unhandled rejection from the background wake loop
      })
      .finally(() => {
        setTimeout(wakeLoop, readWakeConfig().intervalMs).unref();
      });
  };
  if (coordinationToolsEnabled) setTimeout(wakeLoop, readWakeConfig().intervalMs).unref();
}

const EVIDENCE_SOURCE_WINDOW = 64;
export const PI_BRANCH_SHAPE_VERSION = "pi.branch.v1" as const;

export type PiEvidenceResolutionReason =
  "branch_api_unavailable" | "exact_excerpt_not_found" | "incompatible_branch_shape";

export interface PiEvidenceResolution {
  version: typeof PI_BRANCH_SHAPE_VERSION;
  source?: SelectedEvidence;
  reason?: PiEvidenceResolutionReason;
}

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
    const candidate = entry as {
      type?: unknown;
      id?: unknown;
      message?: unknown;
    };
    if (candidate.type !== "message") continue;
    if (
      typeof candidate.id !== "string" ||
      !candidate.message ||
      typeof candidate.message !== "object" ||
      typeof (candidate.message as { role?: unknown }).role !== "string"
    ) {
      return {
        version: PI_BRANCH_SHAPE_VERSION,
        supported: false,
        messages: [],
      };
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
  return resolvePiEvidenceSource(sessionManager, evidence, sourceActor).source;
}

/** Prefer Pi's stable user-message id over prompt text. A repeated user prompt
 * is still a new turn, while tool-loop re-entry keeps the same message id. */
export function piUserTurnKey(
  sessionManager: { getBranch?: () => unknown[] },
  prompt: string,
): string {
  if (typeof sessionManager.getBranch !== "function") return `prompt:${prompt}`;
  const branch = sessionManager.getBranch();
  if (!Array.isArray(branch)) return `prompt:${prompt}`;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as
      { type?: unknown; id?: unknown; message?: { role?: unknown } } | undefined;
    if (
      entry?.type === "message" &&
      entry.message?.role === "user" &&
      typeof entry.id === "string"
    ) {
      return `message:${entry.id}`;
    }
  }
  return `prompt:${prompt}`;
}

export function resolvePiEvidenceSource(
  sessionManager: {
    getSessionId(): string;
    getBranch?: () => unknown[];
  },
  evidence: string | undefined,
  sourceActor: "assistant" | "system" | "tool" | "user",
): PiEvidenceResolution {
  if (!evidence?.trim()) return { version: PI_BRANCH_SHAPE_VERSION };
  if (typeof sessionManager.getBranch !== "function") {
    return {
      version: PI_BRANCH_SHAPE_VERSION,
      reason: "branch_api_unavailable",
    };
  }
  const branch = projectPiBranch(sessionManager.getBranch());
  if (!branch.supported) {
    return { version: branch.version, reason: "incompatible_branch_shape" };
  }
  const source = selectEvidence(evidence, sourceActor, {
    sessionId: sessionManager.getSessionId(),
    sourceRef: `pi-session:${sessionManager.getSessionId()};shape=${branch.version}`,
    messages: branch.messages,
  });
  return source
    ? { version: branch.version, source }
    : { version: branch.version, reason: "exact_excerpt_not_found" };
}

function piHistoryMessage(value: unknown): AgentHistoryMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as {
    type?: unknown;
    id?: unknown;
    message?: { role?: unknown; content?: unknown; isError?: unknown };
  };
  if (entry.type !== "message" || typeof entry.id !== "string" || !entry.message) {
    return undefined;
  }
  if (entry.message.role === "toolResult" && entry.message.isError !== false) return undefined;
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

type DisclosureLevel = "header" | "exact" | "evidence";

const nmgPrompts = loadPrompts();
export const SKILLOPT_POLICY_CHANNELS = resolveSkillOptPolicyChannels(nmgPrompts.memory_policy);
export const MEMORY_POLICY = `<nmg_policy>\n${SKILLOPT_POLICY_CHANNELS.agent.text}\n</nmg_policy>`;

/**
 * Stable prefix only: base system prompt + static memory policy.
 *
 * Per-turn dynamic context (automatic recall, runtime AG, nudges) must NOT
 * live here: the system prompt is the head of the provider's cached prefix,
 * so any per-turn change invalidates the entire prefix (re-billing the full
 * conversation, e.g. "Cache miss: 166k tokens re-billed"). Dynamic content is
 * injected as a trailing custom message via `composeNmgContextMessage` instead,
 * keeping this prefix byte-stable across turns.
 */
export function composeNmgSystemPrompt(baseSystemPrompt: string): string {
  return [baseSystemPrompt, MEMORY_POLICY].filter(Boolean).join("\n\n");
}

/**
 * Per-turn dynamic context, injected as a custom message AFTER the current user
 * prompt. History is append-only here; preparation does not prove provider
 * transmission, cache retention or billing.
 */
export function composeNmgContextMessage(views: readonly InformationView[] = []): string {
  return prepareInformationOutput(views, { format: "context" }).text;
}

function persistedContextResult(output: PreparedInformationOutput, systemPrompt: string) {
  const count = output.included.filter((entry) => entry.source.kind === "memory").length;
  return {
    systemPrompt: composeNmgSystemPrompt(systemPrompt),
    ...(output.text
      ? {
          message: {
            customType: "nmg-context",
            content: output.text,
            display: true,
            details: { count, omitted: output.omitted.length },
          },
        }
      : {}),
  };
}

export function controllerBudgetEnvelopes(context: MemoryContext): {
  minimum: ActiveGraphBudget;
  normalMaximum: ActiveGraphBudget;
  expandedMaximum: ActiveGraphBudget;
} {
  const base = context.activeGraph?.budget;
  const fallback: ActiveGraphBudget = {
    maxNodes: 8,
    maxEdges: 12,
    maxEvidence: 8,
    maxTokens: 2_000,
    maxGraphHops: 1,
    maxLocalTier: 3,
    maxTierBudget: 3,
    maxLatencyMs: 250,
  };
  const current = base ?? fallback;
  const minimum: ActiveGraphBudget = {
    ...current,
    maxNodes: Math.min(current.maxNodes, 4),
    maxEdges: Math.min(current.maxEdges, 6),
    maxEvidence: 1,
    maxTokens: Math.min(current.maxTokens, 512),
    maxTierBudget: Math.min(current.maxTierBudget, 1),
  };
  const normalMaximum: ActiveGraphBudget = {
    ...current,
    maxNodes: Math.max(current.maxNodes, 20),
    maxEdges: Math.max(current.maxEdges, 32),
    maxEvidence: Math.max(current.maxEvidence, 20),
    maxTokens: Math.max(current.maxTokens, 6_000),
    maxTierBudget: Math.max(current.maxTierBudget, 20),
  };
  const expandedMaximum: ActiveGraphBudget = {
    ...normalMaximum,
    maxNodes: 50,
    maxEdges: 100,
    maxEvidence: 50,
    maxTokens: 10_000,
    maxGraphHops: Math.max(normalMaximum.maxGraphHops, 2),
    maxTierBudget: 50,
    maxLatencyMs: Math.max(normalMaximum.maxLatencyMs, 500),
  };
  return { minimum, normalMaximum, expandedMaximum };
}

export async function applyLearnedFold(
  context: MemoryContext,
  controller: Pick<ControllerShadowBridge, "fold">,
  retainedMass: number,
  explicitLimit: boolean,
): Promise<MemoryContext> {
  if (explicitLimit) return context;
  const fold = await controller.fold(context, retainedMass);
  if (!fold || fold.foldedMemoryIds.length === 0) return context;
  const visible = new Set(fold.visibleMemoryIds);
  return {
    ...context,
    results: context.results.filter((result) => visible.has(result.memory.id)),
    progressiveDisclosure: {
      strategy: "learned_retained_mass",
      rankedWarmCandidates: context.results.length,
      initiallyVisible: visible.size,
      deferredMemoryIds: fold.foldedMemoryIds,
    },
  };
}

export function formatSearchRecommendation(
  context: MemoryContext,
  mode: SearchRecommendationMode,
): string {
  const qpp = context.activeGraph?.qpp;
  if (mode === "off" || !qpp?.trigger) return "";
  if (mode === "guardrail" && !qpp.reason.startsWith("guardrail_")) return "";
  return nmgPrompts.search_recommendation;
}

export function formatSearchHeaders(context: MemoryContext): string {
  const nextStep = formatProgressiveDisclosure(context) || nmgPrompts.get_hint;
  return renderSearchSurface(context, {
    preamble: renderDisclosure(nmgPrompts.search_disclosure, {}),
    postamble: renderDisclosure(nmgPrompts.search_disclosure_metadata, {
      count: String(context.results.length),
      next_step: nextStep,
      forget_hint: hasForgetMarker(context) ? nmgPrompts.forget_hint : "",
    }),
  });
}

function hasForgetMarker(context: MemoryContext): boolean {
  return (context.results ?? []).some((result) =>
    (result.memory.markers ?? []).some((marker) => marker.kind === "forget"),
  );
}

function formatProgressiveDisclosure(context: MemoryContext): string {
  const disclosure = context.progressiveDisclosure;
  if (!disclosure || disclosure.deferredMemoryIds.length === 0) return "";
  return `${nmgPrompts.deferred_hint} Memory IDs: ${disclosure.deferredMemoryIds.join(",")}`;
}

function formatActiveGraph(context: MemoryContext): string {
  return context.activeGraph ? `activeGraphId=${context.activeGraph.id}` : "";
}

interface MemoryContextFormatOptions {
  /** Independent budget for compact logical structure. Evidence text is never
   * truncated to make room for it. */
  logicalChainMaxChars?: number;
}

export function formatMemoryContext(
  context: MemoryContext,
  options: MemoryContextFormatOptions = {},
): string {
  return renderEvidenceSurface(context, {
    preamble: renderDisclosure(nmgPrompts.get_disclosure, {}),
    postamble: renderDisclosure(nmgPrompts.get_disclosure_metadata, {
      count: String(context.results.length),
      next_step: formatProgressiveDisclosure(context) || "",
      forget_hint: hasForgetMarker(context) ? nmgPrompts.forget_hint : "",
    }),
    logicalChainMaxChars: options.logicalChainMaxChars,
  });
}

function toolResult(details: unknown, text: string) {
  return { content: [{ type: "text" as const, text }], details };
}

function formatTaskBoardResult(
  result: TaskBoardToolResult,
  taskId: string,
  directory: Array<{
    taskId: string;
    entryCount: number;
    lastUpdatedAt: string;
  }> = [],
): string {
  return renderTaskBoardSurface(result, { taskId, directory });
}

function formatRememberResult(value: unknown): string {
  return renderRememberSurface(value as Parameters<typeof renderRememberSurface>[0]);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
