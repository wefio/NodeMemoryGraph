import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface AgentTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface AgentRunTelemetry {
  toolCalls: number;
  toolRounds: number;
  tokenUsage: AgentTokenUsage | null;
}

/**
 * Losslessly summarize one settled Pi prompt from its event stream.
 *
 * A tool call is a dispatch attempt. A tool round is one model turn that
 * returned at least one tool result, regardless of how many tools ran in that
 * turn. Token usage is the sum of every assistant message in the prompt so
 * retries and multi-turn tool loops are not silently dropped.
 */
export function collectAgentRunTelemetry(
  events: readonly AgentSessionEvent[],
): AgentRunTelemetry {
  const tokenUsage: AgentTokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  let sawUsage = false;
  let toolCalls = 0;
  let toolRounds = 0;

  for (const event of events) {
    if (event.type === "tool_execution_start") toolCalls += 1;
    if (event.type === "turn_end" && event.toolResults.length > 0) toolRounds += 1;
    if (event.type !== "message_end" || event.message.role !== "assistant") continue;
    sawUsage = true;
    tokenUsage.input += event.message.usage.input;
    tokenUsage.output += event.message.usage.output;
    tokenUsage.cacheRead += event.message.usage.cacheRead;
    tokenUsage.cacheWrite += event.message.usage.cacheWrite;
    tokenUsage.total += event.message.usage.totalTokens;
  }

  return { toolCalls, toolRounds, tokenUsage: sawUsage ? tokenUsage : null };
}
