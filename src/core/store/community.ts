/**
 * Community / subgraph pattern suggestions (docs §7.5, implementation step 3).
 *
 * Given the consolidated relation graph, this module finds weakly-connected
 * communities (node clusters), profiles each community's structural patterns
 * (reusing the analogy pattern shapes: evolution / contradiction / dependency
 * / feedback / aggregation), and emits NATURAL-SUPERVISION CANDIDATE
 * suggestions — e.g. "this community holds a supersede evolution chain,
 * consider creating a temporal chain over it after confirmation".
 *
 * Red line: the output is purely advisory. It never writes memory, relations,
 * chains, or markers. A downstream agent / human decides whether to act.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Constructor } from "./store-ctor.ts";
import { detectPatternCounts, type StructurePattern, type RelRow, type SupRow } from "./analogy.ts";

export type SubgraphSuggestionKind =
  | "EVOLUTION_CHAIN"
  | "CONTRADICTION_PAIR"
  | "FEEDBACK_REVIEW"
  | "DEPENDENCY_CHAIN"
  | "AGGREGATION_STRUCTURE";

export interface SubgraphSuggestion {
  kind: SubgraphSuggestionKind;
  evidence: string;
  suggestedAction: string;
}

export interface CommunityAnalysis {
  communityId: number;
  nodeIds: string[];
  memberCount: number;
  patternCounts: Record<StructurePattern, number>;
  suggestions: SubgraphSuggestion[];
}

const SUGGESTION_ACTIONS: Record<SubgraphSuggestionKind, string> = {
  EVOLUTION_CHAIN: "确认后创建时间链覆盖该演进序列（自然监督素材）",
  CONTRADICTION_PAIR: "确认矛盾语义是否准确（contradicts 双向为正常语义）",
  FEEDBACK_REVIEW: "人工确认：反馈回路 vs 数据异常（配合 detectGraphCycles 环诊断）",
  DEPENDENCY_CHAIN: "确认依赖/因果链完整性（是否缺中间节点）",
  AGGREGATION_STRUCTURE: "确认聚合结构（is_a / part_of 是否完整）",
};

function suggestPatternActions(counts: Record<StructurePattern, number>): SubgraphSuggestion[] {
  const suggestions: SubgraphSuggestion[] = [];
  const push = (kind: SubgraphSuggestionKind, evidence: string) => {
    suggestions.push({ kind, evidence, suggestedAction: SUGGESTION_ACTIONS[kind] });
  };
  if (counts.EVOLUTION > 0) {
    push("EVOLUTION_CHAIN", `${counts.EVOLUTION} 条 supersede 演进边`);
  }
  if (counts.CONTRADICTION > 0) {
    push("CONTRADICTION_PAIR", `${counts.CONTRADICTION} 个矛盾对`);
  }
  if (counts.FEEDBACK > 0) {
    push("FEEDBACK_REVIEW", `${counts.FEEDBACK} 个有向反馈环`);
  }
  if (counts.DEPENDENCY > 0) {
    push("DEPENDENCY_CHAIN", `${counts.DEPENDENCY} 条依赖/因果边`);
  }
  if (counts.AGGREGATION > 0) {
    push("AGGREGATION_STRUCTURE", `${counts.AGGREGATION} 条聚合/包含边`);
  }
  return suggestions;
}

export function withCommunity<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    declare protected db: DatabaseSync;

    /**
     * Weakly-connected communities over consolidated relations
     * (docs §7.5). Linear in nodes+edges; advisory grouping only.
     */
    detectCommunities(opts?: { minMembers?: number }): string[][] {
      const minMembers = opts?.minMembers ?? 2;
      const edges = this.db
        .prepare(
          `SELECT source_node_id, target_node_id FROM node_relations
           WHERE status = 'consolidated'`,
        )
        .all() as unknown as Array<{ source_node_id: string; target_node_id: string }>;
      const adj = new Map<string, string[]>();
      for (const e of edges) {
        const a = String(e.source_node_id);
        const b = String(e.target_node_id);
        const la = adj.get(a);
        if (la) la.push(b);
        else adj.set(a, [b]);
        const lb = adj.get(b);
        if (lb) lb.push(a);
        else adj.set(b, [a]);
      }
      const visited = new Set<string>();
      const communities: string[][] = [];
      for (const start of adj.keys()) {
        if (visited.has(start)) continue;
        const component: string[] = [];
        const stack = [start];
        visited.add(start);
        while (stack.length > 0) {
          const cur = stack.pop()!;
          component.push(cur);
          for (const nb of adj.get(cur) ?? []) {
            if (!visited.has(nb)) {
              visited.add(nb);
              stack.push(nb);
            }
          }
        }
        if (component.length >= minMembers) communities.push(component);
      }
      return communities;
    }

    /**
     * Community discovery + subgraph pattern profiling → natural-supervision
     * candidate suggestions (docs §7.5). Read-only; advisory only.
     */
    analyzeCommunities(opts?: { minMembers?: number }): CommunityAnalysis[] {
      const communities = this.detectCommunities(opts);
      const relations = this.db
        .prepare(
          `SELECT source_node_id, target_node_id, relation_type, direction
           FROM node_relations WHERE status = 'consolidated'`,
        )
        .all() as unknown as RelRow[];
      const supersedes = this.db
        .prepare(
          `SELECT id, node_id, supersedes_id FROM memory_records
           WHERE supersedes_id IS NOT NULL`,
        )
        .all() as unknown as SupRow[];
      return communities.map((nodeIds, i) => {
        const nodeSet = new Set(nodeIds);
        const patternCounts = detectPatternCounts(relations, supersedes, nodeSet);
        const suggestions = suggestPatternActions(patternCounts);
        return {
          communityId: i,
          nodeIds,
          memberCount: nodeIds.length,
          patternCounts,
          suggestions,
        };
      });
    }
  };
}
