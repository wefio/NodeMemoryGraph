import assert from "node:assert/strict";
import test from "node:test";
import { createDaemonHealthTool } from "../../src/integration/daemon-health-tool.ts";

test("daemon health projects the current daemon and an offline CLI response", async () => {
  const tool = createDaemonHealthTool();
  for (const [status, expected] of [
    [{ process: { pid: 123 } }, /running pid=123 endpoint=127\.0\.0\.1:9142 compatible=true/u],
    [{ running: false }, /NMG daemon: not running/u],
  ] as const) {
    const result = await tool.execute(
      { action: "status" },
      {
        sessionId: "native",
        requester: "agent:fixture",
        daemonAddress: () => "127.0.0.1:9142",
        async invoke(method, params, cli) {
          assert.equal(method, "status");
          assert.deepEqual(params, {});
          assert.deepEqual(cli, ["daemon", "status", "--json"]);
          return status;
        },
      },
    );
    assert.match(result.text, expected);
  }
});
