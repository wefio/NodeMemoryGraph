import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  resolveLayeredConfig,
  type RuntimePolicy,
  type RuntimePowerProfile,
} from "../capability-config.ts";
import {
  INPUT_NODE_ID,
  type ComputeEffectKind,
  type ComputeCostHint,
  type ComputeResourceProfile,
} from "../compute-contracts.ts";
import type { ComputeRegistry } from "../compute-graph.ts";
import {
  gatherNodeInputs,
  inputSignature,
  invokeNodeAsync,
  memoContextSignature,
  prepareNodeMemo,
  releaseConsumedInputs,
  safeCloneForCache,
  unwrapDefaultPayload,
  type ComputeExecutionDiagnostics,
  type ComputeMemoCache,
} from "../compute-graph.ts";
import type { PhysicalExecutionPlan, PhysicalNodePlan } from "../compute-planner.ts";
import { hasNamedResources, ResourceLockManager } from "../resource-locks.ts";
import { ComputeCostModel, computeUpwardRanks, evaluatePlacementCost } from "./cost-model.ts";
export { ResourceLockManager } from "../resource-locks.ts";
import {
  availableHostCores,
  HostLoadGovernor,
  type AdaptiveDispatchBudget,
} from "./load-governor.ts";
import {
  estimateWorkerPayloadBytes,
  LocalWorkerThreadPool,
  SchedulingDomain,
  type RuntimeWorker,
  type WorkerTaskRequest,
} from "./worker-pool.ts";

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
  readonly onAdmission?: (queueMs: number, resourceWaitMs: number) => void;
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
      const shared = safeCloneForCache(await existing);
      if (shared.ok) return { value: shared.value as T, coalesced: true };
      return { value: await run(), coalesced: false };
    }
    const promise = Promise.resolve()
      .then(run)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    const result = await promise;
    const isolated = safeCloneForCache(result);
    return { value: (isolated.ok ? isolated.value : result) as T, coalesced: false };
  }
}

interface RuntimeScope {
  readonly policy: RuntimePolicy;
  readonly scheduler?: UnifiedRuntimeScheduler;
  readonly priority?: TaskPriority;
  readonly signal?: AbortSignal;
  readonly admission?: { active: boolean; locked: boolean; priority?: TaskPriority };
}

const scope = new AsyncLocalStorage<RuntimeScope>();
const sharedLocks = new ResourceLockManager();
const defaults = resolveLayeredConfig({}).values.runtime as RuntimePolicy;
const NO_RELEASE = () => {};
const CPU_WINDOW_MS = 100;

export function withRuntimePolicy<T>(
  policy: RuntimePolicy | undefined,
  run: () => T,
  scheduler?: UnifiedRuntimeScheduler,
): T {
  const parent = scope.getStore();
  if (!policy && !scheduler) return run();
  return scope.run(
    {
      ...parent,
      policy: policy ?? parent?.policy ?? defaults,
      scheduler: scheduler ?? parent?.scheduler,
    },
    run,
  );
}

interface QueuedEntry {
  readonly run: (signal: AbortSignal) => unknown;
  readonly options: ScheduledTaskOptions;
  readonly lifetime: RuntimeScope & { signal: AbortSignal };
  readonly enqueuedAt: number;
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: unknown) => void;
  resourceWaitStarted?: number;
  finish(): void;
}

export interface RuntimeGraphOptions<TContext = unknown> {
  readonly memo?: ComputeMemoCache;
  readonly diagnostics?: ComputeExecutionDiagnostics;
  readonly priority?: TaskPriority;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly itemEstimate?: number;
  readonly invokeNodeAsync?: (
    node: PhysicalNodePlan,
    registry: ComputeRegistry<TContext>,
    inputs: Record<string, unknown>,
    context: TContext,
    memo: ComputeMemoCache | undefined,
    cacheable: boolean,
  ) => unknown;
}

type SchedulerOptions = Partial<RuntimePolicy> & {
  readonly costModel?: ComputeCostModel;
  readonly governor?: HostLoadGovernor;
  readonly domain?: SchedulingDomain;
  readonly locks?: ResourceLockManager;
};

interface GraphState<TContext> {
  readonly registry: ComputeRegistry<TContext>;
  readonly input: unknown;
  readonly context: TContext;
  readonly options: RuntimeGraphOptions<TContext>;
  readonly signal: AbortSignal;
  readonly outputs: Map<string, unknown>;
  readonly signatures?: Map<string, string>;
  readonly contextSig: string;
}

export class UnifiedRuntimeScheduler {
  readonly costModel: ComputeCostModel;
  readonly governor: HostLoadGovernor;
  readonly domain: SchedulingDomain;
  readonly locks: ResourceLockManager;
  readonly coalescer = new InFlightCoalescer();
  readonly inFlightLatch = new ZeroPollLatch();
  private readonly policy: RuntimePolicy;
  private readonly governors = new Map<RuntimePowerProfile, HostLoadGovernor>();
  private readonly queues: Record<TaskPriority, QueuedEntry[]> = {
    foreground: [],
    normal: [],
    background: [],
  };
  private readonly active: Record<TaskPriority, number> = {
    foreground: 0,
    normal: 0,
    background: 0,
  };
  private readonly shutdown = new AbortController();
  private pumpPending = false;
  private backgroundTurn?: ReturnType<typeof setImmediate>;
  private stopWatchingLocks?: () => void;
  private budgetWake?: ReturnType<typeof setTimeout>;
  private cpuWindowStart = performance.now();
  private backgroundCpuMs = 0;
  private backgroundReservedMs = 0;

  constructor(options: SchedulerOptions = {}) {
    this.policy = { ...defaults, ...options };
    this.locks = options.locks ?? sharedLocks;
    this.costModel = options.costModel ?? new ComputeCostModel();
    this.governor = options.governor ?? new HostLoadGovernor({ profile: this.policy.profile });
    this.governors.set(this.policy.profile, this.governor);
    this.domain =
      options.domain ??
      new SchedulingDomain("local-domain", [
        new LocalWorkerThreadPool({
          maxWorkers: options.maxWorkers || Math.min(64, availableHostCores()),
        }),
      ]);
  }

  get activeCounts() {
    return { ...this.active, queuedBackground: this.queues.background.length };
  }

  /** An already admitted caller can run small, synchronous CPU work inline. */
  exceedsOffloadFloor(op: string, hint: ComputeCostHint | undefined, itemCount: number): boolean {
    const policy = scope.getStore()?.policy ?? this.policy;
    return this.costModel.estimate(op, hint, itemCount).cpuMs >= policy.minOffloadCpuMs;
  }

  private budget(policy: RuntimePolicy): AdaptiveDispatchBudget {
    let governor = this.governors.get(policy.profile);
    if (!governor) {
      governor = new HostLoadGovernor({ profile: policy.profile });
      this.governors.set(policy.profile, governor);
    }
    return governor.sampleHost();
  }

  runTask<T>(
    run: (signal: AbortSignal) => Promise<T> | T,
    options: ScheduledTaskOptions = {},
  ): Promise<T> {
    const parent = scope.getStore();
    const controller = options.timeoutMs === undefined ? undefined : new AbortController();
    const signal = combineSignals(
      this.shutdown.signal,
      parent?.signal,
      options.signal,
      controller?.signal,
    );
    if (signal.aborted) return Promise.reject(signal.reason);
    if (holdsNamedResources(parent) && hasNamedResources(options.resources)) {
      return Promise.reject(
        new Error("A resource-holding task cannot acquire resources in a nested task"),
      );
    }
    const priority = options.priority ?? parent?.priority ?? "foreground";
    const lifetime = {
      ...parent,
      scheduler: this,
      policy: parent?.policy ?? this.policy,
      priority,
      signal,
    };
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: QueuedEntry = {
        run,
        options,
        lifetime,
        enqueuedAt: performance.now(),
        reject,
        resolve: (value) => resolve(value as T),
        finish: () => {
          if (timer) clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          this.inFlightLatch.decrement();
        },
      };
      const onAbort = () => this.requestPump();
      if (controller) {
        timer = setTimeout(() => {
          const error = new Error("Task timed out after " + options.timeoutMs + "ms");
          controller.abort(error);
          reject(error);
        }, options.timeoutMs);
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.inFlightLatch.increment();
      this.queues[priority].push(entry);
      this.requestPump();
    });
  }

  private requestPump(): void {
    if (this.pumpPending) return;
    this.pumpPending = true;
    queueMicrotask(() => {
      this.pumpPending = false;
      this.pump();
    });
  }

  private pump(): void {
    this.stopWatchingLocks?.();
    this.stopWatchingLocks = undefined;
    this.drainQueue("foreground");
    this.drainQueue("normal");
    if (this.queues.background.length === 0 || this.backgroundTurn) return;
    this.backgroundTurn = setImmediate(() => {
      this.backgroundTurn = undefined;
      if (this.drainQueue("background", 1)) this.requestPump();
    });
  }

  private drainQueue(priority: TaskPriority, starts = Infinity): boolean {
    const queue = this.queues[priority];
    const now = performance.now();
    queue.sort((a, b) => compareReady(a, b, now));
    for (let i = 0; i < queue.length;) {
      const entry = queue[i]!;
      const signal = entry.lifetime.signal;
      if (signal.aborted) {
        queue.splice(i, 1);
        entry.reject(signal.reason);
        entry.finish();
        continue;
      }
      if (priority === "background" && !this.canAdmitBackground(entry, now)) {
        i += 1;
        continue;
      }
      const release = this.acquire(entry);
      if (!release) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      this.dispatchEntry(priority, entry, release);
      if (--starts === 0) return true;
    }
    return false;
  }

  private acquire(entry: QueuedEntry): (() => void) | undefined {
    if (!hasNamedResources(entry.options.resources)) return NO_RELEASE;
    const release = this.locks.tryAcquire(entry.options.resources);
    if (!release) {
      entry.resourceWaitStarted ??= performance.now();
      this.stopWatchingLocks ??= this.locks.onRelease(() => this.requestPump());
    }
    return release;
  }

  private canAdmitBackground(entry: QueuedEntry, now: number): boolean {
    const parent = entry.lifetime.admission;
    const nested = parent?.active && parent.priority === "background";
    const budget = this.budget(entry.lifetime.policy);
    const limit = Math.min(
      entry.lifetime.policy.maxConcurrentBackground,
      budget.maxBackgroundConcurrency,
      this.active.foreground > 0 ? 1 : Infinity,
    );
    if (!nested && this.active.background >= limit) return false;
    this.refreshCpuWindow(now);
    const spent = this.backgroundCpuMs + this.backgroundReservedMs;
    const ceiling = Math.min(
      entry.lifetime.policy.backgroundCpuBudgetMs ?? Infinity,
      budget.backgroundCpuBudgetMs,
    );
    if (spent < ceiling) return true;
    if ((nested || this.active.background === 0) && isAged(entry, now)) return true;
    this.budgetWake ??= setTimeout(
      () => {
        this.budgetWake = undefined;
        this.requestPump();
      },
      Math.max(1, this.cpuWindowStart + CPU_WINDOW_MS - now),
    );
    return false;
  }

  private refreshCpuWindow(now: number): void {
    if (now - this.cpuWindowStart < CPU_WINDOW_MS) return;
    this.cpuWindowStart = now;
    this.backgroundCpuMs = 0;
  }

  private dispatchEntry(priority: TaskPriority, entry: QueuedEntry, release: () => void): void {
    const parent = entry.lifetime.admission;
    const nested = parent?.active === true && parent.priority === priority;
    if (!nested) this.active[priority] += 1;
    const admission = {
      active: true,
      priority,
      locked: release !== NO_RELEASE || Boolean(parent?.active && parent.locked),
    };
    const run = () => scope.run({ ...entry.lifetime, admission }, () => this.invokeTask(entry));
    executeWithRetry(run, entry.options, entry.lifetime.signal)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        admission.active = false;
        release();
        if (!nested) this.active[priority] -= 1;
        entry.finish();
        this.requestPump();
      });
  }

  private invokeTask(entry: QueuedEntry): unknown {
    const signal = entry.lifetime.signal;
    signal.throwIfAborted();
    if (entry.options.onAdmission) {
      const now = performance.now();
      const waitingSince = entry.resourceWaitStarted ?? now;
      entry.options.onAdmission(waitingSince - entry.enqueuedAt, now - waitingSince);
    }
    return this.runCpuSlice(() => entry.run(signal));
  }

  /** Charge an explicitly bounded synchronous slice, including after an I/O continuation. */
  runCpuSlice<T>(run: () => T): T {
    const current = scope.getStore();
    const start = current?.priority === "background" ? readThreadCpu() : undefined;
    try {
      return run();
    } finally {
      if (start) this.backgroundCpuMs += elapsedThreadCpu(start);
    }
  }

  /** All asynchronous plans, including composite children, use this dependency loop. */
  async executePlan<TIn, TOut, TContext>(
    plan: PhysicalExecutionPlan,
    registry: ComputeRegistry<TContext>,
    input: TIn,
    context: TContext,
    options: RuntimeGraphOptions<TContext> = {},
  ): Promise<TOut> {
    const failure = new AbortController();
    const deadline =
      options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
    const signal = combineSignals(
      this.shutdown.signal,
      scope.getStore()?.signal,
      options.signal,
      deadline,
      failure.signal,
    );
    signal.throwIfAborted();
    if (options.diagnostics) options.diagnostics.plan = plan;
    if (!plan.order.length) return input as unknown as TOut;
    const state: GraphState<TContext> = {
      registry,
      input,
      context,
      options,
      signal,
      outputs: new Map([[INPUT_NODE_ID, input]]),
      signatures: options.memo ? new Map([[INPUT_NODE_ID, inputSignature(input)]]) : undefined,
      contextSig: options.memo ? memoContextSignature(context, plan) : "",
    };
    return this.runDependencies(plan, state, failure) as Promise<TOut>;
  }

  private async runDependencies<TContext>(
    plan: PhysicalExecutionPlan,
    state: GraphState<TContext>,
    failure: AbortController,
  ): Promise<unknown> {
    const remaining = new Map(plan.consumerCounts);
    const pending = new Map(plan.dependencies.counts);
    const ranks = computeUpwardRanks(
      plan,
      this.costModel,
      state.options.itemEstimate ?? sizeOfInput(state.input),
    );
    const ready = plan.order.filter((node) => pending.get(node.id) === 0);
    let finish!: () => void;
    const complete = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let inFlight = 0;
    const launch = (node: PhysicalNodePlan) => {
      inFlight += 1;
      this.executeNode(node, state, ranks.get(node.id))
        .then((value) => {
          if (state.signal.aborted) return;
          state.outputs.set(node.id, value);
          recordPeak(state.options.diagnostics, state.outputs.size);
          releaseConsumedInputs(node.incoming, remaining, state.outputs, plan.outputNodeId);
          for (const next of plan.dependencies.followers.get(node.id) ?? []) {
            const count = pending.get(next.id)! - 1;
            pending.set(next.id, count);
            if (count === 0) launch(next);
          }
        })
        .catch((error) => failure.abort(error))
        .finally(() => {
          inFlight -= 1;
          if (inFlight === 0) finish();
        });
    };
    for (const node of ready) launch(node);
    await complete;
    state.signal.throwIfAborted();
    return state.outputs.get(plan.outputNodeId);
  }

  private async executeNode<TContext>(
    node: PhysicalNodePlan,
    state: GraphState<TContext>,
    upwardRankMs: number | undefined,
  ): Promise<unknown> {
    const { memo, diagnostics } = state.options;
    const inputs = gatherNodeInputs(node.incoming, state.outputs, state.input);
    if (memo && state.signatures) {
      return this.executeMemoNode(node, state, inputs, upwardRankMs, memo, state.signatures);
    }
    const value = await this.runNode(node, state, inputs, upwardRankMs, state.signal);
    if (diagnostics) diagnostics.executedNodes += 1;
    return value;
  }

  private async executeMemoNode<TContext>(
    node: PhysicalNodePlan,
    state: GraphState<TContext>,
    inputs: Record<string, unknown>,
    upwardRankMs: number | undefined,
    memo: ComputeMemoCache,
    signatures: Map<string, string>,
  ): Promise<unknown> {
    const { diagnostics } = state.options;
    const cache = prepareNodeMemo(
      node,
      state.registry,
      signatures,
      state.contextSig,
      state.context,
    );
    const hit = cache.cacheable ? memo.get(cache.signature) : undefined;
    if (hit?.found) {
      if (diagnostics) diagnostics.cacheHits += 1;
      return hit.value;
    }
    const run = (signal: AbortSignal) =>
      this.runNode(node, state, inputs, upwardRankMs, signal, cache.cacheable);
    const result =
      cache.cacheable && mayCoalesce(node, state.options)
        ? await this.coalescer.coalesce(
            (state.options.priority ?? "foreground") + ":" + cache.signature,
            () => run(this.shutdown.signal),
          )
        : { value: await run(state.signal), coalesced: false };
    state.signal.throwIfAborted();
    if (cache.cacheable && !memo.set(cache.signature, result.value)) cache.taint();
    recordMemoResult(diagnostics, result.coalesced, cache.cacheable);
    return result.value;
  }

  private runNode<TContext>(
    node: PhysicalNodePlan,
    state: GraphState<TContext>,
    inputs: Record<string, unknown>,
    upwardRankMs: number | undefined,
    signal: AbortSignal,
    cacheable = false,
  ): Promise<unknown> {
    if (node.subgraphPlan) {
      const { priority, memo, invokeNodeAsync } = state.options;
      return this.executePlan(
        node.subgraphPlan,
        state.registry,
        unwrapDefaultPayload(inputs),
        state.context,
        {
          signal,
          priority,
          memo: cacheable ? memo : undefined,
          invokeNodeAsync,
        },
      );
    }
    const { resources, effect } = node.capabilities;
    const metrics = state.options.diagnostics?.runtime;
    return this.runTask(
      (activeSignal) => this.dispatchCompute(node, state, inputs, activeSignal, cacheable),
      {
        priority: state.options.priority,
        signal,
        resources,
        effect,
        upwardRankMs,
        onAdmission:
          metrics &&
          ((queueMs, resourceWaitMs) => {
            metrics.queueMs += queueMs;
            metrics.resourceWaitMs += resourceWaitMs;
          }),
      },
    );
  }

  private dispatchCompute<TContext>(
    node: PhysicalNodePlan,
    state: GraphState<TContext>,
    inputs: Record<string, unknown>,
    signal: AbortSignal,
    cacheable: boolean,
  ): unknown {
    const op = state.options.invokeNodeAsync ?? invokeNodeAsync;
    const local = () =>
      op(node, state.registry, inputs, state.context, state.options.memo, cacheable);
    const metrics = state.options.diagnostics?.runtime;
    const cpu = node.capabilities.resources.execution === "cpu" && node.kind === "operator";
    const itemCount = cpu ? (state.options.itemEstimate ?? sizeOfInput(inputs)) : 0;
    const placement = cpu ? this.selectPlacement(node, state, inputs, itemCount) : undefined;
    if (placement) return this.runWorker(node, placement, signal, itemCount, metrics);
    return this.runInline(node.op, local, cpu ? itemCount : undefined, metrics);
  }

  private runInline(
    op: string,
    run: () => unknown,
    itemCount?: number,
    metrics?: ComputeExecutionDiagnostics["runtime"],
  ): unknown {
    if (itemCount === undefined && !metrics) return run();
    const wallStart = performance.now();
    const start = readThreadCpu();
    const value = run();
    const cpuMs = start ? Math.min(elapsedThreadCpu(start), performance.now() - wallStart) : 0;
    if (start && itemCount !== undefined) this.costModel.observe(op, { cpuMs, itemCount });
    if (!metrics) return value;
    metrics.inlineCpuMs += cpuMs;
    if (!value || typeof (value as PromiseLike<unknown>).then !== "function") return value;
    const asyncStart = performance.now();
    return Promise.resolve(value).finally(() => {
      metrics.asyncWallMs += performance.now() - asyncStart;
    });
  }

  private selectPlacement<TContext>(
    node: PhysicalNodePlan,
    state: GraphState<TContext>,
    inputs: Record<string, unknown>,
    itemCount: number,
  ) {
    const current = scope.getStore()!;
    const policy = current.policy;
    const budget = this.budget(policy);
    const limit = Math.min(policy.maxWorkers || Infinity, budget.recommendedWorkers);
    if (this.domain.activeLoad >= limit || current.admission?.locked) return;
    if (!this.exceedsOffloadFloor(node.op, node.capabilities.costHint, itemCount)) return;
    const fn = state.registry.get(node.op);
    const candidates = this.domain
      .leaves()
      .filter(
        (worker) => worker.activeLoad < worker.capacity && worker.supportsOperator?.(node.op, fn),
      );
    if (candidates.length === 0 || state.options.invokeNodeAsync) return;
    const request = { op: node.op, inputs, context: state.context, params: node.params };
    const payloadBytes = estimateWorkerPayloadBytes(request);
    if (payloadBytes === undefined) return;
    const decision = evaluatePlacementCost({
      node,
      costModel: this.costModel,
      itemCount,
      payloadBytes,
      minOffloadCpuMs: policy.minOffloadCpuMs,
      objective: policy.objective,
      localQueueDepth: readyCpuCount(this.queues),
      candidates,
      preferOffload: budget.preferWorkerOffload,
    });
    const target = candidates.find((candidate) => candidate.id === decision.targetId);
    return target ? { target, request, payloadBytes } : undefined;
  }

  private async runWorker(
    node: PhysicalNodePlan,
    placement: { target: RuntimeWorker; request: WorkerTaskRequest; payloadBytes: number },
    signal: AbortSignal,
    itemCount: number,
    metrics?: ComputeExecutionDiagnostics["runtime"],
  ): Promise<unknown> {
    const background = scope.getStore()?.priority === "background";
    const reserved = background
      ? this.costModel.estimate(node.op, node.capabilities.costHint, itemCount).cpuMs
      : 0;
    this.backgroundReservedMs += reserved;
    try {
      const result = await placement.target.execute(placement.request, signal);
      if (background) this.backgroundCpuMs += result.cpuMs;
      this.costModel.observe(node.op, {
        cpuMs: result.cpuMs,
        itemCount,
        serializedBytes: placement.payloadBytes,
        communicationMs: result.ipcMs,
      });
      if (metrics) {
        metrics.workerNodes += 1;
        metrics.workerCpuMs += result.cpuMs;
        metrics.workerQueueMs += result.queueMs ?? 0;
        metrics.communicationMs += result.ipcMs;
      }
      return result.value;
    } finally {
      this.backgroundReservedMs -= reserved;
    }
  }

  async close(): Promise<void> {
    this.shutdown.abort(new Error("Scheduler is closed"));
    if (this.budgetWake) clearTimeout(this.budgetWake);
    this.requestPump();
    await this.domain.close();
    await this.inFlightLatch.waitForZero();
    this.stopWatchingLocks?.();
    for (const governor of this.governors.values()) governor.close();
  }
}

function mayCoalesce<TContext>(
  node: PhysicalNodePlan,
  options: RuntimeGraphOptions<TContext>,
): boolean {
  return (
    node.capabilities.effect === "pure" &&
    !hasNamedResources(node.capabilities.resources) &&
    !node.subgraphPlan &&
    !options.signal &&
    options.timeoutMs === undefined &&
    !scope.getStore()?.signal
  );
}

function recordMemoResult(
  diagnostics: ComputeExecutionDiagnostics | undefined,
  coalesced: boolean,
  cacheable: boolean,
): void {
  if (!diagnostics) return;
  if (coalesced) {
    if (diagnostics.runtime) diagnostics.runtime.coalescedNodes += 1;
    return;
  }
  diagnostics.executedNodes += 1;
  if (!cacheable) diagnostics.cacheSkips += 1;
}

function recordPeak(diagnostics: ComputeExecutionDiagnostics | undefined, size: number): void {
  if (diagnostics) diagnostics.peakLiveOutputs = Math.max(diagnostics.peakLiveOutputs, size);
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal) => signal !== undefined);
  return present.length === 1 ? present[0]! : AbortSignal.any(present);
}

function holdsNamedResources(parent: RuntimeScope | undefined): boolean {
  return parent?.admission?.active === true && parent.admission.locked;
}

function isAged(entry: QueuedEntry, now: number): boolean {
  return now - entry.enqueuedAt >= entry.lifetime.policy.starvationMaxWaitMs;
}

function compareReady(a: QueuedEntry, b: QueuedEntry, now: number): number {
  if (a.lifetime.priority === "background" && (isAged(a, now) || isAged(b, now))) {
    return a.enqueuedAt - b.enqueuedAt;
  }
  return (b.options.upwardRankMs ?? 0) - (a.options.upwardRankMs ?? 0);
}

function readyCpuCount(queues: Record<TaskPriority, QueuedEntry[]>): number {
  return Object.values(queues)
    .flat()
    .filter((entry) => entry.options.resources?.execution === "cpu").length;
}

function sizeOfInput(input: unknown): number {
  if (Array.isArray(input) || typeof input === "string") return input.length;
  if (!input || typeof input !== "object") return 1;
  let size = 1;
  for (const value of Object.values(input)) {
    if (Array.isArray(value)) size = Math.max(size, value.length);
  }
  return size;
}

function readThreadCpu(): NodeJS.CpuUsage | undefined {
  try {
    return process.threadCpuUsage?.();
  } catch {
    return undefined;
  }
}

function elapsedThreadCpu(start: NodeJS.CpuUsage): number {
  const used = readThreadCpu();
  return used ? Math.max(0, (used.user - start.user + used.system - start.system) / 1000) : 0;
}

async function executeWithRetry(
  run: () => unknown,
  options: ScheduledTaskOptions,
  signal: AbortSignal,
): Promise<unknown> {
  const allowed = options.effect === "pure" || options.effect === "read" || options.idempotentWrite;
  const attempts = allowed ? Math.max(1, options.retryPolicy?.maxAttempts ?? 1) : 1;
  for (let attempt = 1; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      const value = await run();
      signal.throwIfAborted();
      return value;
    } catch (error) {
      if (attempt >= attempts || signal.aborted) throw error;
      if (options.retryPolicy?.delayMs)
        await delay(options.retryPolicy.delayMs, undefined, { signal });
    }
  }
}

export function withSyncResources<T>(resources: ComputeResourceProfile, run: () => T): T {
  const parent = scope.getStore();
  if (holdsNamedResources(parent)) {
    throw new Error("A resource-holding task cannot acquire resources in a nested task");
  }
  const locks = parent?.scheduler?.locks ?? sharedLocks;
  const release = locks.tryAcquire(resources);
  if (!release) throw new Error("Synchronous compute resource is busy");
  const admission = { active: true, locked: true };
  const finish = () => {
    admission.active = false;
    release();
  };
  let asynchronous = false;
  try {
    const value = scope.run({ ...parent, policy: parent?.policy ?? defaults, admission }, run);
    asynchronous = Boolean(
      value && typeof (value as unknown as PromiseLike<unknown>).then === "function",
    );
    if (asynchronous) void Promise.resolve(value).then(finish, finish);
    return value;
  } finally {
    if (!asynchronous) finish();
  }
}

let sharedScheduler: UnifiedRuntimeScheduler | undefined;

export function getSharedRuntimeScheduler(): UnifiedRuntimeScheduler {
  sharedScheduler ??= new UnifiedRuntimeScheduler();
  return sharedScheduler;
}

export function getRuntimeScheduler(): UnifiedRuntimeScheduler {
  return scope.getStore()?.scheduler ?? getSharedRuntimeScheduler();
}
