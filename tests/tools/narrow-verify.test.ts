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
  assert.deepEqual(plan.shared, [
    "check",
    "docs:check",
    "format:check",
    "glossary:check",
    "lint",
    "package:check",
    "rtm:check",
  ]);
});

test("a leaf route with no own tests narrows to shared checks only", () => {
  const plan = planNarrowVerify([route("dsh-adapter")], ["dsh/dsh-nmg/src/plugin/index.ts"]);
  assert.equal(plan.narrow, true);
  assert.equal(plan.route!.id, "dsh-adapter");
  assert.deepEqual(plan.testGlobs, []);
  assert.deepEqual(plan.shared, [
    "check",
    "docs:check",
    "format:check",
    "glossary:check",
    "lint",
    "package:check",
    "rtm:check",
  ]);
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

test("a route that declares the shared checks not applicable narrows to its own tests", () => {
  // The declaration is the route owner's, not an inference from the path: a narrow plan for a
  // change this route solely owns carries no always-run shared checks, and the route's own tests
  // are still required - `verify.sharedChecks: none` without them is refused at config load.
  const declined: RouteLike = {
    id: "repository-tooling",
    paths: [".gitignore"],
    tests: ["tests/tools/**"],
    verify: { blocking: ["check"], advisory: [], sharedChecks: "none" },
  };
  const plan = planNarrowVerify([declined], [".gitignore"]);
  assert.equal(plan.narrow, true);
  assert.equal(plan.route!.id, "repository-tooling");
  assert.deepEqual(plan.shared, [], "the shared checks are not run for this surface");
  assert.deepEqual(plan.testGlobs, ["tests/tools/**"], "and the route's own tests still are");
});

test("the declaration is not a way out of a shared/cross-cutting path", () => {
  const declined: RouteLike = {
    id: "repository-tooling",
    paths: ["tools/**"],
    tests: ["tests/tools/**"],
    verify: { blocking: ["check"], advisory: [], sharedChecks: "none" },
  };
  const plan = planNarrowVerify([declined], ["tools/narrow-verify.ts"]);
  assert.equal(plan.narrow, false, "a shared root still escalates to the declared blocking set");
  assert.match(plan.escalationReason!, /shared/u);
});

test('declaring the shared checks "always" is what every route does by default', () => {
  const explicit: RouteLike = {
    id: "documentation",
    paths: ["docs/**"],
    tests: ["tests/docs/**"],
    verify: { blocking: ["docs:check"], advisory: [], sharedChecks: "always" },
  };
  const plan = planNarrowVerify([explicit], ["docs/README.md"]);
  assert.deepEqual(plan.shared, [
    "check",
    "docs:check",
    "format:check",
    "glossary:check",
    "lint",
    "package:check",
    "rtm:check",
  ]);
});

test("no changed paths escalates to full", () => {
  const plan = planNarrowVerify(ROUTES, []);
  assert.equal(plan.narrow, false);
});
