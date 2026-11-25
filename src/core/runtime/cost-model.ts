import type { SchedulingObjective } from "../capability-config.ts";
import type { ComputeCostHint } from "../compute-contracts.ts";
import type { PhysicalExecutionPlan, PhysicalNodePlan } from "../compute-planner.ts";

export interface OpCostStats {
  invocations: number;
  emaCpuMs: number;
  emaWaitMs: number;
  emaSerializedBytes: number;
}

export interface NodeCostEstimate {
  readonly cpuMs: number;
  readonly waitMs: number;
  readonly transferMs: number;
  readonly totalMs: number;
}

export interface WorkerPlacementTarget {
  readonly id: string;
  readonly kind: "inline" | "worker_thread" | "domain" | "external";
  readonly capacity: number;
  readonly activeLoad: number;
  estimatedQueueWaitMs(payloadBytes: number): number;
}

export interface PlacementDecision {
  readonly targetId: string;
  readonly offload: boolean;
  readonly localEftMs: number;
  readonly targetEftMs: number;
  readonly reason: string;
}

const DEFAULT_BASE_MS = 0.08;
const DEFAULT_PER_ITEM_US = 2.0;
const WORKER_SWITCH_OVERHEAD_MS = 0.35;
const IPC_BYTES_PER_MS = 32_768;

/** Calibrated per-operator cost model combining static ComputeCostHint with rolling EMA telemetry. */
export class ComputeCostModel {
  private readonly stats = new Map<string, OpCostStats>();
  private readonly alpha: number;

  constructor(alpha = 0.25) {
    this.alpha = Math.max(0.05, Math.min(0.9, alpha));
  }

  observe(
    op: string,
    sample: { readonly cpuMs: number; readonly waitMs?: number; readonly serializedBytes?: number },
  ): void {
    const cpu = Math.max(0, sample.cpuMs);
    const wait = Math.max(0, sample.waitMs ?? 0);
    const bytes = Math.max(0, sample.serializedBytes ?? 0);
    const prev = this.stats.get(op);
    if (!prev) {
      this.stats.set(op, {
        invocations: 1,
        emaCpuMs: cpu,
        emaWaitMs: wait,
        emaSerializedBytes: bytes,
      });
      return;
    }
    const a = this.alpha;
    prev.invocations += 1;
    prev.emaCpuMs = (1 - a) * prev.emaCpuMs + a * cpu;
    prev.emaWaitMs = (1 - a) * prev.emaWaitMs + a * wait;
    prev.emaSerializedBytes = (1 - a) * prev.emaSerializedBytes + a * bytes;
  }

  getStats(op: string): OpCostStats | undefined {
    const found = this.stats.get(op);
    return found ? { ...found } : undefined;
  }

  estimate(op: string, hint: ComputeCostHint | undefined, itemCount = 16): NodeCostEstimate {
    const measured = this.stats.get(op);
    const hintCpu =
      (hint?.baseMs ?? DEFAULT_BASE_MS) +
      ((hint?.perItemUs ?? DEFAULT_PER_ITEM_US) * itemCount) / 1000;
    const cpuMs = measured ? measured.emaCpuMs : hintCpu;
    const waitMs = measured ? measured.emaWaitMs : 0;
    const transferMs = measured ? measured.emaSerializedBytes / IPC_BYTES_PER_MS : 0;
    return { cpuMs, waitMs, transferMs, totalMs: cpuMs + waitMs };
  }
}

/** HEFT upward critical-path rank (rank_u) across a compiled PhysicalExecutionPlan. */
export function computeUpwardRanks(
  plan: PhysicalExecutionPlan,
  costModel: ComputeCostModel,
  itemCount = 16,
): Map<string, number> {
  const byId = new Map<string, PhysicalNodePlan>(plan.order.map((node) => [node.id, node]));
  const ranks = new Map<string, number>();
  for (let i = plan.order.length - 1; i >= 0; i -= 1) {
    const node = plan.order[i]!;
    const est = costModel.estimate(node.op, node.capabilities.costHint, itemCount);
    const children = plan.outgoing.get(node.id) ?? [];
    let maxChild = 0;
    for (const childId of children) {
      const childRank = ranks.get(childId) ?? 0;
      const childNode = byId.get(childId);
      const commMs = childNode ? est.transferMs : 0;
      const candidate = childRank + commMs;
      if (candidate > maxChild) maxChild = candidate;
    }
    ranks.set(node.id, est.totalMs + maxChild);
  }
  return ranks;
}

/**
 * Evaluate whether executing a pure node locally or offloading to a worker improves the chosen objective.
 * Refuses worker offload for microsecond operators or non-pure/unparallelizable operations.
 */
export function evaluatePlacementCost(options: {
  readonly node: PhysicalNodePlan;
  readonly costModel: ComputeCostModel;
  readonly itemCount: number;
  readonly payloadBytes: number;
  readonly minOffloadCpuMs: number;
  readonly objective: SchedulingObjective;
  readonly localQueueDepth: number;
  readonly candidates: readonly WorkerPlacementTarget[];
  readonly preferOffload: boolean;
}): PlacementDecision {
  const est = options.costModel.estimate(
    options.node.op,
    options.node.capabilities.costHint,
    options.itemCount,
  );
  const localEftMs = options.localQueueDepth * 0.4 + est.totalMs;
  const eligible =
    options.preferOffload &&
    options.node.capabilities.effect === "pure" &&
    options.node.capabilities.parallelSafe &&
    options.node.capabilities.resources.execution !== "async_io" &&
    est.cpuMs >= options.minOffloadCpuMs &&
    options.candidates.length > 0;

  if (!eligible) {
    return {
      targetId: "inline",
      offload: false,
      localEftMs,
      targetEftMs: localEftMs,
      reason:
        est.cpuMs < options.minOffloadCpuMs ? "below_min_offload_cpu_threshold" : "local_affinity",
    };
  }

  let bestTarget: WorkerPlacementTarget | undefined;
  let bestEft = Number.POSITIVE_INFINITY;
  const transferMs = options.payloadBytes / IPC_BYTES_PER_MS + WORKER_SWITCH_OVERHEAD_MS;
  for (const worker of options.candidates) {
    if (worker.kind === "inline") continue;
    const queueMs = worker.estimatedQueueWaitMs(options.payloadBytes);
    const eft = queueMs + transferMs + est.cpuMs;
    if (eft < bestEft) {
      bestEft = eft;
      bestTarget = worker;
    }
  }

  const thresholdFactor = options.objective === "throughput" ? 1.05 : 0.92;
  if (bestTarget && bestEft < localEftMs * thresholdFactor) {
    return {
      targetId: bestTarget.id,
      offload: true,
      localEftMs,
      targetEftMs: bestEft,
      reason: "worker_eft_advantage",
    };
  }
  return {
    targetId: "inline",
    offload: false,
    localEftMs,
    targetEftMs: bestEft,
    reason: "local_eft_faster",
  };
}
