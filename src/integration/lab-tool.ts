import { loadPrompts } from "../prompts/load.ts";
import { LAB_CAPABILITIES, renderLabOutput } from "./lab-capabilities.ts";
import type { AdapterToolSession } from "./adapter-tool-session.ts";

const actions = ["list", "status", "enable", "disable", "invoke"];
const string = { type: "string" };
const inputSchema = {
  type: "object" as const,
  properties: {
    action: { ...string, enum: actions },
    capability: { ...string, enum: LAB_CAPABILITIES.filter((id) => id !== "working_state") },
    reason: string,
    ttlSeconds: { type: "integer", minimum: 60, maximum: 86_400 },
    operation: string,
    input: {},
  },
  required: ["action"],
  additionalProperties: false,
};

export function createLabTool() {
  return {
    name: "nmg_lab" as const,
    requiresNativeSession: false,
    label: "NMG Lab capabilities",
    description: loadPrompts().lab_description,
    inputSchema,
    async execute(args: Record<string, unknown>, session: AdapterToolSession) {
      const { action, capability, reason, ttlSeconds, operation, input } = args;
      validateRequest(action, capability, reason, operation);
      const change = action === "invoke" ? operation : action;
      if (
        capability === "recall_gate" &&
        ["enable", "disable", "clear", "correct", "remove"].includes(String(change))
      )
        session.invalidateRecallGate?.();
      const params = {
        action,
        capability,
        sessionId: session.sessionId,
        scope: action === "enable" ? "session" : undefined,
        requester: action === "enable" ? session.requester : undefined,
        reason,
        ttlSeconds,
        operation,
        input,
      };
      const result = await session.invoke("lab", params, labCliArguments(params));
      return { details: result, text: renderLabOutput(result) };
    },
  };
}

export type SharedLabTool = ReturnType<typeof createLabTool>;

function validateRequest(
  action: unknown,
  capability: unknown,
  reason: unknown,
  operation: unknown,
): void {
  if (capability === "working_state") throw new Error("Working state uses nmg_state");
  if (!actions.includes(String(action))) throw new Error(`Unsupported Lab action: ${action}`);
  if (action !== "list" && !capability) throw new Error(`${action} requires capability`);
  if (action === "enable" && !reason) throw new Error("enable requires reason");
  if (action === "invoke" && !operation) throw new Error("invoke requires operation");
}

function labCliArguments(params: Record<string, unknown>): string[] {
  const { action, capability, sessionId, requester, reason, ttlSeconds, operation, input } = params;
  const argv = ["lab", String(action)];
  if (capability) argv.push(String(capability));
  if (action !== "list") argv.push("--session-id", String(sessionId));
  if (action === "enable") {
    argv.push("--requester", String(requester), "--reason", String(reason));
    if (ttlSeconds != null) argv.push("--ttl-seconds", String(ttlSeconds));
  }
  if (action === "invoke") {
    argv.push("--operation", String(operation));
    if (input != null) argv.push("--input-json", JSON.stringify(input));
  }
  argv.push("--json");
  return argv;
}
