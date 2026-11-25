import { performance } from "node:perf_hooks";
import type { SchedulingObjective } from "../capability-config.ts";
import {
  INPUT_NODE_ID,
  type ComputeEffectKind,
  type ComputeResourceProfile,
} from "../compute-contracts.ts";
import type { ComputeRegistry } from "../compute-graph.ts";
import {
  computeNodeSignature,
  contextSignature,
  gatherNodeInputs,
  inputSignature,
  isCacheableNode,
  releaseConsumedInputs,
  type ComputeExecutionDiagnostics,
  type ComputeMemoCache,
} from "../compute-graph.ts";
import type { PhysicalExecutionPlan, PhysicalNodePlan } from "../compute-planner.ts";
import { ResourceLockManager } from "../resource-locks.ts";
import { ComputeCostModel, computeUpwardRanks, evaluatePlacementCost } from "./cost-model.ts";
export { ResourceLockManager } from "../resource-locks.ts";
import { HostLoadGovernor, type AdaptiveDispatchBudget } from "./load-governor.ts";
import { LocalWorkerThreadPool, SchedulingDomain } from "./worker-pool.ts";

export type TaskPriority = "foreground" | "normal" | "background";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly delayMs?: number;
}

export interface ScheduledTaskOptions {
  readonly priority?: TaskPriority;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly resources?: ComputeResourceProfile;
  readonly effect?: ComputeEffectKind;
  readonly idempotentWrite?: boolean;
  readonly retryPolicy?: RetryPolicy;
  readonly upwardRankMs?: number;
  readonly label?: string;
}

/** Event-driven zero-poll wait latch replacing setInterval/setTimeout polling loops. */
export class ZeroPollLatch {
  private count = 0;
  private waiters: Array<() => void> = [];

  get current(): number {
    return this.count;
  }

  increment(): void {
    this.count += 1;
  }

  decrement(): void {
    this.count = Math.max(0, this.count - 1);
    if (this.count === 0) {
      const pending = this.waiters;
      this.waiters = [];
      for (const resolve of pending) resolve();
    }
  }

  async waitForZero(timeoutMs?: number, timeoutError?: () => Error): Promise<void> {
    if (this.count === 0) return;
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      throw timeoutError ? timeoutError() : new Error(`Timed out waiting after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onZero = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.waiters.push(onZero);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== onZero);
          reject(
            timeoutError ? timeoutError() : new Error(`Timed out waiting after ${timeoutMs}ms`),
          );
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }
}

/** Nginx/Singleflight concurrent identical cacheable computation deduplicator. */
export class InFlightCoalescer {
  private readonly pending = new Map<string, Promise<unknown>>();

  get size(): number {
    return this.pending.size;
  }

  async coalesce<T>(key: string, run: () => Promise<T>): Promise<{ value: T; coalesced: boolean }> {
    const existing = this.pending.get(key);
    if (existing) {
      const shared = await existing;
      return { value: cloneIsolated(shared) as T, coalesced: true };
    }
    const promise = run().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    const result = await promise;
    return { value: cloneIsolated(result) as T, coalesced: false };
  }
}

function cloneIsolated(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

interface QueuedEntry {
  readonly run: () => Promise<unknown>;
  readonly options: ScheduledTaskOptions;
  readonly enqueuedAt: number;
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: unknown) => void;
}

/** Shared event-driven runtime scheduler combining priorities, anti-starvation, R/W locks, coalescing, HEFT placement, and BOINC load budgets. */
export class UnifiedRuntimeScheduler {
  readonly costModel: ComputeCostModel;
  readonly governor: HostLoadGovernor;
  readonly domain: SchedulingDomain;
  readonly locks = new ResourceLockManager();
  readonly coalescer = new InFlightCoalescer();
  readonly inFlightLatch = new ZeroPollLatch();
  private readonly queues: Record<TaskPriority, QueuedEntry[]> = {
    foreground: [],
    normal: [],
    background: [],
  };
  private activeForeground = 0;
  private activeNormal = 0;
  private activeBackground = 0;
  private readonly objective: SchedulingObjective;
  private readonly minOffloadCpuMs: number;
  private readonly maxConcurrentBackground?: number;
  private readonly starvationMaxWaitMs: number;
  private closed = false;

  constructor(
    options: {
      readonly profile?: "eco" | "balanced" | "performance";
      readonly objective?: SchedulingObjective;
      readonly maxWorkers?: number;
      readonly minOffloadCpuMs?: number;
      readonly maxConcurrentBackground?: number;
      readonly starvationMaxWaitMs?: number;
      readonly costModel?: ComputeCostModel;
      readonly governor?: HostLoadGovernor;
      readonly domain?: SchedulingDomain;
    } = {},
  ) {
    this.costModel = options.costModel ?? new ComputeCostModel();
    this.governor =
      options.governor ?? new HostLoadGovernor({ profile: options.profile ?? "balanced" });
    this.objective = options.objective ?? "latency";
    this.minOffloadCpuMs = options.minOffloadCpuMs ?? 1.5;
    this.maxConcurrentBackground = options.maxConcurrentBackground;
    this.starvationMaxWaitMs = options.starvationMaxWaitMs ?? 1500;
    this.domain =
      options.domain ??
      new SchedulingDomain(
        "local-domain",
        options.maxWorkers && options.maxWorkers > 0
          ? [new LocalWorkerThreadPool({ maxWorkers: options.maxWorkers })]
          : [],
      );
  }

  get activeCounts() {
    return {
      foreground: this.activeForeground,
      normal: this.activeNormal,
      background: this.activeBackground,
      queuedBackground: this.queues.background.length,
    };
  }

  runTask<T>(run: () => Promise<T> | T, options: ScheduledTaskOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Scheduler is closed"));
    options.signal?.throwIfAborted();
    const priority = options.priority ?? "foreground";
    return new Promise<T>((resolve, reject) => {
      const entry: QueuedEntry = {
        run: () => executeWithTimeoutAndRetry(run, options),
        options,
        enqueuedAt: performance.now(),
        resolve: (v) => resolve(v as T),
        reject,
      };
      this.queues[priority].push(entry);
      this.pump();
    });
  }

  private effectiveBgLimit(budget: AdaptiveDispatchBudget): number {
    const cap = this.maxConcurrentBackground ?? budget.maxBackgroundConcurrency;
    return this.activeForeground > 0 ? Math.min(1, cap) : cap;
  }

  private pump(): void {
    if (this.closed) return;
    this.drainQueue("foreground", () => true);
    this.drainQueue("normal", () => true);
    const budget = this.governor.sampleHost();
    const bgLimit = this.effectiveBgLimit(budget);
    const now = performance.now();
    this.promoteStarvedBackground(now);
    this.drainQueue("background", () => this.activeBackground < bgLimit);
  }

  private promoteStarvedBackground(now: number): void {
    while (this.queues.background.length > 0) {
      const oldest = this.queues.background[0]!;
      if (now - oldest.enqueuedAt < this.starvationMaxWaitMs) break;
      this.queues.background.shift();
      this.queues.normal.push(oldest);
    }
  }

  private drainQueue(priority: TaskPriority, canStart: () => boolean): void {
    const queue = this.queues[priority];
    queue.sort((a, b) => (b.options.upwardRankMs ?? 0) - (a.options.upwardRankMs ?? 0));
    while (queue.length > 0 && canStart()) {
      const next = queue.shift()!;
      this.dispatchEntry(priority, next);
    }
  }

  private dispatchEntry(priority: TaskPriority, entry: QueuedEntry): void {
    this.adjustActive(priority, 1);
    this.inFlightLatch.increment();
    const exec = () => this.locks.withResources(entry.options.resources, entry.run);
    Promise.resolve()
      .then(exec)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.adjustActive(priority, -1);
        this.inFlightLatch.decrement();
        this.pump();
      });
  }

  private adjustActive(priority: TaskPriority, delta: number): void {
    if (priority === "foreground") this.activeForeground += delta;
    else if (priority === "normal") this.activeNormal += delta;
    else this.activeBackground += delta;
  }

  /** Event-driven DAG executor eliminating full-wave Promise.all barriers while preserving resource/side-effect order. */
  async executePlan<TIn, TOut, TContext>(
    plan: PhysicalExecutionPlan,
    registry: ComputeRegistry<TContext>,
    input: TIn,
    context: TContext,
    options: {
      readonly memo?: ComputeMemoCache;
      readonly diagnostics?: ComputeExecutionDiagnostics;
      readonly priority?: TaskPriority;
      readonly signal?: AbortSignal;
      readonly itemEstimate?: number;
      readonly invokeNodeAsync: (
        node: PhysicalNodePlan,
        registry: ComputeRegistry<TContext>,
        inputs: Record<string, unknown>,
        context: TContext,
        memo: ComputeMemoCache | undefined,
        cacheable: boolean,
      ) => Promise<unknown>;
    },
  ): Promise<TOut> {
    if (options.diagnostics) options.diagnostics.plan = plan;
    const ranks = computeUpwardRanks(plan, this.costModel, options.itemEstimate ?? 16);
    const outputs = new Map<string, unknown>([[INPUT_NODE_ID, input]]);
    if (plan.order.length === 0) return outputs.get(plan.outputNodeId) as TOut;
    const remainingConsumers = new Map<string, number>(plan.consumerCounts);
    const useMemo = options.memo !== undefined;
    const signatures = useMemo ? new Map([[INPUT_NODE_ID, inputSignature(input)]]) : undefined;
    const contextSig = useMemo ? contextSignature(context) : "";
    const { pendingDeps, serialDeps, nodeById } = buildSchedulerDependencies(plan.order);
    const readyQueue = plan.order.filter((node) => pendingDeps.get(node.id) === 0);

    return new Promise<TOut>((resolve, reject) => {
      let remainingNodes = plan.order.length;
      let aborted = false;

      const scheduleNode = (node: PhysicalNodePlan) => {
        if (aborted) return;
        const execNode = () =>
          this.executeSingleDagNode(node, {
            plan,
            registry,
            input,
            context,
            outputs,
            remainingConsumers,
            useMemo,
            memo: options.memo,
            signatures,
            contextSig,
            diagnostics: options.diagnostics,
            priority: options.priority ?? "foreground",
            signal: options.signal,
            itemEstimate: options.itemEstimate ?? 16,
            invokeNodeAsync: options.invokeNodeAsync,
          });

        this.runTask(execNode, {
          priority: options.priority ?? "foreground",
          upwardRankMs: ranks.get(node.id) ?? 0,
          resources: node.capabilities.resources,
          signal: options.signal,
          label: `${plan.logicalGraphId}:${node.id}`,
        })
          .then((value) => {
            if (aborted) return;
            outputs.set(node.id, value);
            if (options.diagnostics && outputs.size > options.diagnostics.peakLiveOutputs) {
              options.diagnostics.peakLiveOutputs = outputs.size;
            }
            releaseConsumedInputs(node.incoming, remainingConsumers, outputs, plan.outputNodeId);
            remainingNodes -= 1;
            if (remainingNodes === 0) {
              resolve(outputs.get(plan.outputNodeId) as TOut);
              return;
            }
            wakeDownstreamNodes(node.id, plan, serialDeps, pendingDeps, nodeById, scheduleNode);
          })
          .catch((error) => {
            if (aborted) return;
            aborted = true;
            reject(error);
          });
      };

      for (const ready of readyQueue) scheduleNode(ready);
    });
  }

  private async executeSingleDagNode<TIn, TContext>(
    node: PhysicalNodePlan,
    ctx: {
      plan: PhysicalExecutionPlan;
      registry: ComputeRegistry<TContext>;
      input: TIn;
      context: TContext;
      outputs: Map<string, unknown>;
      remainingConsumers: Map<string, number>;
      useMemo: boolean;
      memo: ComputeMemoCache | undefined;
      signatures: Map<string, string> | undefined;
      contextSig: string;
      diagnostics: ComputeExecutionDiagnostics | undefined;
      priority: TaskPriority;
      signal: AbortSignal | undefined;
      itemEstimate: number;
      invokeNodeAsync: (
        node: PhysicalNodePlan,
        registry: ComputeRegistry<TContext>,
        inputs: Record<string, unknown>,
        context: TContext,
        memo: ComputeMemoCache | undefined,
        cacheable: boolean,
      ) => Promise<unknown>;
    },
  ): Promise<unknown> {
    if (ctx.useMemo && ctx.memo && ctx.signatures) {
      const cacheable = isCacheableNode(node, node.incoming, ctx.signatures, ctx.context);
      const sig = computeNodeSignature(
        node,
        node.incoming,
        ctx.signatures,
        ctx.registry,
        ctx.contextSig,
        cacheable,
      );
      ctx.signatures.set(node.id, sig);
      const cached = cacheable ? ctx.memo.get(sig) : undefined;
      if (cached?.found) {
        if (ctx.diagnostics) ctx.diagnostics.cacheHits += 1;
        return cached.value;
      }
      const runFresh = async () => {
        const inputs = gatherNodeInputs(node.incoming, ctx.outputs, ctx.input);
        return this.dispatchComputeOrWorker(
          node,
          ctx.registry,
          inputs,
          ctx.context,
          ctx.memo,
          cacheable,
          ctx.priority,
          ctx.itemEstimate,
          ctx.signal,
          ctx.invokeNodeAsync,
        );
      };
      const value = cacheable
        ? (await this.coalescer.coalesce(sig, runFresh)).value
        : await runFresh();
      const stored = cacheable ? ctx.memo.set(sig, value) : false;
      if (cacheable && !stored) ctx.signatures.set(node.id, `tainted:${sig.slice(0, 8)}`);
      if (ctx.diagnostics) {
        ctx.diagnostics.executedNodes += 1;
        if (!cacheable) ctx.diagnostics.cacheSkips += 1;
      }
      return value;
    }
    const inputs = gatherNodeInputs(node.incoming, ctx.outputs, ctx.input);
    const value = await this.dispatchComputeOrWorker(
      node,
      ctx.registry,
      inputs,
      ctx.context,
      undefined,
      false,
      ctx.priority,
      ctx.itemEstimate,
      ctx.signal,
      ctx.invokeNodeAsync,
    );
    if (ctx.diagnostics) ctx.diagnostics.executedNodes += 1;
    return value;
  }

  private async dispatchComputeOrWorker<TContext>(
    node: PhysicalNodePlan,
    registry: ComputeRegistry<TContext>,
    inputs: Record<string, unknown>,
    context: TContext,
    memo: ComputeMemoCache | undefined,
    cacheable: boolean,
    priority: TaskPriority,
    itemEstimate: number,
    signal: AbortSignal | undefined,
    invokeNodeAsync: (
      node: PhysicalNodePlan,
      registry: ComputeRegistry<TContext>,
      inputs: Record<string, unknown>,
      context: TContext,
      memo: ComputeMemoCache | undefined,
      cacheable: boolean,
    ) => Promise<unknown>,
  ): Promise<unknown> {
    const budget = this.governor.sampleHost();
    const workers = this.domain.getWorkers();
    if (node.kind === "operator" && workers.some((w) => w.supports(node.op))) {
      const placement = evaluatePlacementCost({
        node,
        costModel: this.costModel,
        itemCount: itemEstimate,
        payloadBytes: 512,
        minOffloadCpuMs: this.minOffloadCpuMs,
        objective: this.objective,
        localQueueDepth: this.queues.foreground.length + this.queues.background.length,
        candidates: workers,
        preferOffload: budget.preferWorkerOffload,
      });
      if (placement.offload) {
        try {
          const res = await this.domain.execute(
            {
              op: node.op,
              inputs,
              context: sanitizeWorkerContext(context),
              params: node.params,
              background: priority === "background",
            },
            signal,
          );
          this.costModel.observe(node.op, { cpuMs: res.cpuMs, waitMs: res.ipcMs });
          return res.value;
        } catch {
          // Safe fallback to local inline execution if payload or worker serialization rejects
        }
      }
    }
    const start = performance.now();
    const out = await invokeNodeAsync(node, registry, inputs, context, memo, cacheable);
    this.costModel.observe(node.op, { cpuMs: performance.now() - start });
    return out;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.governor.close();
    await this.domain.close();
  }
}

function sanitizeWorkerContext(context: unknown): unknown {
  if (context === null || typeof context !== "object") return context;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context as Record<string, unknown>)) {
    if (typeof v !== "function") out[k] = v;
  }
  return out;
}

function retryAllowed(effect: ComputeEffectKind | undefined, idempotentWrite?: boolean): boolean {
  return effect === "pure" || effect === "read" || Boolean(idempotentWrite);
}

async function executeWithTimeoutAndRetry<T>(
  run: () => Promise<T> | T,
  options: ScheduledTaskOptions,
): Promise<T> {
  const maxAttempts =
    options.retryPolicy && retryAllowed(options.effect, options.idempotentWrite)
      ? Math.max(1, options.retryPolicy.maxAttempts)
      : 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      const execPromise = Promise.resolve().then(run);
      if (options.timeoutMs === undefined) return await execPromise;
      return await raceWithTimeout(execPromise, options.timeoutMs, options.signal);
    } catch (error) {
      lastErr = error;
      if (attempt >= maxAttempts || options.signal?.aborted) throw error;
      if (options.retryPolicy?.delayMs) {
        await new Promise((r) => setTimeout(r, options.retryPolicy!.delayMs));
      }
    }
  }
  throw lastErr;
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Task timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason instanceof Error ? signal!.reason : new Error("Task aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

let sharedScheduler: UnifiedRuntimeScheduler | undefined;

/** Return process-shared default runtime scheduler, creating it lazily on demand. */
export function getSharedRuntimeScheduler(): UnifiedRuntimeScheduler {
  sharedScheduler ??= new UnifiedRuntimeScheduler();
  return sharedScheduler;
}

function isSerialPlanNode(node: PhysicalNodePlan): boolean {
  return (
    !node.capabilities.parallelSafe ||
    (node.capabilities.effect !== "pure" && node.capabilities.effect !== "read")
  );
}

function buildSchedulerDependencies(order: readonly PhysicalNodePlan[]) {
  const pendingDeps = new Map<string, number>();
  const serialDeps = new Map<string, string[]>();
  const nodeById = new Map(order.map((node) => [node.id, node]));
  let lastSerial: string | undefined;
  for (const node of order) {
    const dataDeps = new Set(
      node.incoming.filter((e) => e.from !== INPUT_NODE_ID).map((e) => e.from),
    );
    if (isSerialPlanNode(node)) {
      if (lastSerial && !dataDeps.has(lastSerial)) {
        dataDeps.add(lastSerial);
        const list = serialDeps.get(lastSerial) ?? [];
        list.push(node.id);
        serialDeps.set(lastSerial, list);
      }
      lastSerial = node.id;
    }
    pendingDeps.set(node.id, dataDeps.size);
  }
  return { pendingDeps, serialDeps, nodeById };
}

function wakeDownstreamNodes(
  nodeId: string,
  plan: PhysicalExecutionPlan,
  serialDeps: ReadonlyMap<string, readonly string[]>,
  pendingDeps: Map<string, number>,
  nodeById: ReadonlyMap<string, PhysicalNodePlan>,
  scheduleNode: (node: PhysicalNodePlan) => void,
): void {
  const dependents = [...(plan.outgoing.get(nodeId) ?? []), ...(serialDeps.get(nodeId) ?? [])];
  for (const depId of dependents) {
    const nextDeg = (pendingDeps.get(depId) ?? 1) - 1;
    pendingDeps.set(depId, nextDeg);
    if (nextDeg === 0) {
      const depNode = nodeById.get(depId);
      if (depNode) scheduleNode(depNode);
    }
  }
}
