/**
 * F4: fusion legality - the five conditions the design puts on reusing one Agent session across
 * logical units, each refused by name, plus the candidate set a ranking policy may choose from.
 *
 * The rules live in `src/integration/ooo-execution.ts` beside the selection rules, because a fused
 * successor answers the same kind of question as a selectable task: what the host is allowed to hand
 * out. A pair is legal only when every condition holds, so each case below breaks exactly one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  fusionCandidates,
  fusionSuccessors,
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
    accepted: false,
    claimed: false,
    externalReady: true,
    ...over,
  };
}

function declaration(over: Partial<SessionDeclaration> = {}): SessionDeclaration {
  return { capability: "patch", authority: "host", visible: ["src/a.ts"], ...over };
}

/** `before` accepted, `after` depending on it and passing every declaration check: the one plan the
 *  refusal cases each break in exactly one place. */
function plan(over: Partial<SessionPlan> = {}): SessionPlan {
  return {
    tasks: [task("before", { accepted: true }), task("after", { dependencies: ["before"] })],
    declarations: { before: declaration(), after: declaration() },
    ...over,
  };
}

function legal(over: Partial<SessionPlan> = {}): boolean {
  return sharedSessionLegal("before", "after", plan(over));
}

test("fusion lets a successor continue the session when all five conditions hold", () => {
  assert.equal(legal(), true);
});

test("fusion refuses a unit that needs a different execution capability", () => {
  const declarations = { before: declaration(), after: declaration({ capability: "snapshot" }) };
  assert.equal(legal({ declarations }), false);
});

test("fusion refuses a unit acting under a different authority", () => {
  const declarations = { before: declaration(), after: declaration({ authority: "guest" }) };
  assert.equal(legal({ declarations }), false);
});

test("fusion refuses a successor whose visibility the session would widen", () => {
  const declarations = {
    before: declaration(),
    after: declaration({ visible: ["src/a.ts", "src/secret.ts"] }),
  };
  assert.equal(legal({ declarations }), false);
});

test("fusion refuses to continue from a unit whose verdict is not accepted", () => {
  const tasks = [task("before"), task("after", { dependencies: ["before"] })];
  assert.equal(legal({ tasks }), false);
});

test("fusion refuses a successor whose dependency is delivered but not accepted", () => {
  const tasks = [
    task("before", { accepted: true }),
    task("upstream", { delivered: true }),
    task("after", { dependencies: ["before", "upstream"] }),
  ];
  const declarations = { ...plan().declarations, upstream: declaration() };
  assert.equal(legal({ tasks, declarations }), false);
});

test("fusion refuses a cancelled unit, before or after", () => {
  const cancelledFirst = [
    task("before", { accepted: true, cancelled: true }),
    task("after", { dependencies: ["before"] }),
  ];
  assert.equal(legal({ tasks: cancelledFirst }), false);
  const cancelledNext = [
    task("before", { accepted: true }),
    task("after", { dependencies: ["before"], cancelled: true }),
  ];
  assert.equal(legal({ tasks: cancelledNext }), false);
});

test("fusion ends the session at a declared external wait that is not ready", () => {
  const waiting = [
    task("before", { accepted: true, externalEvent: "g", externalReady: false }),
    task("after", { dependencies: ["before"] }),
  ];
  assert.equal(legal({ tasks: waiting }), false);
  const ready = [
    task("before", { accepted: true, externalEvent: "g", externalReady: true }),
    task("after", { dependencies: ["before"] }),
  ];
  assert.equal(legal({ tasks: ready }), true);
});

test("fusion never reuses the history across a fact whose branch is still pending", () => {
  assert.equal(legal({ pendingBranches: ["after"] }), false);
  assert.equal(legal({ pendingBranches: ["before"] }), false);
  assert.equal(legal({ pendingBranches: ["elsewhere"] }), true);
});

test("fusion refuses a pair whose units or declarations are not in the plan", () => {
  assert.equal(sharedSessionLegal("before", "before", plan()), false);
  assert.equal(sharedSessionLegal("before", "absent", plan()), false);
  assert.equal(legal({ declarations: { before: declaration() } }), false);
});

test("fusion lists the legal successors in plan order", () => {
  const tasks = [
    task("before", { accepted: true }),
    task("after", { dependencies: ["before"] }),
    task("too-wide", { dependencies: ["before"] }),
  ];
  const declarations = {
    before: declaration(),
    after: declaration(),
    "too-wide": declaration({ visible: ["src/a.ts", "src/other.ts"] }),
  };
  assert.deepEqual(fusionSuccessors("before", { tasks, declarations }), ["after"]);
});

test("fusion returns every legal pair, and only legal ones", () => {
  const tasks = [task("before", { accepted: true }), task("after", { dependencies: ["before"] })];
  const declarations = plan().declarations;
  assert.deepEqual(fusionCandidates({ tasks, declarations }), [["before", "after"]]);
  assert.deepEqual(fusionCandidates({ tasks, declarations, pendingBranches: ["after"] }), []);
});
