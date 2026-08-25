import assert from "node:assert/strict";
import test from "node:test";

import { assertDaemonProtocol, NmgDaemonCompatibilityError } from "../../src/cli/daemon-client.ts";
import { NMG_PROTOCOL_VERSION } from "../../src/cli/protocol.ts";

test("daemon protocol guard accepts the current protocol", () => {
  assert.doesNotThrow(() => assertDaemonProtocol({ protocol: NMG_PROTOCOL_VERSION }));
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
  assert.throws(
    () => assertDaemonProtocol({ protocol: "nmg.v7" } as never),
    /restart/u,
  );
});
