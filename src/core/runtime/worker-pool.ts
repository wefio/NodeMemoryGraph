import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { WorkerPlacementTarget } from "./cost-model.ts";

const workerOperators = new Map<string, WorkerOperator>();
type WorkerOperator = (
  inputs: Readonly<Record<string, unknown>>,
  context: unknown,
  params: Readonly<Record<string, unknown>>,
) => unknown;

export function defineLocalWorkerOperator(op: string, implementation: WorkerOperator): void {
  workerOperators.set(op, implementation);
}

export function localWorkerOperator(op: string): WorkerOperator | undefined {
  return workerOperators.get(op);
}

export interface WorkerTaskRequest {
  readonly op: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly context: unknown;
  readonly params: Readonly<Record<string, unknown>>;
  readonly background?: boolean;
  readonly moduleUrl?: string;
}

export interface WorkerTaskResponse {
  readonly value: unknown;
  readonly cpuMs: number;
  readonly ipcMs: number;
  readonly queueMs?: number;
  readonly executionMs?: number;
  readonly workerId: string;
}

export interface RuntimeWorker extends WorkerPlacementTarget {
  readonly dataLocality?: string;
  supports(op: string): boolean;
  supportsOperator?(op: string, implementation: unknown): boolean;
  execute(task: WorkerTaskRequest, signal?: AbortSignal): Promise<WorkerTaskResponse>;
  close(): Promise<void>;
}

interface WorkerCall {
  readonly request: WorkerTaskRequest;
  readonly enqueuedAt: number;
  readonly resolve: (result: WorkerTaskResponse) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly cancel: () => void;
}

interface WorkerSlot {
  readonly id: string;
  readonly worker: Worker;
  readonly spawnedAt: number;
  ready: boolean;
  stopping: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  active?: { call: WorkerCall; startedAt: number };
}

interface WorkerReply {
  readonly ready?: true;
  readonly ok?: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly cpuMs: number;
  readonly executionMs: number;
}

function makeWorker(): Worker {
  const dir = dirname(fileURLToPath(import.meta.url));
  const js = join(dir, "worker-entry.js");
  const ts = join(dir, "worker-entry.ts");
  const source = import.meta.filename?.endsWith(".ts") || !existsSync(js);
  return new Worker(
    source ? ts : js,
    source ? { execArgv: ["--experimental-strip-types"] } : undefined,
  );
}

/** Price a plain data transfer without allocating a serialized copy or invoking accessors. */
export function estimateWorkerPayloadBytes(request: WorkerTaskRequest): number | undefined {
  const seen = new Set<object>();
  let bytes = 0;
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 32 || bytes > 2 ** 20) return false;
    if (value === null || value === undefined || typeof value === "boolean") {
      bytes += 1;
      return true;
    }
    if (typeof value === "number" || typeof value === "string") {
      bytes += typeof value === "number" ? 8 : Buffer.byteLength(value) + 4;
      return true;
    }
    if (typeof value !== "object" || !plainTransferObject(value)) return false;
    if (seen.has(value)) return true;
    seen.add(value);
    const entries = transferableEntries(value);
    if (!entries) return false;
    for (const [key, item] of entries) {
      bytes += Buffer.byteLength(key) + 4;
      if (!visit(item, depth + 1)) return false;
    }
    return true;
  };
  return visit(request, 0) ? bytes : undefined;
}

function transferableEntries(value: object): Array<[string, unknown]> | undefined {
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (Array.isArray(value) && key === "length") continue;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) return;
    entries.push([key, descriptor.value]);
  }
  return entries;
}
function plainTransferObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || (Array.isArray(value) && proto === Array.prototype);
}

/** Lazy worker_threads pool. A slot is reusable only after a reply or thread termination. */
export class LocalWorkerThreadPool implements RuntimeWorker {
  readonly id: string;
  readonly kind = "worker_thread" as const;
  readonly dataLocality = "worker_thread";
  readonly maxWorkers: number;
  private readonly slots = new Set<WorkerSlot>();
  private readonly queue: WorkerCall[] = [];
  private nextId = 0;
  private startupEstimateMs = 35;
  private closed = false;

  constructor(options: { readonly id?: string; readonly maxWorkers?: number } = {}) {
    this.id = options.id ?? "local-worker-pool";
    this.maxWorkers = Math.max(1, Math.floor(options.maxWorkers ?? 2));
  }

  get capacity(): number {
    return this.maxWorkers;
  }

  get activeLoad(): number {
    let active = this.queue.length;
    for (const slot of this.slots) if (slot.active) active += 1;
    return active;
  }

  supports(op: string): boolean {
    return workerOperators.has(op);
  }

  supportsOperator(op: string, implementation: unknown): boolean {
    return workerOperators.has(op) && workerOperators.get(op) === implementation;
  }

  estimatedQueueWaitMs(_payloadBytes: number): number {
    for (const slot of this.slots) if (slot.ready && !slot.stopping && !slot.active) return 0;
    return this.startupEstimateMs + this.queue.length;
  }

  execute(request: WorkerTaskRequest, signal?: AbortSignal): Promise<WorkerTaskResponse> {
    if (this.closed) return Promise.reject(new Error("Worker pool is closed"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const call: WorkerCall = {
        request,
        signal,
        resolve,
        reject,
        enqueuedAt: performance.now(),
        cancel: () => this.cancel(call),
      };
      signal?.addEventListener("abort", call.cancel, { once: true });
      this.queue.push(call);
      this.pump();
    });
  }

  private cancel(call: WorkerCall): void {
    const queued = this.queue.indexOf(call);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.reject(call, call.signal?.reason);
    } else {
      const active = [...this.slots].find((slot) => slot.active?.call === call);
      if (active) this.stop(active);
    }
  }

  private reject(call: WorkerCall, error: unknown): void {
    call.signal?.removeEventListener("abort", call.cancel);
    call.reject(error);
  }

  private spawn(): void {
    const worker = makeWorker();
    const slot: WorkerSlot = {
      id: this.id + "#" + this.nextId++,
      worker,
      spawnedAt: performance.now(),
      ready: false,
      stopping: false,
    };
    this.slots.add(slot);
    let fault: unknown;
    worker.on("message", (message: WorkerReply) => this.receive(slot, message));
    worker.on("error", (error) => {
      fault = error;
    });
    worker.on("exit", (code) => {
      clearTimeout(slot.idleTimer);
      this.slots.delete(slot);
      const error = fault ?? new Error("Worker exited with code " + code);
      if (slot.active) this.reject(slot.active.call, slot.active.call.signal?.reason ?? error);
      if (!slot.ready && !slot.stopping) {
        for (const call of this.queue.splice(0)) this.reject(call, error);
      }
      this.pump();
    });
  }

  private receive(slot: WorkerSlot, message: WorkerReply): void {
    if (slot.stopping) return;
    if (message.ready) {
      slot.ready = true;
      const startupMs = performance.now() - slot.spawnedAt;
      this.startupEstimateMs = 0.75 * this.startupEstimateMs + 0.25 * startupMs;
    }
    const active = slot.active;
    if (active) {
      slot.active = undefined;
      this.complete(slot, active.call, message, active.startedAt);
    }
    slot.worker.unref();
    this.pump();
    if (!slot.active) {
      slot.idleTimer = setTimeout(() => {
        void this.stop(slot);
      }, 15_000);
      slot.idleTimer.unref?.();
    }
  }

  private complete(
    slot: WorkerSlot,
    call: WorkerCall,
    message: WorkerReply,
    startedAt: number,
  ): void {
    if (!message.ok) {
      this.reject(call, new Error(message.error ?? "Worker task failed"));
      return;
    }
    call.signal?.removeEventListener("abort", call.cancel);
    call.resolve({
      value: message.value,
      cpuMs: message.cpuMs,
      executionMs: message.executionMs,
      ipcMs: Math.max(0, performance.now() - startedAt - message.executionMs),
      queueMs: startedAt - call.enqueuedAt,
      workerId: slot.id,
    });
  }

  private pump(): void {
    if (this.closed || this.queue.length === 0) return;
    for (const slot of this.slots) {
      if (this.queue.length === 0) break;
      if (slot.ready && !slot.stopping && !slot.active) this.dispatch(slot);
    }
    const starting = [...this.slots].filter((slot) => !slot.ready && !slot.stopping).length;
    let starts = Math.min(this.maxWorkers - this.slots.size, this.queue.length - starting);
    while (starts-- > 0) {
      try {
        this.spawn();
      } catch (error) {
        for (const call of this.queue.splice(0)) this.reject(call, error);
      }
    }
  }

  private dispatch(slot: WorkerSlot): void {
    clearTimeout(slot.idleTimer);
    const call = this.queue.shift()!;
    slot.active = { call, startedAt: performance.now() };
    slot.worker.ref();
    try {
      slot.worker.postMessage(call.request);
    } catch (error) {
      slot.active = undefined;
      slot.worker.unref();
      this.reject(call, error);
      this.pump();
    }
  }

  private stop(slot: WorkerSlot): Promise<number> {
    clearTimeout(slot.idleTimer);
    slot.stopping = true;
    return slot.worker.terminate();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const call of this.queue.splice(0)) this.reject(call, new Error("Worker pool closed"));
    await Promise.all([...this.slots].map((slot) => this.stop(slot)));
  }
}

/** Resource domains compose recursively. Placement can address the selected leaf directly. */
export class SchedulingDomain implements RuntimeWorker {
  readonly id: string;
  readonly kind = "domain" as const;
  private readonly workers: RuntimeWorker[] = [];

  constructor(id = "default-domain", initialWorkers: readonly RuntimeWorker[] = []) {
    this.id = id;
    for (const worker of initialWorkers) this.addWorker(worker);
  }

  addWorker(worker: RuntimeWorker): void {
    const leaves = worker instanceof SchedulingDomain ? worker.leaves() : [worker];
    const ids = new Set(this.leaves().map((leaf) => leaf.id));
    if (worker === this || (worker instanceof SchedulingDomain && worker.contains(this))) {
      throw new Error("Scheduling domain cycle");
    }
    if (leaves.some((leaf) => ids.has(leaf.id))) throw new Error("Duplicate worker id in domain");
    this.workers.push(worker);
  }

  private contains(domain: SchedulingDomain): boolean {
    return (
      this === domain ||
      this.workers.some((worker) => worker instanceof SchedulingDomain && worker.contains(domain))
    );
  }

  getWorkers(): readonly RuntimeWorker[] {
    return this.workers;
  }

  leaves(): RuntimeWorker[] {
    return this.workers.flatMap((worker) =>
      worker instanceof SchedulingDomain ? worker.leaves() : [worker],
    );
  }

  get capacity(): number {
    return this.workers.reduce((sum, worker) => sum + worker.capacity, 0);
  }

  get activeLoad(): number {
    return this.workers.reduce((sum, worker) => sum + worker.activeLoad, 0);
  }

  supports(op: string): boolean {
    return this.workers.some((worker) => worker.supports(op));
  }

  estimatedQueueWaitMs(payloadBytes: number): number {
    return Math.min(...this.workers.map((worker) => worker.estimatedQueueWaitMs(payloadBytes)));
  }

  selectWorker(op: string, payloadBytes: number): RuntimeWorker | undefined {
    const candidates = this.leaves().filter((worker) => worker.supports(op));
    return candidates.sort(
      (a, b) => a.estimatedQueueWaitMs(payloadBytes) - b.estimatedQueueWaitMs(payloadBytes),
    )[0];
  }

  execute(task: WorkerTaskRequest, signal?: AbortSignal): Promise<WorkerTaskResponse> {
    const worker = this.selectWorker(task.op, estimateWorkerPayloadBytes(task) ?? 0);
    if (!worker) return Promise.reject(new Error("No worker supports op '" + task.op + "'"));
    return worker.execute(task, signal);
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}
