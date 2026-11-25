/**
 * Isolates each arm of the matched production comparison in its own process.
 *
 * The in-process matched runner shares a process between arms, so the first
 * execution of an arm carries V8 optimization and its own garbage collection.
 * This probe measures the same eight-conversation write plus lexical/hybrid
 * query loops, one arm per child process, alternating arm order per round, and
 * records the CPU split and GC time inside each measurement window.
 *
 * Usage:
 *   node hybrid-isolation-probe.mjs --baseline-ref 604a89e9 \
 *     --data-root D:/Github/.benchmarks/official/OmniMemEval/data \
 *     --rounds 6 --limit 1 --out <file>
 *
 * Child mode is internal (`--child`), invoked once per arm.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), "../../..");
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const percentile = (samples, p) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
const percentiles = (samples) => ({
  p50Ms: percentile(samples, 0.5),
  p95Ms: percentile(samples, 0.95),
  p99Ms: percentile(samples, 0.99),
});
const ms = (micros) => micros / 1000;

function parse() {
  return parseArgs({
    options: {
      "baseline-ref": { type: "string", default: "604a89e9" },
      "data-root": { type: "string" },
      rounds: { type: "string", default: "6" },
      limit: { type: "string" },
      out: { type: "string" },
      child: { type: "boolean", default: false },
      source: { type: "string" },
      db: { type: "string" },
      "arm-name": { type: "string" },
    },
    allowPositionals: false,
  }).values;
}

async function loadLib(source) {
  const load = (relative) => import(pathToFileURL(join(source, "src", relative)).href);
  const [graphs, runtime, storage, engine, http, vector] = await Promise.all([
    load("core/compute-graph.ts"),
    load("core/runtime/index.ts"),
    load("core/memory/open.ts"),
    load("core/memory/engine.ts"),
    load("integration/memory-http-service.ts"),
    load("core/vector.ts"),
  ]);
  return { ...graphs, ...runtime, ...storage, ...engine, ...http, ...vector };
}

function observeGc() {
  const window = { count: 0, totalMs: 0, maxMs: 0 };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.count += 1;
      window.totalMs += entry.duration;
      window.maxMs = Math.max(window.maxMs, entry.duration);
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  return {
    reset() {
      window.count = 0;
      window.totalMs = 0;
      window.maxMs = 0;
      globalThis.gc?.();
    },
    read: () => ({ ...window }),
    stop: () => observer.disconnect(),
  };
}

async function measureLoop(service, queries, now, concurrency, gc) {
  const search = (query) => service.search([query], 10, [], undefined, { now });
  for (const query of queries.slice(0, 4)) await search(query.query);
  const latency = [];
  const output = [];
  gc.reset();
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < queries.length; i += concurrency) {
    const batch = queries.slice(i, i + concurrency);
    const pages = await Promise.all(
      batch.map(async ({ query }) => {
        const begin = performance.now();
        const page = await search(query);
        latency.push(performance.now() - begin);
        return page.memories.map(({ id, score }) => ({ id, score }));
      }),
    );
    output.push(...pages);
  }
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuBefore);
  const heapAfter = process.memoryUsage().heapUsed;
  // GC entries are delivered on the next event-loop turn, so flush before reading.
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.ok(output.some((page) => page.length > 0));
  return {
    latency,
    ...percentiles(latency),
    wallMs,
    requestsPerSecond: (1000 * queries.length) / wallMs,
    cpuMs: { user: ms(cpu.user), system: ms(cpu.system), total: ms(cpu.user + cpu.system) },
    gc: gc.read(),
    heapUsedDeltaMb: (heapAfter - heapBefore) / 1024 / 1024,
    digest: digest(output),
  };
}

async function measureArm(lib, dataset, dbPath, now) {
  const backend = await lib.openMemoryBackend({
    kind: "sqlite",
    path: dbPath,
    namespace: "isolation-probe",
  });
  try {
    const engine = new lib.MemoryEngine(backend, () => now);
    const http = new lib.HttpMemoryService(engine, undefined, { preprocessMessages: false });
    const conversations = dataset.conversations.slice(0, 8);
    const queries = dataset.questions.slice(0, 32);
    let records = 0;
    const writeStart = performance.now();
    for (const conversation of conversations) {
      const messages = conversation.messages.map((message, i) => ({
        ...message,
        source_message_id: String(i),
      }));
      const operationId = "locomo:" + conversation.conversationId;
      const out = await http.rememberBatch(
        "locomo",
        conversation.conversationId,
        operationId,
        messages,
        operationId,
      );
      records += out.added;
    }
    const writeMs = performance.now() - writeStart;
    const hashing = new lib.HashingVectorEmbedder();
    const indexId = "offline-hashing";
    const pending = backend.vectorIndex.pending(indexId, 1024);
    backend.vectorIndex.save(
      indexId,
      pending,
      pending.map(({ text }) => [...hashing.embed(text)]),
    );
    const hybrid = new lib.HttpMemoryService(
      engine,
      {
        indexId,
        model: hashing.model,
        profile: "fixture",
        embedQueries: async (texts) => texts.map((text) => [...hashing.embed(text)]),
      },
      { preprocessMessages: false, allowBackfill: false },
    );
    const gc = observeGc();
    const results = { lexical: {}, hybrid: {} };
    try {
      for (const concurrency of [1, 8]) {
        results.lexical[concurrency] = await measureLoop(http, queries, now, concurrency, gc);
        results.hybrid[concurrency] = await measureLoop(hybrid, queries, now, concurrency, gc);
      }
    } finally {
      gc.stop();
    }
    return {
      conversationIds: conversations.map(({ conversationId }) => conversationId),
      queryIds: queries.map(({ id }) => id),
      records,
      writeMs,
      results,
    };
  } finally {
    await backend.close();
  }
}

async function runChild(values) {
  const dataRoot = resolve(values["data-root"]);
  const lib = await loadLib(resolve(values.source));
  const { loadDataset } = await import(
    pathToFileURL(join(root, "evals/retrieval/datasets.ts")).href
  );
  const options = values.limit ? { limit: Number(values.limit) } : {};
  const dataset = loadDataset("locomo", options, dataRoot);
  const result = await measureArm(lib, dataset, values.db, "2026-10-20T00:00:00.000Z");
  writeFileSync(
    values.out,
    JSON.stringify(
      {
        arm: values["arm-name"],
        dataset: { name: dataset.name, sha256: dataset.sha256, sampleNote: dataset.sampleNote },
        ...result,
      },
      null,
      2,
    ) + "\n",
  );
}

function prepareBaseline(baselineRef, scratch) {
  const archive = join(scratch, "baseline.tar");
  const relativeScratch = relative(root, scratch);
  const relativeArchive = join(relativeScratch, "baseline.tar");
  const ref = execFileSync("git", ["rev-parse", "--verify", baselineRef + "^{commit}"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  execFileSync(
    "git",
    ["archive", "-o", relativeArchive, ref, "src", "scripts/generate-prompts.ts"],
    {
      cwd: root,
    },
  );
  execFileSync("tar", ["-xf", relativeArchive, "-C", relativeScratch], { cwd: root });
  execFileSync(process.execPath, [join(scratch, "scripts/generate-prompts.ts")], { cwd: scratch });
  return ref;
}

function spawnChild(values, source, db, out, armName) {
  const args = [
    "--experimental-strip-types",
    "--expose-gc",
    self,
    "--child",
    "--source",
    source,
    "--db",
    db,
    "--out",
    out,
    "--arm-name",
    armName,
    "--data-root",
    values["data-root"],
  ];
  if (values.limit) args.push("--limit", values.limit);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${armName} child exited ${code}`)),
    );
  });
}

function summarize(rounds) {
  const ratio = (samples) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const groups = {};
  for (const mode of ["lexical", "hybrid"]) {
    for (const concurrency of ["1", "8"]) {
      groups[mode + "/" + concurrency] = rounds.map(({ arms }) => {
        const base = arms.baseline.results[mode][concurrency];
        const post = arms.post.results[mode][concurrency];
        return {
          baseRps: base.requestsPerSecond,
          postRps: post.requestsPerSecond,
          ratio: post.requestsPerSecond / base.requestsPerSecond,
          baseCpu: base.cpuMs.total,
          postCpu: post.cpuMs.total,
          baseGc: base.gc.totalMs,
          postGc: post.gc.totalMs,
        };
      });
    }
  }
  const summary = {};
  for (const [key, rows] of Object.entries(groups)) {
    summary[key] = {
      medianRatio: ratio(rows.map((row) => row.ratio)),
      minRatio: Math.min(...rows.map((row) => row.ratio)),
      maxRatio: Math.max(...rows.map((row) => row.ratio)),
      medianBaseRps: ratio(rows.map((row) => row.baseRps)),
      medianPostRps: ratio(rows.map((row) => row.postRps)),
    };
  }
  return summary;
}

async function main(values) {
  assert.ok(values["data-root"], "--data-root is required");
  assert.ok(values.out, "--out is required");
  const rounds = Number(values.rounds);
  assert.ok(Number.isInteger(rounds) && rounds > 0, "--rounds must be a positive integer");
  const scratch = mkdtempSync(join(root, ".isolation-probe-"));
  try {
    const baselineRef = prepareBaseline(values["baseline-ref"], scratch);
    const report = {
      baselineRef,
      measuredAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cores: os.availableParallelism(),
      cpu: os.cpus()[0]?.model,
      isolation: "one process per arm, alternating arm order per round",
      dataset: { dataRoot: resolve(values["data-root"]), limit: values.limit ?? null },
      trials: [],
    };
    for (let round = 0; round < rounds; round += 1) {
      const order = round % 2 === 0 ? ["baseline", "post"] : ["post", "baseline"];
      const arms = {};
      for (const key of order) {
        const source = key === "baseline" ? scratch : root;
        const db = join(scratch, key + "-" + round + ".sqlite");
        const out = join(scratch, key + "-" + round + ".json");
        await spawnChild(values, source, db, out, key);
        arms[key] = JSON.parse(readFileSync(out, "utf8"));
      }
      assert.equal(arms.baseline.records, arms.post.records);
      for (const mode of ["lexical", "hybrid"]) {
        for (const concurrency of [1, 8]) {
          assert.equal(
            arms.baseline.results[mode][concurrency].digest,
            arms.post.results[mode][concurrency].digest,
          );
        }
      }
      report.trials.push({ order, arms });
    }
    report.summary = summarize(report.trials);
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(resolve(values.out), JSON.stringify(report, null, 2) + "\n");
    process.stdout.write("Wrote " + resolve(values.out) + "\n");
    for (const [key, row] of Object.entries(report.summary)) {
      process.stdout.write(
        key +
          "\tmedian " +
          row.medianBaseRps.toFixed(1) +
          " -> " +
          row.medianPostRps.toFixed(1) +
          " req/s\t" +
          (100 * (row.medianRatio - 1)).toFixed(1) +
          "%\t[" +
          (100 * (row.minRatio - 1)).toFixed(1) +
          "%, " +
          (100 * (row.maxRatio - 1)).toFixed(1) +
          "%]\n",
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const values = parse();
if (values.child) await runChild(values);
else await main(values);
