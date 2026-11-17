import { stripProviderEnv } from "../helpers/test-env.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexHook } from "../../codex-plugin/hook.ts";
import { CodexSessionStore } from "../../codex-plugin/session-store.ts";
import { codexHookBinding } from "../../codex-plugin/session.ts";
import { NmgService } from "../../src/cli/service.ts";
import { runCli } from "../../src/cli/main.ts";
import { LegacySqliteFixture } from "../helpers/legacy-sqlite-fixture.ts";
import { stgStorePath } from "../../src/core/stg-projection.ts";
import type { NmgMethod } from "../../src/cli/protocol.ts";
import { ADAPTER_CAPABILITY_CATALOG } from "../../src/integration/adapter-capability-catalog.ts";
import { adapterToolCapability } from "../../src/integration/adapter-capability-assembly.ts";
import { captureStateInvocation } from "../../src/integration/state.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

stripProviderEnv();

const id = "00000000-0000-7000-8000-000000000001";
const turn = "00000000-0000-7000-8000-000000000002";
const capabilities = ADAPTER_CAPABILITY_CATALOG.codex.capabilities.filter(
  (capability) => !adapterToolCapability(capability),
);

test("Codex automatically recalls unified SQLite memory from the owning project and session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-codex-local-memory-"));
  const databasePath = join(directory, "memory.sqlite");
  const project = join(directory, "project");
  const source = new LegacySqliteFixture(stgStorePath(project));
  const owner = `codex-${id}`;
  const captured = source.insertMemory({
    statement: "Atlas SQLite deployment keeps the owner backup in ProjectRecallMarker",
    nodeName: "Atlas SQLite project",
    residence: "stg",
    sessionId: owner,
  });
  source.insertMemory({
    statement: "Atlas SQLite deployment keeps another backup in OtherSessionMarker",
    nodeName: "Atlas SQLite project",
    residence: "stg",
    sessionId: "other-session",
  });
  source.close();
  let service: NmgService | undefined;
  const output: string[] = [];
  const methods: string[] = [];
  let searchBudget: unknown;
  const hook = new CodexHook(
    {
      dataDirectory: directory,
      environment: { NMG_ENABLE_COORDINATION: "0" },
      invoke: async (method, params) => {
        methods.push(method);
        if (method === "search") {
          assert.ok(params && typeof params === "object" && "autoRecallBudgetMs" in params);
          searchBudget = params.autoRecallBudgetMs;
        }
        return service!.invoke(method as NmgMethod, params);
      },
      writeOutput: async (content) => {
        output.push(content);
      },
    },
    capabilities,
  );
  try {
    const legacy = new LegacySqliteFixture(databasePath);
    try {
      legacy.insertMemory({
        statement: "Atlas SQLite deployment keeps a durable rollout guide",
        nodeName: "Atlas SQLite rollout",
        markers: [{ kind: "annotation", attributes: { note: "anchor_ref" } }],
      });
    } finally {
      legacy.close();
    }
    let migration = "";
    let stderr = "";
    assert.equal(
      await runCli(["daemon", "migrate", "--db", databasePath, "--json"], {
        stdout: {
          write: (value) => {
            migration += String(value);
            return true;
          },
        },
        stderr: {
          write: (value) => {
            stderr += String(value);
            return true;
          },
        },
      }),
      0,
      stderr,
    );
    assert.ok(JSON.parse(migration).backupPath);
    service = new NmgService({ databasePath, environment: {} });
    assert.ok((await service.invoke("hello")).capabilities.includes("portable-memory"));
    await hook.run({
      hook_event_name: "UserPromptSubmit",
      session_id: id,
      turn_id: turn,
      cwd: project,
      prompt: "What did we previously decide about Atlas SQLite deployment backup?",
    });
    assert.deepEqual(methods.slice(0, 3), ["state", "sessionActiveGraph", "search"]);
    assert.ok(typeof searchBudget === "number" && searchBudget > 0 && searchBudget <= 1_400);
    assert.match(output.join("\n"), /ProjectRecallMarker/);
    assert.doesNotMatch(
      output.join("\n"),
      /OtherSessionMarker|optional context preparation is unavailable/,
    );

    const read = await service.invoke("state", { action: "read", space: "ag", sessionId: owner });
    assert.match(JSON.stringify(read), new RegExp(captured.memory.id, "u"));
    assert.deepEqual((await service.invoke("status")).rpcRejections, []);
    const context = await service.invoke("get", {
      memoryIds: [captured.memory.id],
      sessionId: owner,
      projectDir: project,
    });
    assert.equal(context.results[0]?.memory.id, captured.memory.id);
    const outside = await service.invoke("get", {
      memoryIds: [captured.memory.id],
      sessionId: owner,
      projectDir: directory,
    });
    assert.equal(outside.results.length, 0);
    const mainWrite = await service.invoke("remember", {
      statement: "Unified SQLite remembers the migration fixture",
      nodeName: "Cutover fixture",
    });
    const board = await service.invoke("taskBoard", {
      action: "put",
      taskId: "local-cutover",
      agentId: "test",
      content: "Shared SQLite coordination",
      ttlSeconds: 600,
    });
    assert.equal(board.action, "put");
    await service.close();
    service = new NmgService({ databasePath, environment: {} });
    assert.equal(
      (await service.invoke("get", { memoryIds: [mainWrite.memory.id] })).results.length,
      1,
    );
    const readBoard = await service.invoke("taskBoard", {
      action: "read",
      taskId: "local-cutover",
      agentId: "test",
    });
    assert.ok(readBoard.action === "read" && readBoard.entries.length === 1);
  } finally {
    await service?.close();
    removeTempDirectory(directory);
  }
});

test("Codex carries full owner state when optional recall fails and restores it after compaction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-codex-hook-"));
  const service = new NmgService({ dataDirectory: directory, environment: {} });
  const output: string[] = [];
  let recallAttempted = false;
  const sessionId = `codex-${id}`;
  const invoke = (method: string, params: unknown) => service.invoke(method as NmgMethod, params);
  try {
    await invoke("state", {
      action: "write",
      space: "ag",
      operation: "enable",
      reason: "Test",
      requester: "test",
      sessionId,
    });
    const replace = await captureStateInvocation(
      {
        action: "write",
        space: "ag",
        operation: "replace",
        text: "OwnerInvariantMarker\nKeep the complete multiline invariant.",
        sessionId,
      },
      (sessionId) =>
        invoke("state", { action: "read", space: "ag", operation: "status", sessionId }),
    );
    await invoke("state", replace);
    const hook = new CodexHook(
      {
        dataDirectory: directory,
        environment: { NMG_ENABLE_COORDINATION: "0" },
        invoke: async (method, params) => {
          if (method === "search") {
            recallAttempted = true;
            throw new Error("Optional recall failed");
          }
          return invoke(method, params);
        },
        writeOutput: async (text) => {
          output.push(text);
        },
      },
      capabilities,
    );
    await hook.run({
      hook_event_name: "UserPromptSubmit",
      session_id: id,
      turn_id: turn,
      cwd: directory,
      prompt: "What did we previously decide about Atlas SQLite?",
    });
    assert.equal(recallAttempted, true);
    assert.match(output.join("\n"), /OwnerInvariantMarker/);
    assert.match(output.join("\n"), /Keep the complete multiline invariant/);
    output.length = 0;
    await hook.run({ hook_event_name: "PreCompact", session_id: id });
    await hook.run({ hook_event_name: "SessionStart", source: "compact", session_id: id });
    assert.match(output.join("\n"), /OwnerInvariantMarker/);
    assert.match(output.join("\n"), /Keep the complete multiline invariant/);
    output.length = 0;
    await hook.run({ hook_event_name: "PostCompact", session_id: id });
    assert.equal(JSON.parse(output[0]!).hookSpecificOutput.hookEventName, "PostCompact");
    assert.match(output.join("\n"), /OwnerInvariantMarker/);
    await hook.run({ hook_event_name: "Stop", session_id: id, turn_id: turn });
    const state = await service.invoke("state", { action: "read", space: "ag", sessionId });
    assert.match(JSON.stringify(state), /OwnerInvariantMarker/);
  } finally {
    await service.close();
    removeTempDirectory(directory);
  }
});

test("Codex refuses context prepared before a native clear", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-codex-stale-hook-"));
  const service = new NmgService({ dataDirectory: directory, environment: {} });
  let output = "";
  let reset = false;
  try {
    const hook = new CodexHook(
      {
        dataDirectory: directory,
        environment: { NMG_ENABLE_COORDINATION: "0" },
        invoke: async (method, params) => {
          const result = await service.invoke(method as NmgMethod, params);
          if (method === "state" && !reset) {
            reset = true;
            await new CodexSessionStore(directory).reset(codexHookBinding({ session_id: id }));
          }
          return result;
        },
        writeOutput: async (text) => {
          output += text;
        },
      },
      capabilities,
    );
    await assert.rejects(
      hook.run({
        hook_event_name: "UserPromptSubmit",
        session_id: id,
        turn_id: turn,
        cwd: directory,
        prompt: "Atlas SQLite",
      }),
      /Obsolete/,
    );
    assert.equal(output, "");
  } finally {
    await service.close();
    removeTempDirectory(directory);
  }
});

test("Codex completion batches many authors, receipts accepted output and prevents continuation loops", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-codex-completion-"));
  const service = new NmgService({ dataDirectory: directory, environment: {} });
  const output: string[] = [];
  let rejectOutput = false;
  let forwardedPosts = 0;
  const receipts: unknown[] = [];
  writeFileSync(
    join(directory, "board-wake.json"),
    JSON.stringify({ enabled: true, budget: 8, cooldownMs: 0 }),
  );
  const sessionId = `codex-${id}`;
  try {
    const hook = new CodexHook(
      {
        dataDirectory: directory,
        environment: {},
        invoke: async (method, params) => {
          if (method === "taskBoard" && (params as { action?: string }).action === "put")
            forwardedPosts++;
          if (method === "taskBoard" && (params as { action?: string }).action === "recordDelivery")
            receipts.push(params);
          return service.invoke(method as NmgMethod, params);
        },
        writeOutput: async (text) => {
          if (rejectOutput) throw new Error("Sink rejected");
          output.push(text);
        },
      },
      capabilities,
    );
    await hook.run({
      hook_event_name: "UserPromptSubmit",
      session_id: id,
      turn_id: turn,
      cwd: directory,
      prompt: "hello",
    });
    for (let i = 0; i < 8; i++)
      await service.invoke("taskBoard", {
        action: "put",
        taskId: "completion-fixture",
        agentId: `author-${i}`,
        kind: "note",
        content: `CompletionNotice${i}`,
        to: sessionId,
        notification: { key: `completion-${i}`, scopes: ["direct"], recipients: [sessionId] },
      });
    output.length = 0;
    rejectOutput = true;
    await assert.rejects(
      hook.run({ hook_event_name: "Stop", session_id: id, turn_id: turn, stop_hook_active: false }),
      /Sink rejected/,
    );
    rejectOutput = false;
    await hook.run({
      hook_event_name: "Stop",
      session_id: id,
      turn_id: turn,
      stop_hook_active: false,
    });
    assert.equal(output.length, 1);
    const message = JSON.parse(output[0]!);
    assert.equal(message.decision, "block");
    const admitted = String(message.reason).match(/CompletionNotice\d/g) ?? [];
    assert.ok(admitted.length > 2);
    assert.ok(admitted.length <= 8);
    assert.ok(message.reason.length <= 4000);
    await hook.run({
      hook_event_name: "Stop",
      session_id: id,
      turn_id: turn,
      stop_hook_active: true,
    });
    await hook.run({
      hook_event_name: "Stop",
      session_id: id,
      turn_id: turn,
      stop_hook_active: false,
    });
    assert.equal(
      output.length,
      1,
      JSON.stringify({
        receipts,
        notices: output.map((text) => JSON.parse(text).reason?.match(/notice=[^ ]+/g)),
      }),
    );
    assert.equal(forwardedPosts, 0);
  } finally {
    await service.close();
    removeTempDirectory(directory);
  }
});
