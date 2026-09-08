import assert from "node:assert/strict";
import test from "node:test";

import { planNarrowVerify, type RouteLike } from "../../tools/narrow-verify.ts";

const ROUTES: RouteLike[] = [
  {
    id: "pi-adapter",
    paths: [".pi/extensions/**", "extensions/**"],
    tests: ["tests/extensions/**", "tests/integration/**"],
    verify: { blocking: ["check", "test:product", "build"], advisory: [] },
  },
  {
    id: "dsh-adapter",
    paths: ["dsh/**"],
    tests: [],
    verify: { blocking: ["check"], advisory: [] },
  },
  {
    id: "documentation",
    paths: ["docs/**", "skills/**"],
    tests: ["tests/docs/**"],
    verify: { blocking: ["docs:check"], advisory: [] },
  },
  {
    id: "core-memory",
    paths: ["src/core/**"],
    tests: ["tests/core/**"],
    verify: { blocking: ["check", "test:product", "build"], advisory: [] },
  },
];

function route(id: string): RouteLike {
  return ROUTES.find((route) => route.id === id)!;
}

test("a change cleanly owned by one leaf route narrows to its own tests", () => {
  const plan = planNarrowVerify([route("pi-adapter")], [".pi/extensions/nmg/index.ts"]);
  assert.equal(plan.narrow, true);
  assert.equal(plan.route!.id, "pi-adapter");
  assert.deepEqual(plan.testGlobs, ["tests/extensions/**", "tests/integration/**"]);
  assert.deepEqual(plan.shared, ["check", "docs:check", "format:check", "lint", "package:check"]);
});

test("a leaf route with no own tests narrows to shared checks only", () => {
  const plan = planNarrowVerify([route("dsh-adapter")], ["dsh/dsh-nmg/src/plugin/index.ts"]);
  assert.equal(plan.narrow, true);
  assert.equal(plan.route!.id, "dsh-adapter");
  assert.deepEqual(plan.testGlobs, []);
  assert.deepEqual(plan.shared, ["check", "docs:check", "format:check", "lint", "package:check"]);
});

test("a shared/cross-cutting path escalates to full", () => {
  const plan = planNarrowVerify(ROUTES, ["src/lab/context-router.ts"]);
  assert.equal(plan.narrow, false);
  assert.match(plan.escalationReason!, /shared|src\//u);
});

test("an unowned path escalates to full", () => {
  const plan = planNarrowVerify([route("documentation")], ["package.json"]);
  assert.equal(plan.narrow, false);
  assert.match(plan.escalationReason!, /shared|owns/u);
});

test("a scope owned by multiple routes escalates to full (ambiguous)", () => {
  const docA = { ...route("documentation") };
  const docB = { ...route("pi-adapter"), paths: ["docs/**"] };
  const plan = planNarrowVerify([docA, docB], ["docs/README.md"]);
  assert.equal(plan.narrow, false);
  assert.match(plan.escalationReason!, /2 routes/u);
});

test("a change spanning multiple routes escalates to full", () => {
  const plan = planNarrowVerify(
    [route("documentation"), route("pi-adapter")],
    ["docs/README.md", ".pi/extensions/nmg/index.ts"],
  );
  assert.equal(plan.narrow, false);
  assert.match(plan.escalationReason!, /spans multiple routes/u);
});

test("no changed paths escalates to full", () => {
  const plan = planNarrowVerify(ROUTES, []);
  assert.equal(plan.narrow, false);
});
