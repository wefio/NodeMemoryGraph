import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDaemonCapability,
  assertDaemonProtocol,
  daemonSupportsCapability,
  NmgDaemonCapabilityError,
  NmgDaemonCompatibilityError,
} from "../../src/cli/daemon-client.ts";
import {
  NMG_CAPABILITIES,
  NMG_OPTIONAL_METHOD_CAPABILITIES,
  NMG_PROTOCOL_VERSION,
  NMG_RPC_DESCRIPTORS,
} from "../../src/cli/protocol.ts";

test("daemon protocol guard accepts the current compatibility epoch", () => {
  assert.doesNotThrow(() => assertDaemonProtocol({ protocol: NMG_PROTOCOL_VERSION }));
});

test("same-epoch capability additions do not affect protocol compatibility", () => {
  assert.doesNotThrow(() =>
    assertDaemonProtocol({ protocol: NMG_PROTOCOL_VERSION, capabilities: ["future-feature"] }),
  );
});

test("daemon protocol guard fails closed with restart guidance", () => {
  assert.throws(
    () => assertDaemonProtocol({ protocol: "nmg.v1" }),
    (error: unknown) => {
      assert.ok(error instanceof NmgDaemonCompatibilityError);
      assert.match(error.message, /nmg\.v1/);
      assert.match(error.message, /nmg daemon restart/);
      return true;
    },
  );
});

test("daemon protocol guard rejects v4 after the attribution RPC contract changed", () => {
  assert.throws(
    () => assertDaemonProtocol({ protocol: "nmg.v4" }),
    (error: unknown) => {
      assert.ok(error instanceof NmgDaemonCompatibilityError);
      assert.match(error.message, /nmg\.v4/);
      assert.match(error.message, new RegExp(NMG_PROTOCOL_VERSION.replace(".", "\\.")));
      return true;
    },
  );
});

test("daemon protocol guard rejects v7 because it cannot serve Lab capabilities", () => {
  assert.throws(() => assertDaemonProtocol({ protocol: "nmg.v7" }), /restart/u);
});

test("optional method guard fails only when the invoked capability is unavailable", () => {
  const baseline = new Set<string>(
    NMG_CAPABILITIES.filter((value) => value !== "session-active-graph"),
  );
  assert.doesNotThrow(() => assertDaemonCapability(baseline, "search"));
  assert.throws(
    () => assertDaemonCapability(baseline, "sessionActiveGraph"),
    (error: unknown) => {
      assert.ok(error instanceof NmgDaemonCapabilityError);
      assert.match(error.message, /session-active-graph/u);
      assert.doesNotMatch(error.message, /restart/u);
      return true;
    },
  );
  assert.doesNotThrow(() =>
    assertDaemonCapability(new Set(NMG_CAPABILITIES), "sessionActiveGraph"),
  );
  assert.equal(
    daemonSupportsCapability({ capabilities: new Set(["future-parameter"]) }, "future-parameter"),
    true,
  );
});

test("RPC descriptors derive every optional method capability from advertised capabilities", () => {
  for (const [method, descriptor] of Object.entries(NMG_RPC_DESCRIPTORS)) {
    if (!("optionalCapability" in descriptor)) continue;
    assert.ok(NMG_CAPABILITIES.includes(descriptor.optionalCapability));
    assert.equal(
      NMG_OPTIONAL_METHOD_CAPABILITIES[method as keyof typeof NMG_OPTIONAL_METHOD_CAPABILITIES],
      descriptor.optionalCapability,
    );
  }
});
