import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { NmgService } from "../../src/cli/service.ts";

const sessions = boundedInteger(process.env.NMG_CONCURRENCY_SESSIONS, 32, 1, 128);
const writesPerSession = boundedInteger(process.env.NMG_CONCURRENCY_WRITES, 25, 1, 100);
const directory = mkdtempSync(join(tmpdir(), "nmg-concurrency-"));
const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
const latencies: number[] = [];
const failures: string[] = [];
const startedAt = performance.now();

try {
  await Promise.all(
    Array.from({ length: sessions }, async (_, sessionIndex) => {
      const sessionId = `concurrency-session-${sessionIndex}`;
      for (let writeIndex = 0; writeIndex < writesPerSession; writeIndex += 1) {
        const started = performance.now();
        try {
          await service.invoke("remember", {
            statement: `Project concurrency-${sessionIndex} requires durable checkpoint ${writeIndex}.`,
            nodeName: `Concurrency project ${sessionIndex}`,
            memoryType: "constraint",
            sourceActor: "user",
            sessionId,
            scope: { project: `concurrency-${sessionIndex}` },
          });
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        } finally {
          latencies.push(performance.now() - started);
        }
      }
      const result = await service.invoke("search", {
        query: `concurrency-${sessionIndex} checkpoint ${writesPerSession - 1}`,
        sessionId,
        scope: { project: `concurrency-${sessionIndex}` },
        retrievalMode: "fts5",
      });
      if (result.results.length === 0) failures.push(`${sessionId}: final checkpoint not found`);
    }),
  );
} finally {
  service.close();
  rmSync(directory, { recursive: true, force: true });
}

latencies.sort((left, right) => left - right);
const elapsedMs = performance.now() - startedAt;
console.log(
  JSON.stringify(
    {
      sessions,
      writesPerSession,
      totalWrites: sessions * writesPerSession,
      failures: failures.length,
      firstFailures: failures.slice(0, 5),
      elapsedMs,
      writesPerSecond: (sessions * writesPerSession) / (elapsedMs / 1_000),
      writeLatencyMs: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
        max: latencies.at(-1) ?? 0,
      },
    },
    null,
    2,
  ),
);

if (failures.length > 0) process.exitCode = 1;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]!;
}
