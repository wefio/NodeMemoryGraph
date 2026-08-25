import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { httpCall } from "../../src/cli/http-client.ts";
import {
  TestRuntime,
  testDaemon,
  testDatabase,
  testWorkspace,
  withTestRuntime,
} from "./test-runtime.ts";

test("TestRuntime composes workspace, database, and daemon resources", async () => {
  const runtime = new TestRuntime();
  await runtime.use(testWorkspace());
  await runtime.use(testDatabase());
  await runtime.use(testDaemon());

  const workspace = runtime.workspace();
  assert.equal(existsSync(workspace.path), true);
  assert.equal(existsSync(runtime.database().path), true);

  const hello = (await httpCall(runtime.daemon().state, "hello")) as {
    service: string;
  };
  assert.equal(hello.service, "node-memory-graph");

  const daemonState = runtime.daemon().state;
  await runtime.dispose();

  assert.equal(existsSync(workspace.path), false);
  await assert.rejects(() => httpCall(daemonState, "hello"));
});

test("withTestRuntime releases resources when the task throws", async () => {
  let workspacePath = "";

  await assert.rejects(
    () =>
      withTestRuntime([testWorkspace(), testDatabase()], async (runtime) => {
        workspacePath = runtime.workspace().path;
        throw new Error("expected failure");
      }),
    /expected failure/,
  );

  assert.notEqual(workspacePath, "");
  assert.equal(existsSync(workspacePath), false);
});

test("resource dependencies fail explicitly instead of creating hidden state", async () => {
  const runtime = new TestRuntime();
  await assert.rejects(() => runtime.use(testDatabase()), /testWorkspace/);
  await runtime.dispose();
});
