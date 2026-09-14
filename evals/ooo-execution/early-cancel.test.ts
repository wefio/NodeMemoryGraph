/**
 * The design's D10: `runCycle`'s early-cancel branch is reachable, or it is dead code.
 *
 * The existing cancellation test aborts while a check is running, so it exercises the late path and
 * the `finally`. This one cancels *before* any dispatch, and it is also where the borrowing contract
 * is observable: the round does not own the store it runs on, so after the early return that store
 * must still be open and usable. A round that closed it - which is what the pre-D7 code did, once
 * per exit path - fails here, and so does one that dispatched work for an already-cancelled round.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { verifyCandidate } from "../../src/integration/ooo-candidate.ts";
import { openRoundStore, runCycle } from "../../src/integration/ooo-cycle.ts";

test("a round cancelled before dispatch takes the early path and leaves the store to its owner", async () => {
  const controller = new AbortController();
  controller.abort();
  let workerCalls = 0;
  // The host owns the store, exactly as the design says: it opens it, the round borrows it, and
  // whoever opened it closes it. Nothing here closes it, so a round that does is caught below.
  const operations = openRoundStore();
  try {
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
      operations,
    });

    // The decision is the operator's, it is explicit, and no work was dispatched on the way out.
    assert.equal(result.cancelled, "operator cancelled the round");
    assert.deepEqual(result.accepted, {});
    assert.equal(workerCalls, 0, "the worker ran even though the round was already cancelled");

    // The borrowed store is still the host's to use. A closed handle throws here, which is how a
    // round that closes what it does not own gets caught.
    assert.equal(operations.cancelled(), "operator cancelled the round");
    assert.deepEqual(operations.accepted(), {});
  } finally {
    operations.close();
  }
});
