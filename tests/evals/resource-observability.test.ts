import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ResourceSampler,
  parsePsCpuTime,
  sampleResourceTick,
  type ProcessSample,
} from "../../evals/omnimemeval/resource-observability.ts";

// Note: on Windows each sampleResourceTick spawns a full PowerShell process
// enumeration (~1-2 s), so tests deliberately share samples instead of
// re-sampling per assertion.

test("parsePsCpuTime handles days, hours, minutes, seconds", () => {
  assert.equal(parsePsCpuTime("0:00:01"), 1);
  assert.equal(parsePsCpuTime("1:02:03"), 3723);
  assert.equal(parsePsCpuTime("1-02:03:04"), 93_784);
  assert.equal(parsePsCpuTime("garbage"), 0);
});

test("sampleResourceTick records cumulative CPU, RSS, and roles", () => {
  const rootPid = process.pid;
  const tick = sampleResourceTick(rootPid, 0, null);
  const root = tick.processes.find((process) => process.pid === rootPid);
  assert.ok(root, "current process appears in its own subtree");
  assert.equal(root!.cpuPercent, 0, "first tick has no interval baseline");
  assert.ok(root!.rssBytes > 0, "current process reports a positive RSS");
  assert.ok(root!.cpuMs >= 0);
  assert.ok(tick.processes.every((process) => process.role.length > 0));
  assert.ok(tick.at && tick.elapsedMs === 0);
});

test("cpuPercent is bounded and zero for a fresh process", () => {
  const rootPid = process.pid;
  // No previous map => no delta => 0%.
  const tick = sampleResourceTick(rootPid, 5_000, new Map());
  const root = tick.processes.find((process) => process.pid === rootPid)!;
  assert.equal(root.cpuPercent, 0);
  // A previous map yields a bounded 0..100 value.
  const previous = new Map<number, number>([[rootPid, root.cpuMs]]);
  const second = sampleResourceTick(rootPid, 5_000, previous);
  const root2 = second.processes.find((process) => process.pid === rootPid)!;
  assert.ok(root2.cpuPercent >= 0 && root2.cpuPercent <= 100);
});

test("resource sampler is bounded and aggregates a summary", async () => {
  const sampler = new ResourceSampler({
    label: "test-suite",
    rootPid: process.pid,
    cadenceMs: 50,
    maxTicks: 3,
  });
  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 180));
  await sampler.stop();

  assert.ok(sampler.report.ticks.length >= 1, "collected at least one tick");
  assert.ok(sampler.report.ticks.length <= 3, "ticks stay bounded by maxTicks");
  assert.ok(sampler.report.endedAt > sampler.report.startedAt);
  assert.ok(sampler.report.summary.processCountMax >= 1);
  assert.ok(sampler.report.summary.peakTotalRssBytes > 0);
  assert.ok(sampler.report.summary.peakProcessRssBytes > 0);
  assert.ok(sampler.report.summary.peakCpuPercent >= 0);
});

test("resource tick exposes the current process as a typed sample", () => {
  const samples: ProcessSample[] = sampleResourceTick(process.pid, 0, null).processes;
  const current = samples.find((sample) => sample.pid === process.pid);
  assert.ok(current);
  assert.equal(typeof current!.role, "string");
  assert.ok(Number.isInteger(current!.pid));
});
