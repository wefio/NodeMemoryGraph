/** Offline estimate of provider prefix-cache potential inside NMG evidence text.
 *
 * Reads saved official search results only. It does not call an LLM or mutate
 * benchmark outputs. Reported recurring evidence is an upper bound: provider
 * prefix caches require those bytes to appear in the same leading order.
 */
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

function evidenceBlocks(context: string): string[] {
  const disclosureEnd = context.indexOf("id/node/type/truth/scope identify the record");
  const evidence = disclosureEnd >= 0 ? context.slice(disclosureEnd) : context;
  const first = evidence.search(/^\s*- /mu);
  if (first < 0) return [];
  return evidence
    .slice(first)
    .split(/\n(?=- )/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function groupsFor(suite: string, payload: Record<string, Row[]>): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  if (suite !== "personamem-v2") {
    for (const [key, rows] of Object.entries(payload)) groups.set(key, rows);
    return groups;
  }
  for (const rows of Object.values(payload)) {
    for (const row of rows) {
      const key = String(row.persona_id ?? row.user_id ?? "unknown");
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
  }
  return groups;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.round((ordered.length - 1) * fraction))]!;
}

function analyze(suite: string, path: string): Record<string, unknown> {
  const payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, Row[]>;
  const groups = groupsFor(suite, payload);
  const prefixes: number[] = [];
  const stableEvidencePrefixes: number[] = [];
  const contextLengths: number[] = [];
  let adjacentPairs = 0;
  let sameFirstBlock = 0;
  let groupedSameFirstBlock = 0;
  let repeatableFirstBlockRows = 0;
  let largestFirstBlockGroup = 0;
  let recurringBytes = 0;
  let evidenceBytes = 0;
  let rows = 0;

  for (const group of groups.values()) {
    const contexts = group.map((row) => String(row.search_context ?? row.context ?? ""));
    const blocks = contexts.map(evidenceBlocks);
    const stableEvidence = blocks.map((values) => [...values].sort().join("\n"));
    const frequency = new Map<string, number>();
    for (const values of blocks) {
      for (const value of new Set(values)) frequency.set(value, (frequency.get(value) ?? 0) + 1);
    }
    for (let index = 0; index < contexts.length; index += 1) {
      const context = contexts[index]!;
      contextLengths.push(context.length);
      rows += 1;
      for (const block of blocks[index]!) {
        evidenceBytes += block.length;
        if ((frequency.get(block) ?? 0) > 1) recurringBytes += block.length;
      }
      if (index === 0) continue;
      adjacentPairs += 1;
      prefixes.push(commonPrefixLength(contexts[index - 1]!, context));
      stableEvidencePrefixes.push(
        commonPrefixLength(stableEvidence[index - 1]!, stableEvidence[index]!),
      );
      if (blocks[index - 1]?.[0] && blocks[index - 1]![0] === blocks[index]?.[0]) {
        sameFirstBlock += 1;
      }
    }
    const firstBlocks = blocks.map((values) => values[0] ?? "");
    const firstFrequency = new Map<string, number>();
    for (const value of firstBlocks) {
      if (value) firstFrequency.set(value, (firstFrequency.get(value) ?? 0) + 1);
    }
    largestFirstBlockGroup = Math.max(largestFirstBlockGroup, ...firstFrequency.values(), 0);
    repeatableFirstBlockRows += firstBlocks.filter(
      (value) => value && (firstFrequency.get(value) ?? 0) > 1,
    ).length;
    const grouped = [...firstBlocks].sort();
    for (let index = 1; index < grouped.length; index += 1) {
      if (grouped[index] && grouped[index] === grouped[index - 1]) groupedSameFirstBlock += 1;
    }
  }

  const average = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    suite,
    groups: groups.size,
    rows,
    multiRowGroups: [...groups.values()].filter((group) => group.length > 1).length,
    contextChars: {
      average: Math.round(average(contextLengths)),
      p50: percentile(contextLengths, 0.5),
      p95: percentile(contextLengths, 0.95),
    },
    adjacentPrefixChars: {
      average: Math.round(average(prefixes)),
      p50: percentile(prefixes, 0.5),
      p95: percentile(prefixes, 0.95),
    },
    stableSortedEvidencePrefixChars: {
      average: Math.round(average(stableEvidencePrefixes)),
      p50: percentile(stableEvidencePrefixes, 0.5),
      p95: percentile(stableEvidencePrefixes, 0.95),
    },
    sameFirstEvidenceRate: adjacentPairs === 0 ? null : sameFirstBlock / adjacentPairs,
    groupedSameFirstEvidenceRate:
      adjacentPairs === 0 ? null : groupedSameFirstBlock / adjacentPairs,
    repeatableFirstEvidenceRowRate: rows === 0 ? null : repeatableFirstBlockRows / rows,
    largestFirstEvidenceGroup: largestFirstBlockGroup,
    recurringEvidenceByteRate: evidenceBytes === 0 ? null : recurringBytes / evidenceBytes,
  };
}

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0) {
  throw new Error("Usage: node context-prefix-potential.ts <suite> <search-results.json> [...]");
}
const results = [];
for (let index = 0; index < args.length; index += 2) {
  results.push(analyze(args[index]!, args[index + 1]!));
}
console.log(JSON.stringify(results, null, 2));
