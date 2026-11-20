import type { MemoryContext, MemorySearchResult } from "../core/types.ts";
import { eventTimeMillis } from "../core/event-time.ts";

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

/** Present known times for the current evidence page in chronological order. */
export function projectTemporalChain(
  records: readonly Pick<MemorySearchResult["memory"], "id" | "eventTime">[],
): {
  labels: Map<string, string>;
  text: string;
} {
  const labels = new Map<string, string>();
  if (records.length === 1) {
    const value = records[0]!.eventTime;
    if (!value) return { labels, text: "" };
    const { time, milliseconds } = eventTimeLabel(value);
    return {
      labels,
      text: milliseconds === null ? `Unresolved event time: ${time}` : `time=${time}`,
    };
  }
  const groups = new Map<string, { time: string; milliseconds: number | null; labels: string[] }>();
  for (const [index, record] of records.entries()) {
    if (!record.eventTime) continue;
    const { time, milliseconds } = eventTimeLabel(record.eventTime);
    const group = groups.get(time) ?? { time, milliseconds, labels: [] };
    const label = memoryLabel(index);
    labels.set(record.id, label);
    group.labels.push(label);
    groups.set(time, group);
  }
  const ordered = [...groups.values()]
    .filter((group) => group.milliseconds !== null)
    .sort((a, b) => a.milliseconds! - b.milliseconds!);
  const unresolved = [...groups.values()].filter((group) => group.milliseconds === null);
  const line = (group: { time: string; labels: string[] }) =>
    `${group.time} ${group.labels.join(",")}`;
  if (ordered.length === 1 && unresolved.length === 0)
    return { labels, text: `time=${line(ordered[0]!)}` };
  const sections = [
    ordered.length ? ["Event time:", ...ordered.map(line)] : [],
    unresolved.length ? ["Unresolved event time by record:", ...unresolved.map(line)] : [],
  ];
  return { labels, text: sections.flat().join("\n") };
}

const STORED_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function eventTimeLabel(raw: string): { time: string; milliseconds: number | null } {
  const safe = raw.replace(/[\r\n]+/gu, " ").trim();
  // Older imported clocks include a redundant three-letter weekday.
  const legacy = /^(\d{4}\/\d{2}\/\d{2}) \(([A-Z][a-z]{2})\) (\d{2}:\d{2})$/u.exec(safe);
  if (legacy) {
    const time = `${legacy[1]!.replaceAll("/", "-")} ${legacy[3]}`;
    const milliseconds = eventTimeMillis(time);
    if (milliseconds !== null && STORED_WEEKDAYS[new Date(milliseconds).getUTCDay()] === legacy[2])
      return { time, milliseconds };
  }
  const milliseconds = eventTimeMillis(safe);
  if (milliseconds === null) return { time: safe, milliseconds };
  const time = safe
    .replace(/(\d{2}:\d{2}):00(?:\.0+)?(Z|[+-]\d{2}:?\d{2})$/u, "$1$2")
    .replace(/(\d{2}:\d{2}:\d{2})\.0+(Z|[+-]\d{2}:?\d{2})$/u, "$1$2");
  return { time, milliseconds };
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
