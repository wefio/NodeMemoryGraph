import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  FIRST_RESPONSE_TIMING_ENTRY,
  FirstResponseTiming,
  retainSlowRecallEvents,
  type FirstResponseClock,
  type FirstResponseOutcome,
} from "../../../src/integration/first-response-timing.ts";

/** Bind host boundaries without retaining prompt, payload, headers, stream contents or tool arguments. */
export function registerFirstResponseTiming(
  pi: ExtensionAPI,
  clock?: FirstResponseClock,
): FirstResponseTiming {
  const timing = new FirstResponseTiming(
    retainSlowRecallEvents((event) => pi.appendEntry(FIRST_RESPONSE_TIMING_ENTRY, event)),
    clock,
  );
  let outcome: Exclude<FirstResponseOutcome, "pending"> = "stop";
  let agentStarted = false;
  const reset = () => {
    agentStarted = false;
    timing.reset();
  };
  pi.registerCommand("nmg-latency", {
    description: "Opt-in metadata-only timing for input-to-recall >1s: on | off | status",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action !== "on" && action !== "off" && action !== "status") {
        ctx.ui.notify("Usage: /nmg-latency on|off|status", "warning");
        return;
      }
      if (action !== "status") {
        await ctx.waitForIdle();
        timing.setEnabled(action === "on");
      }
      ctx.ui.notify(
        JSON.stringify(timing.snapshot()),
        timing.snapshot().failed ? "warning" : "info",
      );
    },
  });
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("session_tree", reset);
  pi.on("input", (event, ctx) => {
    if (!timing.enabled) return;
    if (event.streamingBehavior) timing.exclude("queued_input");
    else {
      agentStarted = false;
      outcome = "stop";
      timing.begin(ctx.sessionManager.getSessionId(), event.source);
    }
  });
  pi.on("agent_start", () => {
    agentStarted = true;
    timing.mark("agent_start");
  });
  pi.on("before_provider_request", (_event, ctx) => {
    if (timing.enabled && agentStarted && !ctx.isIdle()) timing.mark("provider_request");
  });
  pi.on("before_provider_headers", (_event, ctx) => {
    if (timing.enabled && agentStarted && !ctx.isIdle()) timing.mark("provider_headers");
  });
  pi.on("after_provider_response", (_event, ctx) => {
    if (timing.enabled && agentStarted && !ctx.isIdle()) timing.mark("provider_response");
  });
  pi.on("provider_stream_event", (_event, ctx) => {
    if (timing.enabled && agentStarted && !ctx.isIdle()) timing.mark("provider_event");
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") timing.mark("assistant_start");
  });
  pi.on("message_update", (event) => {
    if (!timing.enabled) return;
    const delta = event.assistantMessageEvent;
    if (delta.type === "thinking_delta" && delta.delta.length) timing.mark("first_thinking");
    if (delta.type === "text_delta" && delta.delta.length) timing.mark("first_text");
  });
  pi.on("tool_execution_start", () => timing.mark("first_tool"));
  pi.on("session_before_compact", () => timing.exclude("compaction"));
  pi.on("session_compact", () => timing.exclude("compaction"));
  pi.on("agent_end", (event) => {
    const last = event.messages.findLast((message) => message.role === "assistant");
    const stop = last?.role === "assistant" ? last.stopReason : undefined;
    outcome = stop === "error" || stop === "aborted" || stop === "length" ? stop : "stop";
    if (outcome === "error") timing.mark("attempt_error");
    if (outcome === "aborted") timing.mark("attempt_aborted");
    if (outcome === "length") timing.mark("attempt_length");
  });
  pi.on("agent_before_settle", (event) => {
    if (event.outcome === "aborted") {
      outcome = "aborted";
      timing.mark("attempt_aborted");
    }
    if (event.outcome === "error") {
      outcome = "error";
      timing.mark("attempt_error");
    }
  });
  pi.on("agent_settled", () => {
    timing.end(outcome);
    agentStarted = false;
  });
  return timing;
}
