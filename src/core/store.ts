import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  EmbeddingDocument,
  ExternalEmbedding,
  ExternalLeafEmbedding,
  ExternalNodeEmbedding,
  DeriveMemoryInput,
  HistoryRecord,
  HistoryRole,
  MemoryContext,
  MemoryNode,
  MemoryNodeKind,
  LeafBlock,
  LeafEmbeddingDocument,
  NodeEmbeddingDocument,
  NodeRoute,
  NodeTransform,
  MemoryRecord,
  MemorySearchResult,
  MemoryScope,
  MemoryStatus,
  MemoryTier,
  NodeRelation,
  NodeRelationType,
  RememberInput,
  RememberResult,
  RebalanceResult,
  RecallCue,
  RecallIndex,
  SearchOptions,
  SessionArchive,
  VectorEmbedder,
} from "./types.ts";
import { blockTiers, huffmanDepths } from "./hierarchy.ts";
import { OnlineNodeRouter } from "./router.ts";
import { cosineSimilarity, HashingVectorEmbedder } from "./vector.ts";

type Row = Record<string, string | number | null>;

const MAX_SEARCH_CANDIDATES = 500;

export class NmgStore {
  readonly #db: DatabaseSync;
  readonly #embedder: VectorEmbedder;
  readonly #router: OnlineNodeRouter;

  constructor(databasePath: string, embedder: VectorEmbedder = new HashingVectorEmbedder()) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new DatabaseSync(databasePath);
    this.#embedder = embedder;
    this.#router = new OnlineNodeRouter(embedder);
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  appendHistory(input: {
    content: string;
    role: HistoryRole;
    sessionId?: string;
    sourceMessageId?: string;
    sourceRef?: string;
  }): HistoryRecord {
    const content = requireText(input.content, "history content");
    const sourceMessageId = input.sourceMessageId?.trim() || null;
    if (sourceMessageId) {
      if (!input.sessionId?.trim()) {
        throw new Error("sourceMessageId requires sessionId");
      }
      const existing = this.#db.prepare(
        "SELECT * FROM history_records WHERE session_id = ? AND source_message_id = ?",
      ).get(input.sessionId, sourceMessageId) as Row | undefined;
      if (existing) {
        const record = mapHistory(existing);
        if (record.content !== content || record.role !== input.role) {
          throw new Error(`source message ${sourceMessageId} already exists with different content`);
        }
        return record;
      }
    }
    const record: HistoryRecord = {
      id: randomUUID(),
      sessionId: input.sessionId ?? null,
      sourceMessageId,
      role: input.role,
      content,
      sourceRef: input.sourceRef ?? null,
      createdAt: new Date().toISOString(),
    };

    this.#db
      .prepare(
        `INSERT INTO history_records
          (id, session_id, source_message_id, role, content, source_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.sourceMessageId,
        record.role,
        record.content,
        record.sourceRef,
        record.createdAt,
      );

    return record;
  }

  upsertNode(input: {
    canonicalName: string;
    kind?: MemoryNodeKind;
    summary?: string;
  }): MemoryNode {
    const canonicalName = requireText(input.canonicalName, "node name");
    const existing = this.#db
      .prepare("SELECT * FROM memory_nodes WHERE canonical_name = ?")
      .get(canonicalName) as Row | undefined;

    if (existing) {
      const node = mapNode(existing);
      if (node.status === "active") return node;
      const redirects = this.#db.prepare(
        `SELECT n.* FROM node_redirects r
         JOIN memory_nodes n ON n.id = r.target_node_id
         WHERE r.source_node_id = ? AND n.status = 'active'`,
      ).all(node.id) as Row[];
      const unique = [...new Map(redirects.map((row) => [String(row.id), row])).values()];
      if (unique.length === 1) return mapNode(unique[0]!);
      throw new Error(
        unique.length > 1
          ? `node ${canonicalName} was split; choose a more specific node`
          : `node ${canonicalName} is inactive and has no active redirect`,
      );
    }

    const now = new Date().toISOString();
    const node: MemoryNode = {
      id: randomUUID(),
      canonicalName,
      kind: input.kind ?? "concept",
      summary: input.summary?.trim() || canonicalName,
      createdAt: now,
      updatedAt: now,
      status: "active",
    };

    this.#db
      .prepare(
        `INSERT INTO memory_nodes
          (id, canonical_name, kind, summary, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        node.canonicalName,
        node.kind,
        node.summary,
        node.createdAt,
        node.updatedAt,
        node.status,
      );

    return node;
  }

  addMemory(input: {
    nodeId: string;
    evidenceId: string;
    statement: string;
    memoryType?: MemoryRecord["memoryType"];
    stateKey?: string;
    eventTime?: string;
    sourceActor?: MemoryRecord["sourceActor"];
    truthStatus?: MemoryRecord["truthStatus"];
    tier?: MemoryTier;
    importance?: number;
    scope?: MemoryScope;
    validFrom?: string;
    validUntil?: string;
    evidenceRole?: MemoryRecord["evidenceRole"];
    supersedesId?: string;
  }): MemoryRecord {
    const createdAt = new Date().toISOString();
    const memory: MemoryRecord = {
      id: randomUUID(),
      nodeId: input.nodeId,
      evidenceId: input.evidenceId,
      evidenceIds: [input.evidenceId],
      statement: requireText(input.statement, "memory statement"),
      memoryType: input.memoryType ?? "fact",
      stateKey: input.stateKey ?? null,
      eventTime: input.eventTime ?? null,
      sourceActor: input.sourceActor ?? "user",
      truthStatus: input.truthStatus ?? "asserted",
      scope: input.scope ?? {},
      validFrom: input.validFrom ?? createdAt,
      validUntil: input.validUntil ?? null,
      status: "active",
      evidenceRole: input.evidenceRole ?? "support",
      supersedesId: input.supersedesId ?? null,
      tier: input.tier ?? 1,
      importance: clamp(input.importance ?? 0.5, 0, 1),
      accessCount: 0,
      lastAccessedAt: null,
      createdAt,
    };

    this.#db
      .prepare(
        `INSERT INTO memory_records
          (id, node_id, evidence_id, statement, memory_type, state_key,
           event_time, source_actor, truth_status, scope_json, valid_from,
           valid_until, status, evidence_role, supersedes_id, tier, importance,
           access_count, last_accessed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
      )
      .run(
        memory.id,
        memory.nodeId,
        memory.evidenceId,
        memory.statement,
        memory.memoryType,
        memory.stateKey,
        memory.eventTime,
        memory.sourceActor,
        memory.truthStatus,
        serializeScope(memory.scope),
        memory.validFrom,
        memory.validUntil,
        memory.status,
        memory.evidenceRole,
        memory.supersedesId,
        memory.tier,
        memory.importance,
        memory.createdAt,
      );
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO memory_evidence_links (memory_id, history_id)
         VALUES (?, ?)`,
      )
      .run(memory.id, memory.evidenceId);
    this.#upsertEmbedding(memory.id, this.#memoryText(memory, input.nodeId));
    this.#upsertFts(memory.id, memory.statement, input.nodeId, input.evidenceId);
    this.#db.prepare(
      `INSERT INTO leaf_block_status (node_id, dirty, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(node_id) DO UPDATE SET dirty = 1, updated_at = excluded.updated_at`,
    ).run(input.nodeId, createdAt);

    return memory;
  }

  remember(input: RememberInput): RememberResult {
    const memoryType = input.memoryType ?? "fact";
    if (memoryType === "state" && !input.stateKey?.trim()) {
      throw new Error("state memories require a stable stateKey");
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const history = input.evidenceHistoryId
        ? this.#requireHistory(input.evidenceHistoryId)
        : this.appendHistory({
            content: input.evidence ?? input.statement,
            role: "explicit",
            sessionId: input.sessionId,
            sourceRef: input.sourceRef,
          });
      const node = this.upsertNode({
        canonicalName: input.nodeName,
        kind: input.nodeKind,
        summary: input.nodeSummary,
      });
      const stateKey = memoryType === "state" && input.stateKey
        ? this.#resolveStateKey(input.stateKey, input.scope ?? {}, node)
        : input.stateKey;
      const automaticPrevious = memoryType === "state" && stateKey
        ? this.#db
            .prepare(
              `SELECT id FROM memory_records
               WHERE memory_type = 'state' AND state_key = ? AND scope_json = ?
                 AND status = 'active'
               ORDER BY created_at DESC LIMIT 1`,
            )
            .get(stateKey, serializeScope(input.scope ?? {})) as Row | undefined
        : undefined;
      const supersedesId = input.supersedesId ??
        (automaticPrevious ? String(automaticPrevious.id) : undefined);
      if (supersedesId) {
        const previous = this.#db
          .prepare("SELECT node_id FROM memory_records WHERE id = ?")
          .get(supersedesId) as Row | undefined;
        if (!previous) throw new Error(`memory ${supersedesId} does not exist`);
        this.#db
          .prepare(
            `UPDATE memory_records
             SET status = 'superseded', valid_until = ?
             WHERE id = ?`,
          )
          .run(input.validFrom ?? new Date().toISOString(), supersedesId);
      }
      const memory = this.addMemory({
        nodeId: node.id,
        evidenceId: history.id,
        statement: input.statement,
        memoryType,
        stateKey,
        eventTime: input.eventTime,
        sourceActor: input.sourceActor,
        truthStatus: input.truthStatus,
        tier: input.tier,
        importance: input.importance,
        scope: input.scope,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        evidenceRole: input.evidenceRole ?? (supersedesId ? "update" : undefined),
        supersedesId,
      });
      this.#db.exec("COMMIT");
      return { history, node, memory };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  deriveMemory(input: DeriveMemoryInput): RememberResult {
    const sourceMemoryIds = [...new Set(input.sourceMemoryIds)];
    if (sourceMemoryIds.length < 2) {
      throw new Error("derived memories require at least two source memories");
    }
    const sources = sourceMemoryIds.map((id) => {
      const row = this.#db
        .prepare("SELECT id, node_id, evidence_id FROM memory_records WHERE id = ?")
        .get(id) as Row | undefined;
      if (!row) throw new Error(`source memory ${id} does not exist`);
      return row;
    });

    const result = this.remember({
      ...input,
      memoryType: "derived",
      evidence: input.derivation,
      sourceActor: input.sourceActor ?? "assistant",
      truthStatus: input.truthStatus ?? "inferred",
    });

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const linkEvidence = this.#db.prepare(
        `INSERT OR IGNORE INTO memory_evidence_links (memory_id, history_id)
         VALUES (?, ?)`,
      );
      const linkDerivation = this.#db.prepare(
        `INSERT INTO memory_derivations (derived_memory_id, source_memory_id)
         VALUES (?, ?)`,
      );
      for (const source of sources) {
        const evidenceIds = this.#evidenceIds(String(source.id));
        for (const evidenceId of evidenceIds) {
          linkEvidence.run(result.memory.id, evidenceId);
        }
        linkDerivation.run(result.memory.id, String(source.id));
        this.linkNodes({
          sourceNodeId: result.node.id,
          targetNodeId: String(source.node_id),
          type: "derived_from",
          evidenceIds,
        });
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    result.memory.evidenceIds = this.#evidenceIds(result.memory.id);
    return result;
  }

  linkNodes(input: {
    sourceNodeId: string;
    targetNodeId: string;
    type: NodeRelationType;
    evidenceIds?: string[];
  }): NodeRelation {
    const existing = this.#db
      .prepare(
        `SELECT * FROM node_relations
         WHERE source_node_id = ? AND target_node_id = ? AND relation_type = ?`,
      )
      .get(input.sourceNodeId, input.targetNodeId, input.type) as Row | undefined;
    if (existing) {
      const relation = mapRelation(existing);
      const evidenceIds = [...new Set([...relation.evidenceIds, ...(input.evidenceIds ?? [])])];
      if (evidenceIds.length !== relation.evidenceIds.length) {
        this.#db.prepare("UPDATE node_relations SET evidence_ids_json = ? WHERE id = ?")
          .run(JSON.stringify(evidenceIds), relation.id);
        relation.evidenceIds = evidenceIds;
      }
      return relation;
    }

    const relation: NodeRelation = {
      id: randomUUID(),
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      type: input.type,
      evidenceIds: [...new Set(input.evidenceIds ?? [])],
      createdAt: new Date().toISOString(),
    };
    this.#db
      .prepare(
        `INSERT INTO node_relations
          (id, source_node_id, target_node_id, relation_type,
           evidence_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        relation.id,
        relation.sourceNodeId,
        relation.targetNodeId,
        relation.type,
        JSON.stringify(relation.evidenceIds),
        relation.createdAt,
      );
    return relation;
  }

  getRelations(nodeIds: string[], maxHops = 1): NodeRelation[] {
    const visitedNodes = new Set(nodeIds);
    const relations = new Map<string, NodeRelation>();
    let frontier = [...visitedNodes];
    for (let hop = 0; hop < Math.max(0, maxHops) && frontier.length > 0; hop += 1) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        const rows = this.#db
          .prepare(
            `SELECT * FROM node_relations
             WHERE source_node_id = ? OR target_node_id = ?`,
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
    const sources = sourceNodeIds.map((id) => this.#requireNode(id));
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const target = this.upsertNode({
        canonicalName: input.targetName,
        kind: input.targetKind ?? sources[0]!.kind,
        summary: input.summary,
      });
      if (sourceNodeIds.includes(target.id)) {
        throw new Error("merge target must be distinct from every source node");
      }
      const movedMemoryIds = this.#memoryIdsForNodes(sourceNodeIds);
      const operation = this.#createTransform("merge", sourceNodeIds, [target.id], movedMemoryIds);
      for (const sourceId of sourceNodeIds) {
        this.#db.prepare("UPDATE memory_records SET node_id = ? WHERE node_id = ?")
          .run(target.id, sourceId);
        this.#redirectRelations(sourceId, target.id);
        this.#db.prepare("UPDATE memory_nodes SET status = 'merged', updated_at = ? WHERE id = ?")
          .run(operation.createdAt, sourceId);
        this.#db.prepare(
          `INSERT INTO node_redirects (source_node_id, target_node_id, transform_id)
           VALUES (?, ?, ?)`,
        ).run(sourceId, target.id, operation.id);
      }
      this.#db.exec("COMMIT");
      this.#refreshEmbeddings(movedMemoryIds);
      return operation;
    } catch (error) {
      this.#db.exec("ROLLBACK");
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
    const source = this.#requireNode(input.sourceNodeId);
    if (input.partitions.length < 2) throw new Error("split requires at least two partitions");
    const assigned = input.partitions.flatMap((partition) => partition.memoryIds);
    if (new Set(assigned).size !== assigned.length) {
      throw new Error("a memory cannot belong to two split partitions");
    }
    const available = new Set(this.#memoryIdsForNodes([source.id]));
    if (assigned.some((id) => !available.has(id))) {
      throw new Error("split partitions may contain only memories from the source node");
    }
    if (assigned.length !== available.size) {
      throw new Error("split partitions must assign every source memory exactly once");
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const targets = input.partitions.map((partition) => this.upsertNode({
        canonicalName: partition.nodeName,
        kind: partition.nodeKind ?? source.kind,
        summary: partition.summary,
      }));
      if (new Set(targets.map((node) => node.id)).size !== targets.length ||
          targets.some((node) => node.id === source.id)) {
        throw new Error("split targets must be new, distinct semantic nodes");
      }
      const operation = this.#createTransform(
        "split", [source.id], targets.map((node) => node.id), assigned,
      );
      for (let index = 0; index < input.partitions.length; index += 1) {
        const partition = input.partitions[index]!;
        const target = targets[index]!;
        const update = this.#db.prepare("UPDATE memory_records SET node_id = ? WHERE id = ?");
        for (const memoryId of partition.memoryIds) update.run(target.id, memoryId);
        this.linkNodes({ sourceNodeId: target.id, targetNodeId: source.id, type: "is_a" });
        this.#db.prepare(
          `INSERT INTO node_redirects (source_node_id, target_node_id, transform_id)
           VALUES (?, ?, ?)`,
        ).run(source.id, target.id, operation.id);
      }
      this.#db.prepare("UPDATE memory_nodes SET status = 'split', updated_at = ? WHERE id = ?")
        .run(operation.createdAt, source.id);
      this.#db.exec("COMMIT");
      this.#refreshEmbeddings(assigned);
      return operation;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getNodeTransform(transformId: string): NodeTransform | null {
    const row = this.#db.prepare("SELECT * FROM node_transforms WHERE id = ?")
      .get(transformId) as Row | undefined;
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
    const rows = this.#db.prepare(
      `SELECT n.*, r.weights_json
       FROM memory_nodes n LEFT JOIN router_weights r ON r.node_id = n.id
       WHERE n.status = 'active'`,
    ).all() as Row[];
    const normalized = normalize(query);
    return rows.map((row) => {
      const node = mapNode(row);
      const learned = this.#router.score(query, parseVector(row.weights_json));
      const lexical = lexicalNodeScore(normalized, node);
      return { node, score: learned * 0.7 + lexical * 0.3 };
    }).filter((route) => route.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(limit, 50)));
  }

  routeNodesByVector(
    queryVector: readonly number[],
    model: string,
    limit = 5,
    candidateNodeIds: string[] = [],
  ): NodeRoute[] {
    if (!model.trim()) throw new Error("embedding model is required");
    if (queryVector.length === 0) throw new Error("query vector is required");
    const candidates = [...new Set(candidateNodeIds)].slice(0, 2_000);
    const clause = candidates.length > 0
      ? `AND n.id IN (${candidates.map(() => "?").join(",")})`
      : "";
    const rows = this.#db.prepare(
      `SELECT n.*, e.vector_json
       FROM memory_nodes n JOIN node_embeddings e ON e.node_id = n.id AND e.model = ?
       WHERE n.status = 'active' ${clause}`,
    ).all(model, ...candidates) as Row[];
    return rows.map((row) => ({
      node: mapNode(row),
      score: cosineSimilarity(queryVector, parseVector(row.vector_json)),
    })).filter((route) => route.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(limit, 50)));
  }

  trainRouter(query: string, usefulNodeIds: string[], learningRate = 0.2): void {
    const uniqueIds = [...new Set(usefulNodeIds)];
    const upsert = this.#db.prepare(
      `INSERT INTO router_weights (node_id, model, dimensions, weights_json, examples, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(node_id) DO UPDATE SET weights_json = excluded.weights_json,
         examples = router_weights.examples + 1, updated_at = excluded.updated_at`,
    );
    const select = this.#db.prepare("SELECT weights_json FROM router_weights WHERE node_id = ?");
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const nodeId of uniqueIds) {
        this.#requireNode(nodeId);
        const row = select.get(nodeId) as Row | undefined;
        const weights = this.#router.update(query, row ? parseVector(row.weights_json) : undefined,
          clamp(learningRate, 0.001, 1));
        upsert.run(nodeId, this.#embedder.model, this.#embedder.dimensions,
          JSON.stringify(weights), now);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  rebuildVectorIndex(): number {
    const rows = this.#db.prepare(
      `SELECT m.id, m.statement, m.node_id, n.canonical_name, n.summary
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id`,
    ).all() as Row[];
    const upsert = this.#db.prepare(
      `INSERT INTO memory_embeddings (memory_id, model, dimensions, vector_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, model) DO UPDATE SET
         dimensions = excluded.dimensions, vector_json = excluded.vector_json,
         updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const text = `${row.statement} ${row.canonical_name} ${row.summary}`;
        upsert.run(row.id, this.#embedder.model, this.#embedder.dimensions,
          JSON.stringify(this.#embedder.embed(text)), now);
      }
      this.#db.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  rebalanceNode(
    nodeId: string,
    capacities: readonly [number, number, number] = [16, 64, 256],
  ): RebalanceResult {
    this.#requireNode(nodeId);
    const rows = this.#db.prepare(
      `SELECT id, tier, importance, access_count, pending_access_count,
              last_accessed_at, status
       FROM memory_records WHERE node_id = ?`,
    ).all(nodeId) as Row[];
    const active = rows.filter((row) => ["active", "disputed"].includes(String(row.status)));
    const weighted = active.map((row) => ({
      id: String(row.id),
      weight: hierarchyWeight(row),
    }));
    const depths = huffmanDepths(weighted);
    const tiers = blockTiers(depths, capacities);
    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0) || 1;
    const expectedDepth = weighted.reduce(
      (sum, item) => sum + item.weight / totalWeight * (depths.get(item.id) ?? 0), 0,
    );
    const changedMemoryIds: string[] = [];
    const update = this.#db.prepare(
      "UPDATE memory_records SET tier = ?, pending_access_count = 0 WHERE id = ?",
    );
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of active) {
        const id = String(row.id);
        const tier = tiers.get(id) ?? 3;
        if (tier !== Number(row.tier)) changedMemoryIds.push(id);
        update.run(tier, id);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return {
      nodeId,
      changedMemoryIds,
      expectedDepth,
      pendingAccesses: rows.reduce((sum, row) => sum + Number(row.pending_access_count ?? 0), 0),
    };
  }

  rebalanceDueNodes(
    threshold = 32,
    capacities: readonly [number, number, number] = [16, 64, 256],
  ): RebalanceResult[] {
    const rows = this.#db.prepare(
      `SELECT node_id, SUM(pending_access_count) AS pending
       FROM memory_records GROUP BY node_id HAVING pending >= ?`,
    ).all(Math.max(1, threshold)) as Row[];
    return rows.map((row) => this.rebalanceNode(String(row.node_id), capacities));
  }

  searchContext(query: string, options: SearchOptions = {}): MemoryContext {
    const limit = Math.max(1, Math.min(options.limit ?? 8, 50));
    const direct = this.search(query, {
      ...options,
      limit: Math.min(50, Math.max(20, limit * 3)),
    });
    const relations = this.getRelations(
      direct.map((result) => result.node.id),
      options.graphHops ?? 1,
    );
    const directNodeIds = new Set(direct.map((result) => result.node.id));
    const relatedNodeIds = [...new Set(relations.flatMap(
      (relation) => [relation.sourceNodeId, relation.targetNodeId],
    ))].filter((id) => !directNodeIds.has(id));
    const related = relatedNodeIds.flatMap(
      (nodeId) => this.#resultsForNode(nodeId, options.maxTier ?? 1, 2),
    );
    const nodeCounts = new Map<string, number>();
    const results = [...direct, ...related]
      .filter(
        (result, index, all) =>
          all.findIndex((candidate) => candidate.memory.id === result.memory.id) === index,
      )
      .sort((left, right) =>
        contextUsefulness(query, right) - contextUsefulness(query, left))
      .filter((result) => {
        const count = nodeCounts.get(result.node.id) ?? 0;
        if (count >= 2) return false;
        nodeCounts.set(result.node.id, count + 1);
        return true;
      })
      .slice(0, limit);
    return { results, relations };
  }

  residentKernel(limit = 4): MemoryContext {
    const rows = this.#db.prepare(
      `SELECT m.id, m.node_id
       FROM memory_records m
       JOIN memory_nodes n ON n.id = m.node_id
       WHERE m.memory_type = 'constraint'
         AND m.tier = 0
         AND m.importance >= 0.8
         AND m.status = 'active'
         AND m.truth_status IN ('asserted', 'verified')
         AND m.source_actor IN ('user', 'tool', 'system')
         AND n.status = 'active'
       ORDER BY m.importance DESC, m.access_count DESC, m.created_at DESC
       LIMIT ?`,
    ).all(Math.max(0, Math.min(limit, 12))) as Row[];
    const byNode = new Map<string, MemorySearchResult[]>();
    const results = rows.flatMap((row) => {
      const nodeId = String(row.node_id);
      let nodeResults = byNode.get(nodeId);
      if (!nodeResults) {
        nodeResults = this.#resultsForNode(nodeId, 0, 50);
        byNode.set(nodeId, nodeResults);
      }
      return nodeResults.filter((result) => result.memory.id === String(row.id));
    });
    return { results, relations: [] };
  }

  recallCues(query: string, options: SearchOptions = {}): RecallIndex {
    const cueLimit = Math.max(1, Math.min(options.limit ?? 5, 12));
    const candidates = this.search(query, {
      ...options,
      maxTier: 3,
      limit: 50,
    });
    const nodeIds = [...new Set(candidates.map((result) => result.node.id))]
      .slice(0, cueLimit);
    const aggregate = this.#db.prepare(
      `SELECT COUNT(*) AS active_count, MAX(created_at) AS newest_at,
              MAX(tier) AS deepest_tier,
              SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) AS conflicts,
              GROUP_CONCAT(DISTINCT memory_type) AS memory_types
       FROM memory_records
       WHERE node_id = ? AND status IN ('active', 'disputed')`,
    );
    const cues: RecallCue[] = nodeIds.map((nodeId) => {
      const matches = candidates.filter((result) => result.node.id === nodeId);
      const best = matches[0]!;
      const row = aggregate.get(nodeId) as Row;
      const deepestTier = Number(row.deepest_tier ?? 0) as MemoryTier;
      return {
        nodeId,
        canonicalName: best.node.canonicalName,
        memoryTypes: String(row.memory_types ?? "").split(",")
          .filter(Boolean) as MemoryRecord["memoryType"][],
        activeCount: Number(row.active_count ?? 0),
        newestAt: row.newest_at ? String(row.newest_at) : null,
        deepestTier,
        hasConflicts: Number(row.conflicts ?? 0) > 0,
        hasDeepMemory: deepestTier > 1,
        score: best.combinedScore,
        reason: recallReason(best),
      };
    });
    return { cues };
  }

  search(query: string, options: SearchOptions = {}): MemorySearchResult[] {
    return this.#searchWithVector(
      query,
      this.#embedder.embed(query),
      this.#embedder.model,
      options,
    );
  }

  searchByVector(
    query: string,
    queryVector: readonly number[],
    model: string,
    options: SearchOptions = {},
  ): MemorySearchResult[] {
    return this.#searchWithVector(query, queryVector, model, {
      ...options,
      retrievalMode: options.retrievalMode ?? "qwen3",
    });
  }

  searchByVectorCandidates(
    query: string,
    queryVector: readonly number[],
    model: string,
    candidateMemoryIds: string[],
    options: SearchOptions = {},
  ): MemorySearchResult[] {
    return this.#searchWithVector(query, queryVector, model, {
      ...options,
      retrievalMode: options.retrievalMode ?? "qwen3",
    }, [...new Set(candidateMemoryIds)].slice(0, 2_000));
  }

  embeddingDocuments(afterMemoryId = "", limit = 256, missingModel?: string): EmbeddingDocument[] {
    const rows = this.#db.prepare(
      `SELECT m.id, m.statement, n.canonical_name, n.summary
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id
       WHERE m.id > ?
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model = ?
         ))
       ORDER BY m.id LIMIT ?`,
    ).all(
      afterMemoryId,
      missingModel ?? null,
      missingModel ?? null,
      Math.max(1, Math.min(limit, 2_048)),
    ) as Row[];
    return rows.map((row) => ({
      memoryId: String(row.id),
      text: `${row.statement} ${row.canonical_name} ${row.summary}`,
    }));
  }

  nodeEmbeddingDocuments(afterNodeId = "", limit = 256, missingModel?: string): NodeEmbeddingDocument[] {
    const rows = this.#db.prepare(
      `SELECT n.id, n.canonical_name, n.kind, n.summary
       FROM memory_nodes n
       WHERE n.id > ? AND n.status = 'active'
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM node_embeddings e WHERE e.node_id = n.id AND e.model = ?
         ))
       ORDER BY n.id LIMIT ?`,
    ).all(
      afterNodeId,
      missingModel ?? null,
      missingModel ?? null,
      Math.max(1, Math.min(limit, 2_048)),
    ) as Row[];
    return rows.map((row) => ({
      nodeId: String(row.id),
      text: `${row.canonical_name} ${row.kind} ${row.summary}`,
    }));
  }

  upsertExternalNodeEmbeddings(model: string, embeddings: ExternalNodeEmbedding[]): number {
    if (!model.trim()) throw new Error("embedding model is required");
    if (embeddings.length === 0) return 0;
    const dimensions = embeddings[0]!.vector.length;
    if (dimensions === 0 || embeddings.some((item) => item.vector.length !== dimensions)) {
      throw new Error("external embeddings must have one consistent non-zero dimension");
    }
    const upsert = this.#db.prepare(
      `INSERT INTO node_embeddings (node_id, model, dimensions, vector_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(node_id, model) DO UPDATE SET dimensions = excluded.dimensions,
         vector_json = excluded.vector_json, updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of embeddings) {
        upsert.run(item.nodeId, model, dimensions, JSON.stringify(item.vector), now);
      }
      this.#db.exec("COMMIT");
      return embeddings.length;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  storedNodeEmbeddings(model: string, afterNodeId = "", limit = 256): ExternalNodeEmbedding[] {
    const rows = this.#db.prepare(
      `SELECT node_id, vector_json FROM node_embeddings
       WHERE model = ? AND node_id > ? ORDER BY node_id LIMIT ?`,
    ).all(model, afterNodeId, Math.max(1, Math.min(limit, 2_048))) as Row[];
    return rows.map((row) => ({
      nodeId: String(row.node_id),
      vector: parseVector(row.vector_json),
    }));
  }

  rebuildLeafBlocks(nodeId?: string, blockSize = 32): LeafBlock[] {
    const size = Math.max(4, Math.min(blockSize, 128));
    if (nodeId) this.#requireNode(nodeId);
    const nodeClause = nodeId ? "AND m.node_id = ?" : "";
    const rows = this.#db.prepare(
      `SELECT m.id, m.node_id, m.statement, m.memory_type, m.scope_json, m.tier,
              m.event_time, m.valid_from, m.valid_until, m.status, n.canonical_name
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id
       WHERE n.status = 'active' AND m.status IN ('active', 'disputed') ${nodeClause}
       ORDER BY m.node_id, m.tier, m.memory_type, m.scope_json, m.created_at DESC`,
    ).all(...(nodeId ? [nodeId] : [])) as Row[];
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = `${row.node_id}\u0000${row.tier}\u0000${row.memory_type}\u0000${row.scope_json}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    const blocks: LeafBlock[] = [];
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (nodeId) this.#db.prepare("DELETE FROM memory_leaf_blocks WHERE node_id = ?").run(nodeId);
      else this.#db.exec("DELETE FROM memory_leaf_blocks");
      const insertBlock = this.#db.prepare(
        `INSERT INTO memory_leaf_blocks
          (id, node_id, tier, summary, memory_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertMember = this.#db.prepare(
        "INSERT INTO memory_leaf_members (block_id, memory_id, ordinal) VALUES (?, ?, ?)",
      );
      for (const group of groups.values()) {
        for (let offset = 0; offset < group.length; offset += size) {
          const members = group.slice(offset, offset + size);
          const block: LeafBlock = {
            id: randomUUID(),
            nodeId: String(members[0]!.node_id),
            tier: Number(members[0]!.tier) as MemoryTier,
            summary: leafBlockSummary(members),
            memoryCount: members.length,
            createdAt: now,
            updatedAt: now,
          };
          insertBlock.run(block.id, block.nodeId, block.tier, block.summary,
            block.memoryCount, block.createdAt, block.updatedAt);
          members.forEach((member, ordinal) => insertMember.run(block.id, member.id, ordinal));
          blocks.push(block);
        }
      }
      if (nodeId) {
        this.#db.prepare(
          `INSERT INTO leaf_block_status (node_id, dirty, updated_at) VALUES (?, 0, ?)
           ON CONFLICT(node_id) DO UPDATE SET dirty = 0, updated_at = excluded.updated_at`,
        ).run(nodeId, now);
      } else {
        this.#db.prepare("UPDATE leaf_block_status SET dirty = 0, updated_at = ?").run(now);
      }
      this.#db.exec("COMMIT");
      return blocks;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  dirtyLeafNodeIds(): string[] {
    const rows = this.#db.prepare(
      "SELECT node_id FROM leaf_block_status WHERE dirty = 1 ORDER BY node_id",
    ).all() as Row[];
    return rows.map((row) => String(row.node_id));
  }

  leafEmbeddingDocuments(afterBlockId = "", limit = 256, missingModel?: string): LeafEmbeddingDocument[] {
    const rows = this.#db.prepare(
      `SELECT b.id, b.node_id, b.summary, n.canonical_name, n.summary AS node_summary
       FROM memory_leaf_blocks b JOIN memory_nodes n ON n.id = b.node_id
       WHERE b.id > ?
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM leaf_embeddings e WHERE e.block_id = b.id AND e.model = ?
         ))
       ORDER BY b.id LIMIT ?`,
    ).all(afterBlockId, missingModel ?? null, missingModel ?? null,
      Math.max(1, Math.min(limit, 2_048))) as Row[];
    return rows.map((row) => ({
      blockId: String(row.id),
      nodeId: String(row.node_id),
      text: `${row.canonical_name} ${row.node_summary} ${row.summary}`,
    }));
  }

  upsertExternalLeafEmbeddings(model: string, embeddings: ExternalLeafEmbedding[]): number {
    if (!model.trim()) throw new Error("embedding model is required");
    if (embeddings.length === 0) return 0;
    const dimensions = embeddings[0]!.vector.length;
    if (dimensions === 0 || embeddings.some((item) => item.vector.length !== dimensions)) {
      throw new Error("external embeddings must have one consistent non-zero dimension");
    }
    const upsert = this.#db.prepare(
      `INSERT INTO leaf_embeddings (block_id, model, dimensions, vector_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(block_id, model) DO UPDATE SET dimensions = excluded.dimensions,
         vector_json = excluded.vector_json, updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of embeddings) {
        upsert.run(item.blockId, model, dimensions, JSON.stringify(item.vector), now);
      }
      this.#db.exec("COMMIT");
      return embeddings.length;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  storedLeafEmbeddings(model: string, afterBlockId = "", limit = 256): ExternalLeafEmbedding[] {
    const rows = this.#db.prepare(
      `SELECT block_id, vector_json FROM leaf_embeddings
       WHERE model = ? AND block_id > ? ORDER BY block_id LIMIT ?`,
    ).all(model, afterBlockId, Math.max(1, Math.min(limit, 2_048))) as Row[];
    return rows.map((row) => ({
      blockId: String(row.block_id),
      vector: parseVector(row.vector_json),
    }));
  }

  routeLeafBlocksByVector(
    queryVector: readonly number[],
    model: string,
    nodeIds: string[] = [],
    limit = 8,
    candidateBlockIds: string[] = [],
  ): Array<{ block: LeafBlock; score: number }> {
    const nodes = [...new Set(nodeIds)].slice(0, 50);
    const blocks = [...new Set(candidateBlockIds)].slice(0, 2_000);
    const nodeClause = nodes.length > 0
      ? `AND b.node_id IN (${nodes.map(() => "?").join(",")})`
      : "";
    const blockClause = blocks.length > 0
      ? `AND b.id IN (${blocks.map(() => "?").join(",")})`
      : "";
    const rows = this.#db.prepare(
      `SELECT b.*, e.vector_json FROM memory_leaf_blocks b
       JOIN leaf_embeddings e ON e.block_id = b.id AND e.model = ?
       WHERE 1 = 1 ${nodeClause} ${blockClause}`,
    ).all(model, ...nodes, ...blocks) as Row[];
    return rows.map((row) => ({
      block: mapLeafBlock(row),
      score: cosineSimilarity(queryVector, parseVector(row.vector_json)),
    })).filter((route) => route.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(limit, 50)));
  }

  searchLeafBlocks(
    query: string,
    queryVector: readonly number[],
    model: string,
    blockIds: string[],
    options: SearchOptions = {},
    blockScores?: ReadonlyMap<string, number>,
  ): MemorySearchResult[] {
    const blocks = [...new Set(blockIds)].slice(0, 50);
    if (blocks.length === 0) return [];
    const rows = this.#db.prepare(
      `SELECT memory_id FROM memory_leaf_members
       WHERE block_id IN (${blocks.map(() => "?").join(",")})
       ORDER BY block_id, ordinal LIMIT 2000`,
    ).all(...blocks) as Row[];
    const requestedLimit = Math.max(1, Math.min(options.limit ?? 8, 50));
    const results = this.#searchWithVector(query, queryVector, model, {
      ...options,
      limit: blockScores ? 50 : requestedLimit,
      retrievalMode: "fts5",
    }, rows.map((row) => String(row.memory_id)));
    if (!blockScores) return results;
    const memberships = this.#db.prepare(
      `SELECT memory_id, block_id FROM memory_leaf_members
       WHERE block_id IN (${blocks.map(() => "?").join(",")})`,
    ).all(...blocks) as Row[];
    const memoryScores = new Map(memberships.map((row) => [
      String(row.memory_id), blockScores.get(String(row.block_id)) ?? 0,
    ]));
    for (const result of results) {
      const leafScore = memoryScores.get(result.memory.id) ?? 0;
      result.routeScore = leafScore;
      result.combinedScore = leafScore * 0.9 + result.lexicalScore * 0.1;
    }
    return results.sort((left, right) => right.combinedScore - left.combinedScore)
      .slice(0, requestedLimit);
  }

  searchHierarchyByVector(
    query: string,
    queryVector: readonly number[],
    model: string,
    options: SearchOptions & { nodeLimit?: number; blockLimit?: number } = {},
  ): MemorySearchResult[] {
    const nodes = this.routeNodesByVector(queryVector, model, options.nodeLimit ?? 5);
    const directLeaves = this.routeLeafBlocksByVector(
      queryVector,
      model,
      [],
      options.blockLimit ?? 8,
    );
    const routedLeaves = this.routeLeafBlocksByVector(
      queryVector,
      model,
      nodes.map((route) => route.node.id),
      options.blockLimit ?? 8,
    );
    const leaves = [...directLeaves, ...routedLeaves]
      .filter((route, index, all) =>
        all.findIndex((candidate) => candidate.block.id === route.block.id) === index)
      .sort((left, right) => right.score - left.score)
      .slice(0, options.blockLimit ?? 8);
    return this.searchLeafBlocks(
      query,
      queryVector,
      model,
      leaves.map((route) => route.block.id),
      options,
      new Map(leaves.map((route) => [route.block.id, route.score])),
    );
  }

  searchNodeFirst(
    query: string,
    queryVector: readonly number[],
    model: string,
    nodeIds: string[],
    options: SearchOptions = {},
  ): MemorySearchResult[] {
    const selected = [...new Set(nodeIds)].slice(0, 50);
    if (selected.length === 0) return [];
    const ftsIds = this.#ftsCandidatesInNodes(query, selected, MAX_SEARCH_CANDIDATES);
    const candidateIds = ftsIds.length > 0
      ? ftsIds
      : (this.#db.prepare(
        `SELECT id FROM memory_records
         WHERE node_id IN (${selected.map(() => "?").join(",")})
           AND tier <= ? AND status IN ('active', 'disputed')
         ORDER BY tier ASC, importance DESC, access_count DESC, created_at DESC
         LIMIT ?`,
      ).all(...selected, options.maxTier ?? 1, MAX_SEARCH_CANDIDATES) as Row[])
        .map((row) => String(row.id));
    return this.#searchWithVector(query, queryVector, model, {
      ...options,
      retrievalMode: "fts5",
    }, candidateIds);
  }

  upsertExternalEmbeddings(model: string, embeddings: ExternalEmbedding[]): number {
    if (!model.trim()) throw new Error("embedding model is required");
    if (embeddings.length === 0) return 0;
    const dimensions = embeddings[0]!.vector.length;
    if (dimensions === 0 || embeddings.some((item) => item.vector.length !== dimensions)) {
      throw new Error("external embeddings must have one consistent non-zero dimension");
    }
    const upsert = this.#db.prepare(
      `INSERT INTO memory_embeddings (memory_id, model, dimensions, vector_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, model) DO UPDATE SET dimensions = excluded.dimensions,
         vector_json = excluded.vector_json, updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of embeddings) {
        upsert.run(item.memoryId, model, dimensions, JSON.stringify(item.vector), now);
      }
      this.#db.exec("COMMIT");
      return embeddings.length;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  storedEmbeddings(model: string, afterMemoryId = "", limit = 256): ExternalEmbedding[] {
    const rows = this.#db.prepare(
      `SELECT memory_id, vector_json FROM memory_embeddings
       WHERE model = ? AND memory_id > ? ORDER BY memory_id LIMIT ?`,
    ).all(model, afterMemoryId, Math.max(1, Math.min(limit, 2_048))) as Row[];
    return rows.map((row) => ({
      memoryId: String(row.memory_id),
      vector: parseVector(row.vector_json),
    }));
  }

  #searchWithVector(
    query: string,
    queryVector: readonly number[],
    vectorModel: string,
    options: SearchOptions,
    forcedCandidateIds: string[] = [],
  ): MemorySearchResult[] {
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) return [];

    const maxTier = options.maxTier ?? 1;
    const limit = Math.max(1, Math.min(options.limit ?? 8, 50));
    const nodeName = options.nodeName
      ? this.#resolveActiveNodeName(options.nodeName)
      : null;
    const retrievalMode = options.retrievalMode ?? "legacy";
    const ftsIds = retrievalMode === "fts5" || retrievalMode === "hybrid"
      ? this.#ftsCandidates(query, MAX_SEARCH_CANDIDATES)
      : [];
    if (retrievalMode === "fts5" && ftsIds.length === 0 && forcedCandidateIds.length === 0) {
      return [];
    }
    const candidateIds = forcedCandidateIds.length > 0 ? forcedCandidateIds : ftsIds;
    const candidateClause = forcedCandidateIds.length > 0
      ? `AND m.id IN (${forcedCandidateIds.map(() => "?").join(",")})`
      : retrievalMode === "qwen3"
      ? "AND ve.vector_json IS NOT NULL"
      : retrievalMode === "fts5"
      ? `AND m.id IN (${ftsIds.map(() => "?").join(",")})`
      : retrievalMode === "hybrid" && ftsIds.length > 0
      ? `AND (m.id IN (${ftsIds.map(() => "?").join(",")}) OR m.id IN (
           SELECT id FROM memory_records ORDER BY tier ASC, importance DESC,
             access_count DESC, created_at DESC LIMIT ${MAX_SEARCH_CANDIDATES}
         ))`
      : "";
    const candidateOrder = forcedCandidateIds.length === 0 &&
        retrievalMode === "hybrid" && ftsIds.length > 0
      ? `CASE WHEN m.id IN (${ftsIds.map(() => "?").join(",")}) THEN 0 ELSE 1 END,`
      : "";
    const rowLimit = forcedCandidateIds.length > 0
      ? forcedCandidateIds.length
      : retrievalMode === "qwen3"
      ? 1_000_000
      : retrievalMode === "fts5"
      ? ftsIds.length
      : MAX_SEARCH_CANDIDATES + ftsIds.length;
    const rows = this.#db
      .prepare(
        `SELECT
           m.id AS m_id, m.node_id AS m_node_id,
           m.evidence_id AS m_evidence_id, m.statement AS m_statement,
           m.memory_type AS m_memory_type, m.state_key AS m_state_key,
           m.event_time AS m_event_time, m.source_actor AS m_source_actor,
           m.truth_status AS m_truth_status,
           m.scope_json AS m_scope_json, m.valid_from AS m_valid_from,
           m.valid_until AS m_valid_until, m.status AS m_status,
           m.evidence_role AS m_evidence_role,
           m.supersedes_id AS m_supersedes_id,
           m.tier AS m_tier, m.importance AS m_importance,
           m.access_count AS m_access_count,
           m.last_accessed_at AS m_last_accessed_at,
           m.created_at AS m_created_at,
           n.id AS n_id, n.canonical_name AS n_canonical_name,
           n.kind AS n_kind, n.summary AS n_summary,
           n.created_at AS n_created_at, n.updated_at AS n_updated_at,
           n.status AS n_status, ve.vector_json AS ve_vector_json,
           h.id AS h_id, h.session_id AS h_session_id, h.role AS h_role,
           h.content AS h_content, h.source_message_id AS h_source_message_id,
           h.source_ref AS h_source_ref,
           h.created_at AS h_created_at
         FROM memory_records m
         JOIN memory_nodes n ON n.id = m.node_id
         JOIN history_records h ON h.id = m.evidence_id
         LEFT JOIN memory_embeddings ve ON ve.memory_id = m.id AND ve.model = ?
         WHERE m.tier <= ?
           ${candidateClause}
           AND n.status = 'active'
           AND (? IS NULL OR n.canonical_name = ?)
           AND (? = 1 OR m.status IN ('active', 'disputed'))
         ORDER BY ${candidateOrder} m.tier ASC, m.importance DESC,
                  m.access_count DESC, m.created_at DESC
         LIMIT ?`,
      )
      .all(
        vectorModel,
        maxTier,
        ...candidateIds,
        nodeName,
        nodeName,
        options.includeHistorical ? 1 : 0,
        ...(forcedCandidateIds.length === 0 && retrievalMode === "hybrid" ? ftsIds : []),
        rowLimit,
      ) as Row[];

    const routes = retrievalMode === "fts5" || retrievalMode === "hashing" ||
        retrievalMode === "qwen3"
      ? new Map<string, number>()
      : new Map(this.routeNodes(query, 20).map((route) => [route.node.id, route.score]));
    const results = rows
      .map((row) => {
        const lexical = lexicalScore(normalizedQuery, row);
        const vector = cosineSimilarity(queryVector, parseVector(row.ve_vector_json));
        const route = routes.get(String(row.m_node_id)) ?? 0;
        const result = mapSearchResult(row, lexical);
        result.vectorScore = retrievalMode === "fts5" ? 0 : vector;
        result.routeScore = route;
        result.combinedScore = retrievalMode === "fts5"
          ? (lexical > 0 ? lexical : forcedCandidateIds.length > 0 ? 0.001 : 0)
          : retrievalMode === "hashing" || retrievalMode === "qwen3"
          ? vector
          : hybridScore(lexical, vector, route);
        return result;
      })
      .filter((result) => matchesScope(result.memory.scope, options.scope))
      .filter((result) => result.combinedScore > 0)
      .sort(
        (left, right) =>
          right.combinedScore - left.combinedScore ||
          left.memory.tier - right.memory.tier ||
          right.memory.importance - left.memory.importance,
      )
      .slice(0, limit);
    for (const result of results) {
      result.memory.evidenceIds = this.#evidenceIds(result.memory.id);
      result.evidenceRecords = this.#evidenceRecords(result.memory.evidenceIds);
    }
    return results;
  }

  recordUsage(memoryIds: string[]): void {
    const uniqueIds = [...new Set(memoryIds)];
    if (uniqueIds.length === 0) return;

    const statement = this.#db.prepare(
      `UPDATE memory_records
       SET access_count = access_count + 1,
           pending_access_count = pending_access_count + 1,
           last_accessed_at = ?
       WHERE id = ?`,
    );
    const now = new Date().toISOString();

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of uniqueIds) statement.run(now, id);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  archiveSession(input: {
    sessionId: string;
    transcript: string;
    sourceRef?: string;
  }): SessionArchive {
    const sessionId = requireText(input.sessionId, "session id");
    const existing = this.getSessionArchive(sessionId);
    if (existing) {
      const row = this.#db
        .prepare("SELECT content FROM history_records WHERE id = ?")
        .get(existing.historyId) as Row | undefined;
      if (row && String(row.content) === input.transcript) return existing;
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const history = this.appendHistory({
        content: input.transcript,
        role: "session",
        sessionId,
        sourceRef: input.sourceRef,
      });
      const archive: SessionArchive = {
        sessionId,
        historyId: history.id,
        createdAt: history.createdAt,
      };
      this.#db.prepare(
        `INSERT INTO session_archives (session_id, history_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           history_id = excluded.history_id,
           created_at = excluded.created_at`,
      ).run(archive.sessionId, archive.historyId, archive.createdAt);
      this.#db.exec("COMMIT");
      return archive;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getSessionArchive(sessionId: string): SessionArchive | null {
    const row = this.#db
      .prepare("SELECT * FROM session_archives WHERE session_id = ?")
      .get(sessionId) as Row | undefined;
    if (!row) return null;
    return {
      sessionId: String(row.session_id),
      historyId: String(row.history_id),
      createdAt: String(row.created_at),
    };
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS history_records (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        source_message_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        source_ref TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES memory_nodes(id),
        evidence_id TEXT NOT NULL REFERENCES history_records(id),
        statement TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'fact',
        state_key TEXT,
        event_time TEXT,
        source_actor TEXT NOT NULL DEFAULT 'user',
        truth_status TEXT NOT NULL DEFAULT 'asserted',
        scope_json TEXT NOT NULL DEFAULT '{}',
        valid_from TEXT,
        valid_until TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        evidence_role TEXT NOT NULL DEFAULT 'support',
        supersedes_id TEXT REFERENCES memory_records(id),
        tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
        importance REAL NOT NULL CHECK (importance BETWEEN 0 AND 1),
        access_count INTEGER NOT NULL DEFAULT 0,
        pending_access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_evidence_links (
        memory_id TEXT NOT NULL REFERENCES memory_records(id),
        history_id TEXT NOT NULL REFERENCES history_records(id),
        PRIMARY KEY (memory_id, history_id)
      );

      CREATE TABLE IF NOT EXISTS memory_derivations (
        derived_memory_id TEXT NOT NULL REFERENCES memory_records(id),
        source_memory_id TEXT NOT NULL REFERENCES memory_records(id),
        PRIMARY KEY (derived_memory_id, source_memory_id)
      );

      CREATE TABLE IF NOT EXISTS node_relations (
        id TEXT PRIMARY KEY,
        source_node_id TEXT NOT NULL REFERENCES memory_nodes(id),
        target_node_id TEXT NOT NULL REFERENCES memory_nodes(id),
        relation_type TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE (source_node_id, target_node_id, relation_type)
      );

      CREATE TABLE IF NOT EXISTS node_transforms (
        id TEXT PRIMARY KEY,
        transform_type TEXT NOT NULL,
        source_node_ids_json TEXT NOT NULL,
        target_node_ids_json TEXT NOT NULL,
        moved_memory_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS node_redirects (
        source_node_id TEXT NOT NULL REFERENCES memory_nodes(id),
        target_node_id TEXT NOT NULL REFERENCES memory_nodes(id),
        transform_id TEXT NOT NULL REFERENCES node_transforms(id),
        PRIMARY KEY (source_node_id, target_node_id, transform_id)
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT NOT NULL REFERENCES memory_records(id),
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, model)
      );

      CREATE TABLE IF NOT EXISTS node_embeddings (
        node_id TEXT NOT NULL REFERENCES memory_nodes(id),
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (node_id, model)
      );

      CREATE TABLE IF NOT EXISTS memory_leaf_blocks (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES memory_nodes(id),
        tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
        summary TEXT NOT NULL,
        memory_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_leaf_members (
        block_id TEXT NOT NULL REFERENCES memory_leaf_blocks(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL REFERENCES memory_records(id),
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (block_id, memory_id)
      );

      CREATE TABLE IF NOT EXISTS leaf_embeddings (
        block_id TEXT NOT NULL REFERENCES memory_leaf_blocks(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (block_id, model)
      );

      CREATE TABLE IF NOT EXISTS leaf_block_status (
        node_id TEXT PRIMARY KEY REFERENCES memory_nodes(id),
        dirty INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS router_weights (
        node_id TEXT PRIMARY KEY REFERENCES memory_nodes(id),
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        weights_json TEXT NOT NULL,
        examples INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_fts_registry (
        memory_id TEXT PRIMARY KEY REFERENCES memory_records(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED,
        statement,
        node_name,
        evidence,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS state_key_aliases (
        alias_key TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (alias_key, scope_json)
      );

      CREATE TABLE IF NOT EXISTS session_archives (
        session_id TEXT PRIMARY KEY,
        history_id TEXT NOT NULL UNIQUE REFERENCES history_records(id),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_records_node_tier
        ON memory_records(node_id, tier);
      CREATE INDEX IF NOT EXISTS idx_memory_records_tier_priority
        ON memory_records(tier, importance DESC, access_count DESC);
      CREATE INDEX IF NOT EXISTS idx_node_relations_source
        ON node_relations(source_node_id);
      CREATE INDEX IF NOT EXISTS idx_node_relations_target
        ON node_relations(target_node_id);
    `);
    this.#ensureMemoryColumns();
    this.#ensureHistoryColumns();
    this.#ensureEmbeddingTable();
    this.#ensureNodeColumns();
    this.#db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_history_source_message
        ON history_records(session_id, source_message_id)
        WHERE source_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_records_state
        ON memory_records(memory_type, state_key, status);
      INSERT OR IGNORE INTO memory_evidence_links (memory_id, history_id)
      SELECT id, evidence_id FROM memory_records;
      INSERT INTO memory_fts(memory_id, statement, node_name, evidence)
      SELECT m.id, m.statement, n.canonical_name, h.content
      FROM memory_records m
      JOIN memory_nodes n ON n.id = m.node_id
      JOIN history_records h ON h.id = m.evidence_id
      LEFT JOIN memory_fts_registry r ON r.memory_id = m.id
      WHERE r.memory_id IS NULL;
      INSERT OR IGNORE INTO memory_fts_registry(memory_id)
      SELECT id FROM memory_records;
      INSERT OR IGNORE INTO leaf_block_status(node_id, dirty, updated_at)
      SELECT id, 1, updated_at FROM memory_nodes WHERE status = 'active';
    `);
  }

  #ensureMemoryColumns(): void {
    const existing = new Set(
      (this.#db.prepare("PRAGMA table_info(memory_records)").all() as Row[]).map(
        (row) => String(row.name),
      ),
    );
    const additions: Array<[string, string]> = [
      ["scope_json", "TEXT NOT NULL DEFAULT '{}'"],
      ["valid_from", "TEXT"],
      ["valid_until", "TEXT"],
      ["status", "TEXT NOT NULL DEFAULT 'active'"],
      ["evidence_role", "TEXT NOT NULL DEFAULT 'support'"],
      ["supersedes_id", "TEXT REFERENCES memory_records(id)"],
      ["memory_type", "TEXT NOT NULL DEFAULT 'fact'"],
      ["state_key", "TEXT"],
      ["event_time", "TEXT"],
      ["source_actor", "TEXT NOT NULL DEFAULT 'user'"],
      ["truth_status", "TEXT NOT NULL DEFAULT 'asserted'"],
      ["pending_access_count", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, definition] of additions) {
      if (!existing.has(name)) {
        this.#db.exec(`ALTER TABLE memory_records ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  #ensureHistoryColumns(): void {
    const existing = new Set(
      (this.#db.prepare("PRAGMA table_info(history_records)").all() as Row[]).map(
        (row) => String(row.name),
      ),
    );
    if (!existing.has("source_message_id")) {
      this.#db.exec("ALTER TABLE history_records ADD COLUMN source_message_id TEXT");
    }
  }

  #ensureEmbeddingTable(): void {
    const columns = this.#db.prepare("PRAGMA table_info(memory_embeddings)").all() as Row[];
    const primaryKeyColumns = columns
      .filter((row) => Number(row.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((row) => String(row.name));
    if (primaryKeyColumns.join(",") === "memory_id,model") return;
    this.#db.exec(`
      ALTER TABLE memory_embeddings RENAME TO memory_embeddings_legacy;
      CREATE TABLE memory_embeddings (
        memory_id TEXT NOT NULL REFERENCES memory_records(id),
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, model)
      );
      INSERT OR REPLACE INTO memory_embeddings
        (memory_id, model, dimensions, vector_json, updated_at)
      SELECT memory_id, model, dimensions, vector_json, updated_at
      FROM memory_embeddings_legacy;
      DROP TABLE memory_embeddings_legacy;
    `);
  }

  #requireHistory(historyId: string): HistoryRecord {
    const row = this.#db.prepare("SELECT * FROM history_records WHERE id = ?").get(historyId) as
      Row | undefined;
    if (!row) throw new Error(`history ${historyId} does not exist`);
    return mapHistory(row);
  }

  #upsertFts(memoryId: string, statement: string, nodeId: string, evidenceId: string): void {
    const node = this.#requireNode(nodeId);
    const evidence = this.#requireHistory(evidenceId);
    this.#db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memoryId);
    this.#db.prepare(
      "INSERT INTO memory_fts(memory_id, statement, node_name, evidence) VALUES (?, ?, ?, ?)",
    ).run(memoryId, statement, node.canonicalName, evidence.content);
    this.#db.prepare("INSERT OR IGNORE INTO memory_fts_registry(memory_id) VALUES (?)").run(memoryId);
  }

  #ftsCandidates(query: string, limit: number): string[] {
    const expression = ftsExpression(query);
    if (!expression) return [];
    const rows = this.#db.prepare(
      "SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?",
    ).all(expression, limit) as Row[];
    return rows.map((row) => String(row.memory_id));
  }

  #ftsCandidatesInNodes(query: string, nodeIds: string[], limit: number): string[] {
    const expression = ftsExpression(query);
    if (!expression || nodeIds.length === 0) return [];
    const rows = this.#db.prepare(
      `SELECT f.memory_id FROM memory_fts f
       JOIN memory_records m ON m.id = f.memory_id
       WHERE memory_fts MATCH ? AND m.node_id IN (${nodeIds.map(() => "?").join(",")})
       ORDER BY bm25(memory_fts) LIMIT ?`,
    ).all(expression, ...nodeIds, limit) as Row[];
    return rows.map((row) => String(row.memory_id));
  }

  #ensureNodeColumns(): void {
    const existing = new Set(
      (this.#db.prepare("PRAGMA table_info(memory_nodes)").all() as Row[]).map(
        (row) => String(row.name),
      ),
    );
    if (!existing.has("status")) {
      this.#db.exec("ALTER TABLE memory_nodes ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    }
  }

  #requireNode(nodeId: string): MemoryNode {
    const row = this.#db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(nodeId) as
      Row | undefined;
    if (!row) throw new Error(`node ${nodeId} does not exist`);
    return mapNode(row);
  }

  #resolveActiveNodeName(canonicalName: string): string {
    const row = this.#db.prepare("SELECT * FROM memory_nodes WHERE canonical_name = ?")
      .get(canonicalName) as Row | undefined;
    if (!row) return canonicalName;
    const node = mapNode(row);
    if (node.status === "active") return node.canonicalName;
    const targets = this.#db.prepare(
      `SELECT DISTINCT n.canonical_name FROM node_redirects r
       JOIN memory_nodes n ON n.id = r.target_node_id
       WHERE r.source_node_id = ? AND n.status = 'active'`,
    ).all(node.id) as Row[];
    if (targets.length === 1) return String(targets[0]!.canonical_name);
    if (targets.length > 1) {
      throw new Error(`node ${canonicalName} was split; choose a more specific node`);
    }
    return canonicalName;
  }

  #resolveStateKey(
    requestedKey: string,
    scope: MemoryScope,
    node: MemoryNode,
  ): string {
    const scopeJson = serializeScope(scope);
    const alias = this.#db.prepare(
      `SELECT canonical_key FROM state_key_aliases
       WHERE alias_key = ? AND scope_json = ?`,
    ).get(requestedKey, scopeJson) as Row | undefined;
    if (alias) return String(alias.canonical_key);

    const exact = this.#db.prepare(
      `SELECT state_key FROM memory_records
       WHERE memory_type = 'state' AND state_key = ? AND scope_json = ?
         AND status = 'active' LIMIT 1`,
    ).get(requestedKey, scopeJson) as Row | undefined;
    if (exact) return requestedKey;

    const candidates = this.#db.prepare(
      `SELECT m.state_key, n.canonical_name
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id
       WHERE m.memory_type = 'state' AND m.scope_json = ?
         AND m.status = 'active' AND m.state_key IS NOT NULL`,
    ).all(scopeJson) as Row[];
    const requestedIdentity = `${node.canonicalName} ${requestedKey}`;
    const requestedTokens = identityTokens(requestedIdentity);
    const matches = candidates.map((candidate) => {
      const identity = `${candidate.canonical_name} ${candidate.state_key}`;
      const candidateTokens = identityTokens(identity);
      const overlap = requestedTokens.size === 0 ? 0 :
        [...requestedTokens].filter((token) => candidateTokens.has(token)).length /
          requestedTokens.size;
      return {
        key: String(candidate.state_key),
        score: cosineSimilarity(
          this.#embedder.embed(requestedIdentity),
          this.#embedder.embed(identity),
        ),
        overlap,
      };
    }).filter((candidate) => candidate.score >= 0.65 && candidate.overlap >= 0.7)
      .sort((left, right) => right.score - left.score);
    if (matches.length === 0) return requestedKey;

    const canonicalKey = matches[0]!.key;
    this.#db.prepare(
      `INSERT OR REPLACE INTO state_key_aliases
        (alias_key, scope_json, canonical_key, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(requestedKey, scopeJson, canonicalKey, new Date().toISOString());
    return canonicalKey;
  }

  #memoryIdsForNodes(nodeIds: string[]): string[] {
    const select = this.#db.prepare("SELECT id FROM memory_records WHERE node_id = ?");
    return nodeIds.flatMap((nodeId) =>
      (select.all(nodeId) as Row[]).map((row) => String(row.id)));
  }

  #createTransform(
    type: NodeTransform["type"],
    sourceNodeIds: string[],
    targetNodeIds: string[],
    movedMemoryIds: string[],
  ): NodeTransform {
    const transform: NodeTransform = {
      id: randomUUID(),
      type,
      sourceNodeIds,
      targetNodeIds,
      movedMemoryIds,
      createdAt: new Date().toISOString(),
    };
    this.#db.prepare(
      `INSERT INTO node_transforms
        (id, transform_type, source_node_ids_json, target_node_ids_json,
         moved_memory_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(transform.id, transform.type, JSON.stringify(transform.sourceNodeIds),
      JSON.stringify(transform.targetNodeIds), JSON.stringify(transform.movedMemoryIds),
      transform.createdAt);
    return transform;
  }

  #redirectRelations(sourceNodeId: string, targetNodeId: string): void {
    const rows = this.#db.prepare(
      `SELECT * FROM node_relations
       WHERE source_node_id = ? OR target_node_id = ?`,
    ).all(sourceNodeId, sourceNodeId) as Row[];
    const remove = this.#db.prepare("DELETE FROM node_relations WHERE id = ?");
    for (const row of rows) {
      const relation = mapRelation(row);
      remove.run(relation.id);
      const nextSource = relation.sourceNodeId === sourceNodeId
        ? targetNodeId : relation.sourceNodeId;
      const nextTarget = relation.targetNodeId === sourceNodeId
        ? targetNodeId : relation.targetNodeId;
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

  #memoryText(memory: Pick<MemoryRecord, "statement">, nodeId: string): string {
    const node = this.#requireNode(nodeId);
    return `${memory.statement} ${node.canonicalName} ${node.summary}`;
  }

  #upsertEmbedding(memoryId: string, text: string): void {
    this.#db.prepare(
      `INSERT INTO memory_embeddings (memory_id, model, dimensions, vector_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, model) DO UPDATE SET
         dimensions = excluded.dimensions, vector_json = excluded.vector_json,
         updated_at = excluded.updated_at`,
    ).run(memoryId, this.#embedder.model, this.#embedder.dimensions,
      JSON.stringify(this.#embedder.embed(text)), new Date().toISOString());
  }

  #refreshEmbeddings(memoryIds: string[]): void {
    const select = this.#db.prepare(
      `SELECT m.id, m.statement, m.node_id, n.canonical_name, n.summary
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id WHERE m.id = ?`,
    );
    for (const memoryId of memoryIds) {
      const row = select.get(memoryId) as Row | undefined;
      if (row) this.#upsertEmbedding(memoryId,
        `${row.statement} ${row.canonical_name} ${row.summary}`);
    }
  }

  #evidenceIds(memoryId: string): string[] {
    return (this.#db
      .prepare(
        `SELECT history_id FROM memory_evidence_links
         WHERE memory_id = ? ORDER BY history_id`,
      )
      .all(memoryId) as Row[]).map((row) => String(row.history_id));
  }

  #resultsForNode(
    nodeId: string,
    maxTier: MemoryTier,
    limit: number,
  ): MemorySearchResult[] {
    const rows = this.#db.prepare(
      `SELECT
         m.id AS m_id, m.node_id AS m_node_id,
         m.evidence_id AS m_evidence_id, m.statement AS m_statement,
         m.memory_type AS m_memory_type, m.state_key AS m_state_key,
         m.event_time AS m_event_time, m.source_actor AS m_source_actor,
         m.truth_status AS m_truth_status,
         m.scope_json AS m_scope_json, m.valid_from AS m_valid_from,
         m.valid_until AS m_valid_until, m.status AS m_status,
         m.evidence_role AS m_evidence_role,
         m.supersedes_id AS m_supersedes_id,
         m.tier AS m_tier, m.importance AS m_importance,
         m.access_count AS m_access_count,
         m.last_accessed_at AS m_last_accessed_at,
         m.created_at AS m_created_at,
         n.id AS n_id, n.canonical_name AS n_canonical_name,
         n.kind AS n_kind, n.summary AS n_summary,
         n.created_at AS n_created_at, n.updated_at AS n_updated_at,
         n.status AS n_status,
         h.id AS h_id, h.session_id AS h_session_id, h.role AS h_role,
         h.content AS h_content, h.source_message_id AS h_source_message_id,
         h.source_ref AS h_source_ref,
         h.created_at AS h_created_at
       FROM memory_records m
       JOIN memory_nodes n ON n.id = m.node_id
       JOIN history_records h ON h.id = m.evidence_id
       WHERE m.node_id = ? AND m.tier <= ? AND n.status = 'active'
         AND m.status IN ('active', 'disputed')
       ORDER BY m.tier ASC, m.importance DESC, m.created_at DESC
       LIMIT ?`,
    ).all(nodeId, maxTier, limit) as Row[];
    return rows.map((row) => {
      const result = mapSearchResult(row, 0);
      result.memory.evidenceIds = this.#evidenceIds(result.memory.id);
      result.evidenceRecords = this.#evidenceRecords(result.memory.evidenceIds);
      return result;
    });
  }

  #evidenceRecords(ids: string[]): HistoryRecord[] {
    const statement = this.#db.prepare("SELECT * FROM history_records WHERE id = ?");
    return ids.flatMap((id) => {
      const row = statement.get(id) as Row | undefined;
      return row ? [mapHistory(row)] : [];
    });
  }
}

function mapNode(row: Row, prefix = ""): MemoryNode {
  return {
    id: String(row[`${prefix}id`]),
    canonicalName: String(row[`${prefix}canonical_name`]),
    kind: String(row[`${prefix}kind`]) as MemoryNodeKind,
    summary: String(row[`${prefix}summary`]),
    createdAt: String(row[`${prefix}created_at`]),
    updatedAt: String(row[`${prefix}updated_at`]),
    status: String(row[`${prefix}status`] ?? "active") as MemoryNode["status"],
  };
}

function mapLeafBlock(row: Row): LeafBlock {
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    tier: Number(row.tier) as MemoryTier,
    summary: String(row.summary),
    memoryCount: Number(row.memory_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function leafBlockSummary(rows: Row[]): string {
  const first = rows[0]!;
  const scope = parseScope(first.scope_json);
  const scopeText = Object.entries(scope).map(([key, value]) => `${key}=${value}`).join(", ");
  const times = rows.flatMap((row) => [row.event_time, row.valid_from, row.valid_until])
    .filter((value): value is string | number => value !== null)
    .map(String).sort();
  const sample = rows.slice(0, 8).map((row) => String(row.statement).trim())
    .filter(Boolean).join("; ").slice(0, 1_500);
  return [
    `node=${first.canonical_name}`,
    `type=${first.memory_type}`,
    `tier=${first.tier}`,
    scopeText ? `scope=${scopeText}` : "",
    times.length > 0 ? `time=${times[0]}..${times[times.length - 1]}` : "",
    `count=${rows.length}`,
    `examples=${sample}`,
  ].filter(Boolean).join(" | ");
}

function mapSearchResult(row: Row, score: number): MemorySearchResult {
  return {
    memory: {
      id: String(row.m_id),
      nodeId: String(row.m_node_id),
      evidenceId: String(row.m_evidence_id),
      evidenceIds: [String(row.m_evidence_id)],
      statement: String(row.m_statement),
      memoryType: String(row.m_memory_type) as MemoryRecord["memoryType"],
      stateKey: row.m_state_key ? String(row.m_state_key) : null,
      eventTime: row.m_event_time ? String(row.m_event_time) : null,
      sourceActor: String(row.m_source_actor) as MemoryRecord["sourceActor"],
      truthStatus: String(row.m_truth_status) as MemoryRecord["truthStatus"],
      scope: parseScope(row.m_scope_json),
      validFrom: row.m_valid_from ? String(row.m_valid_from) : null,
      validUntil: row.m_valid_until ? String(row.m_valid_until) : null,
      status: String(row.m_status) as MemoryStatus,
      evidenceRole: String(row.m_evidence_role) as MemoryRecord["evidenceRole"],
      supersedesId: row.m_supersedes_id ? String(row.m_supersedes_id) : null,
      tier: Number(row.m_tier) as MemoryTier,
      importance: Number(row.m_importance),
      accessCount: Number(row.m_access_count),
      lastAccessedAt: row.m_last_accessed_at
        ? String(row.m_last_accessed_at)
        : null,
      createdAt: String(row.m_created_at),
    },
    node: mapNode(row, "n_"),
    evidence: {
      id: String(row.h_id),
      sessionId: row.h_session_id ? String(row.h_session_id) : null,
      sourceMessageId: row.h_source_message_id ? String(row.h_source_message_id) : null,
      role: String(row.h_role) as HistoryRole,
      content: String(row.h_content),
      sourceRef: row.h_source_ref ? String(row.h_source_ref) : null,
      createdAt: String(row.h_created_at),
    },
    evidenceRecords: [],
    lexicalScore: score,
    vectorScore: 0,
    routeScore: 0,
    combinedScore: score,
  };
}

function contextUsefulness(query: string, result: MemorySearchResult): number {
  const normalized = normalize(query);
  const type = result.memory.memoryType;
  let bonus = 0;
  if (/\b(?:how many|how much|list|all|count)\b|(?:多少|几个|列出|全部)/iu.test(normalized)) {
    if (["derived", "event", "fact", "state"].includes(type)) bonus += 0.25;
    if (type === "conversation_evidence") bonus -= 0.15;
    if (type === "strategy") bonus -= 0.1;
  }
  if (/\b(?:recommend|suggest|preference)\b|(?:推荐|建议|偏好)/iu.test(normalized)) {
    if (type === "preference") bonus += 0.3;
    if (type === "constraint") bonus += 0.15;
  }
  if (/\b(?:assistant|you said|previous chat)\b|(?:你说过|助手|之前的对话)/iu.test(normalized) &&
      type === "conversation_evidence") {
    bonus += 0.25;
  }
  return result.combinedScore + bonus;
}

function mapHistory(row: Row): HistoryRecord {
  return {
    id: String(row.id),
    sessionId: row.session_id ? String(row.session_id) : null,
    sourceMessageId: row.source_message_id ? String(row.source_message_id) : null,
    role: String(row.role) as HistoryRole,
    content: String(row.content),
    sourceRef: row.source_ref ? String(row.source_ref) : null,
    createdAt: String(row.created_at),
  };
}

function mapRelation(row: Row): NodeRelation {
  return {
    id: String(row.id),
    sourceNodeId: String(row.source_node_id),
    targetNodeId: String(row.target_node_id),
    type: String(row.relation_type) as NodeRelationType,
    evidenceIds: parseStringArray(row.evidence_ids_json),
    createdAt: String(row.created_at),
  };
}

function lexicalScore(query: string, row: Row): number {
  const haystack = normalize(
    `${row.m_statement} ${row.n_canonical_name} ${row.n_summary}`,
  );
  if (haystack.includes(query)) return 10 + query.length;

  const terms = searchTerms(query);
  return terms.reduce(
    (score, term) => score + (haystack.includes(term) ? term.length : 0),
    0,
  );
}

function ftsExpression(query: string): string {
  const terms = normalize(query).match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  return [...new Set(terms)]
    .filter((term) => term.length > 1)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function lexicalNodeScore(query: string, node: MemoryNode): number {
  if (!query) return 0;
  const haystack = normalize(`${node.canonicalName} ${node.summary}`);
  if (haystack.includes(query)) return 1;
  const terms = searchTerms(query);
  if (terms.length === 0) return 0;
  return terms.filter((term) => haystack.includes(term)).length / terms.length;
}

function hybridScore(lexical: number, vector: number, route: number): number {
  const boundedLexical = lexical <= 0 ? 0 : lexical / (lexical + 10);
  return boundedLexical * 0.5 + Math.max(0, vector) * 0.35 + Math.max(0, route) * 0.15;
}

function recallReason(result: MemorySearchResult): RecallCue["reason"] {
  const scores = [
    ["lexical_match", result.lexicalScore > 0 ? result.lexicalScore / (result.lexicalScore + 10) : 0],
    ["vector_match", Math.max(0, result.vectorScore)],
    ["learned_route", Math.max(0, result.routeScore)],
  ] as const;
  const ordered = [...scores].sort((left, right) => right[1] - left[1]);
  if ((ordered[0]?.[1] ?? 0) <= 0) return "hybrid_match";
  return ordered[0]![0];
}

function hierarchyWeight(row: Row): number {
  const frequency = Math.log2(2 + Number(row.access_count ?? 0));
  const importance = 0.5 + Number(row.importance ?? 0);
  const lastAccessed = row.last_accessed_at ? Date.parse(String(row.last_accessed_at)) : 0;
  const ageDays = lastAccessed > 0 ? Math.max(0, (Date.now() - lastAccessed) / 86_400_000) : 365;
  const recency = 1 / (1 + ageDays / 30);
  return Math.max(Number.EPSILON, frequency * importance * (0.5 + recency));
}

function searchTerms(value: string): string[] {
  const tokens = value.match(/[\p{L}\p{N}_+.#-]+/gu) ?? [];
  const terms = new Set<string>();
  for (const token of tokens) {
    if (token.length >= 2) terms.add(token);
    if (/\p{Script=Han}/u.test(token) && token.length > 4) {
      for (let index = 0; index < token.length - 1; index += 1) {
        terms.add(token.slice(index, index + 2));
      }
    }
  }
  return [...terms];
}

function identityTokens(value: string): Set<string> {
  return new Set(
    normalize(value).split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2 && token !== "time"),
  );
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function requireText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty`);
  return text;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function parseScope(value: string | number | null): MemoryScope {
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value) as MemoryScope;
  } catch {
    return {};
  }
}

function parseStringArray(value: string | number | null): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseVector(value: string | number | null | undefined): number[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
      : [];
  } catch {
    return [];
  }
}

function matchesScope(memory: MemoryScope, requested?: MemoryScope): boolean {
  if (!requested) return true;
  return Object.entries(requested).every(([key, value]) => memory[key] === value);
}

function serializeScope(scope: MemoryScope): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(scope).sort(([left], [right]) =>
      left.localeCompare(right))),
  );
}
