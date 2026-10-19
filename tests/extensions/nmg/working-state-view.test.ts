import assert from "node:assert/strict";
import test from "node:test";
import { SessionActiveGraphRuntime } from "../../../src/core/session-active-graph.ts";
import type { SessionActiveGraphSnapshot } from "../../../src/core/session-active-graph.ts";
import { PI_WORKING_STATE_INPUT_CAPABILITY } from "../../../src/integration/working-state-input.ts";
import nmgExtension from "../../../.pi/extensions/nmg/index.ts";
import { registerWorkingStateView } from "../../../.pi/extensions/nmg/working-state-view.ts";

type Handler = (event: never, context: never) => Promise<unknown>;

function harness(read: (id: string) => Promise<SessionActiveGraphSnapshot | null>) {
  const hooks = new Map<string, Handler>();
  const widgets: Array<string[] | undefined> = [];
  const view = registerWorkingStateView(
    {
      on(name: string, handler: Handler) {
        hooks.set(name, handler);
      },
      registerCommand(name: string) {
        throw new Error(`the state view must not add a top-level command: ${name}`);
      },
    } as never,
    read,
  );
  return { hooks, widgets, view };
}

function sessionContext(widgets: Array<string[] | undefined>, sessionId = "view-session") {
  return {
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setWidget(_key: string, lines: string[] | undefined) {
        widgets.push(lines);
      },
    },
  };
}

test("Pi registers no per-inference state hook and no extra top-level command", () => {
  const hooks: string[] = [];
  const commands: string[] = [];
  nmgExtension({
    on(name: string) {
      hooks.push(name);
    },
    registerTool() {},
    registerMessageRenderer() {},
    registerCommand(name: string) {
      commands.push(name);
    },
  } as never);
  assert.equal(
    hooks.includes("context"),
    false,
    "a mid-turn state injection would re-send the body and move its position",
  );
  assert.equal(commands.includes("nmg"), true, "the menu owns the state sub-command");
  assert.equal(
    commands.includes("nmg-state"),
    false,
    "the read-only view belongs to the existing menu, not a new top-level command",
  );
  assert.deepEqual(PI_WORKING_STATE_INPUT_CAPABILITY, {
    carriage: "per-user-turn",
    confirmation: "unsupported",
  });
});

test("the view owns startup, session and state-write refreshes without touching model input", async () => {
  const runtime = new SessionActiveGraphRuntime();
  const binding = runtime.bindWorkingState("view-session");
  runtime.replaceWorkingState(binding, "Current plan; exact limit=123");
  const h = harness(async (id) => runtime.snapshot(id));
  assert.deepEqual([...h.hooks.keys()].sort(), [
    "session_shutdown",
    "session_start",
    "tool_result",
  ]);
  const ctx = sessionContext(h.widgets);
  await h.hooks.get("session_start")!({} as never, ctx as never);
  assert.match(
    (h.widgets.at(-1) ?? []).join("\n"),
    /Current plan; exact limit=123/u,
    "the user sees the current state after startup",
  );
  runtime.clearWorkingState(binding);
  await h.hooks.get("tool_result")!(
    { toolName: "nmg_lab", input: { capability: "working_state" } } as never,
    ctx as never,
  );
  assert.equal(h.widgets.at(-1), undefined, "a cleared state removes the user view");
});

test("owner failure and foreign snapshots show an explicit unavailable view", async () => {
  const runtime = new SessionActiveGraphRuntime();
  const binding = runtime.bindWorkingState("view-session");
  runtime.replaceWorkingState(binding, "Current plan");
  for (const failure of ["throw", "foreign"] as const) {
    let fail = false;
    const h = harness(async (id) => {
      if (fail && failure === "throw") throw new Error("owner unavailable");
      if (fail) return { ...runtime.snapshot("view-session")!, sessionId: "foreign" };
      return runtime.snapshot(id);
    });
    const ctx = sessionContext(h.widgets);
    await h.hooks.get("session_start")!({} as never, ctx as never);
    assert.match((h.widgets.at(-1) ?? []).join("\n"), /Current plan/u);
    fail = true;
    await h.hooks.get("tool_result")!(
      { toolName: "nmg_lab", input: { capability: "working_state" } } as never,
      ctx as never,
    );
    assert.match((h.widgets.at(-1) ?? []).join("\n"), /不可用/u);
    assert.doesNotMatch((h.widgets.at(-1) ?? []).join("\n"), /Current plan/u);
  }
});
