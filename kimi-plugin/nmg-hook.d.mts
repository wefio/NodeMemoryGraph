interface HookPayload {
  session_id?: string;
  sessionId?: string;
}

interface WakeEntry {
  sourceSessionId?: string | null;
  agentId?: string | null;
  claimExpiresAt?: string | null;
  to?: string | null;
  serialState?: string | null;
  status?: string;
  kind: string;
  content?: string;
}

export function isBoardWakeCandidate(
  entry: WakeEntry,
  identity: { sessionId: string; agentId: string; now?: number },
): boolean;

export function kimiAgentIdentity(
  payload: HookPayload,
  environment?: NodeJS.ProcessEnv,
): { sessionId: string; agentId: string; capabilities: string | undefined };

export function reportAgentPresence(
  payload: HookPayload,
  options?: {
    dataDir?: string;
    lease?: { host: string; port: number; token: string; pid?: number } | null;
    environment?: NodeJS.ProcessEnv;
    rpc?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  },
): Promise<boolean>;
