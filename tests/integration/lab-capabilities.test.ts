import assert from "node:assert/strict";
import test from "node:test";

import { LabActivationAuthority } from "../../src/integration/lab-capabilities.ts";

test("agents can lease bounded session Lab capabilities", () => {
  let now = 1_000;
  const authority = new LabActivationAuthority({ now: () => now });

  const activation = authority.enable({
    capability: "reasoning_workspace",
    scope: "session",
    sessionId: "session-a",
    requester: "agent:test",
    ttlSeconds: 60,
    reason: "preserve a multi-step investigation",
  });

  assert.equal(activation.enabled, true);
  assert.equal(authority.isEnabled("reasoning_workspace", "session-a"), true);
  assert.equal(authority.isEnabled("reasoning_workspace", "session-b"), false);

  now += 60_001;
  assert.equal(authority.isEnabled("reasoning_workspace", "session-a"), false);
});

test("agent self-service cannot bypass controlled or active controller gates", () => {
  const authority = new LabActivationAuthority();
  for (const capability of ["controller_controlled", "controller_active"] as const) {
    assert.throws(
      () =>
        authority.enable({
          capability,
          scope: "session",
          sessionId: "session-a",
          requester: "agent:test",
          reason: "try a stronger controller",
        }),
      /requires operator or harness authorization/,
    );
  }
});

test("Lab capability discovery distinguishes self-service and gated features", () => {
  const descriptors = new LabActivationAuthority().list();
  assert.equal(descriptors.find((item) => item.id === "memory_graph_reasoner")?.agentMayEnable, true);
  assert.equal(descriptors.find((item) => item.id === "controller_active")?.agentMayEnable, false);
});
