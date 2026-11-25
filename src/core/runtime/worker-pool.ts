import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { WorkerPlacementTarget } from "./cost-model.ts";

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
  readonly workerId: string;
}

/** Unified execution resource contract for threads, processes, DB executors, GPUs, or scheduling domains. */
export interface RuntimeWorker extends WorkerPlacementTarget {
  readonly dataLocality?: string;
  supports(op: string): boolean;
  execute(task: WorkerTaskRequest, signal?: AbortSignal): Promise<WorkerTaskResponse>;
  close(): Promise<void>;
}

interface PendingCall {
  readonly resolve: (res: WorkerTaskResponse) => void;
  readonly reject: (err: Error) => void;
  readonly dispatchedAt: number;
  readonly workerId: string;
  readonly onAbort?: () => void;
  readonly signal?: AbortSignal;
}

interface WorkerSlot {
  readonly id: string;
  readonly worker: Worker;
  busy: boolean;
  readonly inflight: Map<number, PendingCall>;
}

const BUILTIN_WORKER_OPS = new Set([
  "__builtin_dense_bench",
  "identity_rank",
  "r3_intent_boost",
  "r5_recency_boost",
  "r1_incremental_dedup",
  "w_session_pivot",
  "bm25f_field_score",
  "incremental_bm25_score",
  "w_temporal_pivot",
  "w_concept_pivot",
  "w_lineage_pivot",
  "w_turn_pivot",
  "w_chrono_seq_pivot",
]);

function resolveWorkerEntryPath(): { path: string; needsStripTypes: boolean } {
  const dir = dirname(fileURLToPath(import.meta.url));
  const tsPath = join(dir, "worker-entry.ts");
  const jsPath = join(dir, "worker-entry.js");
  if (import.meta.filename?.endsWith(".ts") && existsSync(tsPath)) {
    return {
      path: tsPath,
      needsStripTypes: !process.execArgv.includes("--experimental-strip-types"),
    };
  }
  if (existsSync(jsPath)) return { path: jsPath, needsStripTypes: false };
  return {
    path: tsPath,
    needsStripTypes: !process.execArgv.includes("--experimental-strip-types"),
  };
}

/** Lazy Piscina-style local Node.js worker_threads pool implementing RuntimeWorker. */
export class LocalWorkerThreadPool implements RuntimeWorker {
  readonly id: string;
  readonly kind = "worker_thread" as const;
  readonly maxWorkers: number;
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: Array<{
    req: WorkerTaskRequest;
    resolve: (res: WorkerTaskResponse) => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
  }> = [];
  private nextId = 1;
  private closed = false;

  constructor(options: { readonly id?: string; readonly maxWorkers?: number } = {}) {
    this.id = options.id ?? "local-worker-pool";
    this.maxWorkers = Math.max(1, Math.floor(options.maxWorkers ?? 2));
  }

  get capacity(): number {
    return this.maxWorkers;
  }

  get activeLoad(): number {
    return this.slots.filter((s) => s.busy).length + this.queue.length;
  }

  supports(op: string): boolean {
    return BUILTIN_WORKER_OPS.has(op);
  }

  estimatedQueueWaitMs(_payloadBytes: number): number {
    const busyCount = this.slots.filter((s) => s.busy).length;
    if (busyCount < this.maxWorkers) return 0.25;
    return 1 + (this.queue.length / this.maxWorkers) * 2.5;
  }

  execute(task: WorkerTaskRequest, signal?: AbortSignal): Promise<WorkerTaskResponse> {
    if (this.closed) return Promise.reject(new Error("Worker pool is closed"));
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      this.queue.push({ req: task, resolve, reject, signal });
      this.pump();
    });
  }

  private spawnSlot(): WorkerSlot {
    const entry = resolveWorkerEntryPath();
    const worker = new Worker(
      entry.path,
      entry.needsStripTypes ? { execArgv: ["--experimental-strip-types"] } : undefined,
    );
    worker.unref();
    const slot: WorkerSlot = {
      id: `${this.id}#${this.slots.length}`,
      worker,
      busy: false,
      inflight: new Map(),
    };
    worker.on(
      "message",
      (msg: { id: number; ok: boolean; value?: unknown; error?: string; cpuMs: number }) => {
        const pending = slot.inflight.get(msg.id);
        if (!pending) return;
        slot.inflight.delete(msg.id);
        slot.busy = false;
        if (pending.onAbort && pending.signal) {
          pending.signal.removeEventListener("abort", pending.onAbort);
        }
        const roundTripMs = performance.now() - pending.dispatchedAt;
        if (msg.ok) {
          pending.resolve({
            value: msg.value,
            cpuMs: msg.cpuMs,
            ipcMs: Math.max(0, roundTripMs - msg.cpuMs),
            workerId: pending.workerId,
          });
        } else {
          pending.reject(new Error(msg.error ?? "Worker task failed"));
        }
        this.pump();
      },
    );
    worker.on("error", (err) => {
      for (const [, pending] of slot.inflight) {
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      }
      slot.inflight.clear();
      slot.busy = false;
    });
    this.slots.push(slot);
    return slot;
  }

  private pump(): void {
    if (this.closed) return;
    while (this.queue.length > 0) {
      let slot = this.slots.find((s) => !s.busy);
      if (!slot && this.slots.length < this.maxWorkers) {
        slot = this.spawnSlot();
      }
      if (!slot) break;
      const next = this.queue.shift()!;
      if (next.signal?.aborted) {
        next.reject(
          next.signal.reason instanceof Error
            ? next.signal.reason
            : new Error("Worker task aborted"),
        );
        continue;
      }
      const msgId = this.nextId;
      this.nextId += 1;
      slot.busy = true;
      const onAbort = next.signal
        ? () => {
            const call = slot.inflight.get(msgId);
            if (!call) return;
            slot.inflight.delete(msgId);
            call.reject(
              next.signal!.reason instanceof Error
                ? next.signal!.reason
                : new Error("Worker task aborted"),
            );
          }
        : undefined;
      if (onAbort && next.signal) next.signal.addEventListener("abort", onAbort, { once: true });
      slot.inflight.set(msgId, {
        resolve: next.resolve,
        reject: next.reject,
        dispatchedAt: performance.now(),
        workerId: slot.id,
        onAbort,
        signal: next.signal,
      });
      slot.worker.ref();
      slot.worker.postMessage({
        id: msgId,
        op: next.req.op,
        inputs: next.req.inputs,
        context: next.req.context,
        params: next.req.params,
        background: next.req.background,
        moduleUrl: next.req.moduleUrl,
      });
    }
    if (this.slots.every((s) => !s.busy)) {
      for (const slot of this.slots) slot.worker.unref();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.queue.length > 0) {
      const dropped = this.queue.shift()!;
      dropped.reject(new Error("Worker pool closed"));
    }
    await Promise.all(
      this.slots.map(async (slot) => {
        for (const [, pending] of slot.inflight) {
          pending.reject(new Error("Worker pool terminated"));
        }
        slot.inflight.clear();
        await slot.worker.terminate();
      }),
    );
    this.slots.length = 0;
  }
}

/**
 * Recursive logical supernode composing heterogeneous workers under one RuntimeWorker contract.
 * Exposes combined capacity and delegates tasks to the child worker with lowest estimated queue wait.
 */
export class SchedulingDomain implements RuntimeWorker {
  readonly id: string;
  readonly kind = "domain" as const;
  private readonly workers: RuntimeWorker[] = [];

  constructor(id = "default-domain", initialWorkers: readonly RuntimeWorker[] = []) {
    this.id = id;
    for (const worker of initialWorkers) this.workers.push(worker);
  }

  addWorker(worker: RuntimeWorker): void {
    this.workers.push(worker);
  }

  getWorkers(): readonly RuntimeWorker[] {
    return this.workers;
  }

  get capacity(): number {
    return this.workers.reduce((sum, w) => sum + w.capacity, 0);
  }

  get activeLoad(): number {
    return this.workers.reduce((sum, w) => sum + w.activeLoad, 0);
  }

  supports(op: string): boolean {
    return this.workers.some((w) => w.supports(op));
  }

  estimatedQueueWaitMs(payloadBytes: number): number {
    if (!this.workers.length) return Number.POSITIVE_INFINITY;
    return Math.min(...this.workers.map((w) => w.estimatedQueueWaitMs(payloadBytes)));
  }

  selectWorker(op: string, payloadBytes: number): RuntimeWorker | undefined {
    let best: RuntimeWorker | undefined;
    let bestWait = Number.POSITIVE_INFINITY;
    for (const worker of this.workers) {
      if (!worker.supports(op)) continue;
      const wait = worker.estimatedQueueWaitMs(payloadBytes);
      if (wait < bestWait) {
        bestWait = wait;
        best = worker;
      }
    }
    return best;
  }

  execute(task: WorkerTaskRequest, signal?: AbortSignal): Promise<WorkerTaskResponse> {
    const worker = this.selectWorker(task.op, 256);
    if (!worker) return Promise.reject(new Error(`No worker supports op '${task.op}'`));
    return worker.execute(task, signal);
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
  }
}
