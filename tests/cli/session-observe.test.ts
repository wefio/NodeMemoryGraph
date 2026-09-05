import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { runCli } from "../../src/cli/main.ts";
import { testWorkspace, withTestRuntime } from "../support/test-runtime.ts";
import { join } from "node:path";

const quiet = { stdout: { write: () => true }, stderr: { write: () => true } };

test("session observe rejects absent resident daemon instead of losing ephemeral state", async () => {
  await withTestRuntime([testWorkspace()], async (runtime) => {
    const path = join(runtime.workspace().path, "nmg.sqlite");
    const result = await runCli(
      [
        "session",
        "observe",
        "verifier failed",
        "--session-id",
        "owner",
        "--task-frame-id",
        "task-A",
        "--source-id",
        "receipt-1",
        "--db",
        path,
      ],
      quiet,
    );
    assert.equal(result, 1);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(`${path}.server.json`), false);
  });
});

test("session observe requires explicit source, session and task identities", async () => {
  assert.equal(await runCli(["session", "observe", "feedback"], quiet), 2);
  assert.equal(
    await runCli(
      ["session", "observe", "feedback", "--session-id", "owner", "--task-frame-id", "task-A"],
      quiet,
    ),
    2,
  );
});
