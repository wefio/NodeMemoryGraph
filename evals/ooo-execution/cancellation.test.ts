// S2 exit: cancelling a running round leaves no orphan check process and no completion after
// the decision. This runs real child processes and real git worktrees.
//
// Platform note, measured rather than assumed: on Windows a plain `child.kill()` already
// reaps the check's own children, because libuv puts non-detached children in a job object
// (verified: this test passes with the tree kill replaced by `child.kill("SIGKILL")`). The
// explicit `taskkill /T` in `candidate.ts` is therefore belt-and-braces there, while the
// POSIX branch — a detached process group plus `process.kill(-pid)` — is what makes it hold
// where no such job object exists. What this test pins is the property, not the mechanism:
// after cancellation the check is gone, its worktree is gone, and nothing is accepted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ServerState } from "../../src/cli/lifecycle.ts";
import type { TaskBoardEntry } from "../../src/core/types.ts";
import type { BoardTicket } from "./board-admission.ts";
import { Actor } from "./process-driver.ts";
import { verifyCandidate } from "./candidate.ts";
import { runCycle } from "./cycle.ts";

/** A check that reports its own pid and a grandchild's, then outlives the round. */
function longCheck(marker: string): string {
  return `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
  stdio: "ignore",
});
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ check: process.pid, grandchild: grandchild.pid }));
setTimeout(() => {}, 120000);
`;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

test(
  "cancelling a round kills its running check and leaves no accepted work",
  { timeout: 120_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "nmg-ooo-cancel-"));
    // The candidate worktree is created under the OS temp dir, and other test files create
    // their own concurrently. Pointing temp at a directory this test owns makes the leak check
    // about *this* round instead of about whatever else happens to be running.
    const directory = join(root, "work");
    mkdirSync(directory, { recursive: true });
    for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = directory;
    const marker = join(root, "check.json");
    const controller = new AbortController();
    t.after(() => {
      for (const key of ["TMPDIR", "TMP", "TEMP"]) delete process.env[key];
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    const round = runCycle({
      repository: process.cwd(),
      revision: "HEAD",
      baseline: {
        "src/probe.ts": "export const value = 1;\n",
        "src/probe.test.ts": "test('probe identity', () => {});\n",
      },
      checks: [{ label: "slow-check", command: process.execPath, args: ["-e", longCheck(marker)] }],
      runChecks: verifyCandidate,
      signal: controller.signal,
      worker: async (_task, frozen) =>
        JSON.stringify({
          digest: frozen.digest,
          conclusion: "no-change-needed",
          summary: "the check has not reported, so there is nothing to repair yet",
          evidence: "the round was cancelled before the check terminal event",
          citations: [],
        }),
      aInstruction: "repair what the check exposes",
      bInstruction: "add the missing regressions",
      aEditable: ["src/probe.ts"],
      bEditable: ["src/probe.test.ts"],
      budget: { perFile: 8_000, output: 8_000 },
      limits: { turns: 2, reads: 2, timeoutMs: 60_000 },
    });

    assert.ok(await waitFor(() => existsSync(marker), 60_000), "the check never started");
    const pids = JSON.parse(readFileSync(marker, "utf8")) as { check: number; grandchild: number };
    assert.ok(alive(pids.check) && alive(pids.grandchild), "the check should be running");
    controller.abort();

    const result = await round;
    // The round's decision is explicit and durable, not an implied timeout.
    assert.equal(result.cancelled, "operator cancelled the round");
    assert.deepEqual(result.accepted, {});
    assert.equal(result.composed.verdict, "undecidable");
    assert.equal(
      result.log.findLast((event) => event.kind === "terminal")!.cancelled,
      "operator cancelled the round",
    );
    // Nothing the check was doing keeps running afterwards.
    assert.ok(
      await waitFor(() => !alive(pids.check) && !alive(pids.grandchild), 20_000),
      "a check process survived the cancellation",
    );
    // The cancelled round does not leak its candidate worktree either.
    const worktrees = execFileSync("git", ["worktree", "list"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const owned = worktrees
      .split("\n")
      .filter((line) => line.replaceAll("\\", "/").includes(directory.replaceAll("\\", "/")));
    assert.deepEqual(owned, [], `the candidate worktree leaked: ${owned.join(", ")}`);
  },
);

test(
  "cancelling with a live worker in another process leaves no ghost completion",
  { timeout: 90_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "nmg-ooo-cancel-mp-"));
    const database = join(directory, "nmg.sqlite");
    const actors: Actor[] = [];
    const start = (role: string) => {
      const actor = new Actor(role, database);
      actors.push(actor);
      return actor;
    };
    try {
      let daemon = start("daemon");
      let endpoint = (await daemon.ready) as ServerState;
      const worker = start("worker");
      await worker.ready;
      assert.equal(new Set([process.pid, daemon.child.pid, worker.child.pid]).size, 3);
      await worker.call("connect", { endpoint, agent: "worker-1" });
      const ticket = await worker.call<BoardTicket>("take", { task: "B" });
      assert.equal(ticket.attempt, 1);

      // The worker is mid-attempt: its delivery has been verified and is held before the
      // final transaction, which is the exact window a cancellation has to fence.
      await daemon.call("pauseNext");
      const verified = daemon.event("verified");
      const pending = worker.call("deliver", { task: "B" });
      await verified;
      // The operator cancels from a *different* process than the one holding the claim.
      assert.equal(
        await daemon.call("cancel", { reason: "operator stopped the round" }),
        "operator stopped the round",
      );
      await daemon.call("resume");

      assert.equal(await pending, "stale", "a cancelled round must not complete the attempt");
      assert.deepEqual(await daemon.call("accepted"), {});
      assert.equal(await daemon.call("next"), null, "nothing is selectable after cancellation");
      const board = await worker.call<TaskBoardEntry[]>("board");
      assert.equal(
        board.filter(
          (entry: TaskBoardEntry) =>
            entry.kind === "handoff" && JSON.parse(entry.content).id === "C",
        ).length,
        0,
        "a cancelled round must not unlock its dependent",
      );

      // The decision is durable: a restart keeps the reason and still refuses the worker.
      await daemon.kill();
      daemon = start("daemon");
      endpoint = (await daemon.ready) as ServerState;
      await worker.call("connect", { endpoint, agent: "worker-1" });
      assert.equal(await daemon.call("cancelled"), "operator stopped the round");
      assert.equal(await worker.call("deliver", { task: "B" }), "stale");
      assert.deepEqual(await daemon.call("accepted"), {});
      assert.equal(await daemon.call("next"), null);
      // Two refusals, from two different layers: the published handoff is gone, and the
      // coordinator itself refuses a new claim in a cancelled round.
      await assert.rejects(worker.call("take", { task: "B" }), /no ready handoff/);
      await assert.rejects(worker.call("requestClaim", { task: "B" }), /cancelled/);
    } finally {
      await Promise.all(actors.map((actor) => actor.kill()));
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
