import type { MemoryContext, MemorySearchResult } from "../core/types.ts";

export const DEFAULT_LOGICAL_CHAIN_MAX_CHARS = 2_048;

export interface ProjectedLogicalChain {
  chainId: string;
  topic: string;
  memoryIds: string[];
  /** Compact Mermaid-compatible edge expressions using stable local labels. */
  lines: string[];
}

export interface LogicalChainProjection {
  labels: Map<string, string>;
  chains: ProjectedLogicalChain[];
  foldedChainCount: number;
  text: string;
}

export function logicalChainNames(result: MemorySearchResult): string[] {
  return [
    ...new Set(
      (result.chainMemberships ?? [])
        .filter((membership) => membership.chainType === "logical")
        .map((membership) => membership.topic ?? membership.chainId.slice(0, 8)),
    ),
  ];
}

export function logicalChainCount(context: MemoryContext): number {
  return new Set(
    context.results.flatMap((result) =>
      (result.chainMemberships ?? [])
        .filter((membership) => membership.chainType === "logical")
        .map((membership) => membership.chainId),
    ),
  ).size;
}

function memoryLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function compactEdgeLines(
  edges: Array<{ sourceMemoryId: string; targetMemoryId: string }>,
  labels: Map<string, string>,
): string[] {
  const unique = [
    ...new Map(
      edges.map((edge) => [`${edge.sourceMemoryId}\0${edge.targetMemoryId}`, edge]),
    ).values(),
  ];
  const grouped = (incoming: boolean): string[] => {
    const groups = new Map<string, Set<string>>();
    for (const edge of unique) {
      const key = incoming ? edge.targetMemoryId : edge.sourceMemoryId;
      const member = incoming ? edge.sourceMemoryId : edge.targetMemoryId;
      const members = groups.get(key) ?? new Set<string>();
      members.add(member);
      groups.set(key, members);
    }
    return [...groups.entries()].map(([key, members]) => {
      const keyLabel = labels.get(key)!;
      const memberLabels = [...members].map((id) => labels.get(id)!).join(" & ");
      return incoming ? `${memberLabels} --> ${keyLabel}` : `${keyLabel} --> ${memberLabels}`;
    });
  };
  const outgoing = grouped(false);
  const incoming = grouped(true);
  const cost = (lines: string[]): number => lines.reduce((sum, line) => sum + line.length + 1, 0);
  return cost(incoming) < cost(outgoing) ? incoming : outgoing;
}

/**
 * Host-neutral, budgeted projection of logical chain structure.
 *
 * Evidence statements remain outside this projection. Adapters render each
 * statement once, prefix it with the returned local label, then append `text`
 * (or consume `chains` as structured data).
 */
export function projectLogicalChains(
  context: MemoryContext,
  maxChars = DEFAULT_LOGICAL_CHAIN_MAX_CHARS,
): LogicalChainProjection {
  if (maxChars <= 0) return { labels: new Map(), chains: [], foldedChainCount: 0, text: "" };

  const available = new Set(context.results.map((result) => result.memory.id));
  const labels = new Map(
    context.results.map((result, index) => [result.memory.id, memoryLabel(index)]),
  );
  const groupedChains = new Map<
    string,
    { topic?: string; members: Array<{ memoryId: string; position: number }> }
  >();
  for (const result of context.results) {
    for (const membership of result.chainMemberships ?? []) {
      if (membership.chainType !== "logical") continue;
      const chain = groupedChains.get(membership.chainId) ?? {
        topic: membership.topic,
        members: [],
      };
      chain.members.push({ memoryId: result.memory.id, position: membership.position });
      if (!chain.topic && membership.topic) chain.topic = membership.topic;
      groupedChains.set(membership.chainId, chain);
    }
  }

  const blocks: Array<{ chain: ProjectedLogicalChain; text: string }> = [];
  for (const [chainId, chain] of groupedChains) {
    const members = [...chain.members].sort(
      (left, right) =>
        left.position - right.position || left.memoryId.localeCompare(right.memoryId),
    );
    const edges = (context.chainEdges ?? []).filter(
      (edge) =>
        edge.chainId === chainId &&
        available.has(edge.sourceMemoryId) &&
        available.has(edge.targetMemoryId),
    );
    const lines =
      edges.length > 0
        ? compactEdgeLines(edges, labels)
        : members.length > 1
          ? [members.map((member) => labels.get(member.memoryId)!).join(" --> ")]
          : [];
    if (lines.length === 0) continue;
    const topic = (chain.topic ?? chainId).replace(/[\r\n]+/gu, " ").trim();
    const projected = {
      chainId,
      topic,
      memoryIds: members.map((member) => member.memoryId),
      lines,
    };
    blocks.push({
      chain: projected,
      text: `[logical chain: ${topic}]\nflowchart LR\n${lines.map((line) => `  ${line}`).join("\n")}`,
    });
  }
  if (blocks.length === 0) {
    return { labels: new Map(), chains: [], foldedChainCount: 0, text: "" };
  }

  const open = "<nmg_logical_chains>";
  const close = "</nmg_logical_chains>";
  const folded = "[additional logical chains folded by structure budget]";
  const accepted: Array<{ chain: ProjectedLogicalChain; text: string }> = [];
  for (const block of blocks) {
    const candidate = [open, ...accepted.map((item) => item.text), block.text, close].join("\n");
    if (candidate.length <= maxChars) accepted.push(block);
  }
  if (accepted.length === 0) {
    return {
      labels: new Map(),
      chains: [],
      foldedChainCount: blocks.length,
      text: "",
    };
  }

  const foldedChainCount = blocks.length - accepted.length;
  let text = [open, ...accepted.map((item) => item.text), close].join("\n");
  if (foldedChainCount > 0) {
    const withFolded = [open, ...accepted.map((item) => item.text), folded, close].join("\n");
    if (withFolded.length <= maxChars) text = withFolded;
  }
  const usedMemoryIds = new Set(accepted.flatMap((item) => item.chain.memoryIds));
  return {
    labels: new Map([...labels].filter(([memoryId]) => usedMemoryIds.has(memoryId))),
    chains: accepted.map((item) => item.chain),
    foldedChainCount,
    text,
  };
}
