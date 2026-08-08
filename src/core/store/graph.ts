/**
 * Graph cluster of NmgStore methods — official TypeScript mixin pattern
 * (docs/store-cluster-split.md, cluster-dag.test.ts).
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
  TopologyProposal,
  VectorEmbedder,
} from "../types.ts";

export const DEFAULT_CONSOLIDATION_POLICY = {
  minIndependentTasks: 3,
  promoteThreshold: 0.75,
  demoteThreshold: 0.45,
  cooldownMs: 7 * 24 * 60 * 60 * 1_000,
} as const;

export const DEFAULT_TOPOLOGY_POLICY = {
  minObservations: 3,
  minGain: 0.6,
  cooldownMs: 7 * 24 * 60 * 60 * 1_000,
} as const;

import type { Constructor } from "./store-ctor.ts";
import type { Router } from "../router.ts";
import type { Float32VectorCache } from "../vector-cache.ts";
import { parseStringArray } from "./row-parse.ts";
import {
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

export function withGraph<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    // Base-class members (resolved at assembly time)
    declare protected db: DatabaseSync;
    declare protected embedder: VectorEmbedder;
    declare protected router: Router;
    declare protected vectorCaches: Map<string, Float32VectorCache>;

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
      observations: number;
      estimatedGain: number;
    }) => TopologyProposal;
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
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const target = this.upsertNode({
          canonicalName: input.targetName,
          kind: input.targetKind ?? sources[0]!.kind,
          summary: input.summary,
        });
        if (sourceNodeIds.includes(target.id)) {
          throw new Error("merge target must be distinct from every source node");
        }
        const movedMemoryIds = this.memoryIdsForNodes(sourceNodeIds);
        const operation = this.createTransform("merge", sourceNodeIds, [target.id], movedMemoryIds);
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
      const row = this.db.prepare("SELECT * FROM node_transforms WHERE id = ?").get(transformId) as
        Row | undefined;
      if (!row) return null;
      return {
        id: String(row.id),
        type: String(row.transform_type) as NodeTransform["type"],
        sourceNodeIds: parseStringArray(row.source_node_ids_json),
        targetNodeIds: parseStringArray(row.target_node_ids_json),
        movedMemoryIds: parseStringArray(row.moved_memory_ids_json),
        createdAt: String(row.created_at),
      };
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

    trainRouter(query: string, usefulNodeIds: string[], learningRate = 0.2): void {
      const uniqueIds = [...new Set(usefulNodeIds)];
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
          const weights = this.router.update(
            query,
            row ? parseVector(row.weights_json) : undefined,
            clamp(learningRate, 0.001, 1),
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
          ]
        : (this.db
            .prepare(
              `SELECT DISTINCT left_node_id, right_node_id FROM edge_task_observations
             ORDER BY left_node_id, right_node_id`,
            )
            .all() as Row[]);
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
      } = {},
    ): TopologyProposal[] {
      const minObservations = Math.max(
        2,
        options.minObservations ?? DEFAULT_TOPOLOGY_POLICY.minObservations,
      );
      const minGain = clamp(options.minGain ?? DEFAULT_TOPOLOGY_POLICY.minGain, 0, 1);
      const cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_TOPOLOGY_POLICY.cooldownMs);
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
           WHERE p.co_retrieval_count >= ?`,
        )
        .all(minObservations) as Row[];
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
       WHERE s.query_count >= ?`,
        )
        .all(minObservations) as Row[];
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

    topologyProposals(status: TopologyProposal["status"] = "pending"): TopologyProposal[] {
      return (
        this.db
          .prepare("SELECT * FROM topology_proposals WHERE status = ? ORDER BY created_at, id")
          .all(status) as Row[]
      ).map(mapTopologyProposal);
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
        this.linkNodes({
          sourceNodeId: proposal.sourceNodeIds[0]!,
          targetNodeId: proposal.sourceNodeIds[1]!,
          type: proposal.relationType ?? "related_to",
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
