import { coordinationNames } from "./coordination-events.ts";

export type AgentProcessingState = "busy" | "idle" | "unknown";
export interface AgentActivityReport {
  source: "agent" | "harness";
  state: AgentProcessingState;
  capabilities: string[];
  version: string;
  expiresAt: string;
}
export interface AgentSessionActivity {
  agentId: string;
  sessionId: string;
  state: AgentProcessingState;
  capabilities: string[];
  reports: AgentActivityReport[];
}
export interface AgentActivityInput {
  source: AgentActivityReport["source"];
  state: AgentProcessingState;
  capabilities?: string[];
  ttlSeconds: number;
  expectedVersion?: string;
}
export function parseAgentActivity(value: unknown): AgentActivityInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("activity must be an object");
  const data = value as Record<string, unknown>;
  if (!["busy", "idle", "unknown"].includes(String(data.state)))
    throw Error("Invalid agent processing state");
  if (data.source !== undefined && data.source !== "agent" && data.source !== "harness")
    throw Error("Invalid activity report source");
  const ttlSeconds = activityLifetime(data.ttlSeconds);
  if (data.expectedVersion !== undefined && typeof data.expectedVersion !== "string")
    throw Error("expectedVersion must be a string");
  return {
    source: (data.source ?? "agent") as AgentActivityInput["source"],
    state: data.state as AgentProcessingState,
    ttlSeconds: Number(ttlSeconds),
    ...(data.capabilities === undefined
      ? {}
      : { capabilities: coordinationNames(data.capabilities, "activity capabilities") }),
    ...(data.expectedVersion === undefined
      ? {}
      : { expectedVersion: data.expectedVersion as string }),
  };
}

export function projectAgentActivity(
  agentId: string,
  sessionId: string,
  reports: AgentActivityReport[],
): AgentSessionActivity {
  const states = new Set(reports.map((report) => report.state));
  return {
    agentId,
    sessionId,
    state: states.has("busy") ? "busy" : states.has("idle") ? "idle" : "unknown",
    capabilities: [...new Set(reports.flatMap((report) => report.capabilities))].sort(),
    reports,
  };
}

function activityLifetime(value: unknown): number {
  const ttlSeconds = value ?? 180;
  if (!Number.isSafeInteger(ttlSeconds) || Number(ttlSeconds) < 1 || Number(ttlSeconds) > 3600)
    throw Error("Activity ttlSeconds must be 1..3600");
  return Number(ttlSeconds);
}
