import assert from "node:assert/strict";
import test from "node:test";
import { SessionActiveGraphRuntime } from "../../../src/core/session-active-graph.ts";
import type { SessionActiveGraphSnapshot } from "../../../src/core/session-active-graph.ts";
import { registerWorkingStateView } from "../../../.pi/extensions/nmg/working-state-view.ts";

type Handler = (event: never, context: never) => Promise<unknown>;
function harness(read: (id: string) => Promise<SessionActiveGraphSnapshot | null>) {
  const hooks = new Map<string, Handler>();
  const widgets: Array<string[] | undefined> = [];
  const notices: string[] = [];
  let sessionId = "display-session";
  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setWidget(_key: string, lines: string[] | undefined) {
        widgets.push(lines);
      },
      notify(text: string) {
        notices.push(text);
      },
    },
  };
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
  return {
    ctx,
    widgets,
    notices,
    view,
    switchSession(id: string) {
      sessionId = id;
    },
    fire(name: string, event: unknown = {}) {
      assert.ok(hooks.has(name), `missing ${name} hook`);
      return hooks.get(name)!(event as never, ctx as never);
    },
    show() {
      return view.readForUser(ctx as never);
    },
  };
}
function seeded() {
  const runtime = new SessionActiveGraphRuntime();
  const binding = runtime.bindWorkingState("display-session");
  runtime.replaceWorkingState(
    binding,
    "目标：持续状态\n已完成：基础\n当前：实现展示\n下一步：验证\n阻塞：无",
  );
  return { runtime, binding };
}

test("maintained state is visible on startup and directly readable without semantic search", async () => {
  const { runtime } = seeded();
  let reads = 0;
  const h = harness(async (id) => {
    reads++;
    return runtime.snapshot(id);
  });
  await h.fire("session_start");
  assert.match(h.widgets.at(-1)!.join("\n"), /当前：实现展示/u);
  await h.show();
  assert.match(h.notices.at(-1)!, /下一步：验证/u);
  assert.equal(reads, 2);
  assert.deepEqual(runtime.snapshot("display-session")!.disclosures, []);
});

test("state writes refresh the user view; clear and session switch cannot show the old task", async () => {
  const { runtime, binding } = seeded();
  const h = harness(async (id) => runtime.snapshot(id));
  await h.fire("session_start");
  runtime.replaceWorkingState(binding, "当前：已验证展示；下一步：协议");
  await h.fire("tool_result", {
    toolName: "nmg_lab",
    input: { capability: "working_state" },
  });
  assert.match(h.widgets.at(-1)!.join("\n"), /已验证展示/u);
  runtime.clearWorkingState(binding);
  await h.fire("tool_result", {
    toolName: "nmg_lab",
    input: { capability: "working_state" },
  });
  assert.equal(h.widgets.at(-1), undefined);
  await h.show();
  assert.match(h.notices.at(-1)!, /尚未维护/u);
  runtime.replaceWorkingState(binding, "old private task");
  h.switchSession("other-session");
  await h.fire("session_start");
  assert.equal(h.widgets.at(-1), undefined);
});

test("owner failure and foreign snapshots never masquerade as current progress", async () => {
  const { runtime } = seeded();
  for (const failure of ["throw", "foreign"] as const) {
    let fail = false;
    const h = harness(async (id) => {
      if (fail && failure === "throw") throw new Error("owner unavailable");
      if (fail)
        return {
          ...runtime.snapshot("display-session")!,
          sessionId: "foreign",
        };
      return runtime.snapshot(id);
    });
    await h.fire("session_start");
    fail = true;
    await h.fire("tool_result", {
      toolName: "nmg_lab",
      input: { capability: "working_state" },
    });
    assert.match(h.widgets.at(-1)!.join("\n"), /不可用/u);
    assert.doesNotMatch(h.widgets.at(-1)!.join("\n"), /当前：实现展示/u);
    await h.show();
    assert.match(h.notices.at(-1)!, /不可用/u);
  }
});

test("a delayed read cannot overwrite newer progress or repaint after shutdown", async () => {
  const { runtime, binding } = seeded();
  let delay: ((snapshot: SessionActiveGraphSnapshot | null) => void) | undefined;
  let slow = false;
  const h = harness(async (id) =>
    slow
      ? new Promise((resolve) => {
          delay = resolve;
        })
      : runtime.snapshot(id),
  );
  slow = true;
  const pending = h.show();
  const old = runtime.snapshot("display-session");
  slow = false;
  runtime.replaceWorkingState(binding, "最新：测试通过");
  await h.show();
  delay!(old);
  await pending;
  assert.match(h.widgets.at(-1)!.join("\n"), /最新：测试通过/u);
  assert.equal(h.notices.length, 1, "obsolete read owes no notification");
  slow = true;
  const closing = h.show();
  await h.fire("session_shutdown");
  delay!(old);
  await closing;
  assert.equal(h.widgets.at(-1), undefined);
});

test("widget clipping is explicit and the direct view returns the complete admitted body", async () => {
  const { runtime, binding } = seeded();
  const text = Array.from({ length: 14 }, (_, i) => `状态行 ${i}`).join("\n");
  runtime.replaceWorkingState(binding, text);
  const h = harness(async (id) => runtime.snapshot(id));
  await h.fire("session_start");
  assert.match(h.widgets.at(-1)!.join("\n"), /nmg state/u);
  assert.ok(h.widgets.at(-1)!.length <= 8);
  await h.show();
  assert.equal(h.notices.at(-1), `[temporary] ${text}`);
});

test("the preview switch hides and restores the user view without touching the state", async () => {
  const { runtime, binding } = seeded();
  const h = harness(async (id) => runtime.snapshot(id));
  await h.fire("session_start");
  assert.match(h.widgets.at(-1)!.join("\n"), /当前：实现展示/u);
  await h.view.setPreview(false, h.ctx as never);
  assert.equal(h.widgets.at(-1), undefined, "hiding removes the widget");
  runtime.replaceWorkingState(binding, "隐藏预览后仍可读取");
  await h.fire("tool_result", {
    toolName: "nmg_lab",
    input: { capability: "working_state" },
  });
  assert.equal(h.widgets.at(-1), undefined, "a hidden preview stays hidden on refresh");
  await h.show();
  assert.match(h.notices.at(-1)!, /隐藏预览后仍可读取/u, "the body stays readable while hidden");
  await h.view.setPreview(true, h.ctx as never);
  assert.match(h.widgets.at(-1)!.join("\n"), /隐藏预览后仍可读取/u, "re-enabling reads again");
});

test("unified AG writes refresh the view; board operations and state reads do not", async () => {
  const { runtime, binding } = seeded();
  let reads = 0;
  const h = harness(async (id) => {
    reads++;
    return runtime.snapshot(id);
  });
  await h.fire("session_start");
  runtime.replaceWorkingState(binding, "Unified state write");
  await h.fire("tool_result", {
    toolName: "nmg_state",
    input: { action: "write", space: "ag", operation: "replace" },
  });
  assert.match(h.widgets.at(-1)!.join("\n"), /Unified state write/u);
  await h.fire("tool_result", {
    toolName: "nmg_state",
    input: { action: "write", space: "board" },
  });
  await h.fire("tool_result", {
    toolName: "nmg_state",
    input: { action: "read", space: "ag" },
  });
  assert.equal(reads, 2, "unrelated state calls must not read or repaint private AG");
  runtime.clearWorkingState(binding);
  await h.fire("tool_result", {
    toolName: "nmg_state",
    input: { action: "write", space: "ag", operation: "clear" },
  });
  assert.equal(h.widgets.at(-1), undefined);
});

test("a non-interactive host keeps the read-only view without terminal UI", async () => {
  const { runtime } = seeded();
  const h = harness(async (id) => runtime.snapshot(id));
  h.ctx.mode = "rpc";
  await h.fire("session_start");
  assert.equal(h.widgets.length, 0);
  await h.show();
  assert.match(h.notices.at(-1)!, /当前：实现展示/u);
});
