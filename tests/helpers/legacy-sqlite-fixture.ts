import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { recallTriggerMarkers } from "../../src/core/recall-triggers.ts";
import { serializeScope } from "../../src/core/scope.ts";
import { migrate } from "../../src/core/store/schema.ts";
import { encodeVector } from "../../src/core/store/vector-codec.ts";
import type { RememberInput } from "../../src/core/types.ts";

type LegacyBookmark = NonNullable<RememberInput["tesserae"]>[number] & { id: string };
const nullable = <T>(value: T | undefined): T | null => value ?? null;

function legacyRowDefaults(input: RememberInput) {
  return {
    actor: input.sourceActor ?? "user",
    truth: input.truthStatus ?? "asserted",
    claims: input.claims ? JSON.stringify(input.claims) : null,
    related: JSON.stringify(input.relatedMemoryIds ?? []),
    importance: input.importance ?? 0.5,
  };
}

/** Build legacy SQLite inputs for migration contracts using rows and stable defaults. */
export class LegacySqliteFixture {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  insertMemory(input: RememberInput) {
    const now = new Date().toISOString();
    const id = randomUUID();
    const historyId = randomUUID();
    const nodeId = this.insertNode(input, now);
    const residence = input.residence ?? "ltg";
    const sessionId = residence === "stg" ? (input.sessionId ?? null) : null;
    const memoryType = input.memoryType ?? "fact";
    const scope = serializeScope(input.scope ?? {});
    const files = (input.tesserae ?? []).map((file) => ({ ...file, id: randomUUID() }));
    const markers = [
      ...(input.markers ?? []),
      ...recallTriggerMarkers(input.recallTriggers),
      ...files.map(({ id }) => ({ kind: "tessera_ref", attributes: { tesseraId: id } })),
    ];
    const predecessor = input.supersedesId ?? this.previousState(input, nodeId, scope);
    this.insertHistory(historyId, sessionId, input, now);
    const defaults = legacyRowDefaults(input);
    this.db
      .prepare(
        "INSERT INTO memory_records (id,node_id,evidence_id,statement,memory_type,state_key,event_time,source_actor,truth_status,claims_json,markers_json,session_id,scope_json,valid_from,valid_until,related_memory_ids_json,residence,evidence_role,supersedes_id,tier,importance,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        nodeId,
        historyId,
        input.statement,
        memoryType,
        nullable(input.stateKey),
        nullable(input.eventTime),
        defaults.actor,
        defaults.truth,
        defaults.claims,
        JSON.stringify(markers),
        sessionId,
        scope,
        nullable(input.validFrom),
        nullable(input.validUntil),
        defaults.related,
        residence,
        predecessor ? "update" : "support",
        predecessor,
        input.tier ?? (residence === "stg" ? 0 : 1),
        defaults.importance,
        now,
      );
    if (predecessor)
      this.db
        .prepare("UPDATE memory_records SET status='superseded',valid_until=? WHERE id=?")
        .run(input.validFrom ?? now, predecessor);
    this.insertBookmarks(files, id, now);
    return { memory: { id }, node: { id: nodeId }, history: { id: historyId } };
  }

  private insertHistory(
    historyId: string,
    sessionId: string | null,
    input: RememberInput,
    now: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO history_records (id, session_id, role, content, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        historyId,
        sessionId,
        "explicit",
        input.evidence ?? input.statement,
        input.sourceRef ?? null,
        now,
      );
  }

  private insertBookmarks(files: readonly LegacyBookmark[], id: string, now: string): void {
    for (const file of files)
      this.db
        .prepare(
          "INSERT INTO tesserae (id,path,snippet,label,kind,memory_id,created_at,file_simhash) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          file.id,
          file.path,
          file.snippet,
          file.label ?? file.path,
          file.kind ?? null,
          id,
          now,
          file.fileSimhash ?? null,
        );
  }

  private insertNode(input: RememberInput, now: string): string {
    const nodeName = (input.nodeName ?? "").trim();
    const existing = this.db
      .prepare("SELECT id FROM memory_nodes WHERE canonical_name=?")
      .get(nodeName);
    if (existing) return String(existing.id);
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO memory_nodes (id,canonical_name,kind,summary,created_at,updated_at,residence) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        id,
        nodeName,
        input.nodeKind ?? "concept",
        input.nodeSummary ?? nodeName,
        now,
        now,
        input.residence ?? "ltg",
      );
    return id;
  }

  private previousState(input: RememberInput, nodeId: string, scope: string): string | null {
    if (!input.stateKey) return null;
    const row = this.db
      .prepare(
        "SELECT id FROM memory_records WHERE state_key=? AND node_id=? AND scope_json=? AND status='active' LIMIT 1",
      )
      .get(input.stateKey, nodeId, scope);
    return row ? String(row.id) : null;
  }

  insertRelation(input: {
    sourceNodeId: string;
    targetNodeId: string;
    type: string;
    evidenceIds: string[];
  }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO node_relations (id, source_node_id, target_node_id, relation_type, evidence_ids_json, consolidated_at, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.sourceNodeId,
        input.targetNodeId,
        input.type,
        JSON.stringify(input.evidenceIds),
        now,
        now,
      );
    return { id };
  }

  insertChain(type: "logical" | "temporal", topic: string): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO memory_chains (id, chain_type, topic, created_at) VALUES (?,?,?,?)")
      .run(id, type, topic, new Date().toISOString());
    return id;
  }

  insertChainMember(chainId: string, memoryId: string): void {
    const position = this.db
      .prepare("SELECT count(*) AS n FROM memory_chain_members WHERE chain_id=?")
      .get(chainId)!.n!;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO memory_chain_members (chain_id,memory_id,position,created_at) VALUES (?,?,?,?)",
      )
      .run(chainId, memoryId, position, new Date().toISOString());
  }

  insertChainEdge(chainId: string, sourceMemoryId: string, targetMemoryId: string): void {
    this.insertChainMember(chainId, sourceMemoryId);
    this.insertChainMember(chainId, targetMemoryId);
    this.db
      .prepare(
        "INSERT INTO memory_chain_edges (chain_id,source_memory_id,target_memory_id,created_at) VALUES (?,?,?,?)",
      )
      .run(chainId, sourceMemoryId, targetMemoryId, new Date().toISOString());
  }

  insertVector(kind: "record" | "node", model: string, id: string, vector: number[]): void {
    const row = kind === "record" ? "memory_embeddings (memory_id" : "node_embeddings (node_id";
    this.db
      .prepare(
        "INSERT INTO " +
          row +
          ",model,dimensions,vector_json,vector_blob,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        id,
        model,
        vector.length,
        JSON.stringify(vector),
        encodeVector(vector),
        new Date().toISOString(),
      );
  }
}
