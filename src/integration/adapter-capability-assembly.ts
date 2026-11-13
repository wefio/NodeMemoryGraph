import { prepareAutomaticRecallSurface } from "./agent-surface.ts";
import { contextStateViews } from "./context-information.ts";
import { promptCompletionNudge } from "./completion-nudge.ts";
import { AgentAttributionFlow } from "./agent-attribution.ts";
import { collectWakeCandidates } from "./board-wake.ts";
import {
  deliverBoardWakeBatch,
  enqueueBoardWakeBatch,
  preparePendingBoardWake,
  recordBoardWakeBatchDelivery,
  reportHarnessActivity,
} from "./board-wake-batch.ts";
import {
  isMemorableToolResult,
  isSuccessfulCommit,
  summarizeToolResult,
} from "./tool-observation.ts";

export type CapabilityCleanup = () => void | Promise<void>;
type Installation = void | CapabilityCleanup | Promise<void | CapabilityCleanup>;
type ToolName = "nmg_search" | "nmg_get" | "nmg_remember" | "nmg_state" | "nmg_lab";
export type AdapterToolBindings = Partial<Record<ToolName, () => Installation>>;

export interface ToolObservationInput {
  sessionId: string;
  event: Parameters<typeof isMemorableToolResult>[0];
  invoke: (method: "sessionActiveGraph", params: Record<string, unknown>) => Promise<unknown>;
  onCommit?: () => void;
}

/** Native event normalization, queuing and liveness fences belong to the host. */
export async function observeAdapterToolResult(input: ToolObservationInput): Promise<void> {
  const { sessionId, event, invoke, onCommit } = input;
  if (!sessionId || event.toolName.startsWith("nmg_")) return;
  if (isSuccessfulCommit(event)) onCommit?.();
  if (!isMemorableToolResult(event)) return;
  const observation = summarizeToolResult(event);
  await invoke("sessionActiveGraph", {
    action: "observe",
    sessionId,
    sourceId: event.toolName,
    sourceKind: event.isError ? "tool_error" : "tool_result",
    nodeId: observation.nodeName,
    statement: observation.statement,
  });
}

export interface CapabilityServices {
  "automatic-recall": { prepare: typeof prepareAutomaticRecallSurface };
  "state-context": { views: typeof contextStateViews };
  "tool-observation": { observe: typeof observeAdapterToolResult };
  "completion-nudge": { prepare: typeof promptCompletionNudge };
  "answer-attribution": { create: (maxPending?: number) => AgentAttributionFlow };
  "board-delivery": {
    collect: typeof collectWakeCandidates;
    deliver: typeof deliverBoardWakeBatch;
    enqueue: typeof enqueueBoardWakeBatch;
    prepare: typeof preparePendingBoardWake;
    record: typeof recordBoardWakeBatchDelivery;
    activity: typeof reportHarnessActivity;
  };
}

const SERVICES: CapabilityServices = {
  "automatic-recall": { prepare: prepareAutomaticRecallSurface },
  "state-context": { views: contextStateViews },
  "tool-observation": { observe: observeAdapterToolResult },
  "completion-nudge": { prepare: promptCompletionNudge },
  "answer-attribution": { create: (maxPending) => new AgentAttributionFlow(maxPending) },
  "board-delivery": {
    collect: collectWakeCandidates,
    deliver: deliverBoardWakeBatch,
    enqueue: enqueueBoardWakeBatch,
    prepare: preparePendingBoardWake,
    record: recordBoardWakeBatchDelivery,
    activity: reportHarnessActivity,
  },
};

const TOOL_CAPABILITIES = {
  "memory-tools": ["nmg_search", "nmg_get", "nmg_remember"],
  "state-tool": ["nmg_state"],
  "lab-tools": ["nmg_lab"],
} as const;

export type AdapterCapability = keyof typeof TOOL_CAPABILITIES | keyof CapabilityServices;
export type AdapterCapabilityBindings = {
  tools?: AdapterToolBindings;
} & { [K in keyof CapabilityServices]?: (services: CapabilityServices[K]) => Installation };

export interface CapabilityAssembly {
  ready: Promise<void>;
  describe(): Array<{
    capability: AdapterCapability;
    state: "assembled" | "pending" | "disabled" | "failed" | "disposed";
  }>;
  dispose(): Promise<void>;
}

function capabilityInstallers(
  capability: AdapterCapability,
  bindings: AdapterCapabilityBindings,
): Array<() => Installation> {
  if (Object.hasOwn(TOOL_CAPABILITIES, capability)) {
    const names = TOOL_CAPABILITIES[capability as keyof typeof TOOL_CAPABILITIES];
    for (const name of names) {
      const bind = bindings.tools?.[name];
      if (typeof bind !== "function") throw new Error(`${capability}: missing binding ${name}`);
    }
    // Keep the host's existing order within a shared tool group.
    return Object.entries(bindings.tools ?? {})
      .filter(([name]) => (names as readonly string[]).includes(name))
      .map(([, bind]) => bind);
  }
  return [serviceInstaller(capability as keyof CapabilityServices, bindings)];
}

function serviceInstaller<K extends keyof CapabilityServices>(
  capability: K,
  bindings: AdapterCapabilityBindings,
): () => Installation {
  const bind = bindings[capability] as
    ((services: CapabilityServices[K]) => Installation) | undefined;
  if (typeof bind !== "function") throw new Error(`${capability}: missing native binding`);
  return () => bind(SERVICES[capability]);
}

/** Validate the complete declaration before any host mutation. Native schema
 * libraries and event shapes stay in the binding; feature selection is shared.
 * Assembly proves registration/preparation only, not live hook activation or
 * endpoint authority. Callers must await ready for asynchronous host APIs.
 */
export function assembleAdapterCapabilities(
  capabilities: readonly AdapterCapability[],
  bindings: AdapterCapabilityBindings,
  options: { disabled?: readonly AdapterCapability[] } = {},
): CapabilityAssembly {
  const disabled = new Set(options.disabled);
  if (new Set(capabilities).size !== capabilities.length) throw new Error("Duplicate capability");
  const plans = capabilities.map((capability) => ({
    capability,
    state: disabled.has(capability) ? ("disabled" as const) : ("pending" as const),
    install: disabled.has(capability) ? [] : capabilityInstallers(capability, bindings),
  }));
  return installCapabilities(plans);
}

type CapabilityPlan = {
  capability: AdapterCapability;
  state: "assembled" | "pending" | "disabled" | "failed" | "disposed";
  install: Array<() => Installation>;
};

class InstallationScope {
  readonly cleanups: Array<CapabilityCleanup | undefined> = [];
  readonly pending: Promise<void>[] = [];
  closed = false;
  closing: Promise<void> | undefined;

  install(plan: CapabilityPlan): void {
    const pending: Promise<void>[] = [];
    for (const install of plan.install) {
      const slot = this.cleanups.length;
      this.cleanups.push(undefined);
      const result = install();
      if (result instanceof Promise) {
        const accepted = result.then((cleanup) => this.accept(slot, cleanup));
        this.pending.push(accepted);
        pending.push(accepted);
      } else {
        this.cleanups[slot] = result || undefined;
      }
    }
    if (pending.length === 0) {
      plan.state = "assembled";
      return;
    }
    this.pending.push(
      Promise.all(pending).then(
        () => {
          plan.state = this.closed ? "disposed" : "assembled";
        },
        (error) => {
          plan.state = "failed";
          throw error;
        },
      ),
    );
  }

  async accept(slot: number, cleanup: void | CapabilityCleanup): Promise<void> {
    if (typeof cleanup !== "function") return;
    if (this.closed) await cleanup();
    else this.cleanups[slot] = cleanup;
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= this.release();
    return this.closing;
  }

  private async release(): Promise<void> {
    const errors: unknown[] = [];
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      if (!cleanup) continue;
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Capability cleanup failed");
  }
}

function installCapabilities(plans: CapabilityPlan[]): CapabilityAssembly {
  const scope = new InstallationScope();
  try {
    for (const plan of plans) {
      if (plan.state !== "disabled") scope.install(plan);
    }
  } catch (error) {
    // Release synchronous registrations now; late accepted registrations see
    // closed=true and release themselves rather than leaking after failure.
    void scope.close().catch(() => undefined);
    void Promise.allSettled(scope.pending);
    throw error;
  }
  const ready = Promise.allSettled(scope.pending).then(async (outcomes) => {
    const failures = outcomes.filter((result) => result.status === "rejected");
    if (failures.length === 0) return;
    try {
      await scope.close();
    } catch (error) {
      failures.push({ status: "rejected", reason: error });
    }
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Capability assembly failed",
      { cause: failures[0]?.reason },
    );
  });
  // Synchronous hosts register immediately; asynchronous hosts await readiness.
  void ready.catch(() => undefined);
  return {
    ready,
    describe: () => plans.map(({ capability, state }) => ({ capability, state })),
    dispose: async () => {
      scope.closed = true;
      await Promise.allSettled(scope.pending);
      await scope.close();
      for (const plan of plans) if (plan.state === "assembled") plan.state = "disposed";
    },
  };
}
