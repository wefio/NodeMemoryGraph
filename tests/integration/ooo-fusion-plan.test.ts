/**
 * Fusion planning: the move the online half makes, and the ceiling the offline half computes.
 *
 * The cases below pin the three properties the design claims - a move is a pure function of the plan
 * and its facts, an offline graph prices the best case rather than a run's state, and a floor is a
 * floor - plus the two refusals that keep a bound from turning into a schedule.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  chainCoverFloor,
  fusionGraph,
  listScheduleSessions,
  nextSessionMove,
  optimisticPlan,
} from "../../src/integration/ooo-fusion-plan.ts";
import {
  sharedSessionLegal,
  type DispatchTask,
  type SessionDeclaration,
  type SessionPlan,
} from "../../src/integration/ooo-execution.ts";

function task(id: string, over: Partial<DispatchTask> = {}): DispatchTask {
  return {
    id,
    effect: "isolated-artifact",
    sourceVersion: "v1",
    observedVersion: "v1",
    dependencies: [],
    accepted: true,
    claimed: false,
    externalReady: true,
    ...over,
  };
}

function declaration(over: Partial<SessionDeclaration> = {}): SessionDeclaration {
  return { capability: "patch", authority: "host", visible: ["src/a.ts"], ...over };
}

/** Units named `one`, `two`... with identical declarations: the shape that fuses freely. */
function plan(count: number, over: Partial<SessionPlan> = {}): SessionPlan {
  const names = ["one", "two", "three", "four"].slice(0, count);
  const tasks = names.map((name, index) =>
    task(name, index === 0 ? {} : { dependencies: [names[index - 1]!] }),
  );
  return {
    tasks,
    declarations: Object.fromEntries(names.map((name) => [name, declaration()])),
    ...over,
  };
}

test("a linear plan is one chain, and its relation is transitive", () => {
  const graph = fusionGraph(plan(3));
  assert.deepEqual(graph.units, ["one", "two", "three"]);
  assert.equal(graph.transitive, true);
  assert.deepEqual(graph.edges.get("one"), ["two", "three"]);
  assert.deepEqual(graph.edges.get("two"), ["three"]);
  assert.deepEqual(graph.edges.get("three"), []);
});

test("the offline graph prices the best case, not the run's state", () => {
  const stateful = plan(2);
  stateful.tasks[0]!.accepted = false;
  stateful.tasks[1]!.cancelled = true;
  // The run's own view refuses the pair - an unaccepted unit may not be continued.
  assert.equal(sharedSessionLegal("one", "two", stateful), false);
  // The projection makes the conditions that read run state vacuous, leaving condition 1.
  assert.equal(sharedSessionLegal("one", "two", optimisticPlan(stateful)), true);
  assert.deepEqual(fusionGraph(stateful).edges.get("one"), ["two"]);
});

test("a chain is a linear extension: a unit is never followed by what it depends on", () => {
  const reversed: SessionPlan = {
    tasks: [task("one", { dependencies: ["two"] }), task("two")],
    declarations: { one: declaration(), two: declaration() },
  };
  // `two` cannot follow `one` because a chain follows plan order, and `one` cannot follow `two`
  // because `one` depends on it: the pair is refused in both directions, each by one restriction.
  assert.deepEqual(fusionGraph(reversed).edges.get("one"), []);
  assert.deepEqual(fusionGraph(reversed).edges.get("two"), []);
});

test("a relation that is not transitive is reported as such, and still gets a floor", () => {
  // one depends on three, so one may follow two and two may follow three, but one may not follow
  // three - the dependency guard fires where plan order allows the pair.
  const twisted: SessionPlan = {
    tasks: [task("one", { dependencies: ["three"] }), task("two"), task("three")],
    declarations: { one: declaration(), two: declaration(), three: declaration() },
  };
  const graph = fusionGraph(twisted);
  assert.equal(graph.transitive, false);
  assert.deepEqual(graph.edges.get("one"), ["two"]);
  assert.deepEqual(graph.edges.get("two"), ["three"]);
  assert.equal(chainCoverFloor(graph), 1);
});

test("the floor is the minimum chain cover: incommensurable units need their own sessions", () => {
  const incompatible: SessionPlan = {
    tasks: [task("one"), task("two"), task("three")],
    declarations: {
      one: declaration(),
      two: declaration({ capability: "other" }),
      three: declaration({ capability: "third" }),
    },
  };
  assert.equal(chainCoverFloor(fusionGraph(incompatible)), 3);
  assert.equal(chainCoverFloor(fusionGraph(plan(3))), 1);
  assert.equal(chainCoverFloor(fusionGraph(plan(1))), 1);
});

test("list scheduling respects the cap and the legality edges", () => {
  const graph = fusionGraph(plan(3));
  assert.deepEqual(listScheduleSessions(graph, 1), [["one"], ["two"], ["three"]]);
  assert.deepEqual(listScheduleSessions(graph, 3), [["one", "two", "three"]]);
  assert.deepEqual(listScheduleSessions(graph, 2), [["one", "two"], ["three"]]);
});

test("sessions never increase when the cap grows", () => {
  for (const count of [1, 2, 3, 4]) {
    const graph = fusionGraph(plan(count));
    const sizes = [1, 2, 3, 4].map((cap) => listScheduleSessions(graph, cap).length);
    for (let index = 1; index < sizes.length; index += 1) {
      assert.equal(sizes[index]! <= sizes[index - 1]!, true);
    }
    // The floor bounds every feasible schedule from below.
    assert.equal(sizes[sizes.length - 1]! >= chainCoverFloor(graph), true);
  }
});

test("list scheduling refuses a cap that is not a positive integer", () => {
  const graph = fusionGraph(plan(2));
  assert.throws(() => listScheduleSessions(graph, 0), /positive integer/);
  assert.throws(() => listScheduleSessions(graph, 1.5), /positive integer/);
});

test("the move admits the first legal successor on offer, in plan order", () => {
  const move = nextSessionMove({
    plan: plan(3),
    current: "one",
    size: 1,
    bound: 2,
    onOffer: ["three", "two"],
  });
  assert.deepEqual(move, { kind: "admit", unit: "two" });
});

test("the move closes the session by name, never by guessing", () => {
  assert.deepEqual(
    nextSessionMove({ plan: plan(3), current: "one", size: 2, bound: 2, onOffer: ["two"] }),
    { kind: "close", reason: "the declared bound is reached" },
  );
  assert.deepEqual(
    nextSessionMove({ plan: plan(3), current: "one", size: 1, bound: 3, onOffer: [] }),
    { kind: "close", reason: "no legal successor is on offer" },
  );
  // An illegal successor is not admitted even when the board offers it.
  const incompatible: SessionPlan = {
    tasks: [task("one"), task("two")],
    declarations: { one: declaration(), two: declaration({ capability: "other" }) },
  };
  assert.deepEqual(
    nextSessionMove({ plan: incompatible, current: "one", size: 1, bound: 2, onOffer: ["two"] }),
    { kind: "close", reason: "no legal successor is on offer" },
  );
});

test("the same plan and the same facts yield the same move", () => {
  const input = { plan: plan(3), current: "one", size: 1, bound: 3, onOffer: ["two", "three"] };
  assert.deepEqual(nextSessionMove(input), nextSessionMove(input));
});
