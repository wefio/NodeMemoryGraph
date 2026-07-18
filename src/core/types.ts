export type HistoryRole = "user" | "assistant" | "tool" | "system" | "explicit";

export interface HistoryRecord {
  id: string;
  sessionId: string | null;
  role: HistoryRole;
  content: string;
  sourceRef: string | null;
  createdAt: string;
}

export type MemoryNodeKind =
  | "concept"
  | "constraint"
  | "entity"
  | "preference"
  | "procedure"
  | "project"
  | "state"
  | "strategy"
  | "topic";

export interface MemoryNode {
  id: string;
  canonicalName: string;
  kind: MemoryNodeKind;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export type MemoryTier = 0 | 1 | 2 | 3;

export interface MemoryRecord {
  id: string;
  nodeId: string;
  evidenceId: string;
  statement: string;
  tier: MemoryTier;
  importance: number;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
}

export interface RememberInput {
  statement: string;
  nodeName: string;
  nodeKind?: MemoryNodeKind;
  evidence?: string;
  sessionId?: string;
  sourceRef?: string;
  tier?: MemoryTier;
  importance?: number;
}

export interface RememberResult {
  history: HistoryRecord;
  node: MemoryNode;
  memory: MemoryRecord;
}

export interface SearchOptions {
  nodeName?: string;
  maxTier?: MemoryTier;
  limit?: number;
}

export interface MemorySearchResult {
  memory: MemoryRecord;
  node: MemoryNode;
  evidence: HistoryRecord;
  lexicalScore: number;
}

