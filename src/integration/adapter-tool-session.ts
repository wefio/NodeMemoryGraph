import type { NmgMethod } from "../cli/protocol.ts";
import type { MemoryContext } from "../core/types.ts";
import type { AgentAttributionFlow } from "./agent-attribution.ts";
import type { SessionRecallFlow } from "./session-recall-flow.ts";

export interface StateToolIdentity {
  id: string;
  agentName: string;
  saveName?: (name: string) => void;
}

export interface EvidenceLookup {
  memoryIds: string[];
  activeGraphId?: string;
}

export interface AdapterToolSession {
  sessionId: string;
  requester: string;
  invoke(
    method: NmgMethod,
    params: Record<string, unknown>,
    cliFallback?: string[],
  ): Promise<unknown>;
  boardIdentity?: () => StateToolIdentity | Promise<StateToolIdentity>;
  boardReads?: "receipt" | "project";
  legacyBoardVerbs?: boolean;
  invalidateRecallGate?: () => void;
  memory?: {
    projectDir?: string;
    recallFlow?: SessionRecallFlow;
    attribution?: AgentAttributionFlow;
    retryForeignGraph?: boolean;
    onEvidenceLookup?: (request: EvidenceLookup, result: MemoryContext) => void | Promise<void>;
    onEvidenceDisclosed?: (request: EvidenceLookup, result: MemoryContext) => void | Promise<void>;
  };
}
