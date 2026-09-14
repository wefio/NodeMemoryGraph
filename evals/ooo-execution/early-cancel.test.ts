/**
 * The design's D10: `runCycle`'s early-cancel branch is reachable, or it is dead code.
 *
 * The existing cancellation test aborts while a check is running, so it exercises the late path
 * and the `finally` that closes the round. This file cancels *before* any dispatch: if the early
 * branch were unreachable, nothing here would fail and the branch's own cleanup - the one added
 * for the leak - would be untested. Measured, not assumed: the three assertions below are what the
 * early path does and the late path does not.
 *
 * Not asserted: which task the round would have dispatched, or the shape of its log. Those belong
 * to dispatch, and this test is about the path that runs before dispatch has any say.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyCandidate } from "../../src/integration/ooo-candidate.ts";
import { runCycle } from "../../src/integration/ooo-cycle.ts";

test("a round cancelled before dispatch takes the early path and cleans up after itself", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nmg-ooo-early-"));
  // Point the temp directory at something this test owns, so the leak assertion is about this
  // round's default store directory rather than about whatever else is running concurrently.
  const directory = join(root, "work");
  mkdirSync(directory, { recursive: true });
  for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = directory;
  const controller = new AbortController();
  controller.abort();
  let workerCalls = 0;
  t.after(() => {
    for (const key of ["TMPDIR", "TMP", "TEMP"]) delete process.env[key];
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const result = await runCycle({
    repository: process.cwd(),
    revision: "HEAD",
    baseline: { "src/probe.ts": "export const value = 1;\n" },
    // The check would fail if it ever ran; on the early path it must never be started.
    checks: [{ label: "never-runs", command: process.execPath, args: ["-e", "process.exit(1)"] }],
    runChecks: verifyCandidate,
    signal: controller.signal,
    worker: async () => {
      workerCalls += 1;
      throw new Error("a cancelled round must not call its worker");
    },
    aInstruction: "repair what the check exposes",
    bInstruction: "add the missing regressions",
    aEditable: ["src/probe.ts"],
    bEditable: ["src/probe.test.ts"],
    budget: { perFile: 8_000, output: 8_000 },
    limits: { turns: 1, reads: 1, timeoutMs: 10_000 },
  });

  // The decision is the operator's and it is explicit.
  assert.equal(result.cancelled, "operator cancelled the round");
  // Nothing was accepted, and no work was dispatched on the way out.
  assert.deepEqual(result.accepted, {});
  assert.equal(workerCalls, 0, "the worker ran even though the round was already cancelled");
  // And the default store directory is gone: the early return is a cleanup path too, not only the
  // `finally` after a dispatch.
  assert.deepEqual(
    readdirSync(directory).filter((name) => name.startsWith("ooo-cycle-db-")),
    [],
    "the early-cancel path left its default store directory behind",
  );
});
