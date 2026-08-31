/**
 * Four-arm write-path ablation: baseline, scope index, batch transaction, both.
 * No LLM and no external embedding are used. Each run gets a fresh SQLite DB;
 * logical output equivalence is mandatory before speedups are reported.
 *
 * Usage: npm run eval:ingest-ablation [-- path/to/config.json]
 */
import { readFileSync, rmSync, mkdtempSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { NmgStore } from "../../src/core/store.ts";
import type { RememberInput } from "../../src/core/types.ts";

interface Config {
  records: number;
  batchSize: number;
  warmups: number;
  runs: number;
  supersedeScan: boolean;
  preappendHistory?: boolean;
}

interface Arm {
  name: "baseline" | "scope-index" | "batch" | "both";
  scopeIndex: boolean;
  batch: boolean;
}

interface Sample {
  wallMs: number;
  cpuMs: number;
  peakRssBytes: number;
  peakHeapBytes: number;
  databaseBytes: number;
  memories: number;
  signature: string;
}

const arms: Arm[] = [
  { name: "baseline", scopeIndex: false, batch: false },
  { name: "scope-index", scopeIndex: true, batch: false },
  { name: "batch", scopeIndex: false, batch: true },
  { name: "both", scopeIndex: true, batch: true },
];
const defaultConfig = resolve("evals/retrieval/ingest-ablation.config.json");
if (process.argv[2] === "--worker") {
  const arm = arms.find((candidate) => candidate.name === process.argv[3]);
  if (!arm) throw new Error(`unknown ablation arm ${process.argv[3]}`);
  const workerConfig = JSON.parse(readFileSync(resolve(process.argv[4]!), "utf8")) as Config;
  validateConfig(workerConfig);
  const sample = runArm(
    arm,
    buildWorkload(workerConfig.records, workerConfig.supersedeScan),
    workerConfig.batchSize,
    workerConfig.preappendHistory ?? false,
  );
  console.log(JSON.stringify(sample));
} else {
  runCoordinator();
}

function runCoordinator(): void {
  const configPath = resolve(process.argv[2] ?? defaultConfig);
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Config;
  validateConfig(config);
  const samples = new Map<Arm["name"], Sample[]>();
  for (let iteration = 0; iteration < config.warmups + config.runs; iteration += 1) {
    for (const arm of rotate(arms, iteration)) {
      const child = spawnSync(
        process.execPath,
        ["--experimental-strip-types", import.meta.filename, "--worker", arm.name, configPath],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      );
      if (child.status !== 0) {
        throw new Error(`ablation worker ${arm.name} failed: ${child.stderr || child.stdout}`);
      }
      const sample = JSON.parse(child.stdout.trim()) as Sample;
      if (iteration >= config.warmups) {
        const list = samples.get(arm.name) ?? [];
        list.push(sample);
        samples.set(arm.name, list);
      }
    }
  }

  const signatures = new Set([...samples.values()].flat().map((sample) => sample.signature));
  if (signatures.size !== 1) throw new Error("ablation arms produced different persisted semantics");
  const baseline = median(samples.get("baseline")!.map((sample) => sample.wallMs));
  const report = {
    generatedAt: new Date().toISOString(),
    config,
    equivalent: true,
    arms: Object.fromEntries(
      arms.map((arm) => {
        const values = samples.get(arm.name)!;
        const wallMs = median(values.map((sample) => sample.wallMs));
        return [
          arm.name,
          {
            wallMs,
            throughputPerSecond: (config.records * 1000) / wallMs,
            speedupVsBaseline: baseline / wallMs,
            cpuMs: median(values.map((sample) => sample.cpuMs)),
            peakRssBytes: Math.max(...values.map((sample) => sample.peakRssBytes)),
            peakHeapBytes: Math.max(...values.map((sample) => sample.peakHeapBytes)),
            databaseBytes: median(values.map((sample) => sample.databaseBytes)),
            memories: values[0]!.memories,
            runs: values.map(({ signature: _signature, ...sample }) => sample),
          },
        ];
      }),
    ),
  };
  const outputPath = resolve("evals/results/ingest-ablation.json");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, outputPath }, null, 2));
}

function runArm(
  arm: Arm,
  workload: readonly RememberInput[],
  batchSize: number,
  preappendHistory: boolean,
): Sample {
  const root = mkdtempSync(join(tmpdir(), `nmg-ingest-${arm.name}-`));
  const databasePath = join(root, "store.sqlite");
  const store = new NmgStore(databasePath, undefined, { scopeWriteIndex: arm.scopeIndex });
  let peakRssBytes = process.memoryUsage().rss;
  let peakHeapBytes = process.memoryUsage().heapUsed;
  const startedCpu = process.cpuUsage();
  const startedAt = performance.now();
  try {
    if (arm.batch) {
      for (let offset = 0; offset < workload.length; offset += batchSize) {
        const batch = workload
          .slice(offset, offset + batchSize)
          .map((input, index) => prepareInput(store, input, offset + index));
        store.rememberMany(batch);
        sampleMemory();
      }
    } else {
      for (let index = 0; index < workload.length; index += 1) {
        store.remember(prepareInput(store, workload[index]!, index));
        if ((index + 1) % batchSize === 0) sampleMemory();
      }
    }
    const wallMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(startedCpu);
    const exported = store.exportMemories({ includeDeleted: true });
    const byId = new Map(exported.items.map((item) => [item.memory.id, item.memory.statement]));
    const signature = JSON.stringify(
      exported.items
        .map((item) => ({
          statement: item.memory.statement,
          status: item.memory.status,
          stateKey: item.memory.stateKey,
          supersedes: item.memory.supersedesId ? byId.get(item.memory.supersedesId) : null,
          node: item.node.canonicalName,
          evidence: item.evidence.map((evidence) => evidence.content).sort(),
        }))
        .sort((left, right) => left.statement.localeCompare(right.statement)),
    );
    store.close();
    const databaseBytes = statSync(databasePath).size;
    return {
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      peakRssBytes,
      peakHeapBytes,
      databaseBytes,
      memories: exported.items.length,
      signature,
    };
  } finally {
    try {
      store.close();
    } catch {
      // Already closed after a successful run.
    }
    rmSync(root, { recursive: true, force: true });
  }

  function sampleMemory(): void {
    const usage = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, usage.rss);
    peakHeapBytes = Math.max(peakHeapBytes, usage.heapUsed);
  }

  function prepareInput(store: NmgStore, input: RememberInput, index: number): RememberInput {
    if (!preappendHistory) return input;
    const history = store.appendHistory({
      content: input.evidence ?? input.statement,
      role: "user",
      sessionId: "ingest-ablation",
      sourceMessageId: String(index),
      sourceRef: `ingest-ablation:${index}`,
    });
    return { ...input, evidence: undefined, evidenceHistoryId: history.id };
  }
}

function buildWorkload(records: number, supersedeScan: boolean): RememberInput[] {
  return Array.from({ length: records }, (_, index) => {
    if (index > 0 && index % 20 === 0) {
      return {
        statement: `User preference channel ${index % 17} is value ${index}`,
        nodeName: `Preference ${index % 17}`,
        memoryType: "state",
        stateKey: `preference-channel-${index % 17}`,
        scope: { benchmark: "ingest-ablation", user: "u" },
        supersedeScan,
        perf: false,
      };
    }
    const source = index > 0 && index % 29 === 0 ? index - 1 : index;
    return {
      statement: `Synthetic event ${source}: topic ${source % 53} detail ${source} group ${source % 11}`,
      nodeName: `Synthetic node ${source % 61}`,
      memoryType: "conversation_evidence",
      sourceActor: "user",
      truthStatus: "asserted",
      evidence: `Synthetic evidence ${source}`,
      tier: 2,
      scope: { benchmark: "ingest-ablation", user: "u" },
      supersedeScan,
      perf: false,
    };
  });
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  const pivot = offset % values.length;
  return [...values.slice(pivot), ...values.slice(0, pivot)];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function validateConfig(value: Config): void {
  for (const key of ["records", "batchSize", "warmups", "runs"] as const) {
    if (!Number.isInteger(value[key]) || value[key] < (key === "warmups" ? 0 : 1)) {
      throw new Error(`${key} must be a valid integer`);
    }
  }
}
