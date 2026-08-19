/**
 * Graph cluster of NmgStore methods — official TypeScript mixin pattern
 * (docs/design/store-cluster-split.md, cluster-dag.test.ts).
 *
 * The mixin adds the cluster's methods to any base class; store.ts assembles
 * NmgStore = withGraph(withRetrieval(withWrites(withMaintenance(Base)))).
 * Method bodies use `this.` exactly as they did in the monolith: the final
 * class's prototype chain resolves cross-cluster and base-helper calls.
 * Cluster files import no store code — types and utilities only, so the
 * module graph stays acyclic (DAG).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  ActivationSignal,
  ConsolidationEvent,
  ConsolidationResult,
  EdgeStability,
  MemoryNode,
  MemoryNodeKind,
  NodeRelation,
  NodeRelationType,
  NodeRoute,
  NodeTransform,
  PerfSnapshot,
  SemanticMaintenanceResult,
  TopologyProposal,
  TopologyAutomationAssessment,
  VectorEmbedder,
} from "../types.ts";
import { PerfTimer, SECTION, nowMs } from "../perf.ts";

import type { Constructor } from "./store-ctor.ts";
import { DEFAULT_CONSOLIDATION_POLICY, DEFAULT_TOPOLOGY_POLICY } from "./graph-policy.ts";
import type { Router } from "../router.ts";
import type { Float32VectorCache } from "../vector-cache.ts";
import { parseStringArray } from "./row-parse.ts";
import {
  canonicalNodeIdentity,
  clamp,
  mapActivation,
  mapConsolidationEvent,
  mapNode,
  mapRelation,
  mapTopologyProposal,
  partitionLabel,
} from "./rows.ts";
import { lexicalNodeScore, normalize, type StoreRow as Row } from "./search-ranking.ts";
import { parseVector } from "./vector-codec.ts";
import { relationActivationDefaults } from "../edge-activation.ts";

interface MergeRollbackSnapshot {
  version: 1;
  sourceNodes: MemoryNode[];
  targetExisted: boolean;
  targetNode: MemoryNode;
  memoryAssignments: Array<{ memoryId: string; nodeId: string }>;
  relationsBefore: NodeRelation[];
}

interface MergeRollbackExpected {
  version: 1;
  targetNodeId: string;
  relationsAfter: NodeRelation[];
}

function sameRelationSet(left: readonly NodeRelation[], right: readonly NodeRelation[]): boolean {
  const normalized = (relations: readonly NodeRelation[]) =>
    relations
      .map((relation) => ({ ...relation, evidenceIds: [...relation.evidenceIds].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

export function withGraph<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    // Base-class members (resolved at assembly time)
    declare protected db: DatabaseSync;
    declare protected embedder: VectorEmbedder;
    declare protected router: Router;
    declare protected vectorCaches: Map<string, Float32VectorCache>;
    declare protected recordPerfAggregates: (timings: PerfSnapshot | undefined) => void;
    declare expireShortTermMemories: (at?: string, limit?: number) => string[];
    declare drainPendingTraceSignals: (options?: { limit?: number }) => number;

    // Cross-cluster calls (methods defined in other clusters or store.ts)
    declare protected requireNode: (nodeId: string) => MemoryNode;
    declare upsertNode: (input: {
      canonicalName: string;
      kind?: MemoryNodeKind;
      summary?: string;
    }) => MemoryNode;
    declare protected memoryIdsForNodes: (nodeIds: string[]) => string[];
    declare protected createTransform: (
      type: NodeTransform["type"],
      sourceNodeIds: string[],
      targetNodeIds: string[],
      memoryIds: string[],
    ) => NodeTransform;
    declare protected markIndexDelta: (
      memoryId: string,
      nodeId: string,
      cause: string,
      createdAt: string,
    ) => void;
    declare protected refreshNodeResidence: (nodeId: string, updatedAt: string) => void;
    declare protected refreshEmbeddings: (memoryIds: string[]) => void;
    declare protected embeddingCache: (kind: string, model: string) => Float32VectorCache | null;
    declare protected consolidationCoolingDown: (targetId: string, cooldownMs: number) => boolean;
    declare protected edgeEvidenceTraceIds: (leftNodeId: string, rightNodeId: string) => string[];
    declare protected recordConsolidationEvent: (
      action: ConsolidationEvent["action"],
      targetId: string,
      previousState: string,
      nextState: string,
      reason: string,
      evidenceTraceIds: string[],
    ) => string;
    declare protected requireConsolidationEvent: (id: string) => ConsolidationEvent;
    declare protected proposalCoolingDown: (key: string, cooldownMs: number) => boolean;
    declare protected insertTopologyProposal: (input: {
      proposalKey: string;
      type: TopologyProposal["type"];
      sourceNodeIds: string[];
      relationType: NodeRelationType | null;
      partitions: Array<{ label: string; memoryIds: string[] }>;
      evidenceTraceIds: string[];
      evidenceMemoryIds?: string[];
      observations: number;
      estimatedGain: number;
    }) => TopologyProposal;
    declare protected evidenceIds: (memoryId: string) => string[];
    declare protected candidatePartitions: (
      nodeId: string,
    ) => Array<{ label: string; memoryIds: string[] }>;

    linkNodes(input: {
      sourceNodeId: string;
      targetNodeId: string;
      type: NodeRelationType;
      evidenceIds?: string[];
      stability?: number;
      strength?: number;
      direction?: NodeRelation["direction"];
      fanBudget?: boolean;
      activationRule?: NodeRelation["activationRule"];
      consolidationSource?: NodeRelation["consolidationSource"];
    }): NodeRelation {
      const existing = this.db
        .prepare(
          `SELECT * FROM node_relations
         WHERE source_node_id = ? AND target_node_id = ? AND relation_type = ?`,
        )
        .get(input.sourceNodeId, input.targetNodeId, input.type) as Row | undefined;
      if (existing) {
        const relation = mapRelation(existing);
        const evidenceIds = [...new Set([...relation.evidenceIds, ...(input.evidenceIds ?? [])])];
        if (evidenceIds.length !== relation.evidenceIds.length) {
          this.db
            .prepare("UPDATE node_relations SET evidence_ids_json = ? WHERE id = ?")
            .run(JSON.stringify(evidenceIds), relation.id);
          relation.evidenceIds = evidenceIds;
        }
        if (relation.status === "demoted") {
          const consolidatedAt = new Date().toISOString();
          this.db
            .prepare(
              "UPDATE node_relations SET status = 'consolidated', stability = ?, consolidated_at = ? WHERE id = ?",
            )
            .run(clamp(input.stability ?? 1, 0, 1), consolidatedAt, relation.id);
          relation.status = "consolidated";
          relation.stability = clamp(input.stability ?? 1, 0, 1);
          relation.consolidatedAt = consolidatedAt;
          this.db
            .prepare("UPDATE memory_nodes SET residence = 'ltg', updated_at = ? WHERE id IN (?, ?)")
            .run(consolidatedAt, relation.sourceNodeId, relation.targetNodeId);
        }
        return relation;
      }

      const now = new Date().toISOString();
      const activationDefaults = relationActivationDefaults(input.type);
      const relation: NodeRelation = {
        id: randomUUID(),
        sourceNodeId: input.sourceNodeId,
        targetNodeId: input.targetNodeId,
        type: input.type,
        evidenceIds: [...new Set(input.evidenceIds ?? [])],
        residence: "ltg",
        status: "consolidated",
        stability: clamp(input.stability ?? 1, 0, 1),
        strength: clamp(input.strength ?? 0.5, 0, 1),
        direction: input.direction ?? activationDefaults.direction,
        fanBudget: input.fanBudget ?? activationDefaults.fanBudget,
        activationRule: input.activationRule ?? activationDefaults.activationRule,
        consolidationSource: input.consolidationSource ?? "explicit",
        consolidatedAt: now,
        createdAt: now,
      };
      this.db
        .prepare(
          `INSERT INTO node_relations
          (id, source_node_id, target_node_id, relation_type,
           evidence_ids_json, residence, status, stability, strength, direction,
           fan_budget, activation_rule, consolidation_source, consolidated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          relation.id,
          relation.sourceNodeId,
          relation.targetNodeId,
          relation.type,
          JSON.stringify(relation.evidenceIds),
          relation.residence,
          relation.status,
          relation.stability,
          relation.strength,
          relation.direction,
          relation.fanBudget ? 1 : 0,
          relation.activationRule,
          relation.consolidationSource,
          relation.consolidatedAt,
          relation.createdAt,
        );
      this.db
        .prepare("UPDATE memory_nodes SET residence = 'ltg', updated_at = ? WHERE id IN (?, ?)")
        .run(now, relation.sourceNodeId, relation.targetNodeId);
      return relation;
    }

    // Moved up from NmgStoreBase: its only caller is mergeNodes (this
    // cluster), and it calls linkNodes — keeping it in base forced the
    // upward linkNodes stub.
    protected redirectRelations(sourceNodeId: string, targetNodeId: string): void {
      const rows = this.db
        .prepare(
          `SELECT * FROM node_relations
         WHERE source_node_id = ? OR target_node_id = ?`,
        )
        .all(sourceNodeId, sourceNodeId) as Row[];
      const remove = this.db.prepare("DELETE FROM node_relations WHERE id = ?");
      for (const row of rows) {
        const relation = mapRelation(row);
        remove.run(relation.id);
        const nextSource =
          relation.sourceNodeId === sourceNodeId ? targetNodeId : relation.sourceNodeId;
        const nextTarget =
          relation.targetNodeId === sourceNodeId ? targetNodeId : relation.targetNodeId;
        if (nextSource !== nextTarget) {
          this.linkNodes({
            sourceNodeId: nextSource,
            targetNodeId: nextTarget,
            type: relation.type,
            evidenceIds: relation.evidenceIds,
          });
        }
      }
    }

    /**
     * Detect directed cycles in static dependency edges — a maintenance
     * diagnostic (docs §7.2). Supersede relations must be a DAG (a cycle means
     * two records claim to supersede each other); relation cycles signal
     * circular logic / feedback structures. Never mutates state; results are
     * advisory labels only (the caller decides whether to act).
     */
    detectGraphCycles(): {
      relationCycles: string[][];
      supersedeCycles: string[][];
    } {
      const relationRows = this.db
        .prepare(
          `SELECT id, source_node_id, target_node_id, direction, relation_type
           FROM node_relations WHERE status = 'consolidated'`,
        )
        .all() as Row[];
      const relationAdj = new Map<string, Array<{ to: string; edgeId: string }>>();
      for (const row of relationRows) {
        // Symmetric relations (contradicts / same_as / distinct_from /
        // related_to) legitimately appear as bidirectional pairs — a mutual
        // contradiction is not an anomaly, so they never count as a cycle.
        if (SYMMETRIC_RELATION_TYPES.has(String(row.relation_type))) continue;
        const from = String(row.source_node_id);
        const to = String(row.target_node_id);
        const dir = String(row.direction);
        const push = (src: string, dst: string) => {
          const list = relationAdj.get(src) ?? [];
          list.push({ to: dst, edgeId: String(row.id) });
          relationAdj.set(src, list);
        };
        if (dir === "source->target") push(from, to);
        else if (dir === "target->source") push(to, from);
        else {
          push(from, to);
          push(to, from);
        }
      }
      const relationCycles = findDirectedCycles(relationAdj);

      // supersedes_id is single-valued → every record has out-degree ≤ 1, so
      // the supersede graph is a chain/forest. Cycle detection therefore
      // reduces to "walk each chain in its direction and look for an
      // endpoint": reaching NULL (or an already-processed chain) is acyclic;
      // walking back onto the current chain is a cycle. O(V), no adjacency
      // map, no general DFS. (Relation cycles use findDirectedCycles because
      // relations may branch — out-degree is not bounded.)
      const supersedeRows = this.db
        .prepare(
          `SELECT id, supersedes_id FROM memory_records WHERE supersedes_id IS NOT NULL`,
        )
        .all() as Row[];
      const supersedeNext = new Map<string, string>();
      for (const row of supersedeRows) {
        const from = String(row.id);
        const to = String(row.supersedes_id);
        if (from !== to) supersedeNext.set(from, to); // skip degenerate self-edge
      }
      const chainState = new Map<string, 0 | 1 | 2>();
      const supersedeCycles: string[][] = [];
      for (const start of supersedeNext.keys()) {
        if (chainState.has(start)) continue;
        const chain: string[] = [];
        let cur: string | null = start;
        while (cur !== null && !chainState.has(cur)) {
          chainState.set(cur, 1);
          chain.push(cur);
          cur = supersedeNext.get(cur) ?? null;
        }
        if (cur !== null && chainState.get(cur) === 1) {
          // Walking back onto the current chain → elementary cycle.
          const index = chain.indexOf(cur);
          supersedeCycles.push(chain.slice(index));
        }
        for (const id of chain) chainState.set(id, 2);
      }
      return { relationCycles, supersedeCycles };
    }

    /**
     * All memory ids reachable from `memoryId` by following supersedes_id
     * edges (i.e. the chain of records `memoryId` supersedes). Used for
     * write-time cycle defence in applySupersession: adding an edge
     * new→superseded forms a cycle exactly when `superseded` reaches `new`.
     *
     * Because supersedes_id is a single-valued column, every record has
     * out-degree ≤ 1 — the supersede graph is a chain/forest, so the reachable
     * set is exactly the chain obtained by walking `supersedes_id` level by
     * level (PK lookups, O(depth·log N)). This avoids a full-table scan on
     * every write-time defence check.
     */
    supersedeReachableFrom(memoryId: string): Set<string> {
      const seen = new Set<string>();
      const supersedeOf = this.db.prepare(
        `SELECT supersedes_id FROM memory_records WHERE id = ?`,
      );
      let cur: string | null = memoryId;
      while (cur !== null && !seen.has(cur)) {
        seen.add(cur);
        const row = supersedeOf.get(cur) as { supersedes_id: string | null } | undefined;
        cur = row && row.supersedes_id != null ? String(row.supersedes_id) : null;
      }
      return seen;
    }

    /**
     * Break a detected supersede cycle (docs §7.2): clear every supersedes_id
     * inside the cycle that points at another member of the cycle, leaving
     * edges to records outside the cycle intact. Supersede is a DAG by design,
     * so a cycle is a deterministic data anomaly — safe to clear. Audit note:
     * the cleared record ids are returned so the caller can record them.
     */
    breakSupersedeCycle(cycle: string[]): { cleared: string[] } {
      const memberSet = new Set(cycle);
      const rows = this.db
        .prepare(
          `SELECT id, supersedes_id FROM memory_records
           WHERE supersedes_id IS NOT NULL`,
        )
        .all() as Row[];
      const cleared: string[] = [];
      const updater = this.db.prepare(
        `UPDATE memory_records SET supersedes_id = NULL WHERE id = ?`,
      );
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          const from = String(row.id);
          const to = String(row.supersedes_id);
          if (memberSet.has(from) && memberSet.has(to)) {
            updater.run(from);
            cleared.push(from);
          }
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return { cleared };
    }

    getRelations(nodeIds: string[], maxHops = 1): NodeRelation[] {
      const visitedNodes = new Set(nodeIds);
      const relations = new Map<string, NodeRelation>();
      let frontier = [...visitedNodes];
      for (let hop = 0; hop < Math.max(0, maxHops) && frontier.length > 0; hop += 1) {
        const next: string[] = [];
        for (const nodeId of frontier) {
          const rows = this.db
            .prepare(
              `SELECT * FROM node_relations
             WHERE status = 'consolidated'
               AND (source_node_id = ? OR target_node_id = ?)`,
            )
            .all(nodeId, nodeId) as Row[];
          for (const row of rows) {
            const relation = mapRelation(row);
            relations.set(relation.id, relation);
            for (const related of [relation.sourceNodeId, relation.targetNodeId]) {
              if (!visitedNodes.has(related)) {
                visitedNodes.add(related);
                next.push(related);
              }
            }
          }
        }
        frontier = next;
      }
      return [...relations.values()];
    }

    mergeNodes(input: {
      sourceNodeIds: string[];
      targetName: string;
      targetKind?: MemoryNodeKind;
      summary?: string;
    }): NodeTransform {
      const sourceNodeIds = [...new Set(input.sourceNodeIds)];
      if (sourceNodeIds.length < 2) throw new Error("merge requires at least two nodes");
      const sources = sourceNodeIds.map((id) => this.requireNode(id));
      if (sources.some((source) => source.status !== "active")) {
        throw new Error("merge sources must all be active");
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const existingTarget = this.db
          .prepare("SELECT * FROM memory_nodes WHERE canonical_name = ?")
          .get(input.targetName) as Row | undefined;
        const target = this.upsertNode({
          canonicalName: input.targetName,
          kind: input.targetKind ?? sources[0]!.kind,
          summary: input.summary,
        });
        if (sourceNodeIds.includes(target.id)) {
          throw new Error("merge target must be distinct from every source node");
        }
        const memoryAssignments = sourceNodeIds.flatMap((nodeId) =>
          (
            this.db
              .prepare("SELECT id, node_id FROM memory_records WHERE node_id = ?")
              .all(nodeId) as Row[]
          ).map((row) => ({ memoryId: String(row.id), nodeId: String(row.node_id) })),
        );
        const movedMemoryIds = memoryAssignments.map((item) => item.memoryId);
        const operation = this.createTransform("merge", sourceNodeIds, [target.id], movedMemoryIds);
        const journalNodes = [...sourceNodeIds, target.id];
        const snapshot: MergeRollbackSnapshot = {
          version: 1,
          sourceNodes: sources,
          targetExisted: Boolean(existingTarget),
          targetNode: existingTarget ? mapNode(existingTarget) : target,
          memoryAssignments,
          relationsBefore: this.relationNeighborhood(journalNodes),
        };
        this.db
          .prepare(
            `INSERT INTO node_transform_journals
             (transform_id, snapshot_json, expected_json, rolled_back_at)
             VALUES (?, ?, ?, NULL)`,
          )
          .run(operation.id, JSON.stringify(snapshot), "{}");
        for (const sourceId of sourceNodeIds) {
          this.db
            .prepare("UPDATE memory_records SET node_id = ? WHERE node_id = ?")
            .run(target.id, sourceId);
          this.redirectRelations(sourceId, target.id);
          this.db
            .prepare("UPDATE memory_nodes SET status = 'merged', updated_at = ? WHERE id = ?")
            .run(operation.createdAt, sourceId);
          this.db
            .prepare(
              `INSERT INTO node_redirects (source_node_id, target_node_id, transform_id)
           VALUES (?, ?, ?)`,
            )
            .run(sourceId, target.id, operation.id);
        }
        this.db
          .prepare("UPDATE node_transform_journals SET expected_json = ? WHERE transform_id = ?")
          .run(
            JSON.stringify({
              version: 1,
              targetNodeId: target.id,
              relationsAfter: this.relationNeighborhood(journalNodes),
            } satisfies MergeRollbackExpected),
            operation.id,
          );
        for (const memoryId of movedMemoryIds) {
          this.markIndexDelta(memoryId, target.id, "move", operation.createdAt);
        }
        this.refreshNodeResidence(target.id, operation.createdAt);
        this.db.exec("COMMIT");
        this.refreshEmbeddings(movedMemoryIds);
        return operation;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    splitNode(input: {
      sourceNodeId: string;
      partitions: Array<{
        nodeName: string;
        nodeKind?: MemoryNodeKind;
        summary?: string;
        memoryIds: string[];
      }>;
    }): NodeTransform {
      const source = this.requireNode(input.sourceNodeId);
      if (input.partitions.length < 2) throw new Error("split requires at least two partitions");
      const assigned = input.partitions.flatMap((partition) => partition.memoryIds);
      if (new Set(assigned).size !== assigned.length) {
        throw new Error("a memory cannot belong to two split partitions");
      }
      const available = new Set(this.memoryIdsForNodes([source.id]));
      if (assigned.some((id) => !available.has(id))) {
        throw new Error("split partitions may contain only memories from the source node");
      }
      if (assigned.length !== available.size) {
        throw new Error("split partitions must assign every source memory exactly once");
      }

      this.db.exec("BEGIN IMMEDIATE");
      try {
        const targets = input.partitions.map((partition) =>
          this.upsertNode({
            canonicalName: partition.nodeName,
            kind: partition.nodeKind ?? source.kind,
            summary: partition.summary,
          }),
        );
        if (
          new Set(targets.map((node) => node.id)).size !== targets.length ||
          targets.some((node) => node.id === source.id)
        ) {
          throw new Error("split targets must be new, distinct semantic nodes");
        }
        const operation = this.createTransform(
          "split",
          [source.id],
          targets.map((node) => node.id),
          assigned,
        );
        for (let index = 0; index < input.partitions.length; index += 1) {
          const partition = input.partitions[index]!;
          const target = targets[index]!;
          const update = this.db.prepare("UPDATE memory_records SET node_id = ? WHERE id = ?");
          for (const memoryId of partition.memoryIds) {
            update.run(target.id, memoryId);
            this.markIndexDelta(memoryId, target.id, "move", operation.createdAt);
          }
          this.linkNodes({ sourceNodeId: target.id, targetNodeId: source.id, type: "is_a" });
          this.db
            .prepare(
              `INSERT INTO node_redirects (source_node_id, target_node_id, transform_id)
           VALUES (?, ?, ?)`,
            )
            .run(source.id, target.id, operation.id);
        }
        this.db
          .prepare("UPDATE memory_nodes SET status = 'split', updated_at = ? WHERE id = ?")
          .run(operation.createdAt, source.id);
        this.db.exec("COMMIT");
        this.refreshEmbeddings(assigned);
        return operation;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    getNodeTransform(transformId: string): NodeTransform | null {
      const row = this.db
        .prepare(
          `SELECT t.*, j.rolled_back_at FROM node_transforms t
           LEFT JOIN node_transform_journals j ON j.transform_id = t.id
           WHERE t.id = ?`,
        )
        .get(transformId) as Row | undefined;
      if (!row) return null;
      return {
        id: String(row.id),
        type: String(row.transform_type) as NodeTransform["type"],
        sourceNodeIds: parseStringArray(row.source_node_ids_json),
        targetNodeIds: parseStringArray(row.target_node_ids_json),
        movedMemoryIds: parseStringArray(row.moved_memory_ids_json),
        createdAt: String(row.created_at),
        rolledBackAt: row.rolled_back_at ? String(row.rolled_back_at) : null,
      };
    }

    rollbackNodeTransform(transformId: string): NodeTransform {
      const row = this.db
        .prepare(
          `SELECT t.*, j.snapshot_json, j.expected_json, j.rolled_back_at
           FROM node_transforms t
           LEFT JOIN node_transform_journals j ON j.transform_id = t.id
           WHERE t.id = ?`,
        )
        .get(transformId) as Row | undefined;
      if (!row) throw new Error(`node transform ${transformId} does not exist`);
      if (String(row.transform_type) !== "merge") {
        throw new Error("only journaled merge transforms can be rolled back");
      }
      if (!row.snapshot_json || !row.expected_json) {
        throw new Error("node transform predates reversible merge journaling");
      }
      if (row.rolled_back_at)
        throw new Error(`node transform ${transformId} is already rolled back`);
      const snapshot = JSON.parse(String(row.snapshot_json)) as MergeRollbackSnapshot;
      const expected = JSON.parse(String(row.expected_json)) as MergeRollbackExpected;
      if (snapshot.version !== 1 || expected.version !== 1) {
        throw new Error("unsupported merge rollback journal version");
      }
      const involvedNodeIds = [
        ...new Set([...snapshot.sourceNodes.map((node) => node.id), expected.targetNodeId]),
      ];
      const rolledBackAt = new Date().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const nodeStatuses = new Map(
          (
            this.db
              .prepare(
                `SELECT id, status FROM memory_nodes
                 WHERE id IN (${involvedNodeIds.map(() => "?").join(",")})`,
              )
              .all(...involvedNodeIds) as Row[]
          ).map((node) => [String(node.id), String(node.status)]),
        );
        if (
          snapshot.sourceNodes.some((node) => nodeStatuses.get(node.id) !== "merged") ||
          nodeStatuses.get(expected.targetNodeId) !== "active"
        ) {
          throw new Error("merge rollback conflict: node status changed after the merge");
        }
        const currentAssignments = new Map(
          (snapshot.memoryAssignments.length === 0
            ? []
            : (this.db
                .prepare(
                  `SELECT id, node_id FROM memory_records
                   WHERE id IN (${snapshot.memoryAssignments.map(() => "?").join(",")})`,
                )
                .all(...snapshot.memoryAssignments.map((item) => item.memoryId)) as Row[])
          ).map((item) => [String(item.id), String(item.node_id)]),
        );
        if (
          snapshot.memoryAssignments.some(
            (item) => currentAssignments.get(item.memoryId) !== expected.targetNodeId,
          )
        ) {
          throw new Error("merge rollback conflict: a moved memory changed after the merge");
        }
        if (!sameRelationSet(this.relationNeighborhood(involvedNodeIds), expected.relationsAfter)) {
          throw new Error("merge rollback conflict: related topology changed after the merge");
        }
        const placeholders = involvedNodeIds.map(() => "?").join(",");
        this.db
          .prepare(
            `DELETE FROM node_relations
             WHERE source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders})`,
          )
          .run(...involvedNodeIds, ...involvedNodeIds);
        for (const relation of snapshot.relationsBefore) this.restoreRelation(relation);
        const move = this.db.prepare("UPDATE memory_records SET node_id = ? WHERE id = ?");
        for (const assignment of snapshot.memoryAssignments) {
          move.run(assignment.nodeId, assignment.memoryId);
          this.markIndexDelta(assignment.memoryId, assignment.nodeId, "move", rolledBackAt);
        }
        this.db.prepare("DELETE FROM node_redirects WHERE transform_id = ?").run(transformId);
        const restoreNode = this.db.prepare(
          `UPDATE memory_nodes
           SET kind = ?, summary = ?, status = ?, residence = ?, updated_at = ?
           WHERE id = ?`,
        );
        for (const node of snapshot.sourceNodes) {
          restoreNode.run(
            node.kind,
            node.summary,
            node.status,
            node.residence,
            node.updatedAt,
            node.id,
          );
        }
        if (snapshot.targetExisted) {
          const node = snapshot.targetNode;
          restoreNode.run(
            node.kind,
            node.summary,
            node.status,
            node.residence,
            node.updatedAt,
            node.id,
          );
        } else {
          this.db
            .prepare("UPDATE memory_nodes SET status = 'merged', updated_at = ? WHERE id = ?")
            .run(rolledBackAt, expected.targetNodeId);
        }
        this.db
          .prepare("UPDATE node_transform_journals SET rolled_back_at = ? WHERE transform_id = ?")
          .run(rolledBackAt, transformId);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      this.refreshEmbeddings(snapshot.memoryAssignments.map((item) => item.memoryId));
      return this.getNodeTransform(transformId)!;
    }

    protected relationNeighborhood(nodeIds: readonly string[]): NodeRelation[] {
      if (nodeIds.length === 0) return [];
      const placeholders = nodeIds.map(() => "?").join(",");
      return (
        this.db
          .prepare(
            `SELECT * FROM node_relations
             WHERE source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders})
             ORDER BY id`,
          )
          .all(...nodeIds, ...nodeIds) as Row[]
      ).map(mapRelation);
    }

    protected restoreRelation(relation: NodeRelation): void {
      this.db
        .prepare(
          `INSERT INTO node_relations
           (id, source_node_id, target_node_id, relation_type, evidence_ids_json,
            residence, status, stability, strength, direction, fan_budget,
            activation_rule, consolidation_source, consolidated_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          relation.id,
          relation.sourceNodeId,
          relation.targetNodeId,
          relation.type,
          JSON.stringify(relation.evidenceIds),
          relation.residence,
          relation.status,
          relation.stability,
          relation.strength,
          relation.direction,
          relation.fanBudget ? 1 : 0,
          relation.activationRule,
          relation.consolidationSource,
          relation.consolidatedAt,
          relation.createdAt,
        );
    }

    routeNodes(query: string, limit = 5): NodeRoute[] {
      const rows = this.db
        .prepare(
          `SELECT n.*, r.weights_json
       FROM memory_nodes n LEFT JOIN router_weights r ON r.node_id = n.id
       WHERE n.status = 'active'`,
        )
        .all() as Row[];
      const normalized = normalize(query);
      return rows
        .map((row) => {
          const node = mapNode(row);
          const learned = this.router.score(query, parseVector(row.weights_json));
          const lexical = lexicalNodeScore(normalized, node);
          return { node, score: learned * 0.7 + lexical * 0.3 };
        })
        .filter((route) => route.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.max(1, Math.min(limit, 50)));
    }

    routeNodesByVector(
      queryVector: readonly number[],
      model: string,
      limit = 5,
      candidateNodeIds: string[] = [],
      activationMode: "cosine" | "hierarchical-activation" = "cosine",
    ): NodeRoute[] {
      if (!model.trim()) throw new Error("embedding model is required");
      if (queryVector.length === 0) throw new Error("query vector is required");
      const candidates = [...new Set(candidateNodeIds)].slice(0, 2_000);
      const clause =
        candidates.length > 0 ? `AND n.id IN (${candidates.map(() => "?").join(",")})` : "";
      const rows = this.db
        .prepare(
          `SELECT n.*
       FROM memory_nodes n JOIN node_embeddings e ON e.node_id = n.id AND e.model = ?
       WHERE n.status = 'active' ${clause}`,
        )
        .all(model, ...candidates) as Row[];
      const byId = new Map(rows.map((row) => [String(row.id), row]));
      const cache = this.embeddingCache("node", model);
      if (!cache) return [];

      // HA is a stateful experimental controller. It must not silently replace
      // deterministic retrieval before a trained state has passed rollout gates.
      if (activationMode === "hierarchical-activation" && byId.size > 0) {
        const candidateList: Array<{ id: string; vector: Float32Array }> = [];
        for (const id of byId.keys()) {
          const vec = cache.vector(id);
          if (vec) candidateList.push({ id, vector: vec });
        }
        if (candidateList.length > 0) {
          const ha = this.router.ensureHA(queryVector.length);
          const out = ha.propagate(
            new Float32Array(queryVector),
            candidateList.map((c) => ({ nodeId: c.id, vector: c.vector })),
          );
          const scored = candidateList.map((c, i) => ({
            node: mapNode(byId.get(c.id)!),
            score: out.nodeScores[i]!,
          }));
          return scored
            .filter((r) => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, Math.max(1, Math.min(limit, 50)));
        }
      }

      // Default: deterministic Float32VectorCache cosine scoring.
      return cache
        .score(queryVector, new Set(byId.keys()))
        .map(({ id, score }) => ({ node: mapNode(byId.get(id)!), score }))
        .slice(0, Math.max(1, Math.min(limit, 50)));
    }

    trainRouter(
      query: string,
      usefulNodeIds: string[],
      learningRate = 0.2,
      confirmedNodeIds: string[] = [],
    ): void {
      const uniqueIds = [...new Set(usefulNodeIds)];
      const confirmed = new Set(confirmedNodeIds);
      const upsert = this.db.prepare(
        `INSERT INTO router_weights (node_id, model, dimensions, weights_json, examples, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(node_id) DO UPDATE SET weights_json = excluded.weights_json,
         examples = router_weights.examples + 1, updated_at = excluded.updated_at`,
      );
      const select = this.db.prepare("SELECT weights_json FROM router_weights WHERE node_id = ?");
      const now = new Date().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const nodeId of uniqueIds) {
          this.requireNode(nodeId);
          const row = select.get(nodeId) as Row | undefined;
          // Triple-confirmed nodes (summary-routed ∧ recalled ∧ explicitly used)
          // carry double evidence, so they learn at twice the base rate;
          // plain use stays at the base rate. Summary hits alone never train
          // the router (exposure-bias echo-chamber guard).
          const lr = confirmed.has(nodeId)
            ? clamp(learningRate * 2, 0.001, 1)
            : clamp(learningRate, 0.001, 1);
          const weights = this.router.update(
            query,
            row ? parseVector(row.weights_json) : undefined,
            lr,
          );
          upsert.run(
            nodeId,
            this.embedder.model,
            this.embedder.dimensions,
            JSON.stringify(weights),
            now,
          );
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    edgeStability(leftNodeId: string, rightNodeId: string): EdgeStability {
      const [left, right] = [leftNodeId, rightNodeId].sort();
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS independent_tasks,
                SUM(useful) AS useful_tasks,
                SUM(contradicted) AS contradicted_tasks,
                MAX(created_at) AS updated_at
         FROM edge_task_observations
         WHERE left_node_id = ? AND right_node_id = ?`,
        )
        .get(left, right) as Row;
      const independentTasks = Number(row.independent_tasks ?? 0);
      const usefulTasks = Number(row.useful_tasks ?? 0);
      const contradictedTasks = Number(row.contradicted_tasks ?? 0);
      const updatedAt = row.updated_at ? String(row.updated_at) : new Date(0).toISOString();
      const ageDays = Math.max(0, (Date.now() - Date.parse(updatedAt)) / 86_400_000);
      const decay = Math.pow(0.5, ageDays / 180);
      const evidenceScore =
        independentTasks === 0
          ? 0
          : usefulTasks / independentTasks - (0.5 * contradictedTasks) / independentTasks;
      return {
        leftNodeId: left,
        rightNodeId: right,
        independentTasks,
        usefulTasks,
        contradictedTasks,
        score: clamp(evidenceScore * decay, 0, 1),
        updatedAt,
      };
    }

    nodeActivation(nodeId: string): ActivationSignal {
      const row = this.db
        .prepare("SELECT * FROM node_activation_signals WHERE node_id = ?")
        .get(nodeId) as Row | undefined;
      return mapActivation(row, true);
    }

    relationActivation(relationId: string): ActivationSignal {
      const row = this.db
        .prepare("SELECT * FROM edge_activation_signals WHERE relation_id = ?")
        .get(relationId) as Row | undefined;
      return mapActivation(row, false);
    }

    reconcileConsolidation(
      options: {
        minIndependentTasks?: number;
        promoteThreshold?: number;
        demoteThreshold?: number;
        cooldownMs?: number;
        pairLimit?: number;
        pairs?: readonly (readonly [string, string])[];
      } = {},
    ): ConsolidationResult {
      const minIndependentTasks = Math.max(
        2,
        options.minIndependentTasks ?? DEFAULT_CONSOLIDATION_POLICY.minIndependentTasks,
      );
      const promoteThreshold = clamp(
        options.promoteThreshold ?? DEFAULT_CONSOLIDATION_POLICY.promoteThreshold,
        0,
        1,
      );
      const demoteThreshold = clamp(
        options.demoteThreshold ?? DEFAULT_CONSOLIDATION_POLICY.demoteThreshold,
        0,
        promoteThreshold,
      );
      const cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_CONSOLIDATION_POLICY.cooldownMs);
      const pairLimit = Math.max(1, Math.min(options.pairLimit ?? 256, 2_048));
      const consolidatedRelations: NodeRelation[] = [];
      const demotedRelations: NodeRelation[] = [];
      const eventIds: string[] = [];
      const pairs = options.pairs
        ? [
            ...new Map(
              options.pairs.map(([left, right]) => {
                const ordered = left <= right ? [left, right] : [right, left];
                return [
                  ordered.join("\0"),
                  { left_node_id: ordered[0], right_node_id: ordered[1] },
                ];
              }),
            ).values(),
          ].slice(0, pairLimit)
        : (this.db
            .prepare(
              `SELECT DISTINCT left_node_id, right_node_id FROM edge_task_observations
             ORDER BY left_node_id, right_node_id LIMIT ?`,
            )
            .all(pairLimit) as Row[]);
      for (const row of pairs) {
        const stability = this.edgeStability(String(row.left_node_id), String(row.right_node_id));
        const relationRow = this.db
          .prepare(
            `SELECT * FROM node_relations WHERE consolidation_source = 'stability'
           AND ((source_node_id = ? AND target_node_id = ?)
             OR (source_node_id = ? AND target_node_id = ?))
           ORDER BY created_at DESC LIMIT 1`,
          )
          .get(
            stability.leftNodeId,
            stability.rightNodeId,
            stability.rightNodeId,
            stability.leftNodeId,
          ) as Row | undefined;
        const relation = relationRow ? mapRelation(relationRow) : null;
        if (
          stability.independentTasks >= minIndependentTasks &&
          stability.score >= promoteThreshold &&
          (!relation || relation.status === "demoted") &&
          !this.consolidationCoolingDown(
            relation?.id ?? `pair:${stability.leftNodeId}:${stability.rightNodeId}`,
            cooldownMs,
          )
        ) {
          const evidenceTraceIds = this.edgeEvidenceTraceIds(
            stability.leftNodeId,
            stability.rightNodeId,
          );
          const promoted = this.linkNodes({
            sourceNodeId: stability.leftNodeId,
            targetNodeId: stability.rightNodeId,
            type: "related_to",
            evidenceIds: [],
            stability: stability.score,
            consolidationSource: "stability",
          });
          this.db
            .prepare("UPDATE node_relations SET consolidation_source = 'stability' WHERE id = ?")
            .run(promoted.id);
          promoted.consolidationSource = "stability";
          eventIds.push(
            this.recordConsolidationEvent(
              "consolidate",
              promoted.id,
              relation?.status ?? "candidate",
              "consolidated",
              `stability=${stability.score.toFixed(3)} tasks=${stability.independentTasks}`,
              evidenceTraceIds,
            ),
          );
          consolidatedRelations.push(promoted);
        } else if (
          relation?.status === "consolidated" &&
          stability.score <= demoteThreshold &&
          !this.consolidationCoolingDown(relation.id, cooldownMs)
        ) {
          this.db
            .prepare("UPDATE node_relations SET status = 'demoted', stability = ? WHERE id = ?")
            .run(stability.score, relation.id);
          relation.status = "demoted";
          relation.stability = stability.score;
          const now = new Date().toISOString();
          this.refreshNodeResidence(relation.sourceNodeId, now);
          this.refreshNodeResidence(relation.targetNodeId, now);
          eventIds.push(
            this.recordConsolidationEvent(
              "demote",
              relation.id,
              "consolidated",
              "demoted",
              `stability=${stability.score.toFixed(3)} threshold=${demoteThreshold}`,
              this.edgeEvidenceTraceIds(stability.leftNodeId, stability.rightNodeId),
            ),
          );
          demotedRelations.push(relation);
        }
      }
      return {
        consolidatedRelations,
        demotedRelations,
        events: eventIds.map((id) => this.requireConsolidationEvent(id)),
      };
    }

    /** Run conservative semantic maintenance in a separately bounded phase. */
    runSemanticMaintenance(
      options: {
        expiryLimit?: number;
        pairLimit?: number;
        topologyNodeLimit?: number;
        autoMerge?: boolean;
        autoMergeLimit?: number;
      } = {},
    ): SemanticMaintenanceResult {
      const startedAt = nowMs();
      const timer = new PerfTimer();
      let expiredMemoryIds: string[] = [];
      let consolidation: ConsolidationResult = {
        consolidatedRelations: [],
        demotedRelations: [],
        events: [],
      };
      let proposals: TopologyProposal[] = [];
      const autoMergedTransformIds: string[] = [];
      timer.measure(SECTION.maintenanceSemantic, () => {
        // Materialize deferred retrieval-pair signals before any reader
        // (consolidation, topology proposals) consumes them. Bounded by the
        // same per-run pair limit as the phases below.
        this.drainPendingTraceSignals({ limit: options.pairLimit ?? 64 });
        expiredMemoryIds = this.expireShortTermMemories(
          new Date().toISOString(),
          options.expiryLimit ?? 256,
        );
        consolidation = this.reconcileConsolidation({ pairLimit: options.pairLimit ?? 64 });
        proposals = this.proposeTopologyChanges({
          pairLimit: options.pairLimit ?? 64,
          nodeLimit: options.topologyNodeLimit ?? 32,
        });
        if (options.autoMerge) {
          const limit = Math.max(1, Math.min(options.autoMergeLimit ?? 1, 4));
          for (const proposal of this.topologyProposals("pending")) {
            if (autoMergedTransformIds.length >= limit) break;
            const assessment = this.assessAutomaticMergeProposal(proposal.id);
            if (!assessment.eligible) continue;
            try {
              const actuation = this.actuateAutomaticMergeProposal(proposal.id);
              autoMergedTransformIds.push(actuation.id);
            } catch {
              // The proposal keeps its actuation error for audit. One stale or
              // concurrently claimed proposal must not block unrelated work.
            }
          }
        }
      });
      timer.setTotal(nowMs() - startedAt);
      this.recordPerfAggregates(timer.snapshot());
      const result: SemanticMaintenanceResult = {
        id: randomUUID(),
        expiredMemoryIds,
        consolidatedRelationIds: consolidation.consolidatedRelations.map((item) => item.id),
        demotedRelationIds: consolidation.demotedRelations.map((item) => item.id),
        proposedTopologyIds: proposals.map((item) => item.id),
        autoMergedTransformIds,
        rowsTouched:
          expiredMemoryIds.length +
          consolidation.consolidatedRelations.length +
          consolidation.demotedRelations.length +
          proposals.length +
          autoMergedTransformIds.length,
        durationMs: timer.totalMs,
        createdAt: new Date().toISOString(),
      };
      this.db
        .prepare(
          `INSERT INTO maintenance_runs
            (id, phase, considered_nodes, rows_touched, details_json, duration_ms, created_at)
           VALUES (?, 'semantic', ?, ?, ?, ?, ?)`,
        )
        .run(
          result.id,
          new Set([
            ...result.consolidatedRelationIds,
            ...result.demotedRelationIds,
            ...result.proposedTopologyIds,
            ...result.autoMergedTransformIds,
          ]).size,
          result.rowsTouched,
          JSON.stringify(result),
          result.durationMs,
          result.createdAt,
        );
      return result;
    }

    consolidationEvents(): ConsolidationEvent[] {
      return (
        this.db.prepare("SELECT * FROM consolidation_events ORDER BY rowid").all() as Row[]
      ).map(mapConsolidationEvent);
    }

    proposeTopologyChanges(
      options: {
        minObservations?: number;
        minGain?: number;
        cooldownMs?: number;
        pairLimit?: number;
        nodeLimit?: number;
      } = {},
    ): TopologyProposal[] {
      const minObservations = Math.max(
        2,
        options.minObservations ?? DEFAULT_TOPOLOGY_POLICY.minObservations,
      );
      const minGain = clamp(options.minGain ?? DEFAULT_TOPOLOGY_POLICY.minGain, 0, 1);
      const cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_TOPOLOGY_POLICY.cooldownMs);
      const pairLimit = Math.max(1, Math.min(options.pairLimit ?? 256, 2_048));
      const nodeLimit = Math.max(1, Math.min(options.nodeLimit ?? 128, 2_048));
      const proposals: TopologyProposal[] = [];
      const pairRows = this.db
        .prepare(
          `SELECT p.*, l.query_count AS left_queries, r.query_count AS right_queries,
                  (SELECT COUNT(*) FROM edge_task_observations o
                   WHERE o.left_node_id = p.left_node_id
                     AND o.right_node_id = p.right_node_id AND o.useful = 1) AS useful_count_now
           FROM node_pair_signals p
           JOIN node_retrieval_signals l ON l.node_id = p.left_node_id
           JOIN node_retrieval_signals r ON r.node_id = p.right_node_id
           JOIN memory_nodes ln ON ln.id = p.left_node_id AND ln.status = 'active'
           JOIN memory_nodes rn ON rn.id = p.right_node_id AND rn.status = 'active'
           WHERE p.co_retrieval_count >= ?
           ORDER BY p.updated_at, p.left_node_id, p.right_node_id LIMIT ?`,
        )
        .all(minObservations, pairLimit) as Row[];
      for (const row of pairRows) {
        const sourceNodeIds = [String(row.left_node_id), String(row.right_node_id)];
        const proposalKey = `link:${sourceNodeIds.join(":")}`;
        // Co-retrieval is only a candidate signal. Requiring both nodes to have
        // been marked useful avoids turning the retriever's own accidental
        // co-results into self-reinforcing graph edges.
        const gain =
          Number(row.useful_count_now) /
          Math.max(Number(row.left_queries), Number(row.right_queries), 1);
        if (gain < minGain || this.proposalCoolingDown(proposalKey, cooldownMs)) continue;
        const relation = this.db
          .prepare(
            `SELECT 1 FROM node_relations WHERE
         (source_node_id = ? AND target_node_id = ?) OR
         (source_node_id = ? AND target_node_id = ?) LIMIT 1`,
          )
          .get(sourceNodeIds[0], sourceNodeIds[1], sourceNodeIds[1], sourceNodeIds[0]);
        if (relation) continue;
        proposals.push(
          this.insertTopologyProposal({
            proposalKey,
            type: "link",
            sourceNodeIds,
            relationType: "related_to",
            partitions: [],
            evidenceTraceIds: parseStringArray(row.evidence_trace_ids_json),
            observations: Number(row.co_retrieval_count),
            estimatedGain: gain,
          }),
        );
      }
      const nodeRows = this.db
        .prepare(
          `SELECT s.* FROM node_retrieval_signals s
       JOIN memory_nodes n ON n.id = s.node_id AND n.status = 'active'
       WHERE s.query_count >= ? ORDER BY s.updated_at, s.node_id LIMIT ?`,
        )
        .all(minObservations, nodeLimit) as Row[];
      for (const row of nodeRows) {
        const nodeId = String(row.node_id);
        const ambiguity = Number(row.ambiguity_sum) / Math.max(Number(row.query_count), 1);
        const fallback = Number(row.fallback_count) / Math.max(Number(row.query_count), 1);
        const gain = Math.max(ambiguity, fallback);
        const proposalKey = `split:${nodeId}`;
        if (gain < minGain || this.proposalCoolingDown(proposalKey, cooldownMs)) continue;
        const partitions = this.candidatePartitions(nodeId);
        if (partitions.length < 2) continue;
        const traces = this.db
          .prepare(
            `SELECT id FROM retrieval_traces
         WHERE result_node_ids_json LIKE ? ORDER BY created_at DESC LIMIT 16`,
          )
          .all(`%${nodeId}%`) as Row[];
        proposals.push(
          this.insertTopologyProposal({
            proposalKey,
            type: "split",
            sourceNodeIds: [nodeId],
            relationType: null,
            partitions,
            evidenceTraceIds: traces.map((trace) => String(trace.id)),
            observations: Number(row.query_count),
            estimatedGain: gain,
          }),
        );
      }
      return proposals;
    }

    proposeSemanticRelation(input: {
      sourceNodeId: string;
      targetNodeId: string;
      relationType: Extract<
        NodeRelationType,
        "contradicts" | "distinct_from" | "refines" | "related_to" | "same_as"
      >;
      evidenceMemoryIds: string[];
      confidence?: number;
    }): TopologyProposal {
      if (input.sourceNodeId === input.targetNodeId) {
        throw new Error("semantic relation proposal requires two distinct nodes");
      }
      this.requireNode(input.sourceNodeId);
      this.requireNode(input.targetNodeId);
      const evidenceMemoryIds = [...new Set(input.evidenceMemoryIds)];
      if (evidenceMemoryIds.length === 0) {
        throw new Error("semantic relation proposal requires memory evidence");
      }
      for (const memoryId of evidenceMemoryIds) {
        const row = this.db
          .prepare("SELECT node_id FROM memory_records WHERE id = ?")
          .get(memoryId) as Row | undefined;
        if (!row) throw new Error(`memory ${memoryId} does not exist`);
        if (![input.sourceNodeId, input.targetNodeId].includes(String(row.node_id))) {
          throw new Error(`memory ${memoryId} does not belong to either proposed node`);
        }
      }
      const symmetric = ["contradicts", "distinct_from", "related_to", "same_as"].includes(
        input.relationType,
      );
      const nodes = symmetric
        ? [input.sourceNodeId, input.targetNodeId].sort()
        : [input.sourceNodeId, input.targetNodeId];
      const proposalKey = `semantic:${input.relationType}:${nodes.join(":")}`;
      const existing = this.db
        .prepare(
          "SELECT * FROM topology_proposals WHERE proposal_key = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        )
        .get(proposalKey) as Row | undefined;
      if (existing) {
        const proposal = mapTopologyProposal(existing);
        const combinedEvidence = [
          ...new Set([...proposal.evidenceMemoryIds, ...evidenceMemoryIds]),
        ];
        const observations = proposal.observations + 1;
        const estimatedGain =
          (proposal.estimatedGain * proposal.observations + clamp(input.confidence ?? 0.5, 0, 1)) /
          observations;
        this.db
          .prepare(
            `UPDATE topology_proposals
             SET evidence_memory_ids_json = ?, observations = ?, estimated_gain = ?
             WHERE id = ?`,
          )
          .run(JSON.stringify(combinedEvidence), observations, estimatedGain, proposal.id);
        return {
          ...proposal,
          evidenceMemoryIds: combinedEvidence,
          observations,
          estimatedGain,
        };
      }
      return this.insertTopologyProposal({
        proposalKey,
        type: "link",
        sourceNodeIds: [input.sourceNodeId, input.targetNodeId],
        relationType: input.relationType,
        partitions: [],
        evidenceTraceIds: [],
        evidenceMemoryIds,
        observations: 1,
        estimatedGain: clamp(input.confidence ?? 0.5, 0, 1),
      });
    }

    topologyProposals(status: TopologyProposal["status"] = "pending"): TopologyProposal[] {
      return (
        this.db
          .prepare("SELECT * FROM topology_proposals WHERE status = ? ORDER BY created_at, id")
          .all(status) as Row[]
      ).map(mapTopologyProposal);
    }

    /**
     * Conservative, read-only gate for a future automatic identity merge.
     * Passing this gate does not mutate topology; natural-data precision and a
     * separately enabled actuator are still required.
     */
    assessAutomaticMergeProposal(
      proposalId: string,
      policy: {
        minimumObservations?: number;
        minimumEstimatedGain?: number;
        minimumEvidenceMemories?: number;
      } = {},
    ): TopologyAutomationAssessment {
      const minimumObservations = Math.max(3, policy.minimumObservations ?? 5);
      const minimumEstimatedGain = clamp(policy.minimumEstimatedGain ?? 0.98, 0.9, 1);
      const minimumEvidenceMemories = Math.max(2, policy.minimumEvidenceMemories ?? 4);
      const row = this.db
        .prepare("SELECT * FROM topology_proposals WHERE id = ?")
        .get(proposalId) as Row | undefined;
      if (!row) throw new Error(`topology proposal ${proposalId} does not exist`);
      const proposal = mapTopologyProposal(row);
      const reasons: string[] = [];
      if (proposal.status !== "pending") reasons.push("proposal_not_pending");
      if (proposal.type !== "link" || proposal.relationType !== "same_as") {
        reasons.push("not_identity_proposal");
      }
      if (proposal.observations < minimumObservations) reasons.push("insufficient_observations");
      if (proposal.estimatedGain < minimumEstimatedGain) reasons.push("insufficient_confidence");
      if (proposal.evidenceMemoryIds.length < minimumEvidenceMemories) {
        reasons.push("insufficient_evidence_memories");
      }
      const evidenceRows = proposal.evidenceMemoryIds.map(
        (memoryId) =>
          this.db
            .prepare("SELECT node_id, scope_json, status FROM memory_records WHERE id = ?")
            .get(memoryId) as Row | undefined,
      );
      if (evidenceRows.some((candidate) => !candidate || candidate.status !== "active")) {
        reasons.push("missing_or_inactive_evidence");
      }
      for (const nodeId of proposal.sourceNodeIds) {
        if (!evidenceRows.some((candidate) => String(candidate?.node_id ?? "") === nodeId)) {
          reasons.push("evidence_not_balanced_across_nodes");
          break;
        }
      }
      const scopes = new Set(
        evidenceRows
          .filter((candidate): candidate is Row => Boolean(candidate))
          .map((item) => String(item.scope_json)),
      );
      if (scopes.size > 1) reasons.push("scope_mismatch");
      let targetName: string | null = null;
      if (scopes.size === 1) {
        try {
          const scope = JSON.parse([...scopes][0] ?? "{}") as Record<string, unknown>;
          const identityValues = Object.entries(scope).filter(
            ([, value]) => typeof value === "string" && value.trim().length > 0,
          );
          if (identityValues.length === 1) targetName = String(identityValues[0]![1]).trim();
          else reasons.push("ambiguous_target_identity");
        } catch {
          reasons.push("invalid_scope_identity");
        }
      }
      if (targetName) {
        const canonicalIdentity = canonicalNodeIdentity(targetName);
        const existingTarget = (
          this.db.prepare("SELECT id, canonical_name FROM memory_nodes WHERE status = 'active'").all() as Row[]
        ).find(
          (candidate) => canonicalNodeIdentity(String(candidate.canonical_name)) === canonicalIdentity,
        );
        if (existingTarget) reasons.push("target_name_already_active");
      }
      const proposedNodes = [...proposal.sourceNodeIds].sort().join("\0");
      const competing = (
        this.db
          .prepare(
            `SELECT source_node_ids_json FROM topology_proposals
             WHERE id <> ? AND status = 'pending'
               AND relation_type IN ('distinct_from', 'contradicts')`,
          )
          .all(proposal.id) as Row[]
      ).some(
        (candidate) =>
          parseStringArray(candidate.source_node_ids_json).sort().join("\0") === proposedNodes,
      );
      if (competing) reasons.push("competing_conflict_proposal");
      return {
        proposalId,
        eligible: reasons.length === 0,
        reasons: [...new Set(reasons)],
        targetName,
        policy: { minimumObservations, minimumEstimatedGain, minimumEvidenceMemories },
      };
    }

    actuateAutomaticMergeProposal(proposalId: string): NodeTransform {
      const assessment = this.assessAutomaticMergeProposal(proposalId);
      if (!assessment.eligible || !assessment.targetName) {
        throw new Error(
          `topology proposal ${proposalId} is not eligible for automatic merge: ${assessment.reasons.join(",")}`,
        );
      }
      const proposal = this.topologyProposals("pending").find((item) => item.id === proposalId);
      if (!proposal) throw new Error(`topology proposal ${proposalId} is not pending`);
      try {
        const transform = this.mergeNodes({
          sourceNodeIds: proposal.sourceNodeIds,
          targetName: assessment.targetName,
        });
        const actuatedAt = new Date().toISOString();
        this.db
          .prepare(
            `UPDATE topology_proposals
             SET status = 'accepted', actuated_transform_id = ?, actuation_error = NULL,
                 actuated_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(transform.id, actuatedAt, proposalId);
        return transform;
      } catch (error) {
        this.db
          .prepare("UPDATE topology_proposals SET actuation_error = ? WHERE id = ? AND status = 'pending'")
          .run(error instanceof Error ? error.message : String(error), proposalId);
        throw error;
      }
    }

    reviewTopologyProposal(proposalId: string, decision: "accept" | "reject"): TopologyProposal {
      const row = this.db
        .prepare("SELECT * FROM topology_proposals WHERE id = ?")
        .get(proposalId) as Row | undefined;
      if (!row) throw new Error(`topology proposal ${proposalId} does not exist`);
      const proposal = mapTopologyProposal(row);
      if (proposal.status !== "pending") {
        throw new Error(`topology proposal ${proposalId} is already ${proposal.status}`);
      }
      if (decision === "reject") {
        this.db
          .prepare("UPDATE topology_proposals SET status = 'rejected' WHERE id = ?")
          .run(proposalId);
        return { ...proposal, status: "rejected" };
      }
      if (proposal.type === "link") {
        const evidenceIds = [
          ...new Set(proposal.evidenceMemoryIds.flatMap((memoryId) => this.evidenceIds(memoryId))),
        ];
        this.linkNodes({
          sourceNodeId: proposal.sourceNodeIds[0]!,
          targetNodeId: proposal.sourceNodeIds[1]!,
          type: proposal.relationType ?? "related_to",
          evidenceIds,
        });
      } else {
        const source = this.requireNode(proposal.sourceNodeIds[0]!);
        this.splitNode({
          sourceNodeId: source.id,
          partitions: proposal.partitions.map((partition, index) => ({
            nodeName: `${source.canonicalName} / ${partitionLabel(partition.label, index)}`,
            memoryIds: partition.memoryIds,
          })),
        });
      }
      this.db
        .prepare("UPDATE topology_proposals SET status = 'accepted' WHERE id = ?")
        .run(proposalId);
      return { ...proposal, status: "accepted" };
    }
  };
}

/**
 * Iterative three-colour DFS for directed cycles (docs §7.2). Returns each
 * elementary cycle once as an ordered node-id sequence. Iterative (explicit
 * stack of edge iterators) so large graphs cannot blow the call stack.
 */
/**
 * Relation types whose bidirectional pairs are legitimate (docs §7.2): a
 * mutual contradiction is a normal symmetric semantic, so these never count
 * as cycles in detectGraphCycles.
 */
const SYMMETRIC_RELATION_TYPES = new Set([
  "contradicts",
  "same_as",
  "distinct_from",
  "related_to",
]);

function findDirectedCycles(
  adj: Map<string, Array<{ to: string; edgeId: string }>>,
): string[][] {
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const cycles: string[][] = [];
  const seen = new Set<string>();

  for (const start of adj.keys()) {
    if (color.get(start) !== undefined) continue;
    const stack: string[] = [];
    const inStack = new Set<string>();
    const iterators = new Map<string, Iterator<{ to: string; edgeId: string }>>();
    const push = (nodeId: string) => {
      stack.push(nodeId);
      inStack.add(nodeId);
      color.set(nodeId, GRAY);
      iterators.set(nodeId, (adj.get(nodeId) ?? [])[Symbol.iterator]());
    };
    push(start);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const step = iterators.get(top)!.next();
      if (step.done) {
        stack.pop();
        inStack.delete(top);
        color.set(top, BLACK);
        iterators.delete(top);
        continue;
      }
      const { to } = step.value;
      if (inStack.has(to)) {
        const index = stack.indexOf(to);
        const cycle = stack.slice(index).concat(to);
        const key = [...cycle].sort().join("|");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (color.get(to) === undefined) {
        push(to);
      }
    }
  }
  return cycles;
}
