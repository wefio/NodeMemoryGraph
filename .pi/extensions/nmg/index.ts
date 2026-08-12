import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  connectDaemon,
  invokeDaemon,
  shutdownOwnedDaemon,
  type DaemonConnection,
} from "../../../src/cli/daemon-client.ts";
import { resolveNmgDataDir } from "../../../src/cli/data-path.ts";
import {
  archiveOrStage,
  archiveNodeName,
  archiveStatement,
  flushArchives,
  stagingDirFor,
} from "../../../src/cli/archive-staging.ts";
import { loadPrompts, renderDisclosure } from "../../../src/prompts/load.ts";
import { resolveSkillOptLabPolicy } from "../../../src/lab/skillopt-policy.ts";
import type {
  ActiveGraphBudget,
  MemoryContext,
  MemorySearchResult,
  MemoryTier,
} from "../../../src/core/types.ts";
import { WORLD_BOARD_ID } from "../../../src/core/types.ts";
import {
  configuredQpp1Mode,
  configuredQpp2Mode,
  configuredQpp2RetainedMass,
  configuredSearchRecommendationMode,
  type SearchRecommendationMode,
} from "../../../src/integration/config.ts";
import { searchPreview } from "../../../src/integration/search-projection.ts";
import { selectEvidence, type AgentHistoryMessage } from "../../../src/integration/evidence.ts";
import { ControllerShadowBridge, shadowEnabled } from "./controller-shadow.ts";

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

export default function nmgExtension(pi: ExtensionAPI): void {
  let connectionPromise: Promise<DaemonConnection> | undefined;
  const injectionWindow = new SessionInjectionWindow();
  const taskWindow = new SessionTaskWindow();
  const recallFlow = new SessionRecallFlow();
  const runtimeAg = new SessionRuntimeAg();
  const qpp1Mode = configuredQpp1Mode();
  const qpp2Mode = configuredQpp2Mode();
  const qpp2RetainedMass = configuredQpp2RetainedMass();
  const recommendationMode = configuredSearchRecommendationMode();
  const controllerShadow = new ControllerShadowBridge(
    resolveNmgDataDir(),
    shadowEnabled() || qpp1Mode !== "off" || qpp2Mode !== "off",
  );
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
    method: "get" | "remember" | "resolveRemember" | "search" | "taskBoard",
    params: Record<string, unknown>,
  ) => invokeDaemon(await connection(), method, params);

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
    runtimeAg.note(sessionId, event.toolName, summarizeToolResult(event).statement);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    injectionWindow.beginTurn(sessionId);
    const isNewUserTurn = recallFlow.beginTurn(sessionId, event.prompt);
    const completionNudge = popCompletionNudge(event.prompt);
    // Pi re-enters before_agent_start after tool results. A completed graph may
    // already exist at that point, but it must be reviewed on the next user
    // turn, not consumed by an internal tool loop from the same prompt.
    const pendingFeedback = isNewUserTurn ? controllerShadow.pendingFeedback(sessionId) : null;
    if (pendingFeedback) await controllerShadow.feedbackNudgeShown(sessionId, pendingFeedback);
    const feedbackNudge = pendingFeedback
      ? renderDisclosure(nmgPrompts.shadow_feedback_nudge, {
          active_graph_id: pendingFeedback.activeGraphId,
          semantic_task_id: pendingFeedback.semanticTaskId,
        })
      : "";
    const nudge = [completionNudge, feedbackNudge].filter(Boolean).join("\n");
    const runtimeContext = runtimeAg.format(sessionId);
    const recallQuery = taskWindow.prepare(sessionId, event.prompt);
    const dynamicContext = composeNmgContextMessage("", "", nudge, runtimeContext);
    if (!recallQuery) {
      return {
        systemPrompt: composeNmgSystemPrompt(event.systemPrompt),
        ...(dynamicContext
          ? {
              message: {
                customType: "nmg-context",
                content: dynamicContext,
                display: true,
                details: { count: 0 },
              },
            }
          : {}),
      };
    }
    try {
      let context = (await invoke("search", {
        query: recallQuery,
        projectDir: projectDirectory(),
        sessionId,
        maxTier: configuredAutoRecallTier(),
        limit: configuredAutoRecallLimit(),
        initialEvidenceTarget: configuredInitialTarget(),
        strongHitTopGap: configuredStrongHitTopGap(),
        strongHitInitialTarget: configuredStrongHitInitialTarget(),
        secondPass: qpp2Mode === "active",
        graphHops: 1,
        tieredDisclosure: true,
      })) as MemoryContext;
      const fullContext = context;
      if (qpp2Mode === "active") {
        context = await applyLearnedFold(context, controllerShadow, qpp2RetainedMass, false);
      }
      const recalled = injectionWindow.format(sessionId, context, "header");
      await controllerShadow.retrieval(fullContext, sessionId, "automatic", recalled);
      const recordCount = (recalled.match(/memory=/g) ?? []).length;
      const searchNudge = formatSearchRecommendation(context, recommendationMode);
      const recallContext = composeNmgContextMessage(
        recalled,
        "",
        [nudge, searchNudge].filter(Boolean).join("\n"),
        runtimeContext,
      );
      return {
        systemPrompt: composeNmgSystemPrompt(event.systemPrompt),
        ...(recallContext
          ? {
              message: {
                customType: "nmg-context",
                content: recallContext,
                display: true,
                details: { count: recordCount },
              },
            }
          : {}),
      };
    } catch (error) {
      const errorContext = composeNmgContextMessage(
        "",
        `NMG unavailable: ${message(error)}`,
        nudge,
        runtimeContext,
      );
      return {
        systemPrompt: composeNmgSystemPrompt(event.systemPrompt),
        ...(errorContext
          ? {
              message: {
                customType: "nmg-context",
                content: errorContext,
                display: true,
                details: { count: 0 },
              },
            }
          : {}),
      };
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
  const nmgMenuHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const [sub, ...rest] = parts;
    const restText = rest.join(" ");
    switch (sub) {
      case "recall": {
        recallCollapsed = !recallCollapsed;
        ctx.ui.notify(
          recallCollapsed
            ? "nmg-context 已折叠（只显示 [nmg-context] chip）"
            : "nmg-context 已展开（显示召回全文）",
          "info",
        );
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
            ctx.ui.notify(
              `黑板唤醒预算已设为 ${budget === 0 ? "不限制" : `${budget}/天`}`,
              "info",
            );
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
  const nmgInteractiveMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
      ctx.ui.notify(
        "当前模式不支持交互菜单，可用：/nmg recall、/nmg wake on|off|status|budget N|cooldown M|interval S",
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
    if (choice.startsWith("唤醒：参数设置")) {
      // 挡位选择（select 预设值，避免随意输入溢出/无效）；自由数字只走命令形式
      // （/nmg wake budget N 等，已有 clamp）。
      const param = await ctx.ui.select("唤醒参数", ["每日上限", "冷却", "轮询"]);
      if (!param) return;
      const current = readWakeConfig();
      if (param === "每日上限") {
        const option = await ctx.ui.select("每日唤醒上限", ["不限制", "3/天", "8/天", "15/天"]);
        if (!option) return;
        const budget = option === "不限制" ? 0 : Number(option.split("/")[0]);
        writeWakeConfig({ ...current, budget });
        ctx.ui.notify(
          `黑板唤醒预算已设为 ${budget === 0 ? "不限制" : `${budget}/天`}`,
          "info",
        );
      } else if (param === "冷却") {
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
      } else if (param === "轮询") {
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
      }
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
      `唤醒：参数设置（预算 ${budgetText} · 冷却 ${cooldownText} · 轮询 ${Math.round(wake.intervalMs / 1_000)} 秒 · 世界广播 ${wake.worldBroadcast ? "开" : "关"}）`,
      "查看状态",
    ];
  };
  pi.registerCommand("nmg", {
    description: "NMG 菜单：/nmg recall · wake on/off/status · wake budget N · wake cooldown M · wake interval S",
    getArgumentCompletions: (prefix) => {
      const items: AutocompleteItem[] = [
        { value: "recall", label: "recall", description: "切换 nmg-context 召回折叠/展开" },
        { value: "wake", label: "wake", description: "黑板唤醒开关/配置" },
        { value: "wake on", label: "wake on", description: "开启黑板唤醒" },
        { value: "wake off", label: "wake off", description: "关闭黑板唤醒" },
        { value: "wake status", label: "wake status", description: "显示唤醒配置" },
        { value: "wake budget ", label: "wake budget N", description: "每日唤醒上限（0=不限制）" },
        { value: "wake cooldown ", label: "wake cooldown M", description: "冷却分钟（0=无）" },
        { value: "wake interval ", label: "wake interval S", description: "轮询秒（最小 5）" },
        {
          value: "wake world",
          label: "wake world",
          description: "切换世界频道协作广播（1/0 开/关）",
        },
      ];
      const normalized = prefix.trim();
      return items.filter((item) => item.value.startsWith(normalized));
    },
    handler: nmgMenuHandler,
  });

  pi.on("session_start", async (_event, ctx) => {
    latestAgentCtx = ctx;
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
    latestAgentCtx = ctx;
    await controllerShadow.outcome(ctx.sessionManager.getSessionId(), event.messages);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    injectionWindow.clear(sessionId);
    taskWindow.clear(sessionId);
    recallFlow.clear(sessionId);
    runtimeAg.clear(sessionId);
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

  pi.on("session_before_compact", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    injectionWindow.clear(sessionId);
    runtimeAg.activateProjection(sessionId);
    // Pi owns conversational compaction. The runtime AG remains in memory and
    // is injected again on the next turn; compaction alone never promotes
    // temporary state into durable NMG storage.
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
            Type.Literal("resolve"),
            Type.Literal("reopen"),
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
      const sourceActor = params.sourceActor ?? "assistant";
      const evidenceSource = selectPiEvidenceSource(
        ctx.sessionManager,
        params.evidence,
        sourceActor,
      );
      if (sourceActor !== "assistant" && !evidenceSource && !externalSource) {
        throw new Error(
          `sourceActor=${sourceActor} requires an exact matching evidence excerpt from the current Pi session or an explicit externalSource`,
        );
      }
      const result = await invoke("remember", {
        ...memory,
        sourceActor,
        evidenceSource,
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
      const baseParams = {
        ...params,
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
        secondPass: params.secondPass ?? qpp2Mode === "active",
        ...(activeGraphBudget ? { activeGraphBudget, limit: activeGraphBudget.maxEvidence } : {}),
      })) as MemoryContext;
      const fullResult = result;
      if (qpp2Mode === "active") {
        result = await applyLearnedFold(
          result,
          controllerShadow,
          qpp2RetainedMass,
          params.limit !== undefined,
        );
      }
      const text = injectionWindow.format(sessionId, result, "header");
      await controllerShadow.retrieval(fullResult, sessionId, "tool", text);
      return toolResult(result, text);
    },
  });

  pi.registerTool({
    name: "nmg_board",
    label: "NMG Task Board",
    description: nmgPrompts.board_description,
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("put"),
          Type.Literal("read"),
          Type.Literal("resolve"),
          Type.Literal("claim"),
          Type.Literal("release"),
          Type.Literal("unsubscribe"),
          Type.Literal("subscribe"),
        ],
        { description: nmgPrompts.board_action_parameter_description },
      ),
      taskId: Type.Optional(
        Type.String({ description: nmgPrompts.board_task_id_parameter_description }),
      ),
      content: Type.Optional(
        Type.String({ description: nmgPrompts.board_content_parameter_description }),
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
      leaseSeconds: Type.Optional(Type.Number({ minimum: 60, maximum: 86_400 })),
      afterCursor: Type.Optional(Type.Number({ minimum: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
      includeResolved: Type.Optional(Type.Boolean()),
      ttlSeconds: Type.Optional(Type.Number({ minimum: 60, maximum: 2_592_000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      // Identity chain: explicit NMG_AGENT_ID wins, then the session id (stable
      // across a session), then the pid as a last resort. A pid alone would
      // change every launch and fragment cross-session attribution.
      const agentId = process.env.NMG_AGENT_ID?.trim() || sessionId || `pi:${process.pid}`;
      // taskId is optional: without one, entries land on the shared world
      // channel (the lobby), which every Agent reads by default — no channel
      // name needs to be agreed on in advance. Explicit taskIds open named
      // channels that are surfaced in the world channel's lobby.
      const taskId = params.taskId?.trim() || WORLD_BOARD_ID;
      // Unsubscribe/subscribe are session-scoped (whether THIS session keeps
      // getting wake notices for a channel), handled apart from entry reads.
      if (params.action === "unsubscribe" || params.action === "subscribe") {
        const result = (await invoke("taskBoard", {
          action: params.action,
          taskId,
          sessionId,
          agentId,
        })) as { action: "unsubscribe" | "subscribe"; taskId: string };
        return toolResult(
          result,
          params.action === "unsubscribe"
            ? `已退订频道 ${result.taskId}：不再收到该频道新条目的唤醒通知（用 nmg_board subscribe 恢复）。`
            : `已恢复订阅频道 ${result.taskId}：继续接收该频道新条目的唤醒通知。`,
        );
      }
      const result = (await invoke("taskBoard", {
        ...params,
        taskId,
        agentId,
        sourceSessionId: sessionId,
      })) as TaskBoardToolResult;
      const entries = result.entries ?? (result.entry ? [result.entry] : []);
      if (result.action === "read") {
        for (const entry of entries) {
          runtimeAg.note(
            sessionId,
            `board:${taskId}:${entry.id}`,
            `[task-board ${taskId} #${entry.sequence} ${entry.kind} by ${entry.agentId}] ${entry.content}`,
          );
        }
        if (entries.length > 0) runtimeAg.activateProjection(sessionId);
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
      let directory: Array<{ taskId: string; entryCount: number; lastUpdatedAt: string }> = [];
      if (result.action === "read" && taskId === WORLD_BOARD_ID) {
        const lobby = (await invoke("taskBoard", { action: "list", agentId })) as {
          action: "list";
          boards: Array<{ taskId: string; entryCount: number; lastUpdatedAt: string }>;
        };
        directory = lobby.boards ?? [];
      }
      return toolResult(result, formatTaskBoardResult(result, taskId, directory));
    },
  });

  // ---- Board wake loop (config file + /nmg-wake command) ------------
  // Notification for an idle Agent: poll the subscribed spaces (the world
  // channel plus active named channels), and when a new open entry appears
  // that has not already been surfaced, wake the Agent with a broadcast-style
  // pi.sendUserMessage ("your subscribed channel has a new question") — never
  // addressing a specific recipient. This is the notification half of the
  // claim+notify design: claims decide who works, notifications decide who
  // knows. Enabled and tuned via ~/.nmg/board-wake.json (edited by hand or
  // toggled with /nmg-wake, which persists to the same file); dedup state is
  // kept in board-wake-state.json. Defaults are conservative: off.
  const wakeConfigPath = join(resolveNmgDataDir(), "board-wake.json");
  const wakeStatePath = join(resolveNmgDataDir(), "board-wake-state.json");
  interface BoardWakeConfig {
    enabled: boolean;
    budget: number;
    cooldownMs: number;
    intervalMs: number;
    /** When on, a collaboration-kind entry that wakes this session is also
     * announced on the world channel so other agents can pull it in. */
    worldBroadcast: boolean;
  }
  interface BoardWakeState {
    budgetDate: string;
    budgetUsed: number;
    lastWakeAt: number;
  }
  const readWakeConfig = (): BoardWakeConfig => {
    try {
      const raw = JSON.parse(readFileSync(wakeConfigPath, "utf8")) as Partial<BoardWakeConfig>;
      return {
        enabled: raw.enabled === true,
        // 0 = unlimited: budget 0 disables the daily cap, cooldownMs 0 removes the cooldown.
        budget: raw.budget === 0 ? 0 : Math.max(1, Number(raw.budget) || 8),
        cooldownMs: raw.cooldownMs === 0 ? 0 : Math.max(30_000, Number(raw.cooldownMs) || 600_000),
        intervalMs: Math.max(5_000, Number(raw.intervalMs) || 60_000),
        worldBroadcast: raw.worldBroadcast === true,
      };
    } catch {
      return {
        enabled: false,
        budget: 8,
        cooldownMs: 600_000,
        intervalMs: 60_000,
        worldBroadcast: false,
      };
    }
  };
  const writeWakeConfig = (config: BoardWakeConfig): void => {
    try {
      writeFileSync(wakeConfigPath, JSON.stringify(config, null, 2), "utf8");
    } catch {
      // best-effort; a read-only directory just means the toggle cannot persist
    }
  };
  const loadWakeState = (): BoardWakeState => {
    try {
      return JSON.parse(readFileSync(wakeStatePath, "utf8")) as BoardWakeState;
    } catch {
      return { budgetDate: "", budgetUsed: 0, lastWakeAt: 0 };
    }
  };
  const saveWakeState = (state: BoardWakeState): void => {
    try {
      writeFileSync(wakeStatePath, JSON.stringify(state), "utf8");
    } catch {
      // best-effort; losing dedup state only means an entry could re-notify
    }
  };
  const scanBoardWake = async (): Promise<void> => {
    const config = readWakeConfig();
    if (!config.enabled) return;
    const state = loadWakeState();
    const now = Date.now();
    if (config.cooldownMs > 0 && now - state.lastWakeAt < config.cooldownMs) return;
    const today = new Date(now).toISOString().slice(0, 10);
    if (state.budgetDate !== today) {
      state.budgetDate = today;
      state.budgetUsed = 0;
    }
    if (config.budget > 0 && state.budgetUsed >= config.budget) return;
    // A captured ctx goes stale after session replacement/reload; isIdle and
    // getSessionId on a stale ctx throw, which must never crash the host. Guard
    // them and skip this tick when the ctx is unusable.
    let sessionId = "";
    try {
      if (latestAgentCtx?.isIdle && !latestAgentCtx.isIdle()) return;
      sessionId = latestAgentCtx?.sessionManager.getSessionId() ?? "";
    } catch {
      return; // stale ctx — skip this tick, retry later
    }
    if (!sessionId) return;
    const agentId = process.env.NMG_AGENT_ID?.trim() || sessionId || `pi:${process.pid}`;
    try {
      const candidates: Array<TaskBoardToolEntry & { taskId: string }> = [];
      const collect = (taskId: string, entries: TaskBoardToolEntry[] | undefined) => {
        for (const entry of entries ?? []) {
          // Skip entries this exact session posted — waking on your own message
          // is an echo. The echo boundary is the session (sourceSessionId), not
          // the agent id: sessions sharing one NMG_AGENT_ID must still notify
          // each other. Null sourceSessionId (legacy rows) falls back to agentId.
          const ownEcho =
            entry.sourceSessionId === sessionId ||
            (entry.sourceSessionId == null && entry.agentId === agentId);
          if (
            entry.status === "open" &&
            !ownEcho &&
            // Already claimed by this session: don't nudge the holder for work
            // it is already doing — claim decides who works, notification
            // decides who knows (the claimer already knows).
            entry.claimedBy !== agentId
          ) {
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
      const lobby = (await invoke("taskBoard", { action: "list", agentId })) as {
        boards: Array<{ taskId: string; entryCount: number; lastUpdatedAt: string }>;
      };
      for (const board of lobby.boards ?? []) {
        const read = (await invoke("taskBoard", {
          action: "read",
          taskId: board.taskId,
          agentId,
        })) as TaskBoardToolResult;
        collect(board.taskId, read.entries);
      }
      if (candidates.length === 0) return;
      // Delivery protocol: ask the daemon which candidates are already delivered
      // to this session and which channels are suppressed (do-not-send), then
      // keep only undelivered, non-suppressed ones.
      const fresh: Array<TaskBoardToolEntry & { taskId: string }> = [];
      for (const taskId of new Set(candidates.map((candidate) => candidate.taskId))) {
        const check = (await invoke("taskBoard", {
          action: "deliveryCheck",
          taskId,
          agentId,
          sessionId,
          entryIds: candidates
            .filter((candidate) => candidate.taskId === taskId)
            .map((candidate) => candidate.id),
        })) as { delivered: string[]; suppressed: boolean };
        if (check.suppressed) continue; // unsubscribed channel — skip entirely
        const delivered = new Set(check.delivered);
        for (const candidate of candidates) {
          if (candidate.taskId === taskId && !delivered.has(candidate.id)) {
            fresh.push(candidate);
          }
        }
      }
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
      const pick = fresh[0]!;
      const excerpt =
        pick.content.length > 140 ? `${pick.content.slice(0, 140)}…` : pick.content;
      const label = kindLabel(pick.kind);
      pi.sendUserMessage(
        `[NMG board] 你订阅的频道 ${pick.taskId} 有新${label}：#${pick.sequence} — ${excerpt}（open，可认领）。需要的话用 nmg_board read 查看详情、claim 认领处理。`,
      );
      // Delivery receipt: this session has been reached for this entry, so the
      // wake loop will not re-notify it (idempotent in the store).
      await invoke("taskBoard", {
        action: "recordDelivery",
        entryId: pick.id,
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
      if (config.worldBroadcast && BROADCAST_KINDS.has(pick.kind)) {
        await maybeBroadcastToWorld({
          invoke: invoke as (method: string, params: unknown) => Promise<unknown>,
          entry: pick,
          agentId,
          sessionId,
        });
      }
      state.budgetUsed += 1;
      state.lastWakeAt = now;
      saveWakeState(state);
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
  setTimeout(wakeLoop, readWakeConfig().intervalMs).unref();
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

  beginTurn(sessionId: string, turnKey: string): boolean {
    const current = this.#states.get(sessionId);
    if (current?.turnKey === turnKey) return false;
    this.#states.set(sessionId, { turnKey, searches: 0 });
    return true;
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

const nmgPrompts = loadPrompts();
export const MEMORY_POLICY_RESOLUTION = resolveSkillOptLabPolicy(nmgPrompts.memory_policy);
export const MEMORY_POLICY = `<nmg_policy>\n${MEMORY_POLICY_RESOLUTION.text}\n</nmg_policy>`;

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
 * prompt. The message is persistent in the session, so on later turns it becomes
 * part of the stable prefix and only the newest dynamic block is billed.
 */
export function composeNmgContextMessage(
  automaticRecall = "",
  status = "",
  nudge = "",
  runtimeAg = "",
): string {
  return [
    automaticRecall ? `<nmg_automatic_recall>\n${automaticRecall}\n</nmg_automatic_recall>` : "",
    runtimeAg ? `<nmg_runtime_ag>\n${runtimeAg}\n</nmg_runtime_ag>` : "",
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
  return renderDisclosure(nmgPrompts.search_recommendation, {
    reason: qpp.reason,
    qpp: qpp.qpp.toFixed(3),
  });
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
        `${memory.resolution === "open" || memory.resolution === "reopened" ? "[open] " : ""}` +
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
      const resolutionLabel =
        memory.resolution === "open" || memory.resolution === "reopened" ? "[open] " : "";
      const externalSource = external?.attributes?.source
        ? `\n  EXTERNAL_SOURCE=${String(external.attributes.source)}; retrievedAt=${String(external.attributes.retrievedAt ?? "unknown")}`
        : "";
      return (
        `- ${externalLabel}${resolutionLabel}${memory.statement}\n  memory=${memory.id}; node=${node.canonicalName}; ` +
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

interface TaskBoardToolEntry {
  id: string;
  sequence: number;
  agentId: string;
  sourceSessionId?: string | null;
  kind: string;
  status: string;
  content: string;
  claimedBy?: string | null;
  createdAt?: string;
}

function kindLabel(kind: string): string {
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

interface TaskBoardToolResult {
  action: "put" | "read" | "resolve" | "claim" | "release";
  entry?: TaskBoardToolEntry;
  entries?: TaskBoardToolEntry[];
  nextCursor?: number;
}

/** Sentinel deliveries-table session used to dedup world-channel broadcasts:
 * each entry is broadcast at most once, keyed on (entry, this sentinel). */
export const WORLD_BROADCAST_SESSION = "world-broadcast";
/** Collaboration kinds worth pulling other agents in on; note/result/decision
 * updates are not broadcast, to keep the world channel quiet. */
export const BROADCAST_KINDS = new Set(["question", "blocker", "handoff"]);

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
  const worldCheck = (await invoke("taskBoard", {
    action: "deliveryCheck",
    taskId: WORLD_BOARD_ID,
    agentId,
    sessionId: WORLD_BROADCAST_SESSION,
    entryIds: [entry.id],
  })) as { delivered: string[]; suppressed: boolean };
  if (worldCheck.delivered.includes(entry.id)) return false;
  const excerpt =
    entry.content.length > 140 ? `${entry.content.slice(0, 140)}…` : entry.content;
  const label = kindLabel(entry.kind);
  const broadcast = `[NMG board 协作广播] 频道 ${entry.taskId} 有 #${entry.sequence} 未认领的${label}（open）：${excerpt}。有空的 agent 可用 nmg_board read taskId=${entry.taskId} 查看详情、claim 认领处理。`;
  await invoke("taskBoard", {
    action: "put",
    taskId: WORLD_BOARD_ID,
    agentId,
    sourceSessionId: sessionId,
    kind: "handoff",
    content: broadcast,
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

function formatTaskBoardResult(
  result: TaskBoardToolResult,
  taskId: string,
  directory: Array<{ taskId: string; entryCount: number; lastUpdatedAt: string }> = [],
): string {
  const entries = result.entries ?? (result.entry ? [result.entry] : []);
  const lines: string[] = [];
  if (directory.length > 0) {
    lines.push("Active named channels (world channel lobby):");
    for (const board of directory) {
      lines.push(
        `- ${board.taskId} (${board.entryCount} open · updated ${board.lastUpdatedAt.slice(0, 10)})`,
      );
    }
    lines.push("");
  }
  if (entries.length === 0) {
    lines.push(`Task board ${taskId} has no matching entries.`);
  } else {
    lines.push(
      ...entries.map((entry) => {
        const claim = entry.claimedBy ? ` [claimed by ${entry.claimedBy}]` : "";
        return `- #${entry.sequence} ${entry.id} [${entry.kind}/${entry.status}]${claim} ${entry.agentId}: ${excerpt(entry.content, 500)}`;
      }),
    );
    if (result.action === "read") lines.push(`nextCursor=${String(result.nextCursor ?? 0)}`);
  }
  lines.push("Temporary coordination only; use nmg_remember separately for durable knowledge.");
  // Disclosed only on use (progressive disclosure): the full conventions are
  // kept out of the always-resident tool description to save tokens.
  lines.push(
    "Board conventions (on use): entries may carry memory=<id> references to LTG records — readers expand them with nmg_get; open entries can be claimed by one Agent (lease-based, expired claims return to the pool) and released; resolve a request once it is answered — a resolved entry is closed and must not be replied to (reopen only with new substance); keep entries concise and temporary; taskId is the only channel boundary (no DMs, mentions, groups, or pinning).",
  );
  return lines.join("\n");
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
 * PostToolUse runtime-state capture (the tool result is the one event that
 * carries input + content + isError + per-tool details).
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
  return !/(?:nothing to commit|no changes added to commit|nothing added to commit)/iu.test(output);
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

/**
 * Session-local projection of recent tool state. It deliberately has no daemon
 * or SQLite path: explicit nmg_remember remains the durable-memory gate.
 */
export class SessionRuntimeAg {
  readonly #recent = new Map<string, Array<{ key: string; statement: string }>>();
  readonly #projected = new Set<string>();
  readonly maxPerSession: number;
  readonly maxCharacters: number;

  constructor(maxPerSession = 32, maxCharacters = 8000) {
    this.maxPerSession = Math.max(1, maxPerSession);
    this.maxCharacters = Math.max(1, maxCharacters);
  }

  /** Returns true when this (tool, statement) pair is new for the session. */
  note(sessionId: string, toolName: string, statement: string): boolean {
    const key = `${toolName}\u0000${toolTraceHash(statement)}`;
    let entries = this.#recent.get(sessionId);
    if (!entries) {
      entries = [];
      this.#recent.set(sessionId, entries);
    }
    if (entries.some((entry) => entry.key === key)) return false;
    entries.push({ key, statement });
    while (
      entries.length > this.maxPerSession ||
      entries.reduce((sum, entry) => sum + entry.statement.length, 0) > this.maxCharacters
    ) {
      entries.shift();
    }
    return true;
  }

  format(sessionId: string): string {
    if (!this.#projected.has(sessionId)) return "";
    const entries = this.#recent.get(sessionId) ?? [];
    if (entries.length === 0) return "";
    return [
      "Session-local tool state (temporary; not durable memory):",
      ...entries.map((entry) => `- ${entry.statement}`),
    ].join("\n");
  }

  activateProjection(sessionId: string): void {
    this.#projected.add(sessionId);
  }

  clear(sessionId: string): void {
    this.#recent.delete(sessionId);
    this.#projected.delete(sessionId);
  }
}

function toolTraceHash(statement: string): string {
  return createHash("sha256").update(statement).digest("base64url");
}
