/**
 * Embedding index lifecycle state.
 *
 * Tracks a rebuild of the embedding indexes as a small state machine
 * (running → ready | failed) in `embedding_index_state`, so an interrupted or
 * failed rebuild is visible after restart rather than silently leaving the
 * indexes half-populated.
 *
 * Extracted from NmgStore: this group reads and writes only the database
 * handle, with no dependency on the embedder, router or vector caches.
 */

import type { DatabaseSync } from "node:sqlite";

import type { EmbeddingIndexHealth } from "../types.ts";
import { parseStringArray } from "./row-parse.ts";

type Row = Record<string, string | number | Uint8Array | null>;

export function beginEmbeddingIndex(
  db: DatabaseSync,
  input: {
    indexId: string;
    model: string;
    profile: string;
    targets: Array<"leaves" | "nodes" | "records">;
  },
): void {
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT targets_json FROM embedding_index_state WHERE index_id = ?")
    .get(input.indexId) as { targets_json?: string } | undefined;
  let prior: string[] = [];
  try {
    const parsed = JSON.parse(String(existing?.targets_json ?? "[]")) as unknown;
    if (Array.isArray(parsed)) prior = parsed.map(String);
  } catch {
    prior = [];
  }
  // Partial syncs (records-only, leaves-only) share one index row: union the
  // targets so a leaf sync does not erase the records target and vice versa.
  const targets = [...new Set([...prior, ...input.targets])].sort();
  if (targets.length === 0) throw new Error("embedding index requires at least one target");
  db.prepare(
    `INSERT INTO embedding_index_state
        (index_id, model, profile, targets_json, status, last_started_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?)
       ON CONFLICT(index_id) DO UPDATE SET model = excluded.model,
         profile = excluded.profile, targets_json = excluded.targets_json,
         status = 'running',
         last_started_at = excluded.last_started_at, last_error = NULL,
         updated_at = excluded.updated_at`,
  ).run(input.indexId, input.model, input.profile, JSON.stringify(targets), now, now);
}

export function completeEmbeddingIndex(db: DatabaseSync, indexId: string): void {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE embedding_index_state SET status = 'ready',
         last_succeeded_at = ?, last_error = NULL, updated_at = ?
       WHERE index_id = ?`,
    )
    .run(now, now, indexId);
  if (Number(result.changes) === 0) throw new Error(`embedding index ${indexId} was not started`);
}

export function failEmbeddingIndex(db: DatabaseSync, indexId: string, error: unknown): void {
  const now = new Date().toISOString();
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  const result = db
    .prepare(
      `UPDATE embedding_index_state SET status = 'failed',
         last_failed_at = ?, last_error = ?, updated_at = ?
       WHERE index_id = ?`,
    )
    .run(now, message, now, indexId);
  if (Number(result.changes) === 0) throw new Error(`embedding index ${indexId} was not started`);
}

export function embeddingIndexHealth(
  db: DatabaseSync,
  indexId: string,
): EmbeddingIndexHealth | null {
  const row = db.prepare("SELECT * FROM embedding_index_state WHERE index_id = ?").get(indexId) as
    Row | undefined;
  if (!row) return null;
  const targets = parseStringArray(row.targets_json) as EmbeddingIndexHealth["targets"];
  const includes = (target: EmbeddingIndexHealth["targets"][number]): boolean =>
    targets.includes(target);
  const count = (sql: string): number => Number((db.prepare(sql).get(indexId) as Row).count ?? 0);
  return {
    indexId,
    model: String(row.model),
    profile: String(row.profile),
    targets,
    status: String(row.status) as EmbeddingIndexHealth["status"],
    pending: {
      nodes: includes("nodes")
        ? count(`SELECT COUNT(*) AS count FROM memory_nodes n
            LEFT JOIN node_embeddings e ON e.node_id = n.id AND e.model = ?
            WHERE n.status = 'active' AND (e.node_id IS NULL OR e.updated_at < n.updated_at)`)
        : 0,
      leaves: includes("leaves")
        ? count(`SELECT COUNT(*) AS count FROM memory_leaf_blocks b
            LEFT JOIN leaf_embeddings e ON e.block_id = b.id AND e.model = ?
            WHERE e.block_id IS NULL OR e.updated_at < b.updated_at`)
        : 0,
      records: includes("records")
        ? count(`SELECT COUNT(*) AS count FROM memory_records m
            LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ?
            WHERE e.memory_id IS NULL`)
        : 0,
      dirtyNodes: includes("leaves")
        ? Number(
            (
              db
                .prepare("SELECT COUNT(*) AS count FROM leaf_block_status WHERE dirty = 1")
                .get() as Row
            ).count ?? 0,
          )
        : 0,
    },
    indexed: {
      nodes: count("SELECT COUNT(*) AS count FROM node_embeddings WHERE model = ?"),
      leaves: count("SELECT COUNT(*) AS count FROM leaf_embeddings WHERE model = ?"),
      records: count("SELECT COUNT(*) AS count FROM memory_embeddings WHERE model = ?"),
    },
    lastStartedAt: row.last_started_at ? String(row.last_started_at) : null,
    lastSucceededAt: row.last_succeeded_at ? String(row.last_succeeded_at) : null,
    lastFailedAt: row.last_failed_at ? String(row.last_failed_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
  };
}
