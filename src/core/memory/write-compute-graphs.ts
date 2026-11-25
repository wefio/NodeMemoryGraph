import {
  ComputeRegistry,
  INPUT_NODE_ID,
  executeComputeGraph,
  type ComputeGraphSpec,
  type PhysicalPlanOptions,
} from "../compute-graph.ts";
import type {
  LinkMemoriesInput,
  MemoryNode,
  MemoryRecord,
  MemoryRelationRecord,
  MemoryStorageState,
  MemoryWriteEvent,
  NodeRelation,
  RememberResult,
  RecordClaimOutcomesInput,
} from "../types.ts";
import { recordClaimOutcomes } from "./claim-outcomes.ts";
import {
  changeResolution,
  proposeMemoryRelation,
  supersedeMemory,
  type MemoryRelationProposal,
  type MemoryResolutionChange,
  type MemorySupersession,
} from "./lifecycle.ts";
import { memoryIdentity, visibleMemory, type MemoryInput } from "./model.ts";
import type { MemoryPlan } from "./plan.ts";

export interface RememberPlanInput {
  readonly inputs: readonly MemoryInput[];
  readonly operationId: string;
  readonly timestamp: string;
}

export interface PlannedGraphOutput<T> {
  readonly result: T;
  readonly ids: string[];
}

export type LifecyclePlanPayload =
  | { readonly action: "resolution"; readonly input: MemoryResolutionChange; readonly now: string }
  | { readonly action: "supersession"; readonly input: MemorySupersession; readonly now: string }
  | {
      readonly action: "relationProposal";
      readonly input: MemoryRelationProposal;
      readonly now: string;
    }
  | {
      readonly action: "storageState";
      readonly memoryId: string;
      readonly target: MemoryStorageState;
      readonly recoveryDays: number;
      readonly now: string;
    }
  | {
      readonly action: "claimOutcomes";
      readonly input: RecordClaimOutcomesInput;
      readonly now: string;
    }
  | {
      readonly action: "usage";
      readonly ids: readonly string[];
      readonly sessionId?: string;
      readonly now: string;
    }
  | {
      readonly action: "attachNode";
      readonly memoryId: string;
      readonly input: {
        nodeName: string;
        nodeSummary?: string;
        nodeKind?: MemoryNode["kind"];
        sessionId?: string;
      };
      readonly now: string;
    }
  | {
      readonly action: "linkNodes";
      readonly namespace: string;
      readonly input: {
        sourceNodeId: string;
        targetNodeId: string;
        type: NodeRelation["type"];
        evidenceIds?: string[];
      };
      readonly now: string;
    }
  | {
      readonly action: "linkMemories";
      readonly namespace: string;
      readonly input: LinkMemoriesInput;
      readonly now: string;
    }
  | {
      readonly action: "withdraw";
      readonly memoryId: string;
      readonly sessionId?: string;
    }
  | {
      readonly action: "tesseraFingerprint";
      readonly input: {
        id: string;
        memoryId: string;
        path: string;
        fileSimhash: string;
        sessionId?: string;
      };
    }
  | {
      readonly action: "rejectionAudit";
      readonly event: MemoryWriteEvent;
    };

async function planStorageStateTransition(
  plan: MemoryPlan,
  payload: Extract<LifecyclePlanPayload, { action: "storageState" }>,
): Promise<PlannedGraphOutput<MemoryStorageState>> {
  const memory = await plan.record(payload.memoryId);
  if (!memory) throw new Error(`memory ${payload.memoryId} does not exist`);
  if (memory.residence !== "ltg") {
    throw new Error("Retention applies only to shared LTG memories");
  }
  if ((memory.storageState ?? "indexed") === payload.target) {
    return { result: payload.target, ids: [payload.memoryId] };
  }
  if (memory.resolution !== "resolved" && payload.target !== "indexed") {
    throw new Error("open memories must be resolved before archival or quarantine");
  }
  const quarantineUntil =
    payload.target === "quarantine"
      ? new Date(Date.parse(payload.now) + payload.recoveryDays * 86_400_000).toISOString()
      : null;
  plan.put({
    kind: "memory",
    value: {
      ...memory,
      storageState: payload.target === "indexed" ? undefined : payload.target,
      retentionChangedAt: payload.now,
      quarantineUntil,
    },
  });
  return { result: payload.target, ids: [payload.memoryId] };
}

async function planLinkNodes(
  plan: MemoryPlan,
  payload: Extract<LifecyclePlanPayload, { action: "linkNodes" }>,
): Promise<PlannedGraphOutput<NodeRelation>> {
  const { input, now, namespace } = payload;
  const nodes = await plan.find({
    kind: "node",
    ids: [input.sourceNodeId, input.targetNodeId],
  });
  if (
    nodes.length !== 2 ||
    nodes.some(
      (entity) =>
        entity.kind !== "node" ||
        entity.value.status !== "active" ||
        entity.value.residence !== "ltg",
    )
  ) {
    throw new Error("Relations require active LTG nodes");
  }
  const evidenceIds = input.evidenceIds ?? [];
  const evidence = await plan.find({ kind: "history", ids: evidenceIds });
  if (
    evidence.length !== new Set(evidenceIds).size ||
    evidence.some((entity) => entity.kind !== "history" || entity.value.sessionId !== null)
  ) {
    throw new Error("Relation evidence must exist and be shared");
  }
  const result: NodeRelation = {
    ...input,
    evidenceIds,
    id: memoryIdentity(namespace, "edge", input.sourceNodeId, input.targetNodeId, input.type),
    residence: "ltg",
    status: "consolidated",
    stability: 1,
    strength: 1,
    direction: "both",
    fanBudget: true,
    activationRule: "conductive",
    consolidationSource: "explicit",
    consolidatedAt: now,
    createdAt: now,
  };
  plan.put({ kind: "edge", value: result });
  return { result, ids: [result.id] };
}

async function planLinkMemories(
  plan: MemoryPlan,
  payload: Extract<LifecyclePlanPayload, { action: "linkMemories" }>,
): Promise<PlannedGraphOutput<MemoryRelationRecord>> {
  const { input, now, namespace } = payload;
  const rows = await plan.find({
    kind: "memory",
    ids: [input.sourceMemoryId, input.targetMemoryId],
    sessionId: input.sessionId,
  });
  const memories = rows.flatMap((row) => (row.kind === "memory" ? [row.value] : []));
  if (memories.length !== 2 || memories.some((m) => m.status === "deleted")) {
    throw new Error("Memory relations require two accessible memories");
  }
  const result: MemoryRelationRecord = {
    id: memoryIdentity(
      namespace,
      "memoryRelation",
      input.sourceMemoryId,
      input.targetMemoryId,
      input.type,
    ),
    sourceId: input.sourceMemoryId,
    targetId: input.targetMemoryId,
    sourceKind: "memory",
    targetKind: "memory",
    relationType: input.type,
    weight: input.weight ?? 1.0,
    status: "consolidated",
    direction: input.direction ?? "both",
    origin: "explicit",
    createdAt: now,
  };
  plan.put({ kind: "memoryRelation", value: result });
  return { result, ids: [result.id] };
}

async function planWithdraw(
  plan: MemoryPlan,
  memoryId: string,
  sessionId?: string,
): Promise<PlannedGraphOutput<{ memoryId: string; memory: MemoryRecord }>> {
  const found = await plan.find({ kind: "memory", ids: [memoryId], sessionId });
  if (found[0]?.kind !== "memory") throw new Error("Memory does not exist in this session");
  const nextMemory = { ...found[0].value, status: "deleted" as const };
  plan.put({ kind: "memory", value: nextMemory });
  return { result: { memoryId, memory: nextMemory }, ids: [memoryId] };
}

async function planUsageUpdate(
  plan: MemoryPlan,
  ids: readonly string[],
  now: string,
  sessionId?: string,
): Promise<PlannedGraphOutput<null>> {
  const rows = await plan.find({ kind: "memory", ids, sessionId });
  for (const row of rows) {
    if (row.kind !== "memory" || !visibleMemory(row.value, sessionId, now)) continue;
    plan.put({
      kind: "memory",
      value: { ...row.value, accessCount: row.value.accessCount + 1, lastAccessedAt: now },
    });
  }
  return { result: null, ids: [] };
}

async function planTesseraFingerprint(
  plan: MemoryPlan,
  input: Extract<LifecyclePlanPayload, { action: "tesseraFingerprint" }>["input"],
): Promise<PlannedGraphOutput<null>> {
  const [entity] = await plan.find({ kind: "tessera", ids: [input.id] });
  const owner = await plan.record(input.memoryId, input.sessionId);
  if (
    entity?.kind === "tessera" &&
    entity.value.memoryId === owner?.id &&
    entity.value.path === input.path &&
    !entity.value.fileSimhash
  ) {
    plan.put({ kind: "tessera", value: { ...entity.value, fileSimhash: input.fileSimhash } });
  }
  return { result: null, ids: [] };
}

type LifecycleActionHandler = (
  plan: MemoryPlan,
  payload: LifecyclePlanPayload,
) => Promise<PlannedGraphOutput<unknown>> | PlannedGraphOutput<unknown>;

const LIFECYCLE_HANDLERS: Record<LifecyclePlanPayload["action"], LifecycleActionHandler> = {
  resolution: async (plan, p) => {
    const payload = p as Extract<LifecyclePlanPayload, { action: "resolution" }>;
    return {
      result: await changeResolution(plan, payload.input, payload.now),
      ids: [payload.input.memoryId],
    };
  },
  supersession: async (plan, p) => {
    const payload = p as Extract<LifecyclePlanPayload, { action: "supersession" }>;
    return {
      result: await supersedeMemory(plan, payload.input, payload.now),
      ids: [payload.input.memoryId],
    };
  },
  relationProposal: async (plan, p) => {
    const payload = p as Extract<LifecyclePlanPayload, { action: "relationProposal" }>;
    return {
      result: await proposeMemoryRelation(plan, payload.input, payload.now),
      ids: [payload.input.memoryId],
    };
  },
  storageState: (plan, p) =>
    planStorageStateTransition(
      plan,
      p as Extract<LifecyclePlanPayload, { action: "storageState" }>,
    ),
  claimOutcomes: async (plan, p) => {
    const payload = p as Extract<LifecyclePlanPayload, { action: "claimOutcomes" }>;
    const result = await recordClaimOutcomes(plan, payload.input, payload.now);
    return { result, ids: result.events.map((event) => event.id) };
  },
  usage: (plan, p) => {
    const payload = p as Extract<LifecyclePlanPayload, { action: "usage" }>;
    return planUsageUpdate(plan, payload.ids, payload.now, payload.sessionId);
  },
  attachNode: async (plan, p) => {
    const payload = p as Extract<LifecyclePlanPayload, { action: "attachNode" }>;
    const result = await plan.attachNode(payload.memoryId, payload.input, payload.now);
    return { result, ids: [result.memory.id, result.node.id] };
  },
  linkNodes: (plan, p) =>
    planLinkNodes(plan, p as Extract<LifecyclePlanPayload, { action: "linkNodes" }>),
  linkMemories: (plan, p) =>
    planLinkMemories(plan, p as Extract<LifecyclePlanPayload, { action: "linkMemories" }>),
  withdraw: (plan, p) => {
    const payload = p as Extract<LifecyclePlanPayload, { action: "withdraw" }>;
    return planWithdraw(plan, payload.memoryId, payload.sessionId);
  },
  tesseraFingerprint: (plan, p) => {
    const payload = p as Extract<LifecyclePlanPayload, { action: "tesseraFingerprint" }>;
    return planTesseraFingerprint(plan, payload.input);
  },
  rejectionAudit: (plan, p) => {
    const payload = p as Extract<LifecyclePlanPayload, { action: "rejectionAudit" }>;
    plan.audit.push(payload.event);
    return { result: null, ids: [] };
  },
};

function executeLifecyclePlanAction(
  plan: MemoryPlan,
  payload: LifecyclePlanPayload,
): Promise<PlannedGraphOutput<unknown>> | PlannedGraphOutput<unknown> {
  return LIFECYCLE_HANDLERS[payload.action](plan, payload);
}

function buildWriteRegistry(): ComputeRegistry<MemoryPlan> {
  const registry = new ComputeRegistry<MemoryPlan>();
  const planWriteOp = (contract: string) => ({
    version: "1.0.0",
    effect: "write" as const,
    contract,
    cacheable: false,
    parallelSafe: false,
    reorderable: false,
    eliminable: false,
    idempotentWrite: true,
    transactional: true,
    // The plan belongs to one mutation. Revision checks at commit arbitrate writers.
    resources: { execution: "async_io" as const },
  });

  registry.register(
    "prefetch_remember_batch",
    async (inputs, plan): Promise<RememberPlanInput> => {
      const req = inputs.default as RememberPlanInput;
      await plan.prefetchRemember(req.inputs);
      return req;
    },
    planWriteOp("memory.write_plan"),
  );

  registry.register(
    "plan_remember_slots",
    async (inputs, plan): Promise<PlannedGraphOutput<RememberResult[]>> => {
      const req = inputs.default as RememberPlanInput;
      const result: RememberResult[] = [];
      for (const [slot, input] of req.inputs.entries()) {
        result.push(await plan.remember(input, req.operationId, slot, req.timestamp));
      }
      return { result, ids: result.map((item) => item.memory.id) };
    },
    planWriteOp("memory.write_plan"),
  );

  registry.register(
    "plan_lifecycle_mutation",
    (inputs, plan): Promise<PlannedGraphOutput<unknown>> | PlannedGraphOutput<unknown> => {
      const payload = inputs.default as LifecyclePlanPayload;
      return executeLifecyclePlanAction(plan, payload);
    },
    planWriteOp("memory.lifecycle_plan"),
  );

  return registry;
}

export const ENGINE_WRITE_REGISTRY = buildWriteRegistry();

export const DEFAULT_REMEMBER_PLAN_GRAPH: ComputeGraphSpec = {
  id: "engine-remember-plan-v1",
  nodes: [
    {
      id: "prefetch",
      op: "prefetch_remember_batch",
      contract: "memory.write_plan",
      sideEffect: true,
    },
    { id: "plan", op: "plan_remember_slots", contract: "memory.write_plan", sideEffect: true },
  ],
  edges: [
    { from: INPUT_NODE_ID, to: "prefetch" },
    { from: "prefetch", to: "plan" },
  ],
  output: "plan",
};

export const DEFAULT_LIFECYCLE_PLAN_GRAPH: ComputeGraphSpec = {
  id: "engine-lifecycle-plan-v1",
  nodes: [
    {
      id: "plan",
      op: "plan_lifecycle_mutation",
      contract: "memory.lifecycle_plan",
      sideEffect: true,
    },
  ],
  edges: [{ from: INPUT_NODE_ID, to: "plan" }],
  output: "plan",
};

const WRITE_PLAN_OPTIONS: PhysicalPlanOptions = {
  enableCse: false,
  enableDce: false,
  enableLinearFusion: false,
};

export function executeRememberPlanGraph(
  input: RememberPlanInput,
  plan: MemoryPlan,
  spec: ComputeGraphSpec = DEFAULT_REMEMBER_PLAN_GRAPH,
  registry: ComputeRegistry<MemoryPlan> = ENGINE_WRITE_REGISTRY,
): Promise<PlannedGraphOutput<RememberResult[]>> {
  return executeComputeGraph<RememberPlanInput, PlannedGraphOutput<RememberResult[]>, MemoryPlan>(
    spec,
    registry,
    input,
    plan,
    undefined,
    WRITE_PLAN_OPTIONS,
  );
}

export function executeLifecyclePlanGraph<T>(
  payload: LifecyclePlanPayload,
  plan: MemoryPlan,
  spec: ComputeGraphSpec = DEFAULT_LIFECYCLE_PLAN_GRAPH,
  registry: ComputeRegistry<MemoryPlan> = ENGINE_WRITE_REGISTRY,
): Promise<PlannedGraphOutput<T>> {
  return executeComputeGraph<LifecyclePlanPayload, PlannedGraphOutput<T>, MemoryPlan>(
    spec,
    registry,
    payload,
    plan,
    undefined,
    WRITE_PLAN_OPTIONS,
  );
}
