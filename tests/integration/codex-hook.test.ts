import { stripProviderEnv } from "../helpers/test-env.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexHook } from "../../codex-plugin/hook.ts";
import { CodexSessionStore } from "../../codex-plugin/session-store.ts";
import { codexHookBinding } from "../../codex-plugin/session.ts";
import { NmgService } from "../../src/cli/service.ts";
import type { NmgMethod } from "../../src/cli/protocol.ts";
import { ADAPTER_CAPABILITY_CATALOG } from "../../src/integration/adapter-capability-catalog.ts";
import { captureStateInvocation } from "../../src/integration/state.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

stripProviderEnv();

const id = "00000000-0000-7000-8000-000000000001";
const turn = "00000000-0000-7000-8000-000000000002";
const capabilities = ADAPTER_CAPABILITY_CATALOG.codex.capabilities.filter(
  (capability) => !["memory-tools", "state-tool", "lab-tools"].includes(capability),
);

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
