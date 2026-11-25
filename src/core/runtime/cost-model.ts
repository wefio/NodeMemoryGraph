import type { SchedulingObjective } from "../capability-config.ts";
import type { ComputeCostHint } from "../compute-contracts.ts";
import type { PhysicalExecutionPlan, PhysicalNodePlan } from "../compute-planner.ts";

export interface OpCostStats {
  invocations: number;
  emaCpuMs: number;
  emaSerializedBytes: number;
  emaCommunicationMs: number;
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
  private readonly bySize = new Map<string, OpCostStats>();
  /** Observed interruption/I/O wait per operator, kept out of the CPU samples. */
  private readonly waits = new Map<string, number>();
  private readonly alpha: number;

  constructor(alpha = 0.25) {
    this.alpha = Math.max(0.05, Math.min(0.9, alpha));
  }

  observe(op: string, sample: CostSample): void {
    this.update(this.stats, op, sample);
    if (sample.itemCount !== undefined)
      this.update(this.bySize, sizeKey(op, sample.itemCount), sample);
  }

  /**
   * Record the wall time an operator spent suspended (I/O, timers, provider calls).
   * It is a separate sample so an I/O-bound operator never rewrites its CPU estimate.
   */
  observeWait(op: string, waitMs: number): void {
    const wait = Math.max(0, waitMs);
    const previous = this.waits.get(op);
    const a = this.alpha;
    this.waits.set(op, previous === undefined ? wait : (1 - a) * previous + a * wait);
  }

  private update(stats: Map<string, OpCostStats>, key: string, sample: CostSample): void {
    const cpu = Math.max(0, sample.cpuMs);
    const prev = stats.get(key);
    const bytes = sample.serializedBytes ?? prev?.emaSerializedBytes ?? 0;
    const communication = sample.communicationMs ?? prev?.emaCommunicationMs ?? 0;
    if (!prev) {
      stats.set(key, {
        invocations: 1,
        emaCpuMs: cpu,
        emaSerializedBytes: bytes,
        emaCommunicationMs: communication,
      });
      return;
    }
    const a = this.alpha;
    prev.invocations += 1;
    prev.emaCpuMs = (1 - a) * prev.emaCpuMs + a * cpu;
    prev.emaSerializedBytes = (1 - a) * prev.emaSerializedBytes + a * bytes;
    prev.emaCommunicationMs = (1 - a) * prev.emaCommunicationMs + a * communication;
  }

  getStats(op: string): OpCostStats | undefined {
    const found = this.stats.get(op);
    return found ? { ...found } : undefined;
  }

  estimate(op: string, hint: ComputeCostHint | undefined, itemCount = 16): NodeCostEstimate {
    const measured =
      this.bySize.get(sizeKey(op, itemCount)) ?? (hint ? undefined : this.stats.get(op));
    const hintCpu =
      (hint?.baseMs ?? DEFAULT_BASE_MS) +
      ((hint?.perItemUs ?? DEFAULT_PER_ITEM_US) * itemCount) / 1000;
    const cpuMs = measured ? measured.emaCpuMs : hintCpu;
    const waitMs = this.waits.get(op) ?? 0;
    const transferMs = measured ? measured.emaSerializedBytes / IPC_BYTES_PER_MS : 0;
    return { cpuMs, waitMs, transferMs, totalMs: cpuMs + waitMs };
  }
}

interface CostSample {
  readonly cpuMs: number;
  readonly serializedBytes?: number;
  readonly communicationMs?: number;
  readonly itemCount?: number;
}

function sizeKey(op: string, items: number): string {
  return op + ":" + Math.floor(Math.log2(Math.max(1, items)));
}

/** HEFT upward critical-path rank (rank_u) across a compiled PhysicalExecutionPlan. */
export function computeUpwardRanks(
  plan: PhysicalExecutionPlan,
  costModel: ComputeCostModel,
  itemCount = 16,
): Map<string, number> {
  const ranks = new Map<string, number>();
  for (let i = plan.order.length - 1; i >= 0; i -= 1) {
    const node = plan.order[i]!;
    const est = costModel.estimate(node.op, node.capabilities.costHint, itemCount);
    const children = plan.dependencies.followers.get(node.id) ?? [];
    let maxChild = 0;
    for (const child of children) {
      maxChild = Math.max(maxChild, ranks.get(child.id) ?? 0);
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
  const localEftMs = (1 + options.localQueueDepth) * est.cpuMs + est.waitMs;
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
  const transferMs = estimateTransferMs(
    options.costModel.getStats(options.node.op),
    options.payloadBytes,
  );
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

function estimateTransferMs(stats: OpCostStats | undefined, bytes: number): number {
  const measured = stats?.emaSerializedBytes
    ? (stats.emaCommunicationMs * bytes) / stats.emaSerializedBytes
    : 0;
  return Math.max(measured, bytes / IPC_BYTES_PER_MS + WORKER_SWITCH_OVERHEAD_MS);
}
