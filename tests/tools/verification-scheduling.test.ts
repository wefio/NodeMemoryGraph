import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { executeVerificationPlan, PARALLEL_STATIC_CHECKS } from "../../tools/agent-verify.ts";

test("the full verifier batches all approved independent static checks, not writers or product tests", () => {
  assert.deepEqual(
    [...PARALLEL_STATIC_CHECKS].sort(),
    [
      "agent:context:check",
      "check",
      "check:lock",
      "check:policy-words",
      "check:tests",
      "complexity:gate",
      "docs:check",
      "format:check",
      "glossary:check",
      "lint",
      "mutation:anchors",
      "rtm:check",
      "verify:packages",
    ].sort(),
  );
  for (const barrier of ["build", "package:check", "test:product", "mutation:teeth"])
    assert.equal(PARALLEL_STATIC_CHECKS.has(barrier), false);
});

test("tests-surface and anchor checks share a bounded batch while writes and product remain barriers", async () => {
  const commands = [
    "build",
    "package:check",
    "check:tests",
    "mutation:anchors",
    "lint",
    "format:check",
    "check:policy-words",
    "test:product",
  ];
  const events: string[] = [];
  let active = 0;
  let peak = 0;
  const result = await executeVerificationPlan(
    {
      blocking: commands.map((command) => ({
        command,
        classification: "blocking" as const,
        routes: ["ci-and-tests"],
      })),
      advisory: [],
    },
    {
      parallel: { commands: PARALLEL_STATIC_CHECKS, concurrency: 3 },
      run: async (command, classification, routes) => {
        events.push(`start:${command}`);
        peak = Math.max(peak, ++active);
        await setImmediate();
        active--;
        events.push(`end:${command}`);
        return {
          command,
          classification,
          routes,
          status: command === "lint" ? "failed" : "passed",
          durationMs: 1,
        };
      },
    },
  );
  assert.equal(peak, 3);
  assert.ok(events.indexOf("end:package:check") < events.indexOf("start:check:tests"));
  for (const command of commands.slice(2, -1))
    assert.ok(events.indexOf(`end:${command}`) < events.indexOf("start:test:product"));
  assert.deepEqual(
    result.results.map((item) => item.command),
    commands,
  );
  assert.ok(
    result.results.every(
      (item) => item.classification === "blocking" && item.routes[0] === "ci-and-tests",
    ),
  );
  assert.equal(result.results.find((item) => item.command === "lint")?.status, "failed");
  assert.equal(result.ok, false);
});
