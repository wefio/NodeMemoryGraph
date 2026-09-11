import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ServerState } from "../../src/cli/lifecycle.ts";
import type { TaskBoardEntry } from "../../src/core/types.ts";
import type { BoardTicket } from "./board-admission.ts";

import { Actor } from "./process-driver.ts";

test(
  "board-backed multi-process admission survives transfer, duplicate delivery and daemon crash",
  { timeout: 90_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "nmg-ooo-process-"));
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
      const first = start("worker");
      const second = start("worker");
      await Promise.all([first.ready, second.ready]);
      assert.equal(
        new Set([process.pid, daemon.child.pid, first.child.pid, second.child.pid]).size,
        4,
      );
      await first.call("connect", { endpoint, agent: "worker-1" });
      await second.call("connect", { endpoint, agent: "worker-2" });

      await assert.rejects(first.call("take", { task: "A" }), /no ready handoff/);
      const claims = await Promise.allSettled([
        first.call("take", { task: "B" }),
        second.call("take", { task: "B" }),
      ]);
      assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
      const bWorker = claims[0]!.status === "fulfilled" ? first : second;
      const duplicates = await Promise.all([
        bWorker.call("deliver", { task: "B" }),
        bWorker.call("deliver", { task: "B" }),
      ]);
      assert.deepEqual(duplicates.sort(), ["accepted", "duplicate"]);
      assert.equal(
        (await second.call<TaskBoardEntry[]>("board")).filter(
          (entry: TaskBoardEntry) =>
            entry.kind === "handoff" && JSON.parse(entry.content).id === "C",
        ).length,
        0,
      );

      await daemon.call("externalReady", { event: "interface-response" });
      await first.call("take", { task: "A" });
      const invalid = await first.call("publish", { task: "A", artifact: "wrong" });
      assert.equal(await second.call("submit", { resultId: invalid }), "rejected");
      await assert.rejects(second.call("take", { task: "A" }), /claimed/);
      // Hold an already-verified A candidate before its final transaction.
      await daemon.call("pauseNext");
      const verified = daemon.event("verified");
      const late = first.call("deliver", { task: "A" });
      await verified;
      const now = await daemon.call("advance", { milliseconds: 61_000 });
      assert.equal(
        await first.call("deliver", { task: "A" }),
        "stale",
        "expired even before reassignment",
      );
      const replacement = await second.call<BoardTicket>("take", { task: "A" });
      assert.equal(replacement.attempt, 2);
      await daemon.call("resume");
      assert.equal(await late, "stale");
      await daemon.call("pauseAfterCommit");
      const aCommitted = daemon.event("committed");
      const aInterrupted = assert.rejects(
        second.call("deliver", { task: "A" }),
        /fetch failed|socket|closed/i,
      );
      await aCommitted;
      assert.deepEqual(await daemon.call("accepted"), { A: "4", B: "6" });
      assert.equal(
        (await second.call<TaskBoardEntry[]>("board")).filter(
          (entry: TaskBoardEntry) =>
            entry.kind === "handoff" && JSON.parse(entry.content).id === "C",
        ).length,
        0,
      );
      await daemon.kill();
      await aInterrupted;
      daemon = start("daemon");
      endpoint = (await daemon.ready) as ServerState;
      await daemon.call("setNow", { now });
      await first.call("connect", { endpoint, agent: "worker-1" });
      await second.call("connect", { endpoint, agent: "worker-2" });
      assert.equal(await first.call("deliver", { task: "A" }), "stale");
      assert.equal(await second.call("deliver", { task: "A" }), "duplicate");

      const board = await second.call<TaskBoardEntry[]>("board");
      assert.equal(
        board.filter(
          (entry: TaskBoardEntry) =>
            entry.kind === "handoff" && JSON.parse(entry.content).id === "C",
        ).length,
        1,
      );
      await first.call("take", { task: "C" });
      const resultId = await first.call("publish", { task: "C" });
      await first.kill();
      // Another process can submit the dead worker's persisted result.
      await daemon.kill();
      daemon = start("daemon");
      endpoint = (await daemon.ready) as ServerState;
      await daemon.call("setNow", { now });
      await second.call("connect", { endpoint, agent: "worker-2" });
      assert.ok(
        (await second.call<TaskBoardEntry[]>("board")).some(
          (entry: TaskBoardEntry) => entry.id === resultId,
        ),
      );
      await daemon.call("pauseAfterCommit");
      const committed = daemon.event("committed");
      const interrupted = assert.rejects(
        second.call("submit", { resultId }),
        /fetch failed|socket|closed/i,
      );
      await committed;
      assert.equal(
        (await second.call<TaskBoardEntry[]>("board")).filter(
          (entry: TaskBoardEntry) => entry.kind === "decision",
        ).length,
        2,
      );
      // Crash after durable acceptance but before the board decision is published.
      await daemon.kill();
      await interrupted;
      daemon = start("daemon");
      endpoint = (await daemon.ready) as ServerState;
      await daemon.call("setNow", { now });
      await second.call("connect", { endpoint, agent: "worker-2" });
      const verdicts = await Promise.all([
        second.call("submit", { resultId }),
        second.call("submit", { resultId }),
      ]);
      assert.deepEqual(verdicts, ["duplicate", "duplicate"]);
      assert.deepEqual(await daemon.call("accepted"), { A: "4", B: "6", C: "10" });
      const accepted = (await second.call<TaskBoardEntry[]>("board")).filter(
        (entry: TaskBoardEntry) => entry.kind === "decision",
      );
      assert.equal(accepted.length, 3);
      assert.equal(
        accepted.filter((entry: TaskBoardEntry) => JSON.parse(entry.content).id === "C").length,
        1,
      );
    } finally {
      await Promise.all(actors.map((actor) => actor.kill()));
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);

test(
  "narrow dispatch does not preempt and rejects input changes during verification",
  { timeout: 60_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "nmg-ooo-narrow-"));
    const database = join(directory, "nmg.sqlite");
    const daemon = new Actor("daemon", database);
    const first = new Actor("worker", database);
    const second = new Actor("worker", database);
    try {
      const [endpoint] = await Promise.all([daemon.ready, first.ready, second.ready]);
      await first.call("connect", { endpoint, agent: "narrow-1" });
      await second.call("connect", { endpoint, agent: "narrow-2" });
      assert.equal(await daemon.call("next"), "B");
      await assert.rejects(second.call("requestClaim", { task: "A" }), /dependencies/);
      await assert.rejects(daemon.call("externalReady", { event: "invented" }), /unknown/);
      await first.call("take", { task: "B" });
      await daemon.call("externalReady", { event: "interface-response" });
      assert.equal(await daemon.call("next"), null, "ready A does not preempt running B");
      await assert.rejects(second.call("requestClaim", { task: "A" }), /dependencies|not selected/);
      await assert.rejects(second.call("requestClaim", { task: "C" }), /dependencies/);
      await daemon.call("pauseNext");
      const verified = daemon.event("verified");
      const pending = first.call("deliver", { task: "B" });
      await verified;
      await daemon.call("observeRevision", { task: "B", revision: "input-v2" });
      await daemon.call("resume");
      assert.equal(await pending, "stale");
      assert.deepEqual(await daemon.call("accepted"), {});
      await daemon.call("advance", { milliseconds: 61_000 });
      assert.equal(await daemon.call("next"), "A");
      await second.call("take", { task: "A" });
      assert.equal(await second.call("deliver", { task: "A" }), "accepted");
      assert.equal(await daemon.call("next"), null, "changed B needs review, not automatic retry");
      await assert.rejects(first.call("requestClaim", { task: "B" }), /not selected/);
      assert.deepEqual(await daemon.call("accepted"), { A: "4" });
      assert.equal(
        (await second.call<TaskBoardEntry[]>("board")).filter(
          (entry: TaskBoardEntry) =>
            entry.kind === "handoff" && JSON.parse(entry.content).id === "C",
        ).length,
        0,
      );
    } finally {
      await Promise.all([daemon.kill(), first.kill(), second.kill()]);
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
