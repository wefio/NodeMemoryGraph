/** Offline rendering compatibility and cost probe; no store or provider calls. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import type { MemoryContext } from "../../src/core/types.ts";
import {
  renderSearchSurface,
  renderCompactSearchSurface,
  renderEvidenceSurface,
  renderRememberSurface,
} from "../../src/integration/agent-surface.ts";
import { compactSearchContext } from "../../src/integration/search-projection.ts";
import { searchResultFixture } from "../../tests/helpers/search-result.ts";
import { writeJsonAtomic } from "../../tools/parts/fs.ts";
import { mean, percentileFloor } from "../../tools/parts/stats.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    compare: { type: "string" },
    iterations: { type: "string", default: "200" },
  },
});
if (!values.out) throw new Error("Required: --out <report.json> [--compare <baseline.json>]");
const iterations = Number(values.iterations);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0, "Positive iterations required");

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fixture(count: number): MemoryContext {
  return {
    results: Array.from({ length: count }, (_, i) => {
      const record = searchResultFixture(
        `memory-${i}`,
        `Memory ${i}: ${"Keep exact values. ".repeat(30)}`,
      );
      record.memory.eventTime = "2026-10-26T08:00:00+08:00";
      record.memory.resolution = "open";
      record.evidence.content = "A longer original source. ".repeat(40);
      return record;
    }),
    relations: [],
    retrieval: { mode: "lexical", degraded: true, reason: "embedding_unavailable" },
  };
}

function cases() {
  const scenarios: Array<{ name: string; inputHash: string; render: () => string }> = [];
  for (const count of [0, 1, 20, 200]) {
    const input = fixture(count);
    const options = { preamble: "Selected NMG material:", postamble: "Use exact evidence." };
    const compact = compactSearchContext(input);
    for (const [name, render] of [
      ["search", () => renderSearchSurface(input, options)],
      ["compact", () => renderCompactSearchSurface(compact, options)],
      ["evidence", () => renderEvidenceSurface(input, options)],
    ] as const) {
      scenarios.push({ name: `${name}-${count}`, inputHash: digest({ input, options }), render });
    }
  }
  for (const count of [0, 1, 6]) {
    const candidates = Array.from({ length: count }, (_, i) => ({
      memoryId: `old-${i}`,
      nodeId: "node",
      statement: "Previous value. ".repeat(30),
      similarity: 0.8,
      eventTime: null,
    }));
    const input = {
      memory: searchResultFixture("saved", "New value").memory,
      duplicates: candidates,
      supersedeCandidates: candidates,
    };
    scenarios.push({
      name: `remember-${count}`,
      inputHash: digest(input),
      render: () => renderRememberSurface(input),
    });
  }
  return scenarios;
}

function measure(scenario: ReturnType<typeof cases>[number]) {
  for (let i = 0; i < 30; i++) scenario.render();
  const output = scenario.render();
  assert.ok(output.length > 0);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    const result = scenario.render();
    samples.push(performance.now() - started);
    assert.equal(result, output, "Rendering must be deterministic");
  }
  assert.ok(samples.every(Number.isFinite));
  return {
    name: scenario.name,
    inputHash: scenario.inputHash,
    outputHash: digest(output),
    characters: output.length,
    latencyMs: {
      mean: mean(samples),
      p50: percentileFloor(samples, 0.5),
      p95: percentileFloor(samples, 0.95),
    },
  };
}

const report = {
  schema: 1,
  measuredAt: new Date().toISOString(),
  nodeVersion: process.version,
  input: { fixture: "memory-surface-v1", iterations },
  implementation: Object.fromEntries(
    [
      "evals/retrieval/memory-surface.ts",
      "tests/helpers/search-result.ts",
      "src/integration/agent-surface.ts",
      "src/integration/information-output.ts",
      "src/integration/search-projection.ts",
      "src/integration/chain-projection.ts",
    ].map((path) => [path, digest(readFileSync(path, "utf8"))]),
  ),
  cases: cases().map(measure),
};
if (values.compare) {
  const baseline = JSON.parse(readFileSync(values.compare, "utf8")) as typeof report;
  assert.equal(report.nodeVersion, baseline.nodeVersion);
  assert.deepEqual(report.input, baseline.input);
  assert.deepEqual(
    report.cases.map(({ name, inputHash, outputHash, characters }) => ({
      name,
      inputHash,
      outputHash,
      characters,
    })),
    baseline.cases.map(({ name, inputHash, outputHash, characters }) => ({
      name,
      inputHash,
      outputHash,
      characters,
    })),
    "Inputs and complete text must match the baseline",
  );
}
writeJsonAtomic(values.out, report);
console.log(JSON.stringify(report, null, 2));
