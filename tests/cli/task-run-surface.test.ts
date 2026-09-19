import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgService } from "../../src/cli/service.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

// In-process NmgService inherits process.env; keep recall lexical (test-env.ts).
stripProviderEnv();

/** One daemon and one temp database per case. The run surface is what another process reaches, so
 *  every case here goes through `service.invoke`, never through the coordinator directly. */
function withService(
  body: (service: NmgService, databasePath: string) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "nmg-task-run-"));
    const databasePath = join(directory, "nmg.sqlite");
    const service = new NmgService({ databasePath, environment: {} });
    try {
      await body(service, databasePath);
    } finally {
      service.close();
      removeTempDirectory(directory);
    }
  };
}

const CHANNEL = "round-1";
const RUN = "run-1";

async function registerAndFreeze(service: NmgService): Promise<void> {
  await service.invoke("taskRun", {
    action: "register",
    runId: RUN,
    planDigest: "sha256:plan",
    policy: "ordered",
    revision: "r1",
    retention: "evidence",
  });
  await service.invoke("taskRun", {
    action: "freeze",
    runId: RUN,
    tasks: [
      {
        taskId: "P",
        revision: "r1",
        input: "prepare the artifact",
        dependencies: [],
        effect: "artifact",
        operation: "prepare",
      },
      {
        taskId: "J",
        revision: "r1",
        input: "judge the artifact",
        dependencies: ["P"],
        effect: "verdict",
        operation: "judge",
      },
    ],
  });
}

/** Put one entry on the round's channel, adopting it into `taskId` in the same transition. */
async function adopt(
  service: NmgService,
  taskId: string,
  attempt?: number,
): Promise<{ entryId: string; taskId: string }> {
  const written = await service.invoke("taskBoard", {
    action: "put",
    taskId: CHANNEL,
    agentId: "agent-a",
    sourceSessionId: "session-a",
    kind: "handoff",
    content: `carry ${taskId}`,
    adopt: { runId: RUN, taskId, attempt },
  });
  if (written.action !== "put") throw new Error("expected a put result");
  return { entryId: written.entry.id, taskId: written.entry.taskId };
}

async function status(service: NmgService) {
  const result = await service.invoke("taskRun", { action: "status", runId: RUN });
  if (result.action !== "status") throw new Error("expected a status result");
  return result.status;
}

test(
  "a run registers, freezes a plan, adopts entries, and reads it all back",
  withService(async (service) => {
    // The run surface is what another process reaches, so the daemon has to advertise it: a client
    // that wants to adopt an entry gates that field on the method being there (an earlier daemon in
    // the same epoch would ignore `adopt` and create an unmanaged entry).
    const hello = await service.invoke("hello");
    assert.ok(hello.methods.includes("taskRun"));
    await registerAndFreeze(service);
    const written = await service.invoke("taskBoard", {
      action: "put",
      taskId: CHANNEL,
      agentId: "agent-a",
      sourceSessionId: "session-a",
      kind: "handoff",
      content: "carry J",
      adopt: { runId: RUN, taskId: "J" },
    });
    if (written.action !== "put") throw new Error("expected a put result");
    assert.deepEqual(written.bound && { ...written.bound, sequence: undefined }, {
      sequence: undefined,
      recorded: true,
    });

    const view = await status(service);
    assert.equal(view.manifest?.planDigest, "sha256:plan");
    assert.deepEqual(
      view.tasks.map((task) => [task.taskId, task.position, task.dependencies]),
      [
        ["P", 0, []],
        ["J", 1, ["P"]],
      ],
    );
    assert.deepEqual(view.bindings, [
      {
        taskId: "J",
        attempt: 1,
        entryId: written.entry.id,
        sequence: view.bindings[0]!.sequence,
        entry: { taskId: CHANNEL, status: "open", claimedBy: null, ackedBy: [] },
      },
    ]);
    assert.deepEqual(
      view.facts.map((fact) => fact.kind),
      ["entry-bound"],
    );
  }),
);

test(
  "adoption is part of the transition that creates the entry, so a refusal leaves no entry",
  withService(async (service) => {
    await registerAndFreeze(service);
    await assert.rejects(
      service.invoke("taskBoard", {
        action: "put",
        taskId: CHANNEL,
        agentId: "agent-a",
        kind: "handoff",
        content: "carry a task the run never froze",
        adopt: { runId: RUN, taskId: "T9" },
      }),
      /never froze task T9/,
    );
    const read = await service.invoke("taskBoard", {
      action: "read",
      taskId: CHANNEL,
      agentId: "agent-b",
    });
    if (read.action !== "read") throw new Error("expected a read result");
    assert.deepEqual(read.entries, []);
  }),
);

test(
  "a managed entry's lifecycle write goes through the run, and the run records it",
  withService(async (service) => {
    await registerAndFreeze(service);
    const { entryId } = await adopt(service, "J");
    const claimed = await service.invoke("taskBoard", {
      action: "claim",
      taskId: CHANNEL,
      agentId: "agent-b",
      entryId,
      leaseSeconds: 600,
    });
    if (claimed.action !== "claim") throw new Error("expected a claim result");
    const view = await status(service);
    assert.deepEqual(
      view.facts.map((fact) => fact.kind),
      ["entry-bound", "board-claim"],
    );
    assert.equal(view.bindings[0]!.entry?.status, "open");
    assert.equal(view.bindings[0]!.entry?.claimedBy, "agent-b");
  }),
);

test(
  "cancelling a run is recorded once, stops its managed writes, and is readable",
  withService(async (service) => {
    await registerAndFreeze(service);
    const { entryId } = await adopt(service, "J");
    const cancelled = await service.invoke("taskRun", {
      action: "cancel",
      runId: RUN,
      reason: "budget",
    });
    if (cancelled.action !== "cancel") throw new Error("expected a cancel result");
    assert.equal(cancelled.recorded, true);
    const again = await service.invoke("taskRun", { action: "cancel", runId: RUN });
    if (again.action !== "cancel") throw new Error("expected a cancel result");
    assert.equal(again.recorded, false);

    const view = await status(service);
    const cancellation = view.facts.find((fact) => fact.kind === "run-cancelled");
    assert.equal(cancellation?.taskId, "");
    assert.equal(cancellation?.payload, JSON.stringify({ reason: "budget" }));

    await assert.rejects(
      service.invoke("taskBoard", {
        action: "claim",
        taskId: CHANNEL,
        agentId: "agent-b",
        entryId,
        leaseSeconds: 600,
      }),
      /was cancelled at sequence \d+; its managed entries take no further lifecycle writes/,
    );
  }),
);

test(
  "cancelling one task names it, and a task the plan never froze cannot be cancelled",
  withService(async (service) => {
    await registerAndFreeze(service);
    const one = await service.invoke("taskRun", { action: "cancel", runId: RUN, taskId: "P" });
    if (one.action !== "cancel") throw new Error("expected a cancel result");
    assert.equal(one.recorded, true);
    const view = await status(service);
    assert.equal(view.facts.find((fact) => fact.kind === "run-cancelled")?.taskId, "P");
    await assert.rejects(
      service.invoke("taskRun", { action: "cancel", runId: RUN, taskId: "T9" }),
      /never froze task T9; there is nothing to cancel/,
    );
  }),
);

test(
  "a freeze cannot dangle, repeat a task, or lean on itself",
  withService(async (service) => {
    await service.invoke("taskRun", {
      action: "register",
      runId: RUN,
      planDigest: "sha256:plan",
      policy: "ordered",
      revision: "r1",
      retention: "evidence",
    });
    const task = (taskId: string, dependencies: string[]) => ({
      taskId,
      revision: "r1",
      input: taskId,
      dependencies,
      effect: "artifact",
    });
    await assert.rejects(
      service.invoke("taskRun", { action: "freeze", runId: RUN, tasks: [task("P", ["T9"])] }),
      /task P depends on T9, which this run's plan does not freeze/,
    );
    await assert.rejects(
      service.invoke("taskRun", { action: "freeze", runId: RUN, tasks: [task("P", ["P"])] }),
      /task P depends on itself/,
    );
    await assert.rejects(
      service.invoke("taskRun", {
        action: "freeze",
        runId: RUN,
        tasks: [task("P", []), task("P", [])],
      }),
      /one freeze cannot name the same task twice/,
    );
    // A plan that froze nothing is the state the refusals left behind, so the run still has no plan.
    const view = await status(service);
    assert.deepEqual(view.tasks, []);
  }),
);

test(
  "a refused freeze leaves the plan exactly as it was",
  withService(async (service) => {
    await registerAndFreeze(service);
    // The store refuses to replace a frozen task with different content, and that refusal happens
    // while the batch is being applied: Q must not survive as a half-frozen plan.
    await assert.rejects(
      service.invoke("taskRun", {
        action: "freeze",
        runId: RUN,
        tasks: [
          {
            taskId: "Q",
            revision: "r1",
            input: "later work",
            dependencies: ["P"],
            effect: "artifact",
          },
          {
            taskId: "P",
            revision: "r1",
            input: "a different input",
            dependencies: [],
            effect: "artifact",
          },
        ],
      }),
      /already froze task P with a different definition/,
    );
    const view = await status(service);
    assert.deepEqual(
      view.tasks.map((task) => task.taskId),
      ["P", "J"],
    );
  }),
);

test(
  "a cancelled run takes no further plan",
  withService(async (service) => {
    await registerAndFreeze(service);
    await service.invoke("taskRun", { action: "cancel", runId: RUN });
    await assert.rejects(
      service.invoke("taskRun", {
        action: "freeze",
        runId: RUN,
        tasks: [
          {
            taskId: "Q",
            revision: "r1",
            input: "later work",
            dependencies: ["P"],
            effect: "artifact",
          },
        ],
      }),
      /was cancelled at sequence \d+; its managed entries take no further lifecycle writes/,
    );
    const view = await status(service);
    assert.deepEqual(
      view.tasks.map((task) => task.taskId),
      ["P", "J"],
    );
  }),
);

test(
  "status is a read: an unknown run has no manifest and is not registered by being asked",
  withService(async (service) => {
    const view = await status(service);
    assert.equal(view.manifest, null);
    assert.deepEqual(view.tasks, []);
    assert.deepEqual(view.facts, []);
    // Still unregistered afterwards: a plan freeze and a cancellation both refuse by name.
    await assert.rejects(
      service.invoke("taskRun", {
        action: "freeze",
        runId: RUN,
        tasks: [{ taskId: "P", revision: "r1", input: "i", dependencies: [], effect: "e" }],
      }),
      /run run-1 is not registered/,
    );
    await assert.rejects(
      service.invoke("taskRun", { action: "cancel", runId: RUN }),
      /run run-1 is not registered; there is nothing to cancel/,
    );
  }),
);

test(
  "a retry is a new attempt, not a rebinding of the one that came before",
  withService(async (service) => {
    await registerAndFreeze(service);
    const first = await adopt(service, "J", 1);
    const second = await adopt(service, "J", 2);
    const view = await status(service);
    assert.deepEqual(
      view.bindings.map((binding) => [binding.attempt, binding.entryId]),
      [
        [1, first.entryId],
        [2, second.entryId],
      ],
    );
    // Re-pointing attempt 1 at the newer entry is refused rather than silently recorded.
    await assert.rejects(
      service.invoke("taskRun", {
        action: "bind",
        runId: RUN,
        taskId: "J",
        boardTaskId: CHANNEL,
        entryId: second.entryId,
        attempt: 1,
      }),
      /already carries entry .*; another entry is another attempt, not a rebinding/,
    );
  }),
);

test(
  "the surface refuses a run it cannot name and a task the plan does not hold",
  withService(async (service) => {
    await assert.rejects(
      service.invoke("taskRun", {
        action: "bind",
        runId: RUN,
        taskId: "P",
        boardTaskId: CHANNEL,
        entryId: "1_1",
      }),
      /run run-1 is not registered/,
    );
    await registerAndFreeze(service);
    await assert.rejects(
      service.invoke("taskRun", {
        action: "bind",
        runId: RUN,
        taskId: "T9",
        boardTaskId: CHANNEL,
        entryId: "1_1",
      }),
      /never froze task T9; there is no task to bind an entry to/,
    );
  }),
);
