import assert from "node:assert/strict";
import test from "node:test";

import {
  FirstResponseTiming,
  type FirstResponseTimingEvent,
} from "../../src/integration/first-response-timing.ts";

function fixture() {
  let now = 0;
  let ids = 0;
  const events: FirstResponseTimingEvent[] = [];
  const timing = new FirstResponseTiming((event) => events.push(event), {
    now: () => now,
    wall: () => new Date(now).toISOString(),
    id: () => `trace-${++ids}`,
  });
  return { timing, events, advance: (ms: number) => (now += ms), ids: () => ids };
}

test("first-response timing is disabled until explicit activation", () => {
  const { timing, events, ids } = fixture();
  timing.begin("session", "interactive");
  timing.mark("first_text");
  assert.equal(events.length, 0);
  assert.equal(ids(), 0, "disabled observation allocates no trace");
  assert.equal(timing.snapshot().enabled, false);
});

test("first-only phase marks keep elapsed time and do not fabricate missing boundaries", () => {
  const { timing, events, advance } = fixture();
  timing.setEnabled(true);
  timing.begin("session", "rpc");
  advance(25);
  timing.mark("nmg_start");
  advance(5_000);
  timing.mark("nmg_end");
  advance(20);
  timing.mark("provider_request");
  advance(3_000);
  timing.mark("first_text");
  advance(200);
  timing.mark("first_text");
  assert.equal(events.filter((e) => e.phase === "first_text").length, 1);
  assert.equal(timing.snapshot().phases.first_text, 8_045);
  assert.equal(timing.snapshot().phases.nmg_end, 5_025);
  assert.equal(timing.snapshot().phases.provider_event, undefined);
  assert.equal(timing.snapshot().phases.first_tool, undefined);
});

test("superseded inputs retain the unfinished trace and get a fresh identity", () => {
  const { timing, events, advance } = fixture();
  timing.setEnabled(true);
  timing.begin("session", "interactive");
  advance(500);
  timing.begin("session", "rpc");
  const ending = events.find((e) => e.phase === "end");
  assert.equal(ending?.outcome, "superseded");
  assert.equal(ending?.elapsedMs, 500);
  assert.equal(events.at(-1)?.traceId, "trace-2");
  assert.equal(events.at(-1)?.elapsedMs, 0);
});

test("compaction excludes the whole trace even after its first text or end", () => {
  const { timing, events } = fixture();
  timing.setEnabled(true);
  timing.begin("session", "interactive");
  timing.mark("first_text");
  timing.end("stop");
  timing.exclude("compaction");
  timing.exclude("compaction");
  assert.equal(timing.snapshot().excluded, true);
  assert.equal(events.filter((e) => e.phase === "compaction").length, 1);
  assert.equal(events.at(-1)?.excluded, true);
  assert.equal(events.at(-1)?.outcome, "stop");
});

test("failures remain outcomes, not successful zero-latency responses", () => {
  const { timing, events, advance } = fixture();
  timing.setEnabled(true);
  timing.begin("session", "interactive");
  advance(10_000);
  timing.end("error");
  timing.mark("first_text");
  assert.equal(events.at(-1)?.outcome, "error");
  assert.equal(events.at(-1)?.elapsedMs, 10_000);
  assert.equal(timing.snapshot().phases.first_text, undefined);
});

test("observer storage failure disables capture without leaking errors or breaking the host", () => {
  const timing = new FirstResponseTiming(() => {
    throw new Error("credential-canary");
  });
  timing.setEnabled(true);
  assert.doesNotThrow(() => timing.begin("session", "interactive"));
  assert.equal(timing.snapshot().failed, true);
  assert.equal(timing.enabled, false);
  assert.doesNotMatch(JSON.stringify(timing.snapshot()), /credential-canary/u);
});

test("invalid clock data is a reported capture failure, never a made-up duration", () => {
  const events: FirstResponseTimingEvent[] = [];
  const timing = new FirstResponseTiming((e) => events.push(e), {
    now: () => Number.NaN,
    wall: () => "unused",
    id: () => "trace",
  });
  timing.setEnabled(true);
  timing.begin("session", "rpc");
  assert.equal(events.length, 0);
  assert.equal(timing.snapshot().failed, true);
});

test("a thrown clock error cannot interrupt the host", () => {
  const timing = new FirstResponseTiming(() => {}, {
    now: () => {
      throw new Error("clock canary");
    },
    wall: () => "unused",
    id: () => "trace",
  });
  timing.setEnabled(true);
  assert.doesNotThrow(() => timing.begin("session", "interactive"));
  assert.equal(timing.snapshot().failed, true);
  assert.equal(timing.enabled, false);
});

test("session reset stops capture and snapshots cannot modify phase state", () => {
  const { timing, events } = fixture();
  timing.setEnabled(true);
  timing.begin("session", "interactive");
  const snapshot = timing.snapshot();
  snapshot.phases.input = 99;
  assert.equal(timing.snapshot().phases.input, 0);
  timing.reset();
  assert.equal(events.at(-1)?.outcome, "session_shutdown");
  timing.begin("other-session", "interactive");
  assert.equal(events.filter((e) => e.phase === "input").length, 1);
  assert.equal(timing.enabled, false);
});
