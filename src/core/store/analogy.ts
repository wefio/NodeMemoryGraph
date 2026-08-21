/**
 * Cross-domain analogy — the curiosity / knowledge-expansion channel
 * (docs §7.4). Given a subgraph (a domain cluster), this module abstracts its
 * STRUCTURE (which pattern shapes appear: evolution / contradiction /
 * dependency / feedback / aggregation) and finds other, semantically
 * unrelated subgraphs that share the same structural signature.
 *
 * The output is purely advisory: an independent exploration channel that
 * never touches retrieval ranking and never writes memory / relations /
 * chains. "Many ideas recur across domains" — the point is to surface
 * abstract pattern matches (e.g. a budget's evolution ≙ a tech-stack's
 * evolution) for a downstream agent to decide whether to explore.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Constructor } from "./store-ctor.ts";

export type StructurePattern =
  "EVOLUTION" | "CONTRADICTION" | "DEPENDENCY" | "FEEDBACK" | "AGGREGATION";

export const STRUCTURE_PATTERNS: readonly StructurePattern[] = [
  "EVOLUTION",
  "CONTRADICTION",
  "DEPENDENCY",
  "FEEDBACK",
  "AGGREGATION",
];

export interface StructuralSignature {
  nodeIds: string[];
  patternCounts: Record<StructurePattern, number>;
  patternTypes: StructurePattern[];
}

export interface StructuralAnalogy {
  targetNodeId: string;
  targetNodeName: string;
  score: number;
  sharedPatterns: StructurePattern[];
  targetSignature: StructuralSignature;
}

const DEPENDENCY_RELATIONS = new Set(["depends_on", "causes"]);
const AGGREGATION_RELATIONS = new Set(["is_a", "part_of"]);
// Directed semantic relations that can form a feedback loop (symmetric types
// like contradicts/same_as are excluded — they are not feedback).
const DIRECTED_RELATIONS = new Set([
  "applies_to",
  "causes",
  "depends_on",
  "derived_from",
  "exception_to",
  "is_a",
  "part_of",
  "refines",
]);

export interface RelRow {
  source_node_id: string;
  target_node_id: string;
  relation_type: string;
  direction: string;
}
export interface SupRow {
  id: string;
  node_id: string;
  supersedes_id: string;
}

export function detectPatternCounts(
  relations: RelRow[],
  supersedes: SupRow[],
  nodeSet: Set<string>,
): Record<StructurePattern, number> {
  const counts: Record<StructurePattern, number> = {
    EVOLUTION: 0,
    CONTRADICTION: 0,
    DEPENDENCY: 0,
    FEEDBACK: 0,
    AGGREGATION: 0,
  };
  const contradictionPairs = new Set<string>();
  const directed: Array<[string, string]> = [];
  for (const r of relations) {
    if (!nodeSet.has(String(r.source_node_id)) || !nodeSet.has(String(r.target_node_id))) {
      continue;
    }
    const a = String(r.source_node_id);
    const b = String(r.target_node_id);
    const t = String(r.relation_type);
    const dir = String(r.direction);
    if (t === "contradicts") {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      contradictionPairs.add(key);
      continue;
    }
    if (DEPENDENCY_RELATIONS.has(t)) counts.DEPENDENCY += 1;
    if (AGGREGATION_RELATIONS.has(t)) counts.AGGREGATION += 1;
    if (DIRECTED_RELATIONS.has(t)) {
      if (dir === "source->target") directed.push([a, b]);
      else if (dir === "target->source") directed.push([b, a]);
      else {
        directed.push([a, b]);
        directed.push([b, a]);
      }
    }
  }
  counts.CONTRADICTION = contradictionPairs.size;
  for (const s of supersedes) {
    // Same-node supersede chain = value/decision evolution over time.
    if (nodeSet.has(String(s.node_id))) counts.EVOLUTION += 1;
  }
  counts.FEEDBACK = countDirectedCycles(directed);
  return counts;
}

/** Elementary-cycle count on a small directed graph (subgraph scale). */
function countDirectedCycles(edges: Array<[string, string]>): number {
  const adj = new Map<string, string[]>();
  for (const [a, b] of edges) {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  }
  const seen = new Set<string>();
  let cycles = 0;
  for (const start of adj.keys()) {
    const visited = new Set<string>();
    const dfs = (cur: string, path: string[], onPath: Set<string>): void => {
      for (const m of adj.get(cur) ?? []) {
        if (onPath.has(m)) {
          const idx = path.indexOf(m);
          const cycle = path.slice(idx).concat(m);
          // Dedupe members before sorting so both rotations of the same
          // elementary cycle map to one key (the closing repeat is dropped).
          const key = [...new Set(cycle)].sort().join("|");
          if (!seen.has(key)) {
            seen.add(key);
            cycles += 1;
          }
        } else if (!visited.has(m)) {
          visited.add(m);
          path.push(m);
          onPath.add(m);
          dfs(m, path, onPath);
          path.pop();
          onPath.delete(m);
        }
      }
    };
    visited.add(start);
    dfs(start, [start], new Set([start]));
  }
  return cycles;
}

function patternJaccard(a: StructuralSignature, b: StructuralSignature): number {
  const union = new Set<string>([...a.patternTypes, ...b.patternTypes]);
  if (union.size === 0) return 0;
  const inter = a.patternTypes.filter((p) => b.patternTypes.includes(p)).length;
  return inter / union.size;
}

export function withAnalogy<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    declare protected db: DatabaseSync;

    /**
     * Structure abstraction (docs §7.4, layer 1): reduce a subgraph to its
     * structural signature — which pattern shapes are present and how often.
     * Semantics (names, statements) are deliberately ignored.
     */
    abstractSubgraph(nodeIds: string[]): StructuralSignature {
      const ids = [...new Set(nodeIds.filter((id) => !!id))];
      const nodeSet = new Set(ids);
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
      const patternCounts = detectPatternCounts(relations, supersedes, nodeSet);
      const patternTypes = STRUCTURE_PATTERNS.filter((p) => patternCounts[p] > 0);
      return { nodeIds: ids, patternCounts, patternTypes };
    }

    /**
     * Cross-domain analogy search (docs §7.4, layers 2-3): find other,
     * semantically unrelated subgraphs whose structural signature overlaps
     * the query cluster's. Advisory only — callers decide whether to explore.
     */
    findStructuralAnalogies(
      queryNodeIds: string[],
      opts?: { maxCandidates?: number; hops?: number },
    ): StructuralAnalogy[] {
      const maxCandidates = opts?.maxCandidates ?? 5;
      const hops = opts?.hops ?? 1;
      const querySet = new Set(queryNodeIds);
      const querySig = this.abstractSubgraph(queryNodeIds);
      if (querySig.patternTypes.length === 0) return [];

      // Skip nodes directly related to the query cluster — cross-domain means
      // the target should not already be adjacent (that would be same-domain).
      const related = new Set<string>();
      const relRows = this.db
        .prepare(
          `SELECT source_node_id, target_node_id FROM node_relations
           WHERE status = 'consolidated'`,
        )
        .all() as unknown as Array<{ source_node_id: string; target_node_id: string }>;
      for (const r of relRows) {
        if (querySet.has(String(r.source_node_id))) related.add(String(r.target_node_id));
        if (querySet.has(String(r.target_node_id))) related.add(String(r.source_node_id));
      }

      const allNodes = this.db
        .prepare(`SELECT id, canonical_name FROM memory_nodes`)
        .all() as unknown as Array<{ id: string; canonical_name: string }>;
      const candidates: StructuralAnalogy[] = [];
      for (const node of allNodes) {
        const id = String(node.id);
        if (querySet.has(id) || related.has(id)) continue;
        const ego = this.egoSubgraphIds(id, hops);
        const sig = this.abstractSubgraph(ego);
        if (sig.patternTypes.length === 0) continue;
        const score = patternJaccard(querySig, sig);
        if (score <= 0) continue;
        candidates.push({
          targetNodeId: id,
          targetNodeName: String(node.canonical_name),
          score,
          sharedPatterns: sig.patternTypes.filter((p) => querySig.patternTypes.includes(p)),
          targetSignature: sig,
        });
      }
      candidates.sort((a, b) => b.score - a.score);
      return candidates.slice(0, maxCandidates);
    }

    private egoSubgraphIds(rootId: string, hops: number): string[] {
      const ids = [rootId];
      let frontier = [rootId];
      for (let h = 0; h < Math.max(0, hops); h += 1) {
        const next: string[] = [];
        for (const cur of frontier) {
          const rows = this.db
            .prepare(
              `SELECT source_node_id, target_node_id FROM node_relations
               WHERE status = 'consolidated' AND (source_node_id = ? OR target_node_id = ?)`,
            )
            .all(cur, cur) as unknown as Array<{ source_node_id: string; target_node_id: string }>;
          for (const r of rows) {
            const other =
              String(r.source_node_id) === cur
                ? String(r.target_node_id)
                : String(r.source_node_id);
            if (!ids.includes(other)) {
              ids.push(other);
              next.push(other);
            }
          }
        }
        frontier = next;
      }
      return ids;
    }
  };
}
