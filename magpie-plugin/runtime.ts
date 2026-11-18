import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Unsafe } from "typebox";
import { Value } from "typebox/value";
import { join } from "node:path";
import type { MemoryContext } from "../src/core/types.ts";
import type { InformationView } from "../src/core/information-view.ts";
import type {
  NmgStateResult,
  NmgSessionActiveGraphResult,
  NmgHelloResult,
} from "../src/cli/protocol.ts";
import {
  assembleAdapterCapabilities,
  type CapabilityServices,
  type SharedAdapterTool,
  type AdapterCapability,
} from "../src/integration/adapter-capability-assembly.ts";
import { prepareInformationOutput } from "../src/integration/information-output.ts";
import { contextNotice } from "../src/integration/context-information.ts";
import {
  answerAttributionReferences,
  type AnswerAttributionReference,
} from "../src/core/feedback.ts";
import { configuredAutoRecallLimit, coordinationEnabled } from "../src/integration/config.ts";
import { SessionTaskWindow } from "../src/integration/session-task-window.ts";
import { RecallBudget } from "../src/integration/recall-budget.ts";
import {
  readWakeConfig,
  loadWakeState,
  saveWakeState,
  wakeBudgetGate,
  type WakeCandidate,
} from "../src/integration/board-wake.ts";
import { MagpieSessions, type MagpieBinding } from "./session.ts";
import { completedAnswer, containsContext, injectContext } from "./protocol.ts";
import type { MagpieHookContext, MagpieInvoke, MagpieOptions, MagpieTool } from "./types.ts";
import { reportedToolResults } from "./tool-results.ts";

type GraphReference = { activeGraphId: string; memoryVersions: AnswerAttributionReference[] };
type PreparedRequest = {
  binding: MagpieBinding;
  references: GraphReference[];
  entries: WakeCandidate[];
  included: ReturnType<typeof prepareInformationOutput>["included"];
  text: string;
  native: readonly AdapterCapability[];
};

export class MagpieRuntime {
  readonly sessions: MagpieSessions;
  readonly tools: Record<string, MagpieTool> = {};
  readonly ready: Promise<void>;
  private readonly directory: string;
  private readonly invoke: MagpieInvoke;
  private options: MagpieOptions;
  private readonly taskWindow = new SessionTaskWindow();
  private readonly references = new Map<string, Map<string, GraphReference>>();
  private readonly observations = new Map<string, Set<string>>();
  private endpoint?: NmgHelloResult;
  private readonly identities = new Map<
    string,
    { id: string; agentName: string; saveName: (name: string) => void }
  >();
  private recall!: CapabilityServices["automatic-recall"];
  private state!: CapabilityServices["state-context"];
  private attribution!: CapabilityServices["answer-attribution"];
  private observation!: CapabilityServices["tool-observation"];
  private completion!: CapabilityServices["completion-nudge"];
  private board!: CapabilityServices["board-delivery"];

  constructor(
    directory: string,
    invoke: MagpieInvoke,
    capabilities: readonly AdapterCapability[],
    options: MagpieOptions = {},
  ) {
    this.directory = directory;
    this.invoke = invoke;
    this.options = options;
    this.sessions = new MagpieSessions(directory);
    const endpoint = this.discoverEndpoint();
    const assembly = assembleAdapterCapabilities(
      capabilities,
      {
        registerTool: (tool) => {
          this.tools[tool.name] = this.bindTool(tool);
        },
        "automatic-recall": (service) => {
          this.recall = service;
        },
        "state-context": (service) => {
          this.state = service;
        },
        "answer-attribution": (service) => {
          this.attribution = service;
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
      },
      { endpoint },
    );
    this.ready = assembly.ready;
    this.tools.nmg_session = {
      description:
        "Open an independent NMG tool session when no NMG_BINDING was supplied by gateway context. Reuse its handle in this conversation. Inspect validates an existing handle.",
      args: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["open", "inspect"] },
          binding: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (args) => {
        if (args.action === "inspect")
          return JSON.stringify(await this.sessions.resolve(args.binding));
        if (args.action !== "open") throw new Error("Unknown NMG session action");
        return JSON.stringify(await this.sessions.open());
      },
    };
  }

  private coordinationEnabled(): boolean {
    return this.options.coordination ?? coordinationEnabled();
  }

  configure(options: MagpieOptions): void {
    this.options = options;
  }

  request(...args: Parameters<MagpieInvoke>): Promise<unknown> {
    return this.invoke(...args);
  }

  private async discoverEndpoint(
    signal = AbortSignal.timeout(250),
  ): Promise<NmgHelloResult | undefined> {
    try {
      this.endpoint = (await this.invoke("hello", {}, signal)) as NmgHelloResult;
    } catch {
      return undefined;
    }
    return this.endpoint;
  }

  private bindTool(tool: SharedAdapterTool): MagpieTool {
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    return {
      description: tool.description,
      args: {
        ...schema,
        properties: {
          ...schema.properties,
          binding: {
            type: "string",
            description: "NMG_BINDING from gateway context or nmg_session open",
          },
        },
        required: [...(schema.required ?? []), "binding"],
      },
      execute: async (args, context) => {
        await this.ready;
        const binding = await this.sessions.resolve(args.binding);
        const input = { ...args };
        delete input.binding;
        if (!Value.Check(Unsafe(tool.inputSchema), input))
          throw new Error(`Invalid ${tool.name} arguments`);
        const output = await tool.execute(input, {
          sessionId: binding.sessionId,
          requester: "agent:magpie",
          invoke: (method, params) => this.invoke(method, params, context.abort),
          boardIdentity: !this.coordinationEnabled() ? undefined : () => this.identity(binding),
          memory: {
            projectDir: binding.projectDir,
            search: {
              defaultTier: 3,
              onSearch: ({ disclosed }) => {
                this.note(binding, disclosed);
              },
            },
            onEvidenceDisclosed: (_request, result) => {
              this.note(binding, result);
            },
          },
        });
        return output.text;
      },
    };
  }

  private note(binding: MagpieBinding, context: MemoryContext): void {
    if (!context.activeGraph?.id || !context.results.length) return;
    const references = this.references.get(binding.sessionId) ?? new Map<string, GraphReference>();
    references.set(context.activeGraph.id, {
      activeGraphId: context.activeGraph.id,
      memoryVersions: answerAttributionReferences(context.results).slice(0, 50),
    });
    while (references.size > 8) references.delete(references.keys().next().value!);
    this.references.delete(binding.sessionId);
    this.references.set(binding.sessionId, references);
    while (this.references.size > 256) this.references.delete(this.references.keys().next().value!);
  }

  private async identity(binding: MagpieBinding) {
    const existing = this.identities.get(binding.sessionId);
    if (existing) return existing;
    const roster = (await this.invoke("taskBoard", { action: "discover" }).catch(() => null)) as {
      agents?: Array<{ id: string; agentName: string }>;
    } | null;
    const persisted = roster?.agents?.find((agent) => agent.id === binding.agentId);
    const identity = {
      id: binding.agentId,
      agentName: persisted?.agentName ?? binding.agentId,
      saveName: (name: string) => {
        identity.agentName = name;
      },
    };
    this.identities.set(binding.sessionId, identity);
    if (this.identities.size > 256) this.identities.delete(this.identities.keys().next().value!);
    return identity;
  }

  async onRequest(
    body: Record<string, unknown>,
    ctx: MagpieHookContext,
  ): Promise<Record<string, unknown> | undefined> {
    await this.ready;
    const binding = await this.sessions.admit(ctx);
    if (!binding) {
      ctx.report?.("unbound", 0);
      return undefined;
    }
    const native = this.options.nativeCapabilities?.[ctx.agent ?? ""] ?? [];
    if (!this.endpoint) await this.discoverEndpoint(ctx.signal);
    if (!native.includes("tool-observation")) await this.observe(binding, body, ctx);
    const prepared = await this.prepare(binding, ctx, native);
    const output = injectContext(body, ctx.protocol, prepared.text);
    ctx.state.nmg = prepared;
    ctx.report?.("ready", Buffer.byteLength(prepared.text));
    return output;
  }

  private async observe(
    binding: MagpieBinding,
    body: Record<string, unknown>,
    ctx: MagpieHookContext,
  ): Promise<void> {
    if (!this.endpoint?.methods?.includes("sessionActiveGraph")) return;
    const seen = this.observations.get(binding.sessionId) ?? new Set<string>();
    for (const { id, event } of reportedToolResults(body, ctx.protocol)) {
      const key = createHash("sha256")
        .update(JSON.stringify([id, event]))
        .digest("hex");
      if (seen.has(key)) continue;
      await this.observation.observe({
        sessionId: binding.sessionId,
        event,
        invoke: (method, params) => this.invoke(method, params, ctx.signal),
      });
      seen.add(key);
    }
    while (seen.size > 128) seen.delete(seen.values().next().value!);
    this.observations.delete(binding.sessionId);
    this.observations.set(binding.sessionId, seen);
    while (this.observations.size > 256)
      this.observations.delete(this.observations.keys().next().value!);
  }

  private async prepare(
    binding: MagpieBinding,
    ctx: MagpieHookContext,
    native: readonly AdapterCapability[],
  ): Promise<PreparedRequest> {
    const views: InformationView[] = [];
    const budget = new RecallBudget(
      Math.max(50, (this.options.gatewayTimeoutMs ?? 1000) - 50),
      ctx.signal,
    );
    const invoke: MagpieInvoke = (method, params, signal) =>
      this.invoke(method, params, signal ?? budget.signal);
    let entries: WakeCandidate[];
    let recalled: MemoryContext | undefined;
    try {
      if (!native.includes("state-context"))
        await this.prepareState(binding, budget, invoke, views);
      if (!native.includes("automatic-recall"))
        recalled = await this.prepareRecall(binding, ctx.query ?? "", budget, invoke, views);
      entries = await this.prepareBoardViews(binding, native, budget, invoke, views);
    } finally {
      budget.close();
    }
    const nudge = native.includes("completion-nudge")
      ? null
      : this.completion.prepare({ hook_event_name: "UserPromptSubmit", prompt: ctx.query ?? "" });
    views.unshift(
      ...contextNotice(
        `NMG_BINDING=${binding.handle}\nPass this handle as binding when calling Magpie NMG tools.`,
        "guidance",
      ),
    );
    if (nudge) views.push(...contextNotice(nudge));
    const output = prepareInformationOutput(views, {
      format: "context",
      maxCharacters: this.options.maxCharacters ?? 16000,
    });
    const references = new Map(this.references.get(binding.sessionId));
    const automatic = disclosedRecallReference(recalled, output.included);
    if (automatic) references.set(automatic.activeGraphId, automatic);
    return {
      binding,
      references: [...references.values()],
      entries,
      included: output.included,
      text: output.text,
      native,
    };
  }

  private async prepareState(
    binding: MagpieBinding,
    budget: RecallBudget,
    invoke: MagpieInvoke,
    views: InformationView[],
  ): Promise<void> {
    if (this.endpoint?.methods?.includes("state")) {
      const state = (await budget.run("state.read", (signal) =>
        invoke("state", { action: "read", space: "ag", sessionId: binding.sessionId }, signal),
      )) as NmgStateResult;
      if (state.space !== "ag" || state.result.action !== "snapshot")
        throw new Error("NMG owner state is unavailable");
      views.push(...this.state.views(state.result.snapshot, binding.sessionId));
    }
  }

  private async prepareBoardViews(
    binding: MagpieBinding,
    native: readonly AdapterCapability[],
    budget: RecallBudget,
    invoke: MagpieInvoke,
    views: InformationView[],
  ): Promise<WakeCandidate[]> {
    if (
      this.coordinationEnabled() &&
      !native.includes("board-delivery") &&
      this.endpoint?.methods?.includes("state")
    ) {
      const board = await budget
        .run("board.prepare", (signal) =>
          this.pendingBoard(binding, (method, params) => invoke(method, params, signal)),
        )
        .catch(() => null);
      if (board) {
        const ids = new Set(board.entries.map((entry) => entry.id));
        views.push(
          ...board.information.views.filter(
            (view) => view.source?.kind !== "board" || ids.has(view.source.entryId),
          ),
        );
        return [...board.entries];
      }
    }
    return [];
  }

  private async prepareRecall(
    binding: MagpieBinding,
    prompt: string,
    budget: RecallBudget,
    invoke: MagpieInvoke,
    views: InformationView[],
  ): Promise<MemoryContext | undefined> {
    if (!prompt.trim()) return;
    try {
      const turn = this.endpoint?.methods?.includes("sessionActiveGraph")
        ? ((await budget.run("recall.begin", (signal) =>
            invoke(
              "sessionActiveGraph",
              {
                action: "beginDisclosureTurn",
                sessionId: binding.sessionId,
                ...(binding.projectDir
                  ? { recall: { prompt, scheduled: true, projectDir: binding.projectDir } }
                  : {}),
              },
              signal,
            ),
          )) as NmgSessionActiveGraphResult)
        : undefined;
      const request = this.taskWindow.prepare(
        binding.sessionId,
        prompt,
        turn?.action === "beginDisclosureTurn" ? turn.sessionRecall?.decision : undefined,
      );
      if (!request) return;
      const context = (await budget.run("recall.search", (signal) =>
        invoke(
          "search",
          {
            ...request,
            sessionId: binding.sessionId,
            projectDir: binding.projectDir,
            autoRecall: true,
            limit: Math.min(request.limit, configuredAutoRecallLimit()),
            autoRecallBudgetMs: budget.searchBudgetMs(),
            tieredDisclosure: false,
          },
          signal,
        ),
      )) as MemoryContext;
      views.push(...this.recall.evidence(context).views);
      return context;
    } catch {
      views.push(...contextNotice("NMG optional recall is unavailable.", "diagnostic"));
    }
  }

  private wakeDirectory(binding: MagpieBinding): string {
    return join(
      this.directory,
      "magpie",
      "wake",
      createHash("sha256").update(binding.sessionId).digest("hex"),
    );
  }

  private async pendingBoard(binding: MagpieBinding, invoke: MagpieInvoke) {
    const identity = await this.identity(binding);
    await invoke("taskBoard", {
      action: "registerAgent",
      id: identity.id,
      agentName: identity.agentName,
      supportedInterfaces: "magpie",
    });
    const directory = this.wakeDirectory(binding);
    await mkdir(directory, { recursive: true });
    if (!wakeBudgetGate(readWakeConfig(this.directory), loadWakeState(directory), Date.now()))
      return null;
    const entries = await this.board.collect(
      (method, params) =>
        invoke(method as Parameters<MagpieInvoke>[0], params as Record<string, unknown>),
      { agentId: identity.id, agentName: identity.agentName, sessionId: binding.sessionId },
    );
    return this.board.prepare({
      invoke: (method, params) =>
        invoke(method as Parameters<MagpieInvoke>[0], params as Record<string, unknown>),
      entries,
      dataDir: directory,
      agentId: identity.id,
      sessionId: binding.sessionId,
      maxCharacters: 4000,
    });
  }

  async onResponse(reply: unknown, ctx: MagpieHookContext): Promise<void> {
    const prepared = ctx.state.nmg as PreparedRequest | undefined;
    if (!prepared?.text || ctx.success !== true) return;
    if (!containsContext(ctx.request ?? {}, ctx.protocol, prepared.text)) return;
    delete ctx.state.nmg;
    const { binding, native } = prepared;
    if (!native.includes("answer-attribution")) {
      const answerText = completedAnswer(reply, ctx.protocol);
      for (const reference of prepared.references) {
        await this.attribution
          .record({
            ...reference,
            answerText,
            sessionId: binding.sessionId,
            projectDir: binding.projectDir,
            invoke: (method, params) =>
              this.invoke(
                method as Parameters<MagpieInvoke>[0],
                params as Record<string, unknown>,
                ctx.signal,
              ),
          })
          .catch(() => undefined);
        const pending = this.references.get(binding.sessionId);
        if (pending?.get(reference.activeGraphId) === reference)
          pending.delete(reference.activeGraphId);
      }
    }
    const admitted = new Set(
      prepared.included.flatMap(({ source }) => (source?.kind === "board" ? [source.entryId] : [])),
    );
    const entries = prepared.entries.filter((entry) => admitted.has(entry.id));
    if (entries.length) {
      await this.board.record(
        (method, params) =>
          this.invoke(
            method as Parameters<MagpieInvoke>[0],
            params as Record<string, unknown>,
            ctx.signal,
          ),
        entries,
        binding.agentId,
        binding.sessionId,
      );
      const state = loadWakeState(this.wakeDirectory(binding));
      state.budgetUsed++;
      state.lastWakeAt = Date.now();
      saveWakeState(state, this.wakeDirectory(binding));
    }
  }
}

function disclosedRecallReference(
  context: MemoryContext | undefined,
  included: PreparedRequest["included"],
): GraphReference | undefined {
  const activeGraphId = context?.activeGraph?.id;
  if (!context || !activeGraphId) return undefined;
  const delivered = new Set(
    included.flatMap(({ source }) =>
      source.kind === "memory" && source.activeGraphId === activeGraphId ? [source.memoryId] : [],
    ),
  );
  const results = context.results.filter(({ memory }) => delivered.has(memory.id)).slice(0, 50);
  if (!results.length) return undefined;
  return { activeGraphId, memoryVersions: answerAttributionReferences(results) };
}
