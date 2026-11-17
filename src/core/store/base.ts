import { withRetrievalDiagnostics } from "./retrieval-diagnostics.ts";
import { LocalSqliteStateBase } from "./local-sqlite-state-base.ts";
import { normalizeStatement } from "../memory-normalization.ts";
import { randomUUID } from "node:crypto";

import type {
  ConsolidationEvent,
  EmbeddingDocument,
  ExternalEmbedding,
  ExternalLeafEmbedding,
  ExternalNodeEmbedding,
  HistoryRecord,
  MemoryActor,
  MemoryNode,
  LeafBlock,
  LeafEmbeddingDocument,
  NodeEmbeddingDocument,
  NodeTransform,
  MemoryRecord,
  MemoryWriteEvent,
  MemoryChain,
  MemoryChainMember,
  MemoryChainEdge,
  MemoryChainEdgeType,
  MemoryChainStatus,
  MemoryChainType,
  MemorySearchResult,
  MemoryScope,
  MemoryTier,
  MemoryStatus,
  NmgStoreOptions,
  TopologyProposal,
  VectorEmbedder,
} from "../types.ts";
import { currentlyValid, notExpired } from "./clock.ts";
import { Router } from "../router.ts";
import { cosineSimilarity, HashingVectorEmbedder } from "../vector.ts";
import { Float32VectorCache } from "../vector-cache.ts";
import { migrate } from "./schema.ts";
import { encodeVector, storedVector } from "./vector-codec.ts";
import { deleteMemoryFts, indexMemoryFts, memoryFtsLink } from "./fts-index.ts";
import { updateRelationStrength } from "../edge-activation.ts";
import { serializeScope } from "../scope.ts";
import { recallTriggersFromStoredMarkers } from "../recall-triggers.ts";
import { ScopeWriteIndex, type ScopeWriteIndexRow, writeTokens } from "./scope-write-index.ts";
import {
  ftsExpression,
  MEMORY_PREVIOUS_TURN_SQL,
  memoryEmbeddingModelId,
  memoryEmbeddingText,
  surfaceAnchorExpression,
  type StoreRow as Row,
} from "./search-ranking.ts";

import {
  identityTokens,
  mapConsolidationEvent,
  mapHistory,
  mapLeafBlock,
  mapNode,
  mapRelation,
  mapSearchResult,
} from "./rows.ts";

export type { TransactionPort } from "./store-ctor.ts";

export { taskBoardClaimIsLive } from "./local-sqlite-state-base.ts";

export class NmgStoreBase extends withRetrievalDiagnostics(LocalSqliteStateBase) {
  protected embedder: VectorEmbedder;
  protected router: Router;
  protected vectorCaches = new Map<string, Float32VectorCache>();
  protected scopeWriteIndexes = new Map<string, ScopeWriteIndex>();
  protected scopeWriteIndexEnabled: boolean;
  constructor(
    databasePath: string,
    embedder: VectorEmbedder = new HashingVectorEmbedder(),
    options: NmgStoreOptions = {},
  ) {
    super(databasePath, options);
    this.embedder = embedder;
    this.router = new Router(embedder);
    this.scopeWriteIndexEnabled = options.scopeWriteIndex ?? false;
  }

  /** The core schema's marker table: present means this file was written by a version this code reads. */
  protected override initializeSchema(): void {
    if (
      !this.hasSchema() &&
      this.db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='nmg_local_memory'")
        .get()
    )
      throw new Error("This database uses the unified memory engine");
    migrate(this.db);
  }

  protected override hasSchema(): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_nodes'")
        .get() !== undefined
    );
  }

  protected scopeWriteIndex(scopeJson: string): ScopeWriteIndex | null {
    if (!this.scopeWriteIndexEnabled) return null;
    let index = this.scopeWriteIndexes.get(scopeJson);
    if (index) return index;
    const rows = this.db
      .prepare(
        `SELECT id, node_id, statement, event_time, polarity, status, created_at
           FROM memory_records
          WHERE scope_json = ? AND status IN ('active', 'disputed')
            AND storage_state = 'indexed'
          ORDER BY created_at, rowid`,
      )
      .all(scopeJson) as Record<string, unknown>[];
    index = new ScopeWriteIndex(
      rows.map((row): ScopeWriteIndexRow => ({
        id: String(row.id),
        nodeId: String(row.node_id),
        statement: String(row.statement),
        normalizedStatement: normalizeStatement(String(row.statement)),
        tokens: writeTokens(String(row.statement)),
        eventTime: row.event_time ? String(row.event_time) : null,
        polarity: row.polarity ? (String(row.polarity) as ScopeWriteIndexRow["polarity"]) : null,
        status: String(row.status) as MemoryStatus,
        createdAt: String(row.created_at),
      })),
    );
    this.scopeWriteIndexes.set(scopeJson, index);
    return index;
  }

  protected indexScopeWriteMemory(memory: MemoryRecord): void {
    const index = this.scopeWriteIndex(serializeScope(memory.scope));
    index?.add({
      id: memory.id,
      nodeId: memory.nodeId,
      statement: memory.statement,
      normalizedStatement: normalizeStatement(memory.statement),
      tokens: writeTokens(memory.statement),
      eventTime: memory.eventTime,
      polarity: memory.polarity,
      status: memory.status,
      createdAt: memory.createdAt,
    });
  }

  protected setScopeWriteMemoryStatus(
    memoryId: string,
    scopeJson: string,
    status: MemoryStatus,
  ): void {
    this.scopeWriteIndexes.get(scopeJson)?.setStatus(memoryId, status);
  }

  protected invalidateScopeWriteIndexes(scopeJson?: string): void {
    if (scopeJson) this.scopeWriteIndexes.delete(scopeJson);
    else this.scopeWriteIndexes.clear();
  }
  createMemoryChain(input: {
    chainType: MemoryChainType;
    topic: string;
    ownerSessionId?: string;
    now?: string;
  }): MemoryChain {
    const now = input.now ?? new Date().toISOString();
    const chain: MemoryChain = {
      id: randomUUID(),
      chainType: input.chainType,
      topic: input.topic,
      ownerSessionId: input.ownerSessionId ?? null,
      status: "active",
      createdAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO memory_chains (id, chain_type, topic, owner_session_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chain.id,
        chain.chainType,
        chain.topic,
        chain.ownerSessionId,
        chain.status,
        chain.createdAt,
      );
    return chain;
  }

  /** Append (or place at an explicit position) a memory reference in a chain.
   * PK (chain_id, memory_id) makes membership idempotent per chain; a memory
   * may join many chains (node reuse / cross-chain intersection). Time chains
   * order by event_time — pass position derived from it; otherwise append. */
  addMemoryToChain(input: {
    chainId: string;
    memoryId: string;
    position?: number;
    note?: string;
    now?: string;
  }): MemoryChainMember {
    const now = input.now ?? new Date().toISOString();
    const chain = this.getMemoryChain(input.chainId);
    if (!chain) throw new Error(`memory chain not found: ${input.chainId}`);
    let position = input.position;
    if (position === undefined) {
      const row = this.db
        .prepare(
          "SELECT COALESCE(MAX(position), 0) + 1 AS next FROM memory_chain_members WHERE chain_id = ?",
        )
        .get(input.chainId) as Row;
      position = Number(row.next);
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_chain_members (chain_id, memory_id, position, note, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.chainId, input.memoryId, position, input.note ?? null, now);
    return {
      chainId: input.chainId,
      memoryId: input.memoryId,
      position,
      note: input.note ?? null,
      createdAt: now,
    };
  }

  /** Fetch a chain with all members in order (整链拉起). */
  getMemoryChain(chainId: string): {
    chain: MemoryChain;
    members: MemoryChainMember[];
  } | null {
    const row = this.db
      .prepare(
        "SELECT id, chain_type, topic, owner_session_id, status, created_at FROM memory_chains WHERE id = ?",
      )
      .get(chainId) as Row | undefined;
    if (!row) return null;
    const members = (
      this.db
        .prepare(
          `SELECT chain_id, memory_id, position, note, created_at FROM memory_chain_members
           WHERE chain_id = ? ORDER BY position`,
        )
        .all(chainId) as Row[]
    ).map((m) => {
      const memberId = String(m.memory_id);
      // Live-reference marker: if this member's memory was superseded, point at
      // its active successor while keeping the original snapshot (historical
      // context) in the chain.
      const statusRow = this.db
        .prepare("SELECT status FROM memory_records WHERE id = ?")
        .get(memberId) as Row | undefined;
      let successorId: string | undefined;
      if (statusRow && String(statusRow.status) === "superseded") {
        const successor = this.db
          .prepare(
            "SELECT id FROM memory_records WHERE supersedes_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
          )
          .get(memberId) as Row | undefined;
        if (successor) successorId = String(successor.id);
      }
      return {
        chainId: String(m.chain_id),
        memoryId: memberId,
        position: Number(m.position),
        note: m.note === null ? null : String(m.note),
        createdAt: String(m.created_at),
        ...(successorId === undefined ? {} : { successorId }),
      };
    });
    return {
      chain: {
        id: String(row.id),
        chainType: String(row.chain_type) as MemoryChainType,
        topic: String(row.topic),
        ownerSessionId: row.owner_session_id === null ? null : String(row.owner_session_id),
        status: String(row.status) as MemoryChainStatus,
        createdAt: String(row.created_at),
      },
      members,
    };
  }

  /** List chains, optionally filtered. */
  listMemoryChains(input?: {
    chainType?: MemoryChainType;
    topic?: string;
    ownerSessionId?: string;
    limit?: number;
  }): MemoryChain[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (input?.chainType) {
      where.push("chain_type = ?");
      params.push(input.chainType);
    }
    if (input?.topic !== undefined) {
      where.push("topic = ?");
      params.push(input.topic);
    }
    if (input?.ownerSessionId !== undefined) {
      where.push("owner_session_id = ?");
      params.push(input.ownerSessionId);
    }
    const sql = `SELECT id, chain_type, topic, owner_session_id, status, created_at FROM memory_chains
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as Row[];
    const limit = input?.limit ?? rows.length;
    return rows.slice(0, limit).map((row) => ({
      id: String(row.id),
      chainType: String(row.chain_type) as MemoryChainType,
      topic: String(row.topic),
      ownerSessionId: row.owner_session_id === null ? null : String(row.owner_session_id),
      status: String(row.status) as MemoryChainStatus,
      createdAt: String(row.created_at),
    }));
  }

  /** Remove a memory reference from a chain. */
  removeMemoryFromChain(input: { chainId: string; memoryId: string }): boolean {
    return this.writeTransaction(() => {
      this.db
        .prepare(
          `DELETE FROM memory_chain_edges
           WHERE chain_id = ? AND (source_memory_id = ? OR target_memory_id = ?)`,
        )
        .run(input.chainId, input.memoryId, input.memoryId);
      const result = this.db
        .prepare("DELETE FROM memory_chain_members WHERE chain_id = ? AND memory_id = ?")
        .run(input.chainId, input.memoryId);
      return result.changes > 0;
    });
  }

  // ── memory-chain DAG edges (pointers) ──

  /** Read the directed edges of a chain (its DAG structure). */
  getMemoryChainEdges(chainId: string): MemoryChainEdge[] {
    const rows = this.db
      .prepare(
        `SELECT chain_id, source_memory_id, target_memory_id, edge_type, created_at
         FROM memory_chain_edges WHERE chain_id = ?`,
      )
      .all(chainId) as Row[];
    return rows.map((r) => ({
      chainId: String(r.chain_id),
      sourceMemoryId: String(r.source_memory_id),
      targetMemoryId: String(r.target_memory_id),
      edgeType: String(r.edge_type) as MemoryChainEdgeType,
      createdAt: String(r.created_at),
    }));
  }

  /** Add a directed edge source → target to a chain (a pointer). Enforces the
   *  DAG invariant: the edge is rejected if it would create a cycle (target
   *  already reaches source through existing edges). Endpoint memories are
   *  auto-joined as members when absent, so edges can be added without a
   *  separate member step. */
  addMemoryChainEdge(input: {
    chainId: string;
    sourceMemoryId: string;
    targetMemoryId: string;
    edgeType?: MemoryChainEdgeType;
    now?: string;
  }): MemoryChainEdge {
    const now = input.now ?? new Date().toISOString();
    const chain = this.getMemoryChain(input.chainId);
    if (!chain) throw new Error(`memory chain not found: ${input.chainId}`);
    if (input.sourceMemoryId === input.targetMemoryId) {
      throw new Error("memory chain edge must connect two distinct memories");
    }
    for (const id of [input.sourceMemoryId, input.targetMemoryId]) {
      const exists = this.db.prepare("SELECT 1 FROM memory_records WHERE id = ?").get(id);
      if (!exists) throw new Error(`memory record not found: ${id}`);
    }
    const edgeType = input.edgeType ?? "order";
    // DAG check: does target already reach source through existing edges? If
    // so, adding source → target would close a directed cycle — reject.
    const adj = new Map<string, string[]>();
    for (const e of this.getMemoryChainEdges(input.chainId)) {
      const list = adj.get(e.sourceMemoryId) ?? [];
      list.push(e.targetMemoryId);
      adj.set(e.sourceMemoryId, list);
    }
    if (this.reaches(adj, input.targetMemoryId, input.sourceMemoryId, new Set())) {
      throw new Error(
        `memory chain edge ${input.sourceMemoryId} -> ${input.targetMemoryId} rejected: would create a cycle`,
      );
    }
    // Auto-join endpoints as members (idempotent) so edges are self-contained.
    const join = (memoryId: string) => {
      const row = this.db
        .prepare(
          "SELECT COALESCE(MAX(position), 0) + 1 AS next FROM memory_chain_members WHERE chain_id = ?",
        )
        .get(input.chainId) as Row;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO memory_chain_members (chain_id, memory_id, position, note, created_at)
           VALUES (?, ?, ?, NULL, ?)`,
        )
        .run(input.chainId, memoryId, Number(row.next), now);
    };
    join(input.sourceMemoryId);
    join(input.targetMemoryId);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memory_chain_edges
           (chain_id, source_memory_id, target_memory_id, edge_type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.chainId, input.sourceMemoryId, input.targetMemoryId, edgeType, now);
    return {
      chainId: input.chainId,
      sourceMemoryId: input.sourceMemoryId,
      targetMemoryId: input.targetMemoryId,
      edgeType,
      createdAt: now,
    };
  }

  /** Remove a directed edge from a chain. */
  removeMemoryChainEdge(input: {
    chainId: string;
    sourceMemoryId: string;
    targetMemoryId: string;
  }): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM memory_chain_edges WHERE chain_id = ? AND source_memory_id = ? AND target_memory_id = ?",
      )
      .run(input.chainId, input.sourceMemoryId, input.targetMemoryId);
    return result.changes > 0;
  }

  /** Topological order of a chain's members over its DAG edges (Kahn).
   *  Members with no incident edges are appended in insertion (position) order
   *  so the whole chain is covered. Deterministic: ties break by position. */
  topologicalChainOrder(chainId: string): string[] {
    const chain = this.getMemoryChain(chainId);
    const members = chain?.members ?? [];
    const edges = this.getMemoryChainEdges(chainId);
    const indegree = new Map<string, number>();
    const out = new Map<string, string[]>();
    const posByMemory = new Map<string, number>();
    for (const m of members) posByMemory.set(m.memoryId, m.position);
    for (const e of edges) {
      indegree.set(e.targetMemoryId, (indegree.get(e.targetMemoryId) ?? 0) + 1);
      if (!indegree.has(e.sourceMemoryId)) indegree.set(e.sourceMemoryId, 0);
      const list = out.get(e.sourceMemoryId) ?? [];
      list.push(e.targetMemoryId);
      out.set(e.sourceMemoryId, list);
    }
    const queue: string[] = [];
    const inQueue = new Set<string>();
    const pushZero = () => {
      const eligible = [...indegree.entries()]
        .filter(([id, d]) => d === 0 && !inQueue.has(id))
        .sort((a, b) => (posByMemory.get(a[0]) ?? 0) - (posByMemory.get(b[0]) ?? 0));
      for (const [id] of eligible) {
        queue.push(id);
        inQueue.add(id);
      }
    };
    pushZero();
    const order: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      order.push(node);
      for (const next of out.get(node) ?? []) {
        indegree.set(next, (indegree.get(next) ?? 1) - 1);
        if ((indegree.get(next) ?? 0) === 0) pushZero();
      }
    }
    const visited = new Set(order);
    const rest = members
      .filter((m) => !visited.has(m.memoryId))
      .sort((a, b) => a.position - b.position)
      .map((m) => m.memoryId);
    return [...order, ...rest];
  }

  /** True if `from` can reach `to` following directed edges in `adj` (DFS). */
  private reaches(
    adj: Map<string, string[]>,
    from: string,
    to: string,
    visited: Set<string>,
  ): boolean {
    if (from === to) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    for (const next of adj.get(from) ?? []) {
      if (this.reaches(adj, next, to, visited)) return true;
    }
    return false;
  }
  /** Named channels this session has joined (wake-loop routing: only these
   * named channels are scanned for this session, never all active boards). */
  cascadeDerivedMemories(sourceMemoryId: string): void {
    const derivations = this.db
      .prepare("SELECT derived_memory_id FROM memory_derivations WHERE source_memory_id = ?")
      .all(sourceMemoryId) as Row[];
    this.db
      .prepare("DELETE FROM memory_derivations WHERE source_memory_id = ?")
      .run(sourceMemoryId);
    for (const row of derivations) {
      const derivedId = String(row.derived_memory_id);
      const remaining = this.db
        .prepare("SELECT 1 FROM memory_derivations WHERE derived_memory_id = ?")
        .get(derivedId);
      if (!remaining) {
        deleteMemoryFts(this.db, derivedId);
        this.db.prepare("DELETE FROM memory_fts_registry WHERE memory_id = ?").run(derivedId);
        this.db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(derivedId);
        this.db.prepare("DELETE FROM memory_index_delta WHERE memory_id = ?").run(derivedId);
        this.db.prepare("DELETE FROM memory_evidence_links WHERE memory_id = ?").run(derivedId);
        this.db.prepare("DELETE FROM memory_leaf_members WHERE memory_id = ?").run(derivedId);
        this.db.prepare("UPDATE memory_records SET status = 'deleted' WHERE id = ?").run(derivedId);
        for (const key of this.vectorCaches.keys()) {
          this.vectorCaches.get(key)?.remove(derivedId);
        }
        this.cascadeDerivedMemories(derivedId);
      }
    }
  }
  embeddingDocuments(afterMemoryId = "", limit = 256, missingModel?: string): EmbeddingDocument[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.statement, m.event_time, n.canonical_name, n.summary,
                ${MEMORY_PREVIOUS_TURN_SQL} AS previous_turn
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id
       WHERE m.id > ?
         AND m.storage_state = 'indexed'
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model = ?
         ))
       ORDER BY m.id LIMIT ?`,
      )
      .all(
        afterMemoryId,
        missingModel ?? null,
        missingModel ?? null,
        Math.max(1, Math.min(limit, 2_048)),
      ) as Row[];
    return rows.map((row) => ({
      memoryId: String(row.id),
      text: memoryEmbeddingText(row.statement, {
        eventTime: row.event_time,
        previousTurn: row.previous_turn,
      }),
    }));
  }
  nodeEmbeddingDocuments(
    afterNodeId = "",
    limit = 256,
    missingModel?: string,
  ): NodeEmbeddingDocument[] {
    const rows = this.db
      .prepare(
        `SELECT n.id, n.canonical_name, n.kind, n.summary, n.semantic_summary
       FROM memory_nodes n
       WHERE n.id > ? AND n.status = 'active'
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM node_embeddings e WHERE e.node_id = n.id AND e.model = ?
             AND e.updated_at >= COALESCE(n.semantic_summary_at, n.updated_at)
         ))
       ORDER BY n.id LIMIT ?`,
      )
      .all(
        afterNodeId,
        missingModel ?? null,
        missingModel ?? null,
        Math.max(1, Math.min(limit, 2_048)),
      ) as Row[];
    return rows.map((row) => ({
      nodeId: String(row.id),
      text: `${row.canonical_name} ${row.kind} ${row.semantic_summary ?? row.summary}`,
    }));
  }
  upsertExternalNodeEmbeddings(model: string, embeddings: ExternalNodeEmbedding[]): number {
    if (!model.trim()) throw new Error("embedding model is required");
    if (embeddings.length === 0) return 0;
    const dimensions = embeddings[0]!.vector.length;
    if (dimensions === 0 || embeddings.some((item) => item.vector.length !== dimensions)) {
      throw new Error("external embeddings must have one consistent non-zero dimension");
    }
    const upsert = this.db.prepare(
      `INSERT INTO node_embeddings
        (node_id, model, dimensions, vector_json, vector_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id, model) DO UPDATE SET dimensions = excluded.dimensions,
         vector_json = excluded.vector_json, vector_blob = excluded.vector_blob,
         updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    // The store owns the boundary. The cache refresh stays outside it, so a batch whose
    // transaction did not commit cannot warm the cache either.
    this.writeTransaction(() => {
      for (const item of embeddings) {
        upsert.run(item.nodeId, model, dimensions, "[]", encodeVector(item.vector), now);
      }
    });
    for (const item of embeddings) {
      this.updateVectorCache("node", model, item.nodeId, item.vector);
    }
    return embeddings.length;
  }
  storedNodeEmbeddings(model: string, afterNodeId = "", limit = 256): ExternalNodeEmbedding[] {
    const rows = this.db
      .prepare(
        `SELECT node_id,
          CASE WHEN typeof(vector_blob) = 'blob' THEN vector_blob ELSE vector_json END AS vector
       FROM node_embeddings
       WHERE model = ? AND node_id > ? ORDER BY node_id LIMIT ?`,
      )
      .all(model, afterNodeId, Math.max(1, Math.min(limit, 2_048))) as Row[];
    return rows.map((row) => ({
      nodeId: String(row.node_id),
      vector: storedVector(row),
    }));
  }
  leafEmbeddingDocuments(
    afterBlockId = "",
    limit = 256,
    missingModel?: string,
  ): LeafEmbeddingDocument[] {
    const rows = this.db
      .prepare(
        `SELECT b.id, b.node_id, b.summary, b.semantic_summary, n.canonical_name, n.summary AS node_summary
       FROM memory_leaf_blocks b JOIN memory_nodes n ON n.id = b.node_id
       WHERE b.id > ?
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM leaf_embeddings e WHERE e.block_id = b.id AND e.model = ?
             AND e.updated_at >= b.updated_at
         ))
       ORDER BY b.id LIMIT ?`,
      )
      .all(
        afterBlockId,
        missingModel ?? null,
        missingModel ?? null,
        Math.max(1, Math.min(limit, 2_048)),
      ) as Row[];
    return rows.map((row) => ({
      blockId: String(row.id),
      nodeId: String(row.node_id),
      // Prefer the LLM-written semantic summary when present; the structural
      // label (scope/type/time range) is the no-LLM fallback.
      text: `${row.canonical_name}: ${row.semantic_summary ?? row.summary}`,
    }));
  }
  upsertExternalLeafEmbeddings(model: string, embeddings: ExternalLeafEmbedding[]): number {
    if (!model.trim()) throw new Error("embedding model is required");
    if (embeddings.length === 0) return 0;
    const dimensions = embeddings[0]!.vector.length;
    if (dimensions === 0 || embeddings.some((item) => item.vector.length !== dimensions)) {
      throw new Error("external embeddings must have one consistent non-zero dimension");
    }
    const upsert = this.db.prepare(
      `INSERT INTO leaf_embeddings
        (block_id, model, dimensions, vector_json, vector_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(block_id, model) DO UPDATE SET dimensions = excluded.dimensions,
         vector_json = excluded.vector_json, vector_blob = excluded.vector_blob,
         updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    // As above: the boundary is the store's, and the cache is warmed only after it commits.
    this.writeTransaction(() => {
      for (const item of embeddings) {
        upsert.run(item.blockId, model, dimensions, "[]", encodeVector(item.vector), now);
      }
    });
    for (const item of embeddings) {
      this.updateVectorCache("leaf", model, item.blockId, item.vector);
    }
    return embeddings.length;
  }
  storedLeafEmbeddings(model: string, afterBlockId = "", limit = 256): ExternalLeafEmbedding[] {
    const rows = this.db
      .prepare(
        `SELECT block_id,
          CASE WHEN typeof(vector_blob) = 'blob' THEN vector_blob ELSE vector_json END AS vector
       FROM leaf_embeddings
       WHERE model = ? AND block_id > ? ORDER BY block_id LIMIT ?`,
      )
      .all(model, afterBlockId, Math.max(1, Math.min(limit, 2_048))) as Row[];
    return rows.map((row) => ({
      blockId: String(row.block_id),
      vector: storedVector(row),
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
    const nodeClause =
      nodes.length > 0 ? `AND b.node_id IN (${nodes.map(() => "?").join(",")})` : "";
    const blockClause = blocks.length > 0 ? `AND b.id IN (${blocks.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(
        `SELECT b.* FROM memory_leaf_blocks b
       JOIN memory_nodes n ON n.id = b.node_id AND n.status = 'active'
       JOIN leaf_embeddings e ON e.block_id = b.id AND e.model = ?
       WHERE 1 = 1 ${nodeClause} ${blockClause}`,
      )
      .all(model, ...nodes, ...blocks) as Row[];
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const cache = this.embeddingCache("leaf", model);
    if (!cache) return [];
    return cache
      .score(queryVector, new Set(byId.keys()))
      .map(({ id, score }) => ({ block: mapLeafBlock(byId.get(id)!), score }))
      .slice(0, Math.max(1, Math.min(limit, 50)));
  }
  upsertExternalEmbeddings(model: string, embeddings: ExternalEmbedding[]): number {
    if (!model.trim()) throw new Error("embedding model is required");
    if (embeddings.length === 0) return 0;
    const dimensions = embeddings[0]!.vector.length;
    if (dimensions === 0 || embeddings.some((item) => item.vector.length !== dimensions)) {
      throw new Error("external embeddings must have one consistent non-zero dimension");
    }
    const upsert = this.db.prepare(
      `INSERT INTO memory_embeddings
        (memory_id, model, dimensions, vector_json, vector_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, model) DO UPDATE SET dimensions = excluded.dimensions,
         vector_json = excluded.vector_json, vector_blob = excluded.vector_blob,
         updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    this.writeTransaction(() => {
      for (const item of embeddings) {
        upsert.run(item.memoryId, model, dimensions, "[]", encodeVector(item.vector), now);
      }
    });
    return embeddings.length;
  }
  storedEmbeddings(model: string, afterMemoryId = "", limit = 256): ExternalEmbedding[] {
    const rows = this.db
      .prepare(
        `SELECT memory_id,
          CASE WHEN typeof(vector_blob) = 'blob' THEN vector_blob ELSE vector_json END AS vector
       FROM memory_embeddings
       WHERE model = ? AND memory_id > ? ORDER BY memory_id LIMIT ?`,
      )
      .all(model, afterMemoryId, Math.max(1, Math.min(limit, 2_048))) as Row[];
    return rows.map((row) => ({
      memoryId: String(row.memory_id),
      vector: storedVector(row),
    }));
  }
  requireActiveMemory(memoryId: string): MemoryRecord {
    const row = this.db.prepare("SELECT node_id FROM memory_records WHERE id = ?").get(memoryId) as
      Row | undefined;
    if (!row) throw new Error(`memory ${memoryId} does not exist`);
    const result = this.resultsForNode(String(row.node_id), 3, 1, memoryId)[0];
    if (!result) throw new Error(`memory ${memoryId} is not active`);
    return result.memory;
  }
  refreshNodeResidence(nodeId: string, updatedAt: string): void {
    const hasLongTermMemory = this.db
      .prepare(
        `SELECT 1 FROM memory_records
         WHERE node_id = ? AND residence = 'ltg'
           AND status IN ('active', 'disputed') LIMIT 1`,
      )
      .get(nodeId);
    const hasLongTermRelation = this.db
      .prepare(
        `SELECT 1 FROM node_relations
         WHERE status = 'consolidated'
           AND (source_node_id = ? OR target_node_id = ?) LIMIT 1`,
      )
      .get(nodeId, nodeId);
    this.db
      .prepare("UPDATE memory_nodes SET residence = ?, updated_at = ? WHERE id = ?")
      .run(hasLongTermMemory || hasLongTermRelation ? "ltg" : "stg", updatedAt, nodeId);
  }
  recordNodeSelections(nodeIds: string[], expandedNodeIds: string[], updatedAt: string): void {
    const selected = new Set(nodeIds);
    const expanded = new Set(expandedNodeIds);
    const upsert = this.db.prepare(
      `INSERT INTO node_activation_signals
        (node_id, selected_count, expanded_count, used_count,
         contradicted_count, rejected_count, updated_at)
       VALUES (?, ?, ?, 0, 0, 0, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         selected_count = selected_count + excluded.selected_count,
         expanded_count = expanded_count + excluded.expanded_count,
         updated_at = excluded.updated_at`,
    );
    for (const nodeId of new Set([...selected, ...expanded])) {
      upsert.run(nodeId, selected.has(nodeId) ? 1 : 0, expanded.has(nodeId) ? 1 : 0, updatedAt);
    }
  }
  recordEdgeSelections(relationIds: readonly string[], updatedAt: string): void {
    const upsert = this.db.prepare(
      `INSERT INTO edge_activation_signals
        (relation_id, selected_count, used_count, contradicted_count,
         rejected_count, updated_at)
       VALUES (?, 1, 0, 0, 0, ?)
       ON CONFLICT(relation_id) DO UPDATE SET
         selected_count = selected_count + 1,
         updated_at = excluded.updated_at`,
    );
    for (const relationId of new Set(relationIds)) upsert.run(relationId, updatedAt);
  }
  recordNodeOutcomes(
    used: Set<string>,
    contradicted: Set<string>,
    rejected: Set<string>,
    updatedAt: string,
  ): void {
    const upsert = this.db.prepare(
      `INSERT INTO node_activation_signals
        (node_id, selected_count, expanded_count, used_count,
         contradicted_count, rejected_count, updated_at)
       VALUES (?, 0, 0, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         used_count = used_count + excluded.used_count,
         contradicted_count = contradicted_count + excluded.contradicted_count,
         rejected_count = rejected_count + excluded.rejected_count,
         updated_at = excluded.updated_at`,
    );
    for (const nodeId of new Set([...used, ...contradicted, ...rejected])) {
      upsert.run(
        nodeId,
        used.has(nodeId) ? 1 : 0,
        contradicted.has(nodeId) ? 1 : 0,
        rejected.has(nodeId) ? 1 : 0,
        updatedAt,
      );
    }
  }
  recordEdgeOutcomes(
    relationIds: readonly string[],
    used: Set<string>,
    contradicted: Set<string>,
    rejected: Set<string>,
    updatedAt: string,
  ): void {
    const find = this.db.prepare("SELECT * FROM node_relations WHERE id = ?");
    const rows = [...new Set(relationIds)]
      .map((relationId) => find.get(relationId) as Row | undefined)
      .filter((row): row is Row => Boolean(row));
    const totalPrediction = Math.min(
      1,
      rows.reduce((total, row) => total + Number(row.strength ?? 0.5), 0),
    );
    const updateStrength = this.db.prepare("UPDATE node_relations SET strength = ? WHERE id = ?");
    const upsert = this.db.prepare(
      `INSERT INTO edge_activation_signals
        (relation_id, selected_count, used_count, contradicted_count,
         rejected_count, updated_at)
       VALUES (?, 0, ?, ?, ?, ?)
       ON CONFLICT(relation_id) DO UPDATE SET
         used_count = used_count + excluded.used_count,
         contradicted_count = contradicted_count + excluded.contradicted_count,
         rejected_count = rejected_count + excluded.rejected_count,
         updated_at = excluded.updated_at`,
    );
    for (const row of rows) {
      const relation = mapRelation(row);
      const relationId = relation.id;
      const endpoints = [relation.sourceNodeId, relation.targetNodeId];
      const usedTogether = endpoints.every((nodeId) => used.has(nodeId));
      const negative = endpoints.some((nodeId) => contradicted.has(nodeId) || rejected.has(nodeId));
      upsert.run(
        relationId,
        usedTogether ? 1 : 0,
        endpoints.some((nodeId) => contradicted.has(nodeId)) ? 1 : 0,
        endpoints.some((nodeId) => rejected.has(nodeId)) ? 1 : 0,
        updatedAt,
      );
      if (usedTogether || negative) {
        updateStrength.run(
          updateRelationStrength(
            relation.strength,
            usedTogether && !negative ? 1 : 0,
            totalPrediction,
            1,
          ),
          relationId,
        );
      }
    }
  }
  refreshPairUsefulness(leftNodeId: string, rightNodeId: string): void {
    this.db
      .prepare(
        `UPDATE node_pair_signals SET useful_count = (
           SELECT COUNT(*) FROM edge_task_observations
           WHERE left_node_id = ? AND right_node_id = ? AND useful = 1
         ) WHERE left_node_id = ? AND right_node_id = ?`,
      )
      .run(leftNodeId, rightNodeId, leftNodeId, rightNodeId);
  }
  edgeEvidenceTraceIds(leftNodeId: string, rightNodeId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT trace_id FROM edge_task_observations
           WHERE left_node_id = ? AND right_node_id = ? AND useful = 1
           ORDER BY created_at DESC LIMIT 32`,
        )
        .all(leftNodeId, rightNodeId) as Row[]
    ).map((row) => String(row.trace_id));
  }
  recordMemoryWriteEvent(input: Omit<MemoryWriteEvent, "createdAt" | "id">): MemoryWriteEvent {
    const event: MemoryWriteEvent = {
      id: randomUUID(),
      ...input,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO memory_write_events
          (id, memory_id, history_id, session_id, decision, policy_reason,
           write_reason, write_source, memory_type, requested_residence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.memoryId,
        event.historyId,
        event.sessionId,
        event.decision,
        event.policyReason,
        event.writeReason,
        event.writeSource,
        event.memoryType,
        event.requestedResidence,
        event.createdAt,
      );
    return event;
  }
  requireConsolidationEvent(id: string): ConsolidationEvent {
    const row = this.db.prepare("SELECT * FROM consolidation_events WHERE id = ?").get(id) as
      Row | undefined;
    if (!row) throw new Error(`consolidation event ${id} does not exist`);
    return mapConsolidationEvent(row);
  }
  consolidationCoolingDown(targetId: string, cooldownMs: number): boolean {
    const row = this.db
      .prepare(
        `SELECT created_at FROM consolidation_events
         WHERE target_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(targetId) as Row | undefined;
    return Boolean(row) && Date.now() - Date.parse(String(row!.created_at)) < cooldownMs;
  }
  requireHistory(historyId: string): HistoryRecord {
    const row = this.db.prepare("SELECT * FROM history_records WHERE id = ?").get(historyId) as
      Row | undefined;
    if (!row) throw new Error(`history ${historyId} does not exist`);
    return mapHistory(row);
  }
  upsertFts(memoryId: string, statement: string, nodeId: string, evidenceId: string): void {
    const node = this.requireNode(nodeId);
    const evidence = this.requireHistory(evidenceId);
    const row = this.db
      .prepare("SELECT markers_json FROM memory_records WHERE id = ?")
      .get(memoryId) as Row | undefined;
    const triggers = recallTriggersFromStoredMarkers(row?.markers_json).join(" ");
    indexMemoryFts(this.db, {
      memoryId,
      statement,
      nodeName: node.canonicalName,
      evidence: evidence.content,
      triggers,
    });
  }
  ftsCandidates(query: string, limit: number): string[] {
    const expression = ftsExpression(query);
    if (!expression) return [];
    const link = memoryFtsLink(this.db);
    const rows = this.db
      .prepare(
        `SELECT ${link.id} AS memory_id FROM memory_fts f ${link.join}
         WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts), f.rowid LIMIT ?`,
      )
      .all(expression, limit) as Row[];
    return rows.map((row) => String(row.memory_id));
  }
  surfaceAnchorCandidates(query: string, limit: number): string[] {
    const expression = surfaceAnchorExpression(query);
    if (!expression) return [];
    const rows = this.db
      .prepare(
        `SELECT r.memory_id FROM memory_surface_fts s
         JOIN memory_fts_registry r ON r.rowid = s.rowid
         WHERE memory_surface_fts MATCH ? LIMIT ?`,
      )
      .all(expression, Math.max(1, Math.min(limit, 2_000))) as Row[];
    return rows.map((row) => String(row.memory_id));
  }
  ftsCandidatesInNodes(query: string, nodeIds: string[], limit: number): string[] {
    const expression = ftsExpression(query);
    if (!expression || nodeIds.length === 0) return [];
    const link = memoryFtsLink(this.db);
    const rows = this.db
      .prepare(
        `SELECT ${link.id} AS memory_id FROM memory_fts f ${link.join}
       JOIN memory_records m ON m.id = ${link.id}
       WHERE memory_fts MATCH ? AND m.node_id IN (${nodeIds.map(() => "?").join(",")})
       ORDER BY bm25(memory_fts), f.rowid LIMIT ?`,
      )
      .all(expression, ...nodeIds, limit) as Row[];
    return rows.map((row) => String(row.memory_id));
  }
  requireNode(nodeId: string): MemoryNode {
    const row = this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(nodeId) as
      Row | undefined;
    if (!row) throw new Error(`node ${nodeId} does not exist`);
    return mapNode(row);
  }
  resolveActiveNodeName(canonicalName: string): string {
    const row = this.db
      .prepare("SELECT * FROM memory_nodes WHERE canonical_name = ?")
      .get(canonicalName) as Row | undefined;
    if (!row) return canonicalName;
    const node = mapNode(row);
    if (node.status === "active") return node.canonicalName;
    const targets = this.db
      .prepare(
        `SELECT DISTINCT n.canonical_name FROM node_redirects r
       JOIN memory_nodes n ON n.id = r.target_node_id
       WHERE r.source_node_id = ? AND n.status = 'active'`,
      )
      .all(node.id) as Row[];
    if (targets.length === 1) return String(targets[0]!.canonical_name);
    if (targets.length > 1) {
      throw new Error(`node ${canonicalName} was split; choose a more specific node`);
    }
    return canonicalName;
  }
  resolveStateKey(requestedKey: string, scope: MemoryScope, node: MemoryNode): string {
    const scopeJson = serializeScope(scope);
    const alias = this.db
      .prepare(
        `SELECT canonical_key FROM state_key_aliases
       WHERE alias_key = ? AND scope_json = ?`,
      )
      .get(requestedKey, scopeJson) as Row | undefined;
    if (alias) return String(alias.canonical_key);

    const exact = this.db
      .prepare(
        `SELECT state_key FROM memory_records
       WHERE memory_type = 'state' AND state_key = ? AND scope_json = ?
         AND status = 'active' LIMIT 1`,
      )
      .get(requestedKey, scopeJson) as Row | undefined;
    if (exact) return requestedKey;

    const candidates = this.db
      .prepare(
        `SELECT m.state_key, n.canonical_name
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id
       WHERE m.memory_type = 'state' AND m.scope_json = ?
         AND m.status = 'active' AND m.state_key IS NOT NULL`,
      )
      .all(scopeJson) as Row[];
    const requestedIdentity = `${node.canonicalName} ${requestedKey}`;
    const requestedTokens = identityTokens(requestedIdentity);
    const matches = candidates
      .map((candidate) => {
        const identity = `${candidate.canonical_name} ${candidate.state_key}`;
        const candidateTokens = identityTokens(identity);
        const overlap =
          requestedTokens.size === 0
            ? 0
            : [...requestedTokens].filter((token) => candidateTokens.has(token)).length /
              requestedTokens.size;
        return {
          key: String(candidate.state_key),
          score: cosineSimilarity(
            this.embedder.embed(requestedIdentity),
            this.embedder.embed(identity),
          ),
          overlap,
        };
      })
      .filter((candidate) => candidate.score >= 0.65 && candidate.overlap >= 0.7)
      .sort((left, right) => right.score - left.score);
    if (matches.length === 0) return requestedKey;

    const canonicalKey = matches[0]!.key;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO state_key_aliases
        (alias_key, scope_json, canonical_key, created_at)
       VALUES (?, ?, ?, ?)`,
      )
      .run(requestedKey, scopeJson, canonicalKey, new Date().toISOString());
    return canonicalKey;
  }
  memoryIdsForNodes(nodeIds: string[]): string[] {
    const select = this.db.prepare("SELECT id FROM memory_records WHERE node_id = ?");
    return nodeIds.flatMap((nodeId) => (select.all(nodeId) as Row[]).map((row) => String(row.id)));
  }
  createTransform(
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
      rolledBackAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO node_transforms
        (id, transform_type, source_node_ids_json, target_node_ids_json,
         moved_memory_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transform.id,
        transform.type,
        JSON.stringify(transform.sourceNodeIds),
        JSON.stringify(transform.targetNodeIds),
        JSON.stringify(transform.movedMemoryIds),
        transform.createdAt,
      );
    return transform;
  }
  memoryText(
    memory: Pick<MemoryRecord, "statement"> & { eventTime?: string | null },
    _nodeId: string,
    previousTurn?: string,
  ): string {
    // The node id stays in the signature so callers do not change; the name no
    // longer takes part in the embedding text.
    return memoryEmbeddingText(memory.statement, {
      eventTime: memory.eventTime,
      previousTurn,
    });
  }
  upsertEmbedding(memoryId: string, text: string): void {
    const vector = this.embedder.embed(text);
    this.db
      .prepare(
        `INSERT INTO memory_embeddings
        (memory_id, model, dimensions, vector_json, vector_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, model) DO UPDATE SET
         dimensions = excluded.dimensions, vector_json = excluded.vector_json,
         vector_blob = excluded.vector_blob,
         updated_at = excluded.updated_at`,
      )
      .run(
        memoryId,
        memoryEmbeddingModelId(this.embedder.model),
        this.embedder.dimensions,
        "[]",
        encodeVector(vector),
        new Date().toISOString(),
      );
  }
  refreshEmbeddings(memoryIds: string[]): void {
    const select = this.db.prepare(
      `SELECT m.id, m.statement, m.event_time, m.node_id, n.canonical_name, n.summary,
              ${MEMORY_PREVIOUS_TURN_SQL} AS previous_turn
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id WHERE m.id = ?`,
    );
    for (const memoryId of memoryIds) {
      const row = select.get(memoryId) as Row | undefined;
      if (row)
        this.upsertEmbedding(
          memoryId,
          memoryEmbeddingText(row.statement, {
            eventTime: row.event_time,
            previousTurn: row.previous_turn,
          }),
        );
    }
  }
  nodeIdsForMemories(memoryIds: readonly string[]): string[] {
    const ids = [...new Set(memoryIds)];
    if (ids.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT DISTINCT node_id FROM memory_records
       WHERE id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(...ids) as Row[]
    ).map((row) => String(row.node_id));
  }
  proposalCoolingDown(proposalKey: string, cooldownMs: number): boolean {
    const row = this.db
      .prepare(
        `SELECT created_at FROM topology_proposals
       WHERE proposal_key = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(proposalKey) as Row | undefined;
    return Boolean(row) && Date.now() - Date.parse(String(row!.created_at)) < cooldownMs;
  }
  candidatePartitions(nodeId: string): Array<{ label: string; memoryIds: string[] }> {
    const rows = this.db
      .prepare(
        `SELECT id, memory_type, scope_json FROM memory_records
       WHERE node_id = ?
       ORDER BY memory_type, scope_json, id`,
      )
      .all(nodeId) as Row[];
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const key = `${row.memory_type}|${row.scope_json}`;
      const group = groups.get(key) ?? [];
      group.push(String(row.id));
      groups.set(key, group);
    }
    return [...groups].map(([label, memoryIds]) => ({ label, memoryIds }));
  }
  insertTopologyProposal(
    proposal: Omit<
      TopologyProposal,
      | "actuatedAt"
      | "actuatedTransformId"
      | "actuationError"
      | "createdAt"
      | "id"
      | "status"
      | "evidenceMemoryIds"
    > & {
      evidenceMemoryIds?: string[];
    },
  ): TopologyProposal {
    const result: TopologyProposal = {
      ...proposal,
      evidenceMemoryIds: [...new Set(proposal.evidenceMemoryIds ?? [])],
      id: randomUUID(),
      status: "pending",
      actuatedTransformId: null,
      actuationError: null,
      actuatedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO topology_proposals
        (id, proposal_key, proposal_type, source_node_ids_json, relation_type,
         partitions_json, evidence_trace_ids_json, evidence_memory_ids_json,
         observations, estimated_gain, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.id,
        result.proposalKey,
        result.type,
        JSON.stringify(result.sourceNodeIds),
        result.relationType,
        JSON.stringify(result.partitions),
        JSON.stringify(result.evidenceTraceIds),
        JSON.stringify(result.evidenceMemoryIds),
        result.observations,
        result.estimatedGain,
        result.status,
        result.createdAt,
      );
    return result;
  }
  embeddingCache(kind: "leaf" | "node", model: string): Float32VectorCache | null {
    const key = `${kind}:${model}`;
    const existing = this.vectorCaches.get(key);
    if (existing) return existing;
    const table = kind === "node" ? "node_embeddings" : "leaf_embeddings";
    const idColumn = kind === "node" ? "node_id" : "block_id";
    const rows = this.db
      .prepare(
        `SELECT ${idColumn} AS id, dimensions,
          CASE WHEN typeof(vector_blob) = 'blob' THEN vector_blob ELSE vector_json END AS vector
       FROM ${table} WHERE model = ? ORDER BY ${idColumn}`,
      )
      .all(model) as Row[];
    if (rows.length === 0) return null;
    const dimensions = Number(rows[0]!.dimensions);
    const cache = new Float32VectorCache(dimensions, rows.length);
    for (const row of rows) cache.upsert(String(row.id), storedVector(row));
    this.vectorCaches.set(key, cache);
    return cache;
  }
  updateVectorCache(
    kind: "leaf" | "node",
    model: string,
    id: string,
    vector: readonly number[],
  ): void {
    this.vectorCaches.get(`${kind}:${model}`)?.upsert(id, vector);
  }
  invalidateVectorCaches(kind: "leaf" | "node"): void {
    for (const key of this.vectorCaches.keys()) {
      if (key.startsWith(`${kind}:`)) this.vectorCaches.delete(key);
    }
  }
  markIndexDelta(
    memoryId: string,
    nodeId: string,
    operation: "move" | "upsert",
    createdAt = new Date().toISOString(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_index_delta
        (memory_id, node_id, operation, compacted, created_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(memory_id) DO UPDATE SET node_id = excluded.node_id,
         operation = excluded.operation, compacted = 0,
         created_at = excluded.created_at`,
      )
      .run(memoryId, nodeId, operation, createdAt);
    this.db
      .prepare(
        `INSERT INTO leaf_block_status (node_id, dirty, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(node_id) DO UPDATE SET dirty = 1, updated_at = excluded.updated_at`,
      )
      .run(nodeId, createdAt);
  }
  evidenceIds(memoryId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT history_id FROM memory_evidence_links
         WHERE memory_id = ? ORDER BY history_id`,
        )
        .all(memoryId) as Row[]
    ).map((row) => String(row.history_id));
  }
  resultsForNode(
    nodeId: string,
    maxTier: MemoryTier,
    limit: number,
    memoryId?: string,
    sourceActor?: MemoryActor,
    sessionId?: string | null,
    includeHistorical = false,
  ): MemorySearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT
         m.id AS m_id, m.node_id AS m_node_id,
         m.evidence_id AS m_evidence_id, m.statement AS m_statement,
         m.memory_type AS m_memory_type, m.state_key AS m_state_key,
         m.event_time AS m_event_time, m.source_actor AS m_source_actor,
         m.truth_status AS m_truth_status,
         m.confidence AS m_confidence,
         m.polarity AS m_polarity,
         m.predicate_key AS m_predicate_key, m.extract_method AS m_extract_method, m.claims_json AS m_claims_json,
         m.markers_json AS m_markers_json,
         m.scope_json AS m_scope_json, m.valid_from AS m_valid_from,
         m.valid_until AS m_valid_until, m.status AS m_status,
         m.resolution AS m_resolution, m.opened_at AS m_opened_at,
         m.related_memory_ids_json AS m_related_memory_ids_json,
         m.residence AS m_residence, m.session_id AS m_session_id, m.promoted_at AS m_promoted_at,
         m.expires_at AS m_expires_at,
         m.evidence_role AS m_evidence_role,
         m.supersedes_id AS m_supersedes_id,
         m.tier AS m_tier, m.importance AS m_importance,
         m.access_count AS m_access_count,
         m.last_accessed_at AS m_last_accessed_at,
         m.write_reason AS m_write_reason,
         m.write_source AS m_write_source,
         m.created_at AS m_created_at,
         n.id AS n_id, n.canonical_name AS n_canonical_name,
         n.kind AS n_kind, n.summary AS n_summary,
         n.created_at AS n_created_at, n.updated_at AS n_updated_at,
         n.status AS n_status, n.residence AS n_residence,
         h.id AS h_id, h.session_id AS h_session_id, h.role AS h_role,
         h.content AS h_content, h.source_message_id AS h_source_message_id,
         h.source_ref AS h_source_ref,
         h.created_at AS h_created_at
       FROM memory_records m
       JOIN memory_nodes n ON n.id = m.node_id
       JOIN history_records h ON h.id = m.evidence_id
       WHERE m.node_id = ? AND m.tier <= ? AND n.status = 'active'
         AND (m.storage_state = 'indexed' OR ? IS NOT NULL)
         AND (? IS NULL OR m.id = ?)
         AND (? IS NULL OR m.source_actor = ?)
         AND (? = 0 OR ((? IS NOT NULL AND (m.session_id IS NULL OR m.session_id = ?))
           OR (? IS NULL AND m.session_id IS NULL)))
         AND m.status IN ('active', 'disputed', 'superseded')
         AND (? = 1 OR m.status IN ('active', 'disputed'))
         AND ${notExpired("m")}
         AND (? = 1 OR ${currentlyValid("m")})
       ORDER BY m.tier ASC, m.importance DESC, m.created_at DESC
       LIMIT ?`,
      )
      .all(
        nodeId,
        maxTier,
        memoryId ?? null,
        memoryId ?? null,
        memoryId ?? null,
        sourceActor ?? null,
        sourceActor ?? null,
        sessionId === undefined ? 0 : 1,
        sessionId ?? null,
        sessionId ?? null,
        sessionId ?? null,
        includeHistorical ? 1 : 0,
        includeHistorical ? 1 : 0,
        limit,
      ) as Row[];
    return this.hydrateEvidence(rows.map((row) => mapSearchResult(row, 0)));
  }
  /** Load provenance after result selection, in bounded batches. The LEFT JOIN
   * retains linked IDs even if their history row is absent, matching the single
   * record readers. SQL ordering preserves the existing history-ID order.
   */
  protected hydrateEvidence(results: MemorySearchResult[]): MemorySearchResult[] {
    const ids = [...new Set(results.map((result) => result.memory.id))];
    const linked = new Map<string, Row[]>();
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = ids.slice(offset, offset + 400);
      const rows = this.db
        .prepare(
          `
        SELECT l.memory_id AS linked_memory_id, l.history_id AS linked_history_id, h.*
        FROM memory_evidence_links l
        LEFT JOIN history_records h ON h.id = l.history_id
        WHERE l.memory_id IN (${batch.map(() => "?").join(",")})
        ORDER BY l.memory_id, l.history_id`,
        )
        .all(...batch) as Row[];
      for (const row of rows) {
        const id = String(row.linked_memory_id);
        const records = linked.get(id) ?? [];
        records.push(row);
        linked.set(id, records);
      }
    }
    for (const result of results) {
      const rows = linked.get(result.memory.id) ?? [];
      result.memory.evidenceIds = rows.map((row) => String(row.linked_history_id));
      result.evidenceRecords = rows.filter((row) => row.id !== null).map(mapHistory);
    }
    return results;
  }
  evidenceRecords(ids: string[]): HistoryRecord[] {
    const statement = this.db.prepare("SELECT * FROM history_records WHERE id = ?");
    return ids.flatMap((id) => {
      const row = statement.get(id) as Row | undefined;
      return row ? [mapHistory(row)] : [];
    });
  }
}
