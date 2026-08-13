/**
 * Read-only graph projection for `nmg graph`.
 *
 * Same discipline as inspect-data.ts: the database is opened read-only, row
 * parsing is local, and nothing here becomes a store capability. The output
 * shape is the contract consumed by the graph-view template (assets/graph.js),
 * so field names stay stable once the template relies on them.
 *
 * Edges come in three layers:
 *  - "relation":   consolidated node_relations (explicit or stability-promoted)
 *  - "candidate":  node_pair_signals co-retrieval pairs that consolidation has
 *                  NOT promoted yet — the pipeline's pending queue, rendered
 *                  faint so you can see what is close to consolidating
 *  - "supersedes": memory-level supersedes_id chains aggregated to node pairs
 */
import type { DatabaseSync } from "node:sqlite";

export type GraphEdgeLayer = "relation" | "candidate" | "supersedes";

export interface GraphNodeData {
  id: string;
  name: string;
  kind: string;
  status: string;
  residence: string;
  summary: string;
  /** Active/disputed memories grouped under this node. */
  memoryCount: number;
  /** Top statements by importance, for the detail panel (capped). */
  statements: string[];
  degree: number;
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  layer: GraphEdgeLayer;
  type: string;
  /** 0..1; for candidates this is useful/co-retrieved (pair quality). */
  strength: number;
  direction: string;
  status: string;
  /** Candidate layer only: raw co-retrieval observation count. */
  observations?: number;
}

export interface GraphData {
  generatedAt: string;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
}

const MAX_STATEMENTS_PER_NODE = 5;
const MAX_STATEMENT_LENGTH = 160;
/** Pairs below this co-retrieval count are noise, not candidates. */
const MIN_CANDIDATE_OBSERVATIONS = 2;
/** Keep the candidate layer readable on busy databases. */
const MAX_CANDIDATE_EDGES = 500;

type Row = Record<string, unknown>;

export function readGraphData(db: DatabaseSync): GraphData {
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM memory_records
     WHERE node_id = ? AND status IN ('active', 'disputed')`,
  );
  const statementStmt = db.prepare(
    `SELECT statement FROM memory_records
     WHERE node_id = ? AND status IN ('active', 'disputed')
     ORDER BY importance DESC, created_at DESC
     LIMIT ?`,
  );

  const nodeRows = db
    .prepare(
      `SELECT id, canonical_name, kind, status, residence, summary
       FROM memory_nodes
       ORDER BY canonical_name`,
    )
    .all() as Row[];

  const nodes: GraphNodeData[] = nodeRows.map((row) => {
    const id = String(row.id);
    const statements = (statementStmt.all(id, MAX_STATEMENTS_PER_NODE) as Row[]).map((memory) =>
      truncate(String(memory.statement)),
    );
    return {
      id,
      name: String(row.canonical_name),
      kind: String(row.kind),
      status: String(row.status),
      residence: String(row.residence),
      summary: String(row.summary),
      memoryCount: Number((countStmt.get(id) as Row).n),
      statements,
      degree: 0,
    };
  });

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges: GraphEdgeData[] = [];
  const pushEdge = (edge: GraphEdgeData) => {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) return;
    if (edge.source === edge.target) return;
    nodeById.get(edge.source)!.degree += 1;
    nodeById.get(edge.target)!.degree += 1;
    edges.push(edge);
  };

  const relationRows = db
    .prepare(
      `SELECT id, source_node_id, target_node_id, relation_type,
              strength, direction, status
       FROM node_relations
       ORDER BY relation_type`,
    )
    .all() as Row[];
  const consolidatedPairs = new Set<string>();
  for (const row of relationRows) {
    const source = String(row.source_node_id);
    const target = String(row.target_node_id);
    consolidatedPairs.add(pairKey(source, target));
    pushEdge({
      id: String(row.id),
      source,
      target,
      layer: "relation",
      type: String(row.relation_type),
      strength: Number(row.strength),
      direction: String(row.direction),
      status: String(row.status),
    });
  }

  // Candidate layer: co-retrieval signals awaiting consolidation. Pairs that
  // already hold a consolidated relation are excluded — they graduated.
  const candidateRows = db
    .prepare(
      `SELECT left_node_id, right_node_id, co_retrieval_count, useful_count
       FROM node_pair_signals
       WHERE co_retrieval_count >= ?
       ORDER BY co_retrieval_count DESC
       LIMIT ?`,
    )
    .all(MIN_CANDIDATE_OBSERVATIONS, MAX_CANDIDATE_EDGES) as Row[];
  for (const row of candidateRows) {
    const source = String(row.left_node_id);
    const target = String(row.right_node_id);
    if (consolidatedPairs.has(pairKey(source, target))) continue;
    const observations = Number(row.co_retrieval_count);
    pushEdge({
      id: `candidate:${source}:${target}`,
      source,
      target,
      layer: "candidate",
      type: "co_retrieved",
      strength: observations > 0 ? Number(row.useful_count) / observations : 0,
      direction: "both",
      status: "candidate",
      observations,
    });
  }

  // Supersedes chains live at memory level; aggregate to node pairs.
  const supersedesRows = db
    .prepare(
      `SELECT m.node_id AS source, s.node_id AS target, COUNT(*) AS n
       FROM memory_records m
       JOIN memory_records s ON m.supersedes_id = s.id
       WHERE m.node_id != s.node_id
       GROUP BY m.node_id, s.node_id`,
    )
    .all() as Row[];
  for (const row of supersedesRows) {
    pushEdge({
      id: `supersedes:${String(row.source)}:${String(row.target)}`,
      source: String(row.source),
      target: String(row.target),
      layer: "supersedes",
      type: "supersedes",
      strength: 1,
      direction: "source->target",
      status: "active",
      observations: Number(row.n),
    });
  }

  return { generatedAt: new Date().toISOString(), nodes, edges };
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}${right}` : `${right}${left}`;
}

function truncate(value: string): string {
  return value.length <= MAX_STATEMENT_LENGTH
    ? value
    : `${value.slice(0, MAX_STATEMENT_LENGTH - 1)}…`;
}
