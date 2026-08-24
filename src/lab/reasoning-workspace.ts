import { randomUUID } from "node:crypto";

export const REASONING_NODE_KINDS = [
  "goal",
  "observation",
  "hypothesis",
  "evidence",
  "conclusion",
  "decision",
  "open_question",
  "next_action",
] as const;

export type ReasoningNodeKind = (typeof REASONING_NODE_KINDS)[number];

export const REASONING_STATUSES = [
  "active",
  "supported",
  "rejected",
  "resolved",
  "superseded",
] as const;

export type ReasoningStatus = (typeof REASONING_STATUSES)[number];

export type ReasoningSupportState = "referenced" | "linked" | "unsupported";

export const REASONING_EDGE_KINDS = [
  "supports",
  "contradicts",
  "derived_from",
  "tests",
  "rejects",
  "depends_on",
  "next_step",
] as const;

export type ReasoningEdgeKind = (typeof REASONING_EDGE_KINDS)[number];

export interface ReasoningNode {
  id: string;
  kind: ReasoningNodeKind;
  content: string;
  status: ReasoningStatus;
  importance: number;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReasoningEdge {
  sourceId: string;
  targetId: string;
  type: ReasoningEdgeKind;
  createdAt: string;
}

export interface ReasoningWorkspaceState {
  version: 1;
  sessionId: string;
  nodes: ReasoningNode[];
  edges: ReasoningEdge[];
  updatedAt: string;
}

export interface ReasoningCheckpoint {
  sessionId: string;
  generatedAt: string;
  nodes: ReasoningNode[];
  edges: ReasoningEdge[];
  omittedNodes: number;
  text: string;
}

export interface AddReasoningNodeInput {
  kind: ReasoningNodeKind;
  content: string;
  status?: ReasoningStatus;
  importance?: number;
  evidenceRefs?: string[];
}

const KIND_PRIORITY: Record<ReasoningNodeKind, number> = {
  goal: 8,
  decision: 7,
  conclusion: 6,
  next_action: 5,
  open_question: 4,
  hypothesis: 3,
  evidence: 2,
  observation: 1,
};

const STATUS_PRIORITY: Record<ReasoningStatus, number> = {
  active: 5,
  supported: 4,
  rejected: 3,
  resolved: 2,
  superseded: 1,
};

function clampImportance(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function compactContent(content: string, maxLength = 320): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export class ReasoningWorkspace {
  readonly sessionId: string;
  private readonly nodes = new Map<string, ReasoningNode>();
  private readonly edges = new Map<string, ReasoningEdge>();
  private updatedAt: string;

  constructor(sessionId: string, state?: ReasoningWorkspaceState) {
    if (!sessionId.trim()) throw new Error("ReasoningWorkspace requires a session ID");
    if (state && state.sessionId !== sessionId) {
      throw new Error("ReasoningWorkspace state belongs to a different session");
    }
    this.sessionId = sessionId;
    this.updatedAt = state?.updatedAt ?? new Date().toISOString();
    for (const node of state?.nodes ?? []) this.nodes.set(node.id, structuredClone(node));
    for (const edge of state?.edges ?? [])
      this.edges.set(this.edgeKey(edge), structuredClone(edge));
  }

  addNode(input: AddReasoningNodeInput): ReasoningNode {
    const content = compactContent(input.content, 4_000);
    if (!content) throw new Error("Reasoning node content cannot be empty");
    const now = new Date().toISOString();
    const node: ReasoningNode = {
      id: `reason_${randomUUID()}`,
      kind: input.kind,
      content,
      status: input.status ?? "active",
      importance: clampImportance(input.importance),
      evidenceRefs: normalizeEvidenceRefs(input.evidenceRefs ?? []),
      createdAt: now,
      updatedAt: now,
    };
    this.nodes.set(node.id, node);
    try {
      this.assertNodeSupport(node);
    } catch (error) {
      this.nodes.delete(node.id);
      throw error;
    }
    this.updatedAt = now;
    return structuredClone(node);
  }

  updateNode(
    id: string,
    update: {
      content?: string;
      status?: ReasoningStatus;
      importance?: number;
      evidenceRefs?: string[];
    },
  ): ReasoningNode {
    const current = this.nodes.get(id);
    if (!current) throw new Error(`Unknown reasoning node: ${id}`);
    const content =
      update.content === undefined ? current.content : compactContent(update.content, 4_000);
    if (!content) throw new Error("Reasoning node content cannot be empty");
    const now = new Date().toISOString();
    const next: ReasoningNode = {
      ...current,
      content,
      status: update.status ?? current.status,
      importance:
        update.importance === undefined ? current.importance : clampImportance(update.importance),
      evidenceRefs:
        update.evidenceRefs === undefined
          ? current.evidenceRefs
          : normalizeEvidenceRefs(update.evidenceRefs),
      updatedAt: now,
    };
    this.nodes.set(id, next);
    try {
      this.assertNodeSupport(next);
      const lostAnchors = [...this.nodes.values()].filter(
        (node) =>
          node.status === "supported" &&
          this.supportState(node.id) === "unsupported" &&
          this.supportState(node.id, new Map([[id, current]])) !== "unsupported",
      );
      if (lostAnchors.length > 0) {
        throw new Error(
          `Reasoning update would remove support from: ${lostAnchors.map((node) => node.id).join(", ")}`,
        );
      }
    } catch (error) {
      this.nodes.set(id, current);
      throw error;
    }
    this.updatedAt = now;
    return structuredClone(next);
  }

  link(sourceId: string, targetId: string, type: ReasoningEdgeKind): ReasoningEdge {
    if (!this.nodes.has(sourceId)) throw new Error(`Unknown reasoning node: ${sourceId}`);
    if (!this.nodes.has(targetId)) throw new Error(`Unknown reasoning node: ${targetId}`);
    if (sourceId === targetId) throw new Error("A reasoning node cannot link to itself");
    const edge: ReasoningEdge = {
      sourceId,
      targetId,
      type,
      createdAt: new Date().toISOString(),
    };
    const key = this.edgeKey(edge);
    const existing = this.edges.get(key);
    if (existing) return structuredClone(existing);
    this.edges.set(key, edge);
    this.updatedAt = edge.createdAt;
    return structuredClone(edge);
  }

  checkpoint(options: { maxNodes?: number; maxChars?: number } = {}): ReasoningCheckpoint {
    const maxNodes = Math.max(1, Math.floor(options.maxNodes ?? 24));
    const maxChars = Math.max(256, Math.floor(options.maxChars ?? 6_000));
    const ranked = [...this.nodes.values()].sort((left, right) => {
      const score = (node: ReasoningNode) =>
        STATUS_PRIORITY[node.status] * 100 + KIND_PRIORITY[node.kind] * 10 + node.importance;
      return score(right) - score(left) || right.updatedAt.localeCompare(left.updatedAt);
    });
    const selected = ranked.slice(0, maxNodes);
    const selectedIds = new Set(selected.map((node) => node.id));
    const selectedEdges = [...this.edges.values()].filter(
      (edge) => selectedIds.has(edge.sourceId) && selectedIds.has(edge.targetId),
    );

    const header = `Reasoning checkpoint for session ${this.sessionId}. Treat as an auditable scratchpad, not verified fact.`;
    const lines = [header];
    const includedNodes: ReasoningNode[] = [];
    for (const node of selected) {
      const support = this.supportState(node.id);
      const line =
        `[${node.id}] ${node.kind}/${node.status}/support=${support}/i=${node.importance.toFixed(2)}: ` +
        compactContent(node.content);
      if (lines.join("\n").length + line.length + 1 > maxChars) break;
      lines.push(line);
      includedNodes.push(structuredClone(node));
    }

    const includedIds = new Set(includedNodes.map((node) => node.id));
    const includedEdges: ReasoningEdge[] = [];
    for (const edge of selectedEdges) {
      if (!includedIds.has(edge.sourceId) || !includedIds.has(edge.targetId)) continue;
      const line = `${edge.sourceId} -[${edge.type}]-> ${edge.targetId}`;
      if (lines.join("\n").length + line.length + 1 > maxChars) break;
      lines.push(line);
      includedEdges.push(structuredClone(edge));
    }

    return {
      sessionId: this.sessionId,
      generatedAt: new Date().toISOString(),
      nodes: includedNodes,
      edges: includedEdges,
      omittedNodes: this.nodes.size - includedNodes.length,
      text: lines.join("\n"),
    };
  }

  consolidationCandidates(minImportance = 0.8): ReasoningNode[] {
    return [...this.nodes.values()]
      .filter(
        (node) =>
          (node.kind === "conclusion" || node.kind === "decision") &&
          node.status === "supported" &&
          node.importance >= minImportance &&
          this.supportState(node.id) !== "unsupported",
      )
      .map((node) => structuredClone(node));
  }

  /**
   * Resolve whether a scratch node is anchored in an external stable reference.
   * A relation is support only when its source is itself anchored; graph cycles
   * cannot manufacture evidence by pointing at each other.
   */
  supportState(
    nodeId: string,
    nodeOverrides: ReadonlyMap<string, ReasoningNode> = new Map(),
  ): ReasoningSupportState {
    const node = nodeOverrides.get(nodeId) ?? this.nodes.get(nodeId);
    if (!node) throw new Error(`Unknown reasoning node: ${nodeId}`);
    if (node.evidenceRefs.length > 0) return "referenced";

    const anchored = new Set<string>();
    for (const candidate of this.nodes.values()) {
      const effective = nodeOverrides.get(candidate.id) ?? candidate;
      if (effective.evidenceRefs.length > 0) anchored.add(effective.id);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of this.edges.values()) {
        if (
          (edge.type === "supports" || edge.type === "derived_from") &&
          anchored.has(edge.sourceId) &&
          !anchored.has(edge.targetId)
        ) {
          anchored.add(edge.targetId);
          changed = true;
        }
      }
    }
    return anchored.has(nodeId) ? "linked" : "unsupported";
  }

  toJSON(): ReasoningWorkspaceState {
    return {
      version: 1,
      sessionId: this.sessionId,
      nodes: [...this.nodes.values()].map((node) => structuredClone(node)),
      edges: [...this.edges.values()].map((edge) => structuredClone(edge)),
      updatedAt: this.updatedAt,
    };
  }

  static fromJSON(state: ReasoningWorkspaceState): ReasoningWorkspace {
    if (state.version !== 1) throw new Error(`Unsupported reasoning workspace version`);
    return new ReasoningWorkspace(state.sessionId, state);
  }

  private edgeKey(edge: Pick<ReasoningEdge, "sourceId" | "targetId" | "type">): string {
    return `${edge.sourceId}\u0000${edge.type}\u0000${edge.targetId}`;
  }

  private assertNodeSupport(node: ReasoningNode): void {
    if (node.kind === "evidence" && node.evidenceRefs.length === 0) {
      throw new Error("Reasoning evidence nodes require at least one stable evidence reference");
    }
    if (node.status === "supported" && this.supportState(node.id) === "unsupported") {
      throw new Error(
        "A supported reasoning node requires a stable evidence reference or an anchored supports/derived_from path",
      );
    }
  }
}

function normalizeEvidenceRefs(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
