import assert from "node:assert/strict";
import test from "node:test";

import nmgExtension from "../../../.pi/extensions/nmg/index.ts";
import { registerFirstResponseTiming } from "../../../.pi/extensions/nmg/first-response-timing.ts";
import {
  FIRST_RESPONSE_TIMING_ENTRY,
  type FirstResponseTimingEvent,
} from "../../../src/integration/first-response-timing.ts";

test("Pi exposes an explicitly enabled first-response observer without making provider calls", () => {
  const commands = new Map<string, unknown>();
  nmgExtension({
    on() {},
    registerTool() {},
    registerMessageRenderer() {},
    registerCommand(name: string, options: unknown) {
      commands.set(name, options);
    },
  } as never);
  assert.ok(commands.has("nmg-latency"), "first-response observation has its own opt-in command");
});

type Hook = (event: never, ctx: never) => unknown;
type Command = { handler: (args: string, ctx: never) => Promise<void> };

function host() {
  const hooks = new Map<string, Hook>();
  const commands = new Map<string, Command>();
  const records: FirstResponseTimingEvent[] = [];
  const notices: string[] = [];
  let idle = false;
  let waits = 0;
  let sessionReads = 0;
  let now = 0;
  let ids = 0;
  const api = {
    on(name: string, handler: Hook) {
      hooks.set(name, handler);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    appendEntry(name: string, data: FirstResponseTimingEvent) {
      assert.equal(name, FIRST_RESPONSE_TIMING_ENTRY);
      records.push(data);
    },
  };
  const timing = registerFirstResponseTiming(api as never, {
    now: () => now,
    wall: () => new Date(now).toISOString(),
    id: () => `trace-${++ids}`,
  });
  const context = {
    sessionManager: {
      getSessionId: () => {
        sessionReads += 1;
        return "timing-session";
      },
    },
    isIdle: () => idle,
    waitForIdle: async () => {
      waits += 1;
    },
    ui: { notify: (text: string) => notices.push(text) },
  };
  return {
    timing,
    records,
    notices,
    setIdle: (value: boolean) => (idle = value),
    waits: () => waits,
    sessionReads: () => sessionReads,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    recall: (milliseconds = 1_001) => {
      timing.mark("nmg_start");
      now += milliseconds;
      timing.mark("nmg_end");
    },
    fire: (name: string, event: unknown = {}) => hooks.get(name)!(event as never, context as never),
    command: (action: string) => commands.get("nmg-latency")!.handler(action, context as never),
  };
}

test("Pi does not persist a fast input-to-recall trace", async () => {
  const h = host();
  await h.command("on");
  h.fire("input", { source: "interactive" });
  h.recall(1_000);
  h.advance(20_000);
  h.fire("agent_start");
  h.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "response" } });
  h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  h.fire("agent_settled");
  assert.ok(h.timing.snapshot().phases.nmg_end! <= 1_000);
  assert.deepEqual(h.records, [], "fast recall metadata stays out of the session log");
});

function forbiddenPayload(field: string): Record<string, unknown> {
  return Object.defineProperty({}, field, {
    get() {
      throw new Error(`observer must not read ${field}`);
    },
  });
}

test("Pi observation is default-off and enabling waits for an idle boundary", async () => {
  const h = host();
  h.fire("input", { source: "interactive", text: "ignored" });
  h.fire("provider_stream_event");
  assert.equal(h.records.length, 0);
  assert.equal(h.sessionReads(), 0, "disabled observation does not collect input metadata");
  h.fire("message_update", forbiddenPayload("assistantMessageEvent"));
  await h.command("status");
  assert.equal(h.waits(), 0);
  assert.equal(JSON.parse(h.notices.at(-1)!).enabled, false);
  await h.command("on");
  assert.equal(h.waits(), 1);
  assert.equal(h.timing.enabled, true);
  await h.command("invalid");
  assert.equal(h.waits(), 1);
  assert.match(h.notices.at(-1)!, /Usage/u);
});

test("host boundaries log only metadata and first nonempty deltas", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("observation must not call a provider or daemon");
  });
  const h = host();
  await h.command("on");
  h.fire("input", Object.assign(forbiddenPayload("text"), { source: "rpc" }));
  assert.equal(h.records.length, 0, "the input boundary is buffered, not immediately persisted");
  h.recall();
  h.fire("agent_start");
  h.fire("before_provider_request", forbiddenPayload("payload"));
  h.fire("before_provider_headers", forbiddenPayload("headers"));
  h.fire("after_provider_response", forbiddenPayload("headers"));
  h.fire("provider_stream_event", forbiddenPayload("data"));
  h.fire("message_start", { message: { role: "assistant" } });
  h.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "" } });
  assert.equal(
    h.records.some((r) => r.phase === "first_text"),
    false,
  );
  for (const type of ["thinking_delta", "text_delta", "text_delta"]) {
    h.fire("message_update", { assistantMessageEvent: { type, delta: "CONTENT_CANARY" } });
  }
  h.fire("tool_execution_start", forbiddenPayload("args"));
  h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  h.fire("agent_settled");
  assert.equal(h.records.filter((r) => r.phase === "first_text").length, 1);
  assert.equal(h.records.at(-1)?.outcome, "stop");
  assert.doesNotMatch(JSON.stringify(h.records), /CONTENT_CANARY/u);
  for (const record of h.records) {
    assert.deepEqual(
      Object.keys(record).sort(),
      [
        "at",
        "elapsedMs",
        "excluded",
        "outcome",
        "phase",
        "sessionId",
        "source",
        "traceId",
        "version",
      ],
      "no prompt, payload, headers or stream contents are persisted",
    );
  }
});

test("idle cache work is not attributed to an input's provider request", async () => {
  const h = host();
  await h.command("on");
  h.fire("input", { source: "interactive" });
  h.recall();
  h.fire("before_provider_request");
  assert.deepEqual(
    h.records.map((r) => r.phase),
    ["input", "nmg_start", "nmg_end"],
    "pre-agent requests are not model output",
  );
  h.fire("agent_start");
  h.setIdle(true);
  h.fire("before_provider_request");
  h.fire("provider_stream_event");
  assert.deepEqual(
    h.records.map((r) => r.phase),
    ["input", "nmg_start", "nmg_end", "agent_start"],
  );
});

test("compaction and queued input exclude traces without resetting the active identity", async () => {
  const h = host();
  await h.command("on");
  h.fire("input", { source: "interactive" });
  h.recall();
  const id = h.records[0]!.traceId;
  h.fire("input", { source: "interactive", streamingBehavior: "followUp" });
  h.fire("session_before_compact");
  h.fire("session_compact");
  assert.ok(h.records.every((r) => r.traceId === id));
  assert.equal(h.records.filter((r) => r.phase === "compaction").length, 1);
  assert.equal(h.timing.snapshot().excluded, true);
});

test("a failed attempt can retry before settlement and remains observable", async () => {
  const h = host();
  await h.command("on");
  h.fire("input", { source: "interactive" });
  h.recall();
  h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
  assert.equal(
    h.records.some((r) => r.phase === "end"),
    false,
  );
  h.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "response" } });
  h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  h.fire("agent_settled");
  assert.ok(h.records.some((r) => r.phase === "attempt_error"));
  assert.ok(h.records.some((r) => r.phase === "first_text"));
  assert.equal(h.records.at(-1)?.outcome, "stop");
});

test("aborting after a tool request is not misreported as successful settlement", async () => {
  const h = host();
  await h.command("on");
  h.fire("input", { source: "interactive" });
  h.recall();
  h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "toolUse" }] });
  h.fire("agent_before_settle", { outcome: "aborted" });
  h.fire("agent_settled");
  assert.equal(h.records.at(-1)?.outcome, "aborted");
  assert.equal(h.timing.snapshot().phases.first_text, undefined);
});

test("session replacement and explicit off never leave capture armed", async () => {
  const h = host();
  await h.command("on");
  h.fire("input", { source: "interactive" });
  h.recall();
  await h.command("off");
  assert.equal(h.records.at(-1)?.outcome, "disabled");
  await h.command("on");
  h.fire("session_start");
  assert.equal(h.timing.enabled, false);
  h.fire("input", { source: "interactive" });
  assert.equal(h.records.filter((r) => r.phase === "input").length, 1);
  for (const event of ["session_tree", "session_shutdown"]) {
    await h.command("on");
    h.fire(event);
    assert.equal(h.timing.enabled, false, `${event} resets observation`);
  }
});
