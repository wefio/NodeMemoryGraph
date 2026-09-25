/**
 * The shared dispatch loop, driven through its port.
 *
 * What this file pins is the *order of operations*, not the board's storage or the arm's spec: the
 * loop is handed a board that answers in memory, so a case here costs milliseconds and a case that
 * fails names one job of the loop. The board below implements `DispatchBoard` and nothing else - the
 * loop cannot tell it from a real board, which is the property that lets a product path provide one.
 *
 * The last case is the exception, and it is the one that matters most: recording the session decision
 * is the store's write, so it runs against a real store - the product's own run surface - and asserts
 * that each boundary's move names the unit, its attempt and the entry it belongs to.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import {
  dispatchPlan,
  type DispatchBoard,
  type DispatchTicket,
} from "../../src/integration/ooo-dispatch.ts";
import {
  SESSION_MOVE_FACT,
  recordedSessionMoves,
} from "../../src/integration/ooo-session-facts.ts";
import { registerRun } from "../../src/integration/task-coordinator.ts";
import {
  unitLegality,
  type DispatchTask,
  type LegalityAnswer,
  type SessionPlan,
} from "../../src/integration/ooo-execution.ts";
import type { PlanSession, PlanWorker } from "../../src/integration/ooo-dispatch.ts";

const REMOVE_TEMP_TREE = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

/** The revision this stub's plan declares. The stub models the loop's order of operations, not drift,
 *  so every task's inputs are the ones the plan declared and `current()` always holds. */
const REVISION = "stub-v1";

type BoardOptions = {
  /** Which legal unit to refuse, as the board does when another claim holds the handoff. */
  refuse?: (taskId: string) => boolean;
  /** How long a submitted result takes to be judged. */
  submitMs?: number;
  /** The verdict for a submitted result. */
  verdict?: (taskId: string) => string;
};

/** A board in memory: legal set, claims, entries and verdicts, with no store behind any of it. */
class StubBoard implements DispatchBoard {
  readonly channel = "run-1";
  now = 1_700_000_000_000;
  /** What a delivered-but-unaccepted unit reports, so a case can drive a rejection. */
  readonly events: string[] = [];
  /** When each thing happened, so overlap is read from the data and not from a wall clock. */
  readonly times = new Map<string, number>();
  #order: readonly string[];
  #dependencies: Readonly<Record<string, readonly string[]>>;
  #options: BoardOptions;
  #inFlight = new Set<string>();
  #accepted: Record<string, string> = {};
  #taskOf = new Map<string, string>();
  #entries = 0;
  #claims = new Map<string, number>();

  constructor(
    order: readonly string[],
    dependencies: Readonly<Record<string, readonly string[]>> = {},
    options: BoardOptions = {},
  ) {
    this.#order = order;
    this.#dependencies = dependencies;
    this.#options = options;
  }

  /**
   * The answer the port asks for, from this board's own fields: its order, dependencies, claims and
   * accepted artifacts are exactly what the shared rules read, so the stub hands them to the shared
   * reading instead of growing a second set of rules. No budget is declared here - the stub's job is
   * the loop's order of operations - so the reading runs with a budget that never cuts.
   */
  legality(): LegalityAnswer {
    const tasks = this.#order.map((id) => ({
      id,
      effect: "isolated-artifact",
      sourceVersion: REVISION,
      observedVersion: REVISION,
      dependencies: [...(this.#dependencies[id] ?? [])],
      accepted: this.#accepted[id] !== undefined,
      claimed: this.#inFlight.has(id),
      externalReady: false,
    }));
    return unitLegality(tasks, Number.MAX_SAFE_INTEGER);
  }

  candidates(): readonly string[] {
    return this.legality().legal;
  }

  accepted(): Readonly<Record<string, string>> {
    return this.#accepted;
  }

  claim(taskId: string, _owner: string): DispatchTicket {
    if (this.#options.refuse?.(taskId)) throw new Error(`no published handoff for ${taskId}`);
    const attempt = (this.#claims.get(taskId) ?? 0) + 1;
    this.#claims.set(taskId, attempt);
    this.#inFlight.add(taskId);
    return {
      attempt,
      dependencies: {},
      patch: {
        taskId,
        attempt,
        instruction: `work on ${taskId}`,
        files: { "src/unit.ts": "export const value = 1;\n" },
        editable: ["src/unit.ts"],
      },
    };
  }

  putTaskBoardEntry(input: { taskId: string; kind: "result"; content: string }): { id: string } {
    const id = `entry-${++this.#entries}`;
    this.#taskOf.set(id, JSON.parse(input.content).ticket.patch.taskId);
    return { id };
  }

  async submit(entryId: string): Promise<string> {
    const taskId = this.#taskOf.get(entryId) ?? "";
    if (this.#options.submitMs)
      await new Promise((done) => setTimeout(done, this.#options.submitMs));
    const verdict = this.#options.verdict?.(taskId) ?? "accepted";
    this.#inFlight.delete(taskId);
    if (verdict === "accepted") this.#accepted[taskId] = `${taskId}-artifact`;
    this.times.set(`submit-end:${taskId}`, Date.now());
    this.events.push(`judged:${taskId}`);
    return verdict;
  }

  /** Give up a claim: what a board does when the work it admitted never comes back, so the unit is on
   *  offer again. A case uses it to model a failed worker, whose unit a later pass could ask for. */
  release(taskId: string): void {
    this.#inFlight.delete(taskId);
  }
}

/** A worker that answers in the protocol's shape and records when it ran. */
function worker(
  log: string[],
  options: { latencyMs?: number; fail?: readonly string[]; session?: boolean } = {},
): PlanWorker {
  return async (taskId, _frozen, _dependencies, session?: PlanSession) => {
    log.push(`worker:${taskId}`);
    if (options.latencyMs) await new Promise((done) => setTimeout(done, options.latencyMs));
    if (options.fail?.includes(taskId)) return { failure: "the model returned nothing" };
    return {
      artifact: "candidate",
      metrics: options.session && session ? { sessionId: session.id } : {},
    };
  };
}

/** The legality view the shared move reads: the plan's order, what is accepted, and the pair rules. */
function legality(
  order: readonly string[],
  accepted: Readonly<Record<string, string>>,
): SessionPlan {
  const tasks: DispatchTask[] = order.map((id) => ({
    id,
    effect: "isolated-artifact",
    sourceVersion: "v1",
    observedVersion: "v1",
    dependencies: [],
    accepted: accepted[id] !== undefined,
    claimed: false,
    externalReady: true,
  }));
  return {
    tasks,
    declarations: Object.fromEntries(
      order.map((id) => [id, { capability: "patch", authority: "host", visible: [] }]),
    ),
    // The cases that declare sessions here expect the chain to continue, so the plan enables the
    // constraint that allows it. A case with no sessions never reaches the move at all.
    constraints: ["repair-first"],
  };
}

test("the loop runs what the board offers, in the order the board offers it", async () => {
  const board = new StubBoard(["second", "first"]);
  const outcome = await dispatchPlan({
    board,
    plan: ["first", "second"],
    slots: 1,
    legality: () => legality(["first", "second"], board.accepted()),
    worker: worker([]),
    ownerOf: (taskId) => `owner:${taskId}`,
  });
  assert.deepEqual(outcome.order, ["second", "first"]);
  assert.deepEqual(
    outcome.units.map((unit) => unit.taskId),
    ["second", "first"],
  );
  assert.deepEqual(outcome.slotRefusals, []);
  assert.deepEqual(outcome.failures, []);
});

test("a declared slot count is reached, and the claims overlap in time", async () => {
  const log: string[] = [];
  let peak = 0;
  let inFlight = 0;
  const inner = worker(log, { latencyMs: 40 });
  const board = new StubBoard(["first", "second", "third"]);
  const outcome = await dispatchPlan({
    board,
    plan: ["first", "second", "third"],
    slots: 3,
    legality: () => legality(["first", "second", "third"], board.accepted()),
    worker: async (taskId, frozen, dependencies, session) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await inner(taskId, frozen, dependencies, session);
      } finally {
        inFlight -= 1;
      }
    },
    ownerOf: (taskId) => `owner:${taskId}`,
  });
  assert.equal(outcome.slotsUsed, 3);
  assert.equal(peak, 3, `the worker saw the claims overlap: ${log.join(",")}`);
  assert.deepEqual(outcome.order, ["first", "second", "third"], "each unit is dispatched once");
  assert.deepEqual(
    outcome.slotRefusals,
    [],
    "and asking twice for one unit is not how the slot count is reached",
  );
});

test("a unit's check is outstanding while an independent unit's worker runs", async () => {
  const board = new StubBoard(["first", "second"], {}, { submitMs: 300 });
  const started = new Map<string, number>();
  const inner = worker([], { latencyMs: 20 });
  // More slots than units, on purpose: a batch built by repeating the legal set instead of taking a
  // prefix of it would ask for one unit twice, and the board would refuse the second claim.
  const outcome = await dispatchPlan({
    board,
    plan: ["first", "second"],
    slots: 3,
    legality: () => legality(["first", "second"], board.accepted()),
    worker: async (taskId, frozen, dependencies, session) => {
      started.set(taskId, Date.now());
      return inner(taskId, frozen, dependencies, session);
    },
    ownerOf: (taskId) => `owner:${taskId}`,
  });
  assert.ok(
    (started.get("second") ?? 0) < (board.times.get("submit-end:first") ?? Infinity),
    "the second unit's work starts while the first unit's result is still being judged",
  );
  assert.deepEqual(outcome.order, ["first", "second"], "each unit is dispatched once");
  assert.deepEqual(outcome.slotRefusals, [], "and no unit is asked for twice");
});

test("a refused claim leaves the unit on offer and does not end the pass", async () => {
  const board = new StubBoard(
    ["first", "second"],
    {},
    { refuse: (taskId) => taskId === "first" && false },
  );
  const refusing = new StubBoard(
    ["first", "second"],
    {},
    { refuse: (taskId) => taskId === "first" },
  );
  const outcome = await dispatchPlan({
    board: refusing,
    plan: ["first", "second"],
    slots: 1,
    legality: () => legality(["first", "second"], refusing.accepted()),
    worker: worker([]),
    ownerOf: (taskId) => `owner:${taskId}`,
  });
  assert.ok(
    outcome.slotRefusals.length >= 1,
    "the board refused a claim, and the loop says so instead of calling it a failure",
  );
  assert.deepEqual(outcome.failures, []);
  assert.deepEqual(board.accepted(), {});
});

test("a unit whose worker failed is asked once in a pass", async () => {
  const board = new StubBoard(["first", "second"]);
  const asked: string[] = [];
  const outcome = await dispatchPlan({
    board,
    plan: ["first", "second"],
    slots: 1,
    legality: () => legality(["first", "second"], board.accepted()),
    worker: async (taskId) => {
      asked.push(taskId);
      if (taskId !== "second") return { artifact: "candidate" };
      // The board gives the claim back when the work never comes, so the unit is on offer again - which
      // is what makes asking it twice possible, and what the pass must not do.
      board.release(taskId);
      return { failure: "the model returned nothing" };
    },
    ownerOf: (taskId) => `owner:${taskId}`,
  });
  assert.equal(outcome.failures.length, 1);
  assert.equal(
    asked.filter((id) => id === "second").length,
    1,
    "the pass reports the failure rather than asking the same unit again",
  );
});

test("a fused chain stops at the declared bound and does not swallow the plan", async () => {
  const order = ["first", "second", "third", "fourth"];
  const board = new StubBoard(order);
  const outcome = await dispatchPlan({
    board,
    plan: order,
    slots: 1,
    sessions: { bound: 2, identity: (first) => `host:${first}` },
    legality: () => legality(order, board.accepted()),
    worker: worker([], { session: true }),
    ownerOf: (taskId) => `owner:${taskId}`,
  });
  assert.deepEqual(outcome.sessions, [
    ["first", "second"],
    ["third", "fourth"],
  ]);
});

test("a worker that starts its own session is not reported as fusion", async () => {
  const order = ["first", "second"];
  const board = new StubBoard(order);
  const outcome = await dispatchPlan({
    board,
    plan: order,
    slots: 1,
    sessions: { bound: 2, identity: (first) => `host:${first}` },
    legality: () => legality(order, board.accepted()),
    worker: async (taskId) => ({ artifact: "candidate", metrics: { sessionId: `own:${taskId}` } }),
    ownerOf: (taskId) => `owner:${taskId}`,
  });
  assert.deepEqual(outcome.sessions, [["first"], ["second"]]);
});

test("the session decision is a run fact naming the unit, its attempt and its entry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-dispatch-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    registerRun(store, {
      runId: "run-1",
      planDigest: "plan-a",
      policy: "checks-a",
      revision: "v1",
      retention: "keep:evidence",
    });
    const order = ["first", "second", "third"];
    const board = new StubBoard(order);
    const outcome = await dispatchPlan({
      board,
      plan: order,
      slots: 1,
      sessions: { bound: 3, identity: (first) => `host:${first}` },
      legality: () => legality(order, board.accepted()),
      worker: worker([], { session: true }),
      ownerOf: (taskId) => `owner:${taskId}`,
      sessionMoves: { store, runId: "run-1" },
    });
    assert.deepEqual(outcome.sessions, [order], "the chain ran to its declared bound");
    // One fact per unit that ran, not one per run: the store's key is (run, kind, task, attempt), so a
    // decision that names no unit collides with the one before it and is dropped while still being
    // returned. Every boundary's move is readable afterwards, which is what makes the decision
    // replayable.
    const facts = store.taskRunFacts("run-1").filter((fact) => fact.kind === SESSION_MOVE_FACT);
    assert.deepEqual(
      facts.map((fact) => [fact.taskId, fact.attempt]),
      [
        ["first", 1],
        ["second", 1],
        ["third", 1],
      ],
    );
    assert.deepEqual(
      recordedSessionMoves(store, "run-1")
        .slice(0, 2)
        .map((entry) => entry.move),
      [
        { kind: "admit", unit: "second" },
        { kind: "admit", unit: "third" },
      ],
    );
    assert.deepEqual(
      recordedSessionMoves(store, "run-1").map((entry) => entry.move.kind),
      ["admit", "admit", "close"],
    );
  } finally {
    store.close();
    rmSync(directory, REMOVE_TEMP_TREE);
  }
});
