export type HistoryRole =
  | "user"
  | "assistant"
  | "tool"
  | "system"
  | "explicit"
  | "session";

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
export type MemoryType =
  | "constraint"
  | "conversation_evidence"
  | "derived"
  | "event"
  | "fact"
  | "preference"
  | "state"
  | "strategy";
export type MemoryActor = "assistant" | "system" | "tool" | "user";
export type TruthStatus = "asserted" | "inferred" | "unverified" | "verified";
export type MemoryStatus = "active" | "disputed" | "inactive" | "superseded";
export type EvidenceRole =
  | "contradict"
  | "example"
  | "exception"
  | "origin"
  | "support"
  | "update";
export type MemoryScope = Record<string, string>;
export type NodeRelationType =
  | "applies_to"
  | "causes"
  | "contradicts"
  | "depends_on"
  | "derived_from"
  | "exception_to"
  | "is_a"
  | "part_of"
  | "related_to"
  | "supports"
  | "supersedes";

export interface NodeRelation {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: NodeRelationType;
  evidenceIds: string[];
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  nodeId: string;
  evidenceId: string;
  evidenceIds: string[];
  statement: string;
  memoryType: MemoryType;
  stateKey: string | null;
  eventTime: string | null;
  sourceActor: MemoryActor;
  truthStatus: TruthStatus;
  scope: MemoryScope;
  validFrom: string | null;
  validUntil: string | null;
  status: MemoryStatus;
  evidenceRole: EvidenceRole;
  supersedesId: string | null;
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
  memoryType?: MemoryType;
  stateKey?: string;
  eventTime?: string;
  sourceActor?: MemoryActor;
  truthStatus?: TruthStatus;
  evidence?: string;
  sessionId?: string;
  sourceRef?: string;
  tier?: MemoryTier;
  importance?: number;
  scope?: MemoryScope;
  validFrom?: string;
  validUntil?: string;
  evidenceRole?: EvidenceRole;
  supersedesId?: string;
}

export interface RememberResult {
  history: HistoryRecord;
  node: MemoryNode;
  memory: MemoryRecord;
}

export interface SearchOptions {
  nodeName?: string;
  scope?: MemoryScope;
  includeHistorical?: boolean;
  maxTier?: MemoryTier;
  limit?: number;
  graphHops?: number;
}

export interface SessionArchive {
  sessionId: string;
  historyId: string;
  createdAt: string;
}

export interface MemorySearchResult {
  memory: MemoryRecord;
  node: MemoryNode;
  evidence: HistoryRecord;
  evidenceRecords: HistoryRecord[];
  lexicalScore: number;
}

export interface DeriveMemoryInput extends Omit<RememberInput, "evidence"> {
  sourceMemoryIds: string[];
  derivation: string;
}

export interface MemoryContext {
  results: MemorySearchResult[];
  relations: NodeRelation[];
}
