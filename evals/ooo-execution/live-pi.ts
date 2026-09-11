import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Actor } from "./process-driver.ts";
import type { BoardTicket } from "./board-admission.ts";
import type { PiRun } from "../../.pi/extensions/nmg/ooo-execution.ts";

/** What a `solve` command returns: the run's own measurements plus the host verdict. */
type Solved = PiRun & { verdict: string; workerPid: number; taskId: string };

if (!process.argv.includes("--live"))
  throw new Error("Explicit --live required: this runs three real Pi tasks");
const provider = process.env.PI_PROVIDER;
const model = process.env.PI_MODEL;
if (!provider || !model) throw new Error("Set PI_PROVIDER and PI_MODEL explicitly");
const directory = mkdtempSync(join(tmpdir(), "nmg-ooo-live-"));
const database = join(directory, "nmg.sqlite");
const daemon = new Actor("daemon-live", database);
const first = new Actor("pi-worker", database);
const second = new Actor("pi-worker", database);
const startedAt = new Date().toISOString();
try {
  const [endpoint] = await Promise.all([daemon.ready, first.ready, second.ready]);
  await first.call("connect", { endpoint, agent: "pi-ooo-1" });
  await second.call("connect", { endpoint, agent: "pi-ooo-2" });
  const results = [];
  assert.equal(await daemon.call("next"), "B");
  const run = async (worker: Actor, task: string) => {
    const ticket = await worker.call<BoardTicket>("take", { task });
    const start = Date.now();
    const execution = await worker.call<Solved>("solve", { task, provider, model }, 65_000);
    assert.equal(execution.verdict, "accepted", `${task}: ${execution.verdict}`);
    console.log(
      `${task}: accepted, ${execution.reads} snapshot read(s), ${execution.tokens} tokens`,
    );
    return { ...execution, inputDigest: ticket.inputDigest, elapsedMs: Date.now() - start };
  };
  results.push(await run(first, "B"));
  assert.equal(await daemon.call("next"), null, "A remains externally blocked after B");
  await daemon.call("externalReady", { event: "interface-response" });
  results.push(await run(second, "A"));
  results.push(await run(first, "C"));
  assert.equal(
    new Set(results.map((result) => result.sessionId)).size,
    3,
    "fresh model context per task",
  );
  assert.equal(
    new Set(results.map((result) => result.workerPid)).size,
    2,
    "two real Pi worker processes",
  );
  assert.equal(await daemon.call("next"), null);
  const accepted = await daemon.call<Record<string, string>>("accepted");
  assert.equal(accepted.C, `${accepted.A}\n${accepted.B}`);
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    provider,
    model,
    order: results.map((result) => result.taskId),
    results,
    accepted,
    boundary:
      "Real Pi SDK agents and frozen repository text; externally signalled wait is controlled. No speedup baseline, arbitrary tools or AG migration tested.",
  };
  const output = resolve(import.meta.dirname, "../../.nmg/ooo-live/latest.json");
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Report: ${output}`);
} finally {
  await Promise.all([daemon.kill(), first.kill(), second.kill()]);
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
