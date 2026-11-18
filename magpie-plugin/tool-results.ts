import type { ToolObservationEvent } from "../src/integration/tool-observation.ts";
import type { GatewayProtocol } from "./protocol.ts";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}

export interface ReportedToolResult {
  id: string;
  event: ToolObservationEvent;
}

/** Client-submitted results are reported evidence with unknown execution outcome. */
export function reportedToolResults(
  body: Record<string, unknown>,
  protocol: GatewayProtocol,
): ReportedToolResult[] {
  const result: ReportedToolResult[] = [];
  const calls = new Map<string, { name: string; input: unknown }>();
  const remember = (id: unknown, name: unknown, input: unknown) => {
    if (typeof id === "string" && typeof name === "string") calls.set(id, { name, input });
  };
  const receive = (id: unknown, content: unknown) => {
    const call = calls.get(String(id));
    if (!call || call.name.startsWith("nmg_") || call.name.startsWith("mcp__nmg")) return;
    result.push({
      id: String(id),
      event: {
        toolName: /^(Bash|exec_command|shell_command)$/i.test(call.name) ? "bash" : call.name,
        input: call.input,
        content:
          typeof content === "string" || Array.isArray(content) ? content : JSON.stringify(content),
        isError: false,
        outcomeKnown: false,
      },
    });
  };
  switch (protocol) {
    case "chat":
      for (const message of rows(body.messages)) {
        for (const call of rows(message.tool_calls))
          remember(call.id, object(call.function).name, object(call.function).arguments);
        if (message.role === "tool") receive(message.tool_call_id, message.content);
      }
      break;
    case "responses":
      for (const item of rows(body.input)) {
        if (item.type === "function_call") remember(item.call_id, item.name, item.arguments);
        if (item.type === "function_call_output") receive(item.call_id, item.output);
      }
      break;
    case "anthropic":
      readAnthropic(body, remember, receive);
      break;
    case "gemini":
      readGemini(body, remember, receive);
      break;
  }
  return result.slice(-16);
}

function readAnthropic(
  body: Record<string, unknown>,
  remember: RememberCall,
  receive: ReceiveResult,
): void {
  for (const message of rows(body.messages))
    for (const item of rows(message.content)) {
      if (item.type === "tool_use") remember(item.id, item.name, item.input);
      if (item.type === "tool_result") receive(item.tool_use_id, item.content);
    }
}

function readGemini(
  body: Record<string, unknown>,
  remember: RememberCall,
  receive: ReceiveResult,
): void {
  for (const message of rows(body.contents))
    for (const item of rows(message.parts)) {
      const call = object(item.functionCall);
      if (call.name) remember(call.id ?? call.name, call.name, call.args);
      const response = object(item.functionResponse);
      if (response.name) receive(response.id ?? response.name, response.response);
    }
}

type RememberCall = (id: unknown, name: unknown, input: unknown) => void;
type ReceiveResult = (id: unknown, content: unknown) => void;
