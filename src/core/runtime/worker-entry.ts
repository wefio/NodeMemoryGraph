import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parentPort } from "node:worker_threads";
import { RERANK_COMPUTE_REGISTRY } from "../memory/piecewise-rerank.ts";
import { applyBackgroundOsPriority } from "./load-governor.ts";

interface WorkerMessage {
  readonly id: number;
  readonly op: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly context: unknown;
  readonly params: Readonly<Record<string, unknown>>;
  readonly background?: boolean;
  readonly moduleUrl?: string;
}

const loadedModules = new Map<
  string,
  (
    inputs: Readonly<Record<string, unknown>>,
    context: unknown,
    params: Readonly<Record<string, unknown>>,
  ) => unknown
>();

function heavyDenseBench(seed: number, rounds: number): number {
  let acc = seed * 0.137 + 1.0;
  for (let i = 0; i < rounds; i += 1) {
    acc = Math.sin(acc * 1.00013 + i * 0.001) + Math.cos(acc * 0.9997);
  }
  return acc;
}

async function executeWorkerOp(msg: WorkerMessage): Promise<unknown> {
  if (msg.op === "__builtin_dense_bench") {
    const payload = (msg.inputs.default ?? {}) as { seed?: number; rounds?: number };
    return heavyDenseBench(payload.seed ?? 1, payload.rounds ?? 1000);
  }
  if (msg.moduleUrl) {
    let fn = loadedModules.get(msg.moduleUrl);
    if (!fn) {
      const mod = (await import(pathToFileURL(msg.moduleUrl).href)) as {
        default?: typeof fn;
        execute?: typeof fn;
      };
      fn = mod.execute ?? mod.default;
      if (typeof fn !== "function")
        throw new Error(`Worker module missing execute(): ${msg.moduleUrl}`);
      loadedModules.set(msg.moduleUrl, fn);
    }
    return await fn(msg.inputs, msg.context, msg.params);
  }
  if (RERANK_COMPUTE_REGISTRY.has(msg.op)) {
    const fn = RERANK_COMPUTE_REGISTRY.get(msg.op) as (
      inputs: Readonly<Record<string, unknown>>,
      context: unknown,
      params: Readonly<Record<string, unknown>>,
    ) => unknown;
    return await fn(msg.inputs, msg.context, msg.params);
  }
  throw new Error(`Unknown worker operator: ${msg.op}`);
}

if (parentPort) {
  parentPort.on("message", async (msg: WorkerMessage) => {
    const start = performance.now();
    if (msg.background) applyBackgroundOsPriority();
    try {
      const value = await executeWorkerOp(msg);
      const cpuMs = performance.now() - start;
      parentPort!.postMessage({ id: msg.id, ok: true, value, cpuMs });
    } catch (error) {
      const cpuMs = performance.now() - start;
      parentPort!.postMessage({
        id: msg.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        cpuMs,
      });
    }
  });
}
