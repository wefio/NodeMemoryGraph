import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parentPort } from "node:worker_threads";
import "../memory/piecewise-rerank.ts";
import { localWorkerOperator } from "./worker-pool.ts";

interface WorkerMessage {
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

async function loadModule(moduleUrl: string) {
  let fn = loadedModules.get(moduleUrl);
  if (!fn) {
    const mod = (await import(pathToFileURL(moduleUrl).href)) as {
      default?: typeof fn;
      execute?: typeof fn;
    };
    fn = mod.execute ?? mod.default;
    if (typeof fn !== "function") throw new Error(`Worker module missing execute(): ${moduleUrl}`);
    loadedModules.set(moduleUrl, fn);
  }
  return fn;
}

if (parentPort) {
  parentPort.on("message", async (msg: WorkerMessage) => {
    try {
      const fn = msg.moduleUrl ? await loadModule(msg.moduleUrl) : localWorkerOperator(msg.op);
      if (!fn) throw new Error(`Unknown worker operator: ${msg.op}`);
      const start = performance.now();
      const cpuStart = process.threadCpuUsage();
      const work = fn(msg.inputs, msg.context, msg.params);
      const cpu = process.threadCpuUsage(cpuStart);
      const value = await work;
      parentPort!.postMessage({
        ok: true,
        value,
        cpuMs: (cpu.user + cpu.system) / 1000,
        executionMs: performance.now() - start,
      });
    } catch (error) {
      parentPort!.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  parentPort.postMessage({ ready: true });
}
