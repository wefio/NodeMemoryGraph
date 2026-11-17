import { loadPrompts } from "../prompts/load.ts";
import {
  REASONING_EDGE_KINDS,
  REASONING_NODE_KINDS,
  REASONING_STATUSES,
} from "../lab/reasoning-workspace.ts";
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

const reasonOperations = {
  add: {
    required: ["kind", "content"],
    fields: ["kind", "content", "status", "importance", "evidenceRefs"],
  },
  update: {
    required: ["nodeId"],
    fields: ["nodeId", "content", "status", "importance", "evidenceRefs"],
  },
  link: { required: ["sourceId", "targetId", "relation"], fields: ["sourceId", "targetId"] },
  checkpoint: { required: [], fields: [] },
  clear: { required: [], fields: [] },
} as const;
type ReasonOperation = keyof typeof reasonOperations;

export function createReasonTool() {
  const prompts = loadPrompts();
  return {
    name: "nmg_reason" as const,
    requiresNativeSession: false,
    label: "NMG Reasoning Scratchpad",
    description: prompts.reason_description,
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          ...string,
          enum: Object.keys(reasonOperations),
          description: prompts.reason_action_parameter_description,
        },
        nodeId: { ...string, description: prompts.reason_node_id_parameter_description },
        kind: {
          ...string,
          enum: [...REASONING_NODE_KINDS],
          description: prompts.reason_kind_parameter_description,
        },
        content: { ...string, description: prompts.reason_content_parameter_description },
        status: {
          ...string,
          enum: [...REASONING_STATUSES],
          description: prompts.reason_status_parameter_description,
        },
        importance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: prompts.reason_importance_parameter_description,
        },
        evidenceRefs: {
          type: "array",
          items: string,
          description: prompts.reason_evidence_refs_parameter_description,
        },
        sourceId: { ...string, description: prompts.reason_source_id_parameter_description },
        targetId: { ...string, description: prompts.reason_target_id_parameter_description },
        relation: {
          ...string,
          enum: [...REASONING_EDGE_KINDS],
          description: prompts.reason_relation_parameter_description,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, session: AdapterToolSession) {
      if (typeof args.action !== "string" || !Object.hasOwn(reasonOperations, args.action))
        throw new Error("nmg_reason requires a supported action.");
      const operation = args.action as ReasonOperation;
      const shape = reasonOperations[operation];
      for (const key of shape.required) {
        const value = args[key];
        if (typeof value !== "string" || !value.trim())
          throw new Error(`nmg_reason ${operation} requires ${key}.`);
      }
      const input = Object.fromEntries(shape.fields.map((key) => [key, args[key]]));
      if (operation === "link") input.type = args.relation;
      return invokeReasoningWorkspace(session, operation, input);
    },
  };
}

export type SharedReasonTool = ReturnType<typeof createReasonTool>;

async function invokeReasoningWorkspace(
  session: AdapterToolSession,
  operation: ReasonOperation,
  input: Record<string, unknown>,
) {
  const invoke = (request: Record<string, unknown>) => {
    const params = { capability: "reasoning_workspace", sessionId: session.sessionId, ...request };
    return session.invoke("lab", params, labCliArguments(params));
  };
  const status = (await invoke({ action: "status" })) as { activation?: unknown };
  if (!status.activation)
    await invoke({
      action: "enable",
      scope: "session",
      requester: session.requester,
      reason: "nmg_reason requested a session scratchpad",
    });
  const invoked = await invoke({ action: "invoke", operation, input });
  if (operation === "clear") return { details: invoked, text: "Reasoning scratchpad cleared." };
  const checkpoint =
    operation === "checkpoint"
      ? invoked
      : await invoke({
          action: "invoke",
          operation: "checkpoint",
        });
  return { details: { invoked, checkpoint }, text: JSON.stringify(checkpoint, null, 2) };
}

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
