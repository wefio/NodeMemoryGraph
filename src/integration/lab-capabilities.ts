import type { WorkingStateBinding } from "../core/session-active-graph.ts";

export const LAB_CAPABILITIES = [
  "working_state",
  "reasoning_workspace",
  "recall_gate",
  "memory_graph_reasoner",
  "controller_shadow",
  "controller_controlled",
  "controller_active",
] as const;

export type LabCapability = (typeof LAB_CAPABILITIES)[number];
export type LabScope = "session" | "project" | "global";

export interface LabCapabilityDescriptor {
  id: LabCapability;
  summary: string;
  agentMayEnable: boolean;
  supportedScopes: readonly LabScope[];
  operations: readonly string[];
}

export interface LabActivation {
  capability: LabCapability;
  scope: "session";
  sessionId: string;
  requester: string;
  reason: string;
  enabled: boolean;
  enabledAt: string;
  expiresAt: string;
  /** Owner-captured fence; never selected through the model's operation input. */
  workingStateBinding?: WorkingStateBinding;
}

export interface LabActivationAuthorityOptions {
  now?: () => number;
}

const DESCRIPTORS: readonly LabCapabilityDescriptor[] = [
  {
    id: "working_state",
    summary:
      "Replace or clear one provisional AG state in the session working frame; no durable or collaboration writes.",
    agentMayEnable: true,
    supportedScopes: ["session"],
    operations: ["replace", "clear"],
  },
  {
    id: "reasoning_workspace",
    summary:
      "Session-private auditable scratch graph for multi-step reasoning and compaction recovery.",
    agentMayEnable: true,
    supportedScopes: ["session"],
    operations: [
      "add",
      "update",
      "link",
      "checkpoint",
      "mark_compacted",
      "consume_checkpoint",
      "clear",
    ],
  },
  {
    id: "recall_gate",
    summary:
      "Session-only weak intent cues, no facts/training/persistence. Normal search can propose recallCue; explicit clients can prepare a revision. list/events inspect the bounded pool; remove/clear retire it.",
    agentMayEnable: true,
    supportedScopes: ["session"],
    operations: ["prepare", "correct", "list", "events", "remove", "clear"],
  },
  {
    id: "memory_graph_reasoner",
    summary:
      "Read-only differentiable traversal, fuzzy set logic, and what-if analysis over supplied memory vectors.",
    agentMayEnable: true,
    supportedScopes: ["session"],
    operations: ["traverse", "logic_search", "what_if"],
  },
  {
    id: "controller_shadow",
    summary: "Observe controller decisions without changing product retrieval.",
    agentMayEnable: true,
    supportedScopes: ["session"],
    operations: ["observe"],
  },
  {
    id: "controller_controlled",
    summary: "Allow candidate controller actuation only under harness-controlled evaluation gates.",
    agentMayEnable: false,
    supportedScopes: ["session"],
    operations: [],
  },
  {
    id: "controller_active",
    summary:
      "Production controller actuation; requires candidate, receipt, product gates, and rollback authority.",
    agentMayEnable: false,
    supportedScopes: ["session"],
    operations: [],
  },
] as const;

/** Capture immediately before ordinary RPC transport. Supplied fences are never
 * refreshed on retry: an old operation must not borrow a new context. */
export async function captureWorkingStateInvocation(
  params: Record<string, unknown>,
  readStatus: (sessionId: string) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  if (
    params.action !== "invoke" ||
    params.capability !== "working_state" ||
    params.workingStateBinding !== undefined
  )
    return params;
  if (typeof params.sessionId !== "string")
    throw new Error("working_state requires a host session binding");
  const status = (await readStatus(params.sessionId)) as {
    activation?: LabActivation | null;
  };
  const binding = status?.activation?.workingStateBinding;
  if (!binding || binding.sessionId !== params.sessionId)
    throw new Error("working_state requires an enabled host binding");
  return {
    ...params,
    workingStateBinding: Object.freeze({
      sessionId: binding.sessionId,
      agId: binding.agId,
      taskFrameId: binding.taskFrameId,
      bindingId: binding.bindingId,
    }),
  };
}

/** Ordinary text is short; the native structured RPC envelope remains intact. */
export function renderLabOutput(result: unknown): string {
  const value = result as {
    action?: string;
    capability?: string;
    output?: unknown;
  } | null;
  if (
    value?.action === "invoke" &&
    value.capability === "working_state" &&
    typeof value.output === "string" &&
    ["updated", "unchanged", "cleared"].includes(value.output)
  )
    return value.output;
  if (value?.action === "list") {
    const catalog = result as { capabilities?: LabCapabilityDescriptor[] };
    return JSON.stringify(
      {
        ...catalog,
        capabilities: catalog.capabilities?.filter((item) => item.id !== "working_state"),
      },
      null,
      2,
    );
  }
  return JSON.stringify(result, null, 2) ?? "";
}

export class LabActivationAuthority {
  readonly #now: () => number;
  readonly #leases = new Map<string, LabActivation>();

  constructor(options: LabActivationAuthorityOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  list(): LabCapabilityDescriptor[] {
    return DESCRIPTORS.map((item) => ({ ...item }));
  }

  enable(input: {
    capability: LabCapability;
    scope: LabScope;
    sessionId?: string;
    requester: string;
    reason: string;
    ttlSeconds?: number;
    authorizedByHarness?: boolean;
    workingStateBinding?: WorkingStateBinding;
  }): LabActivation {
    const descriptor = this.#descriptor(input.capability);
    if (input.scope !== "session" || !input.sessionId?.trim()) {
      throw new Error("Lab self-service currently requires a non-empty session scope");
    }
    if (!descriptor.agentMayEnable && !input.authorizedByHarness) {
      throw new Error(`${input.capability} requires operator or harness authorization`);
    }
    if (
      input.capability === "working_state" &&
      input.workingStateBinding?.sessionId !== input.sessionId.trim()
    ) {
      throw new Error("working_state activation requires an owner-captured binding");
    }
    const requester = input.requester.trim();
    const reason = input.reason.trim();
    if (!requester || !reason) throw new Error("Lab activation requires requester and reason");
    const ttlSeconds = Math.max(60, Math.min(86_400, Math.floor(input.ttlSeconds ?? 3_600)));
    const now = this.#now();
    const activation: LabActivation = {
      capability: input.capability,
      scope: "session",
      sessionId: input.sessionId.trim(),
      requester,
      reason,
      enabled: true,
      enabledAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlSeconds * 1_000).toISOString(),
    };
    if (input.capability === "working_state")
      activation.workingStateBinding = input.workingStateBinding;
    this.#leases.set(this.#key(input.capability, activation.sessionId), activation);
    return { ...activation };
  }

  disable(capability: LabCapability, sessionId: string): LabActivation | null {
    const key = this.#key(capability, sessionId);
    const current = this.#leases.get(key);
    if (!current) return null;
    this.#leases.delete(key);
    return { ...current, enabled: false };
  }

  status(capability: LabCapability, sessionId: string): LabActivation | null {
    const current = this.#leases.get(this.#key(capability, sessionId));
    if (!current) return null;
    if (Date.parse(current.expiresAt) <= this.#now()) {
      this.#leases.delete(this.#key(capability, sessionId));
      return null;
    }
    return { ...current };
  }

  isEnabled(capability: LabCapability, sessionId: string): boolean {
    return this.status(capability, sessionId)?.enabled === true;
  }

  requireEnabled(capability: LabCapability, sessionId: string): LabActivation {
    const activation = this.status(capability, sessionId);
    if (!activation) throw new Error(`${capability} is not enabled for session ${sessionId}`);
    return activation;
  }

  #descriptor(capability: LabCapability): LabCapabilityDescriptor {
    const descriptor = DESCRIPTORS.find((item) => item.id === capability);
    if (!descriptor) throw new Error(`Unknown Lab capability: ${capability}`);
    return descriptor;
  }

  #key(capability: LabCapability, sessionId: string): string {
    return `${sessionId.trim()}\u0000${capability}`;
  }
}
