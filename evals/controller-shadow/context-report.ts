import type { ContextDatasetRow, ContextSplit } from "./context-dataset.ts";

export interface ContextSplitSummary {
  /** Number of distinct independent source groups assigned to this split. */
  groups: number;
  /** Number of input rows assigned to this split (informational; rows within
   *  one source group are not independent samples). */
  rows: number;
  /** Per source group, the number of rows from that group. Keys are sorted so
   *  the serialized summary is deterministic across identical inputs. */
  rowsByGroup: Record<string, number>;
}

export interface ContextGroupSummary {
  splits: Record<ContextSplit, ContextSplitSummary>;
  /** Transparency-only notices; never an efficacy or activation gate. */
  warnings: string[];
}

const SPLIT_ORDER: readonly ContextSplit[] = ["train", "validation", "test"];
const MIN_INDEPENDENT_GROUPS = 5;

/** Independent-sample accounting over a built dataset.
 *
 * The honest statistical unit of a source-group-partitioned dataset is the
 * source group (a conversation/user), not the row: rows within one group share
 * the same conversation, style and evidence pool. This summarizer reports both
 * the group count and the row count per split so a large row count can never
 * mask a tiny number of independent units, and it rejects rows that would place
 * one source group across two splits (a leakage signal the caller should never
 * emit). Empty partitions are reported, not hidden.
 *
 * The `<5 independent groups` notice is a transparency hint about the weakness
 * of a generalization claim; it is deliberately not an efficacy or activation
 * gate and carries no pass/fail meaning.
 */
export function summarizeContextGroups(rows: readonly ContextDatasetRow[]): ContextGroupSummary {
  const groupSplit = new Map<string, ContextSplit>();
  const rowsBySplitGroup = new Map<ContextSplit, Map<string, number>>();
  for (const split of SPLIT_ORDER) rowsBySplitGroup.set(split, new Map());

  for (const row of rows) {
    const prior = groupSplit.get(row.groupId);
    if (prior !== undefined && prior !== row.split) {
      throw new Error(`source group "${row.groupId}" spans splits ${prior} and ${row.split}`);
    }
    groupSplit.set(row.groupId, row.split);
    const groupRows = rowsBySplitGroup.get(row.split)!;
    groupRows.set(row.groupId, (groupRows.get(row.groupId) ?? 0) + 1);
  }

  const warnings: string[] = [];
  const splits = {} as Record<ContextSplit, ContextSplitSummary>;
  for (const split of SPLIT_ORDER) {
    const groupRows = rowsBySplitGroup.get(split)!;
    // Sort for deterministic key insertion order in the serialized record.
    const groups = [...groupRows.keys()].sort();
    const rowsByGroup = Object.fromEntries(groups.map((group) => [group, groupRows.get(group)!]));
    const rowsTotal = Object.values(rowsByGroup).reduce((total, count) => total + count, 0);
    if (groups.length < MIN_INDEPENDENT_GROUPS) {
      warnings.push(
        `${split}: ${groups.length} independent source group(s) (<${MIN_INDEPENDENT_GROUPS}); ` +
          "row counts overstate the independent sample size - transparency only, " +
          "not an efficacy or activation gate",
      );
    }
    splits[split] = { groups: groups.length, rows: rowsTotal, rowsByGroup };
  }
  return { splits, warnings };
}
