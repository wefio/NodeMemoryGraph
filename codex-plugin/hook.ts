import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assembleAdapterCapabilities,
  type CapabilityServices,
  type AdapterCapability,
} from "../src/integration/adapter-capability-assembly.ts";
import { contextNotice } from "../src/integration/context-information.ts";
import { prepareInformationOutput } from "../src/integration/information-output.ts";
import { compactSearchContext } from "../src/integration/search-projection.ts";
import { RecallBudget } from "../src/integration/recall-budget.ts";
import { SessionTaskWindow } from "../src/integration/session-task-window.ts";
import { coordinationEnabled, configuredAutoRecallLimit } from "../src/integration/config.ts";
import {
  readWakeConfig,
  loadWakeState,
  saveWakeState,
  wakeBudgetGate,
  type WakeCandidate,
} from "../src/integration/board-wake.ts";
import type { InformationView } from "../src/core/information-view.ts";
import type { MemoryContext } from "../src/core/types.ts";
import type { NmgStateResult, NmgSessionActiveGraphResult } from "../src/cli/protocol.ts";
import { completedCodexTools, normalizeCodexToolResult } from "./tool-result.ts";
import { CodexSessionStore } from "./session-store.ts";
import { CodexTurnTraces } from "./turn-traces.ts";
import { codexHookBinding, type CodexBinding } from "./session.ts";

export type CodexInvoke = (
  method: string,
  params: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
export interface CodexHookOptions {
  dataDirectory: string;
  invoke: CodexInvoke;
  writeOutput: (text: string) => Promise<void>;
  environment?: NodeJS.ProcessEnv;
}

/** Native event translation only. Shared modules own rendering, observation
 * selection and board receipts. Hook stdout is preparation, not disclosure.
 */
export class CodexHook {
  private readonly store: CodexSessionStore;
  private readonly traces: CodexTurnTraces;
  private recall!: CapabilityServices["automatic-recall"];
  private state!: CapabilityServices["state-context"];
  private observation!: CapabilityServices["tool-observation"];
  private completion!: CapabilityServices["completion-nudge"];
  private board!: CapabilityServices["board-delivery"];
  private attribution!: CapabilityServices["answer-attribution"];
  private readonly assembly;
  private readonly options: CodexHookOptions;

  constructor(options: CodexHookOptions, capabilities: readonly AdapterCapability[]) {
    this.options = options;
    this.store = new CodexSessionStore(options.dataDirectory);
    this.traces = new CodexTurnTraces(options.dataDirectory);
    this.assembly = assembleAdapterCapabilities(capabilities, {
      "automatic-recall": (service) => {
        this.recall = service;
      },
      "state-context": (service) => {
        this.state = service;
      },
      "tool-observation": (service) => {
        this.observation = service;
      },
      "completion-nudge": (service) => {
        this.completion = service;
      },
      "board-delivery": (service) => {
        this.board = service;
      },
      "answer-attribution": (service) => {
        this.attribution = service;
      },
    });
  }

  async run(payload: Record<string, unknown>): Promise<void> {
    await this.assembly.ready;
    const native = codexHookBinding(payload);
    const event = String(payload.hook_event_name);
    if (event === "SessionStart") {
      if (payload.source === "clear") await this.store.reset(native);
      if (payload.source === "compact") await this.carriedState(native);
      return;
    }
    if (event === "PreCompact") {
      const current = await this.store.current(native);
      await this.options.invoke("sessionActiveGraph", {
        action: "clearDisclosures",
        sessionId: current.sessionId,
      });
      return;
    }
    if (event === "UserPromptSubmit") return this.prompt(payload, native);
    if (event === "PostCompact") return this.carriedState(native, "PostCompact");
    const binding = await this.store.resolve(native);
    if (event === "PostToolUse") await this.observe(payload, binding);
    if (event === "Interrupt") {
      await this.traces.cancel(binding);
      if (this.coordination())
        await this.board.activity(
          this.options.invoke,
          binding.agentId,
          binding.sessionId,
          "unknown",
          ["prompt-delivery", "completion-delivery"],
        );
    }
    if (event === "Stop") await this.stop(payload, binding);
  }

  private async stop(payload: Record<string, unknown>, binding: CodexBinding): Promise<void> {
    for (const tool of await completedCodexTools(payload, binding).catch(() => []))
      await this.observe(tool, binding);
    const answerText =
      typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "";
    if (binding.turnId && answerText.trim()) {
      await this.traces
        .finish(binding, (trace) =>
          this.attribution.record({
            ...trace,
            answerText,
            sessionId: binding.sessionId,
            projectDir: binding.projectDir,
            invoke: this.options.invoke,
          }),
        )
        .catch(() => undefined);
    }
    if (this.coordination()) {
      await this.board.activity(
        this.options.invoke,
        binding.agentId,
        binding.sessionId,
        "unknown",
        ["prompt-delivery", "completion-delivery"],
      );
      const continued = payload.stop_hook_active !== true && (await this.completionBoard(binding));
      await this.board.activity(
        this.options.invoke,
        binding.agentId,
        binding.sessionId,
        continued ? "busy" : "unknown",
        ["prompt-delivery"],
      );
    }
  }

  private async completionBoard(binding: CodexBinding): Promise<boolean> {
    if (await this.traces.continued(binding)) return false;
    const pending = await this.pendingBoard(binding).catch(() => null);
    if (!pending?.entries.length) return false;
    const output = pending.information;
    if (!output.text) return false;
    await this.options.writeOutput(JSON.stringify({ decision: "block", reason: output.text }));
    await this.traces.continued(binding, true);
    await this.receiptBoard(binding, pending.entries, output.included);
    return true;
  }

  private coordination(): boolean {
    return coordinationEnabled(this.options.environment);
  }

  private async carriedState(native: CodexBinding, eventName = "SessionStart"): Promise<void> {
    const binding = await this.store.current(native);
    const state = (await this.options.invoke("state", {
      action: "read",
      space: "ag",
      sessionId: binding.sessionId,
    })) as NmgStateResult;
    if (state.space !== "ag" || state.result.action !== "snapshot") return;
    const output = prepareInformationOutput(
      this.state.views(state.result.snapshot, binding.sessionId),
      { format: "context" },
    );
    if (output.text)
      await this.options.writeOutput(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: eventName,
            additionalContext: output.text,
          },
        }),
      );
  }

  private async prompt(payload: Record<string, unknown>, native: CodexBinding): Promise<void> {
    const binding = await this.store.admit(native, String(payload.cwd ?? ""));
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const views = await this.context(binding, prompt);
    const pending = this.coordination() ? await this.pendingBoard(binding).catch(() => null) : null;
    if (pending) {
      const admitted = new Set(pending.entries.map((entry) => entry.id));
      views.push(
        ...pending.information.views.filter(
          (view) => view.source?.kind !== "board" || admitted.has(view.source.entryId),
        ),
      );
    }
    const nudge = this.completion.prepare({ hook_event_name: "UserPromptSubmit", prompt });
    if (nudge) views.push(...contextNotice(nudge));
    if (await this.store.nudge(binding, true))
      views.push(
        ...contextNotice("A completed code commit is available to review for durable memory."),
      );
    const output = prepareInformationOutput(views, { format: "context" });
    const current = await this.store.resolve(native);
    if (current.sessionId !== binding.sessionId)
      throw new Error("Obsolete Codex context preparation");
    if (output.text) {
      await this.options.writeOutput(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: output.text,
          },
        }),
      );
    }
    if (pending && output.text) await this.receiptBoard(binding, pending.entries, output.included);
    if (this.coordination())
      await this.board.activity(this.options.invoke, binding.agentId, binding.sessionId, "busy", [
        "prompt-delivery",
      ]);
  }

  private async context(binding: CodexBinding, prompt: string): Promise<InformationView[]> {
    const budget = new RecallBudget(1500);
    const views: InformationView[] = [];
    try {
      const state = (await budget.run("state.read", (signal) =>
        this.options.invoke(
          "state",
          {
            action: "read",
            space: "ag",
            sessionId: binding.sessionId,
          },
          signal,
        ),
      )) as NmgStateResult;
      if (state.space !== "ag" || state.result.action !== "snapshot")
        throw new Error("Invalid Codex owner state");
      views.push(...this.state.views(state.result.snapshot, binding.sessionId));
      const handshake = (await budget.run("turn.begin", (signal) =>
        this.options.invoke(
          "sessionActiveGraph",
          {
            action: "beginDisclosureTurn",
            sessionId: binding.sessionId,
            recall: { prompt, scheduled: true, projectDir: binding.projectDir },
          },
          signal,
        ),
      )) as NmgSessionActiveGraphResult;
      const request = new SessionTaskWindow().prepare(
        binding.sessionId,
        prompt,
        handshake.action === "beginDisclosureTurn" ? handshake.sessionRecall?.decision : undefined,
      );
      if (request) {
        const context = (await budget.run("recall.search", (signal) =>
          this.options.invoke(
            "search",
            {
              ...request,
              limit: Math.min(request.limit, configuredAutoRecallLimit()),
              autoRecall: true,
              tieredDisclosure: true,
              sessionId: binding.sessionId,
              projectDir: binding.projectDir,
            },
            signal,
          ),
        )) as MemoryContext;
        await this.traces.note(binding, context).catch(() => undefined);
        views.push(...this.recall.prepare(compactSearchContext(context)).views);
      }
    } catch {
      views.push(
        ...contextNotice("NMG optional context preparation is unavailable.", "diagnostic"),
      );
    } finally {
      budget.close();
    }
    return views;
  }

  private async pendingBoard(binding: CodexBinding) {
    const invoke = this.options.invoke;
    await invoke("taskBoard", {
      action: "registerAgent",
      id: binding.agentId,
      agentName: binding.agentId,
      supportedInterfaces: "codex",
    });
    const directory = join(
      this.options.dataDirectory,
      "codex-sessions",
      `wake-${binding.nativeId}`,
    );
    await mkdir(directory, { recursive: true });
    if (
      !wakeBudgetGate(
        readWakeConfig(this.options.dataDirectory),
        loadWakeState(directory),
        Date.now(),
      )
    )
      return null;
    const entries = await this.board.collect(invoke, {
      agentId: binding.agentId,
      agentName: binding.agentId,
      sessionId: binding.sessionId,
    });
    return this.board.prepare({
      invoke,
      entries,
      dataDir: directory,
      agentId: binding.agentId,
      sessionId: binding.sessionId,
      maxCharacters: 4000,
    });
  }

  private async receiptBoard(
    binding: CodexBinding,
    entries: readonly WakeCandidate[],
    included: readonly { source: unknown }[],
  ): Promise<void> {
    const ids = new Set(
      included.flatMap(({ source }) => {
        const item = source as { kind?: string; entryId?: string };
        return item.kind === "board" && item.entryId ? [item.entryId] : [];
      }),
    );
    const admitted = entries.filter((entry) => ids.has(entry.id));
    await this.board.record(this.options.invoke, admitted, binding.agentId, binding.sessionId);
    if (!admitted.length) return;
    const directory = join(
      this.options.dataDirectory,
      "codex-sessions",
      `wake-${binding.nativeId}`,
    );
    const state = loadWakeState(directory);
    state.budgetUsed++;
    state.lastWakeAt = Date.now();
    saveWakeState(state, directory);
  }

  private async observe(payload: Record<string, unknown>, binding: CodexBinding): Promise<void> {
    const event = await normalizeCodexToolResult(payload, binding);
    if (!event) return;
    const observe = () => this.recordObservation(event, binding);
    if (event.outcomeKnown && typeof payload.tool_use_id === "string")
      return this.traces.observeOnce(binding, payload.tool_use_id, observe);
    await observe();
  }

  private async recordObservation(
    event: Parameters<CapabilityServices["tool-observation"]["observe"]>[0]["event"],
    binding: CodexBinding,
  ): Promise<void> {
    let committed = false;
    await this.observation.observe({
      sessionId: binding.sessionId,
      event,
      invoke: this.options.invoke,
      onCommit: () => {
        committed = true;
      },
    });
    if (committed) await this.store.nudge(binding);
  }
}
