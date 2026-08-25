import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

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
  PerfSnapshot,
  TaskBoardEntry,
  TaskBoardKind,
  TopologyProposal,
  VectorEmbedder,
} from "../types.ts";
import { WORLD_BOARD_ID } from "../types.ts";
import { histogramAdd } from "../perf.ts";
import { Router } from "../router.ts";
import { cosineSimilarity, HashingVectorEmbedder } from "../vector.ts";
import { Float32VectorCache } from "../vector-cache.ts";
import { migrate } from "./schema.ts";
import { parseNumberArray } from "./row-parse.ts";
import { encodeVector, storedVector } from "./vector-codec.ts";
import { updateRelationStrength } from "../edge-activation.ts";
import { serializeScope } from "../scope.ts";
import {
  ftsExpression,
  ftsIndexedText,
  memoryEmbeddingText,
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

export class NmgStoreBase {
  protected db: DatabaseSync;
  protected embedder: VectorEmbedder;
  protected router: Router;
  protected vectorCaches = new Map<string, Float32VectorCache>();

  constructor(databasePath: string, embedder: VectorEmbedder = new HashingVectorEmbedder()) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.embedder = embedder;
    this.router = new Router(embedder);
    try {
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA cache_size = -64000;
        PRAGMA temp_store = MEMORY;
        PRAGMA mmap_size = 268435456;
        PRAGMA busy_timeout = 5000;
      `);
      migrate(this.db);
      // checkpoint-on-open: fold any -wal left behind by a force-exit shutdown
      // (where close() never ran) into the main DB and truncate it, so WAL can
      // never accumulate across restarts. SQLite auto-recovers WAL frames on
      // open. Conditional on a non-empty -wal: normal close() already
      // checkpoints, so the common open path skips the blocking TRUNCATE
      // (stg-v2 review ③a; wal_checkpoint is synchronous disk I/O that stalls
      // the event loop when the WAL is large).
      if (existsSync(`${databasePath}-wal`)) {
        try {
          if (statSync(`${databasePath}-wal`).size > 0) {
            this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          }
        } catch {
          // best effort; a racing process may have removed the file
        }
      }
    } catch (error) {
      // A corrupt database makes PRAGMA/migrate throw while the underlying
      // handle is still open. Close it before propagating, or the file stays
      // locked on Windows and any cleanup (rmSync) fails with EPERM forever.
      try {
        this.db.close();
      } catch {
        // Best effort; the original error is the one the caller needs.
      }
      throw error;
    }
  }

  close(): void {
    // WAL checkpoint before close: without this the daemon's force-exit
    // shutdown leaves -wal files behind (v1 measured ~1.5G across 1681
    // session STG stores). TRUNCATE folds WAL into the main DB then resets it.
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // ignore — closing anyway
    }
    this.db.close();
  }
  putTaskBoardEntry(input: {
    taskId: string;
    agentId: string;
    sourceSessionId?: string;
    kind: TaskBoardKind;
    content: string;
    expiresAt: string;
    /** Directed delivery: stable agent_name to wake for this entry. */
    to?: string;
  }): TaskBoardEntry {
    const now = new Date().toISOString();
    this.pruneExpiredTaskBoardEntries(now, input.taskId);
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM task_board_entries WHERE task_id = ?",
        )
        .get(input.taskId) as Row;
      const sequence = Number(row.next_sequence);
      // Reply-gated serial handoff: an un-directed actionable (handoff/
      // question/blocker) is 'outstanding' if no other open un-directed
      // actionable exists in this channel yet, else 'pending' (queued until
      // the outstanding one is replied/resolved). Directed entries and
      // notify-only kinds are not serialised (point-to-point, parallel-safe).
      const actionable =
        input.kind === "handoff" || input.kind === "question" || input.kind === "blocker";
      let serialState: string | null = null;
      if (actionable && input.to == null) {
        const outstanding = this.db
          .prepare(
            "SELECT 1 FROM task_board_entries WHERE task_id = ? AND status = 'open' " +
              "AND serial_state = 'outstanding' LIMIT 1",
          )
          .get(input.taskId);
        serialState = outstanding ? "pending" : "outstanding";
      }
      this.db
        .prepare(
          `INSERT INTO task_board_entries(
             id, task_id, sequence, agent_id, source_session_id, kind, content,
             status, created_at, expires_at, [to], serial_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.taskId,
          sequence,
          input.agentId,
          input.sourceSessionId ?? null,
          input.kind,
          input.content,
          now,
          input.expiresAt,
          input.to ?? null,
          serialState,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.taskBoardEntry(id)!;
  }
  readTaskBoard(input: {
    taskId: string;
    afterCursor?: number;
    limit?: number;
    includeResolved?: boolean;
    now?: string;
  }): { entries: TaskBoardEntry[]; nextCursor: number } {
    const now = input.now ?? new Date().toISOString();
    this.pruneExpiredTaskBoardEntries(now, input.taskId);
    const rows = this.db
      .prepare(
        `SELECT * FROM task_board_entries
         WHERE task_id = ? AND sequence > ?
           AND (? = 1 OR status = 'open')
         ORDER BY sequence ASC LIMIT ?`,
      )
      .all(
        input.taskId,
        Math.max(0, input.afterCursor ?? 0),
        input.includeResolved ? 1 : 0,
        Math.max(1, Math.min(input.limit ?? 50, 200)),
      ) as Row[];
    const rawEntries = rows.map(mapTaskBoardEntry);
    const ackMap = this.taskBoardAckMap(rawEntries.map((entry) => entry.id));
    for (const entry of rawEntries) entry.ackedBy = ackMap.get(entry.id) ?? [];
    return {
      entries: rawEntries,
      nextCursor: rawEntries.at(-1)?.sequence ?? Math.max(0, input.afterCursor ?? 0),
    };
  }
  /** Open point-to-point entries addressed to this stable agent identity.
   * Unlike channel reads, this inbox spans named boards so directed delivery
   * does not require the recipient to discover and subscribe first. */
  readDirectedTaskBoard(input: {
    agentId: string;
    agentName: string;
    limit?: number;
    now?: string;
  }): TaskBoardEntry[] {
    const now = input.now ?? new Date().toISOString();
    this.pruneExpiredTaskBoardEntries(now);
    const targets = [...new Set([input.agentId.trim(), input.agentName.trim()].filter(Boolean))];
    if (targets.length === 0) return [];
    const placeholders = targets.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM task_board_entries
         WHERE status = 'open' AND expires_at > ? AND [to] IN (${placeholders})
         ORDER BY created_at ASC, task_id ASC, sequence ASC LIMIT ?`,
      )
      .all(now, ...targets, Math.max(1, Math.min(input.limit ?? 50, 200))) as Row[];
    const entries = rows.map(mapTaskBoardEntry);
    const ackMap = this.taskBoardAckMap(entries.map((entry) => entry.id));
    for (const entry of entries) entry.ackedBy = ackMap.get(entry.id) ?? [];
    return entries;
  }
  resolveTaskBoardEntry(input: {
    taskId: string;
    entryId: string;
    agentId: string;
    resolution?: string;
  }): TaskBoardEntry {
    const existing = this.taskBoardEntry(input.entryId);
    if (!existing || existing.taskId !== input.taskId) {
      throw new Error(`task board entry not found in task ${input.taskId}`);
    }
    if (existing.status === "resolved") return existing;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE task_board_entries
         SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ?,
             claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL
         WHERE id = ? AND task_id = ?`,
      )
      .run(now, input.agentId, input.resolution ?? null, input.entryId, input.taskId);
    // RAII: receipts are bound to the entry lifecycle. The wake loop only scans
    // open entries, so a resolved entry's delivery receipts are dead state —
    // clear them with the close so task_board_deliveries cannot grow without
    // bound. Acknowledgements die with the entry for the same reason.
    this.db.prepare("DELETE FROM task_board_deliveries WHERE entry_id = ?").run(input.entryId);
    this.db.prepare("DELETE FROM task_board_acks WHERE entry_id = ?").run(input.entryId);
    // Reply-gated serial handoff: the outstanding actionable is done — promote
    // the earliest pending to outstanding so the next one can be worked.
    this.promoteNextSerialPending(input.taskId);
    return this.taskBoardEntry(input.entryId)!;
  }
  /** True when a board entry carries a live claim (holder set, lease not expired). */
  private taskBoardClaimLive(entry: TaskBoardEntry, now: string): boolean {
    return entry.claimedBy !== null && entry.claimExpiresAt !== null && entry.claimExpiresAt > now;
  }
  /**
   * Reply-gated serial handoff: promote the earliest pending actionable to
   * outstanding, unless an un-claimed outstanding already occupies the serial
   * slot. An outstanding that is claimed ("回复=接手", someone is working it) or
   * resolved no longer blocks; the claim/resolve/prune paths call this to let
   * the queue move. A lapsed claim leaves the entry outstanding (still waiting
   * to be claimed), so no promotion happens — correct: it is not yet replied.
   */
  private promoteNextSerialPending(taskId: string): void {
    const hasUnclaimedOutstanding = this.db
      .prepare(
        "SELECT 1 FROM task_board_entries WHERE task_id = ? AND status = 'open' " +
          "AND serial_state = 'outstanding' AND claimed_by IS NULL LIMIT 1",
      )
      .get(taskId);
    if (hasUnclaimedOutstanding) return;
    const pending = this.db
      .prepare(
        "SELECT id FROM task_board_entries WHERE task_id = ? AND status = 'open' " +
          "AND serial_state = 'pending' ORDER BY sequence ASC LIMIT 1",
      )
      .get(taskId) as Row | undefined;
    if (pending) {
      this.db
        .prepare("UPDATE task_board_entries SET serial_state = 'outstanding' WHERE id = ?")
        .run(String(pending.id));
    }
  }
  /**
   * Lease-based claiming via a single atomic compare-and-set UPDATE. Succeeds
   * when the entry is open and unclaimed (or its lease lapsed), or when the
   * caller already holds it (a re-claim/heartbeat that refreshes the lease).
   * Lease expiry is enforced lazily here — no background sweeper. On a losing
   * CAS the failure is diagnosed against a fresh read so the caller is not
   * sent chasing a holder that does not exist.
   */
  claimTaskBoardEntry(input: {
    taskId: string;
    entryId: string;
    agentId: string;
    leaseSeconds?: number;
    now?: string;
  }): TaskBoardEntry {
    const now = input.now ?? new Date().toISOString();
    this.pruneExpiredTaskBoardEntries(now, input.taskId);
    const existing = this.taskBoardEntry(input.entryId);
    if (!existing || existing.taskId !== input.taskId) {
      throw new Error(`task board entry not found in task ${input.taskId}`);
    }
    if (existing.serialState === "pending") {
      throw new Error(
        `task board entry ${input.entryId} is pending until the prior serial entry is claimed, resolved, or expires`,
      );
    }
    const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 3600, 60), 86_400);
    const expiresAt = new Date(Date.parse(now) + leaseSeconds * 1_000).toISOString();
    const result = this.db
      .prepare(
        `UPDATE task_board_entries
         SET claimed_by = ?, claimed_at = ?, claim_expires_at = ?
         WHERE id = ? AND task_id = ?
           AND status = 'open'
           AND (
             (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)
             OR claimed_by = ?
           )`,
      )
      .run(input.agentId, now, expiresAt, input.entryId, input.taskId, now, input.agentId);
    if (Number(result.changes) === 0) {
      // CAS lost — diagnose against a fresh read (do not trust the snapshot).
      const current = this.taskBoardEntry(input.entryId)!;
      if (current.status === "resolved") {
        throw new Error(`task board entry ${input.entryId} already resolved`);
      }
      if (this.taskBoardClaimLive(current, now) && current.claimedBy !== input.agentId) {
        throw new Error(
          `task board entry ${input.entryId} already claimed by ${current.claimedBy}`,
        );
      }
      throw new Error(`task board entry ${input.entryId} claim conflicted; retry`);
    }
    // Reply-gated serial handoff: "回复=接手（claim）" — once the outstanding
    // actionable is claimed by an agent, the claim is the reply that lets the
    // next pending promote to outstanding (someone is working it, so it no
    // longer occupies the serial slot). A claimed entry stops counting as the
    // blocking outstanding.
    if (existing.serialState === "outstanding") {
      this.db
        .prepare("UPDATE task_board_entries SET serial_state = NULL WHERE id = ?")
        .run(input.entryId);
      this.promoteNextSerialPending(input.taskId);
    }
    return this.taskBoardEntry(input.entryId)!;
  }
  /** Release a claim back to the open pool. Only the current holder may release. */
  releaseTaskBoardEntry(input: {
    taskId: string;
    entryId: string;
    agentId: string;
  }): TaskBoardEntry {
    const result = this.db
      .prepare(
        `UPDATE task_board_entries
         SET claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL
         WHERE id = ? AND task_id = ? AND claimed_by = ? AND status = 'open'`,
      )
      .run(input.entryId, input.taskId, input.agentId);
    if (Number(result.changes) === 0) {
      const existing = this.taskBoardEntry(input.entryId);
      if (!existing || existing.taskId !== input.taskId) {
        throw new Error(`task board entry not found in task ${input.taskId}`);
      }
      if (existing.status === "resolved") {
        throw new Error(`task board entry ${input.entryId} already resolved`);
      }
      throw new Error(`task board entry ${input.entryId} not claimed by ${input.agentId}`);
    }
    return this.taskBoardEntry(input.entryId)!;
  }
  /** Record a delivery receipt: the wake loop reached this session for this
   * entry. Idempotent (UNIQUE(entry_id, session_id)); re-acking is fine. */
  recordTaskBoardDelivery(input: {
    entryId: string;
    sessionId: string;
    source?: string;
    now?: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_board_deliveries (id, entry_id, session_id, source, delivered_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.entryId,
        input.sessionId,
        input.source ?? "wake",
        input.now ?? new Date().toISOString(),
      );
  }
  /** System-layer agent registration (A2A AgentCard local edition). Called by
   * hooks/extensions on startup + heartbeat. Upsert + refresh last_seen.
   * Never wakes an LLM, never enters context. Fields aligned with A2A
   * AgentCard (name/description/version/url/capabilities/skills/
   * supportedInterfaces) so a future external-agent gateway maps with zero
   * model change. */
  registerTaskBoardAgent(input: {
    id: string;
    agentName: string;
    description?: string;
    version?: string;
    url?: string;
    capabilities?: string;
    skills?: string;
    supportedInterfaces?: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO task_board_agents(
           id, agent_name, description, version, url, capabilities, skills,
           supported_interfaces, last_seen_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent_name = excluded.agent_name,
           description = excluded.description,
           version = excluded.version,
           url = excluded.url,
           capabilities = excluded.capabilities,
           skills = excluded.skills,
           supported_interfaces = excluded.supported_interfaces,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        input.id,
        input.agentName,
        input.description ?? null,
        input.version ?? null,
        input.url ?? null,
        input.capabilities ?? null,
        input.skills ?? null,
        input.supportedInterfaces ?? null,
        now,
        now,
      );
  }

  /** System-layer heartbeat: refresh last_seen so the agent stays online.
   * Keyed by the stable id (never the mutable display name). */
  heartbeatTaskBoardAgent(input: { id: string }): void {
    this.db
      .prepare("UPDATE task_board_agents SET last_seen_at = ? WHERE id = ?")
      .run(new Date().toISOString(), input.id);
  }

  /** Runtime rename: change the display agent_name for a stable id (the id is
   * the routing key and never changes; only the human-readable label does). */
  renameTaskBoardAgent(input: { id: string; agentName: string }): void {
    this.db
      .prepare("UPDATE task_board_agents SET agent_name = ? WHERE id = ?")
      .run(input.agentName, input.id);
  }

  /** Find-and-direct roster: online agents, optionally filtered by a
   * capabilities substring (A2A discovery semantics localised). Online =
   * last_seen_at within NMG_AGENT_ONLINE_MS (default 10 min). Never wakes an
   * LLM — this is the identity roster used to pick `to=` for a directed put. */
  discoverTaskBoardAgents(input: { capabilities?: string }): Array<{
    id: string;
    agentName: string;
    description: string | null;
    capabilities: string | null;
    lastSeenAt: string;
  }> {
    const onlineMs = Number(process.env.NMG_AGENT_ONLINE_MS ?? 600_000);
    const since = new Date(Date.now() - onlineMs).toISOString();
    let sql =
      "SELECT id, agent_name, description, capabilities, last_seen_at " +
      "FROM task_board_agents WHERE last_seen_at >= ?";
    const args: Array<string | number | null> = [since];
    if (input.capabilities) {
      sql += " AND capabilities LIKE ?";
      args.push(`%${input.capabilities}%`);
    }
    sql += " ORDER BY last_seen_at DESC";
    return (this.db.prepare(sql).all(...args) as Row[]).map((row) => ({
      id: String(row.id),
      agentName: String(row.agent_name),
      description: row.description === null ? null : String(row.description),
      capabilities: row.capabilities === null ? null : String(row.capabilities),
      lastSeenAt: String(row.last_seen_at),
    }));
  }

  /** True when a delivery receipt exists for this session + entry. */
  hasTaskBoardDelivery(input: { entryId: string; sessionId: string }): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM task_board_deliveries WHERE entry_id = ? AND session_id = ?")
      .get(input.entryId, input.sessionId) as Row | undefined;
    return row !== undefined;
  }
  /** Record an acknowledgement: the agent has seen and accepted this entry and
   * owes no reply ("确认但不用回"). Idempotent (UNIQUE(entry_id, agent_id));
   * re-acking updates the timestamp/reason. Pure state write — never triggers
   * a broadcast or wake, and acked entries stop being wake candidates for the
   * acking agent. */
  acknowledgeTaskBoardEntry(input: {
    entryId: string;
    agentId: string;
    reason?: string;
    now?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO task_board_acks (id, entry_id, agent_id, acknowledged_at, reason)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(entry_id, agent_id) DO UPDATE SET
           acknowledged_at = excluded.acknowledged_at,
           reason = excluded.reason`,
      )
      .run(
        randomUUID(),
        input.entryId,
        input.agentId,
        input.now ?? new Date().toISOString(),
        input.reason ?? null,
      );
  }
  /** Agent ids that have acknowledged each of the given entries (logical
   * "N checkmarks" per entry). Empty map when no entryIds given. */
  taskBoardAckMap(entryIds: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (entryIds.length === 0) return result;
    const rows = this.db
      .prepare(
        `SELECT entry_id, agent_id FROM task_board_acks
         WHERE entry_id IN (${entryIds.map(() => "?").join(",")})
         ORDER BY agent_id ASC`,
      )
      .all(...entryIds) as Row[];
    for (const row of rows) {
      const entryId = String(row.entry_id);
      const list = result.get(entryId) ?? [];
      list.push(String(row.agent_id));
      result.set(entryId, list);
    }
    return result;
  }
  /** Which of the given entryIds have been acknowledged by any of the given
   * agent ids. Wake-loop support: an acked entry must not be re-notified to the
   * acking agent. */
  taskBoardAckedIds(entryIds: string[], agentIds: string[]): Set<string> {
    const result = new Set<string>();
    if (entryIds.length === 0 || agentIds.length === 0) return result;
    const rows = this.db
      .prepare(
        `SELECT entry_id FROM task_board_acks
         WHERE entry_id IN (${entryIds.map(() => "?").join(",")})
           AND agent_id IN (${agentIds.map(() => "?").join(",")})`,
      )
      .all(...entryIds, ...agentIds) as Row[];
    for (const row of rows) result.add(String(row.entry_id));
    return result;
  }
  /** Fetch a single board entry (with its ack list populated) scoped to a
   * task id; null when the entry does not exist in that task. */
  getTaskBoardEntryById(taskId: string, entryId: string): TaskBoardEntry | null {
    const entry = this.taskBoardEntry(entryId);
    if (!entry || entry.taskId !== taskId) return null;
    return entry;
  }
  /** Opt a session out of wake notices for a channel (do-not-send registry). */
  suppressTaskBoard(input: { sessionId: string; taskId: string; now?: string }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_board_suppressions (session_id, task_id, unsubscribed_at)
         VALUES (?, ?, ?)`,
      )
      .run(input.sessionId, input.taskId, input.now ?? new Date().toISOString());
  }
  /** True when a session is suppressed for a channel (will not be woken for it). */
  isTaskBoardSuppressed(input: { sessionId: string; taskId: string }): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM task_board_suppressions WHERE session_id = ? AND task_id = ?")
      .get(input.sessionId, input.taskId) as Row | undefined;
    return row !== undefined;
  }
  /** All channels a session is suppressed on (for the /nmg wake menu). */
  listTaskBoardSuppressions(sessionId: string): Array<{
    taskId: string;
    unsubscribedAt: string;
  }> {
    return (
      this.db
        .prepare(
          `SELECT task_id, unsubscribed_at FROM task_board_suppressions
           WHERE session_id = ? ORDER BY unsubscribed_at DESC`,
        )
        .all(sessionId) as Row[]
    ).map((row) => ({
      taskId: String(row.task_id),
      unsubscribedAt: String(row.unsubscribed_at),
    }));
  }
  /** Remove a session's suppression for a channel (re-subscribe). */
  unsuppressTaskBoard(input: { sessionId: string; taskId: string }): void {
    this.db
      .prepare(`DELETE FROM task_board_suppressions WHERE session_id = ? AND task_id = ?`)
      .run(input.sessionId, input.taskId);
  }
  /** Explicitly join a channel: the session receives wake notices for it.
   * Topic-based membership — the world channel is the default member channel
   * (opt out via suppressTaskBoard), named channels require this to join.
   * Idempotent (PRIMARY KEY (session_id, task_id)). */
  subscribeTaskBoard(input: { sessionId: string; taskId: string; now?: string }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_board_subscriptions (session_id, task_id, subscribed_at)
         VALUES (?, ?, ?)`,
      )
      .run(input.sessionId, input.taskId, input.now ?? new Date().toISOString());
  }
  /** Leave a channel: stop receiving wake notices for it. */
  unsubscribeTaskBoard(input: { sessionId: string; taskId: string }): void {
    this.db
      .prepare(`DELETE FROM task_board_subscriptions WHERE session_id = ? AND task_id = ?`)
      .run(input.sessionId, input.taskId);
  }
  /** True when this session has explicitly subscribed to the channel. The
   * world channel is implicitly subscribed for every session (membership is
   * the default there); named channels require an explicit subscribe. */
  isTaskBoardSubscribed(input: { sessionId: string; taskId: string }): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM task_board_subscriptions WHERE session_id = ? AND task_id = ?")
      .get(input.sessionId, input.taskId) as Row | undefined;
    return row !== undefined;
  }

  // ── memory chains (static ordered-reference DAG forests) ──

  /** Create a new memory chain (temporal or logical). Chains are written
   * explicitly under natural supervision — never auto-inferred. */
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `DELETE FROM memory_chain_edges
           WHERE chain_id = ? AND (source_memory_id = ? OR target_memory_id = ?)`,
        )
        .run(input.chainId, input.memoryId, input.memoryId);
      const result = this.db
        .prepare("DELETE FROM memory_chain_members WHERE chain_id = ? AND memory_id = ?")
        .run(input.chainId, input.memoryId);
      this.db.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
  listTaskBoardSubscriptions(sessionId: string): Array<{
    taskId: string;
    subscribedAt: string;
  }> {
    return (
      this.db
        .prepare(
          `SELECT task_id, subscribed_at FROM task_board_subscriptions
           WHERE session_id = ? AND task_id != ? ORDER BY subscribed_at DESC`,
        )
        .all(sessionId, WORLD_BOARD_ID) as Row[]
    ).map((row) => ({
      taskId: String(row.task_id),
      subscribedAt: String(row.subscribed_at),
    }));
  }
  pruneExpiredTaskBoardEntries(now = new Date().toISOString(), taskId?: string): number {
    // RAII: an expired entry's receipts die with it (same binding as resolve).
    // Serial handoff: if an expired entry was the blocking outstanding, promote
    // the earliest pending of that channel after the delete.
    if (taskId) {
      this.db
        .prepare(
          `DELETE FROM task_board_deliveries WHERE entry_id IN (
             SELECT id FROM task_board_entries WHERE task_id = ? AND expires_at <= ?)`,
        )
        .run(taskId, now);
      this.db
        .prepare(
          `DELETE FROM task_board_acks WHERE entry_id IN (
             SELECT id FROM task_board_entries WHERE task_id = ? AND expires_at <= ?)`,
        )
        .run(taskId, now);
      const changed = Number(
        this.db
          .prepare("DELETE FROM task_board_entries WHERE task_id = ? AND expires_at <= ?")
          .run(taskId, now).changes,
      );
      this.promoteNextSerialPending(taskId);
      return changed;
    }
    // Collect channels whose blocking outstanding just expired, so their
    // pending queue can move after the delete (idempotent per channel).
    const expiredOutstandingTasks = (
      this.db
        .prepare(
          "SELECT DISTINCT task_id FROM task_board_entries " +
            "WHERE serial_state = 'outstanding' AND expires_at <= ?",
        )
        .all(now) as Row[]
    ).map((row) => String(row.task_id));
    this.db
      .prepare(
        `DELETE FROM task_board_deliveries WHERE entry_id IN (
           SELECT id FROM task_board_entries WHERE expires_at <= ?)`,
      )
      .run(now);
    this.db
      .prepare(
        `DELETE FROM task_board_acks WHERE entry_id IN (
           SELECT id FROM task_board_entries WHERE expires_at <= ?)`,
      )
      .run(now);
    const changed = Number(
      this.db.prepare("DELETE FROM task_board_entries WHERE expires_at <= ?").run(now).changes,
    );
    for (const t of expiredOutstandingTasks) this.promoteNextSerialPending(t);
    return changed;
  }
  /** Directory of active named channels (the lobby). Excludes the world channel
   * itself and expired/fully-resolved channels; ordered most-recently-updated
   * first. Entry count counts open (non-expired, non-resolved) entries only. */
  listTaskBoards(now = new Date().toISOString()): Array<{
    taskId: string;
    entryCount: number;
    lastUpdatedAt: string;
  }> {
    this.pruneExpiredTaskBoardEntries(now);
    return (
      this.db
        .prepare(
          `SELECT task_id, COUNT(*) AS entry_count, MAX(created_at) AS last_updated_at
           FROM task_board_entries
           WHERE expires_at > ? AND status = 'open' AND task_id != ?
           GROUP BY task_id
           ORDER BY last_updated_at DESC`,
        )
        .all(now, WORLD_BOARD_ID) as Row[]
    ).map((row) => ({
      taskId: String(row.task_id),
      entryCount: Number(row.entry_count),
      lastUpdatedAt: String(row.last_updated_at),
    }));
  }
  private taskBoardEntry(id: string): TaskBoardEntry | null {
    const row = this.db.prepare("SELECT * FROM task_board_entries WHERE id = ?").get(id) as
      Row | undefined;
    if (!row) return null;
    const entry = mapTaskBoardEntry(row);
    entry.ackedBy = this.taskBoardAckMap([entry.id]).get(entry.id) ?? [];
    return entry;
  }
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
        this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(derivedId);
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
  recordPerfAggregates(timings: PerfSnapshot | undefined): void {
    if (!timings) return;
    const createdAt = new Date().toISOString();
    const read = this.db.prepare(`SELECT buckets_json FROM perf_aggregates WHERE section = ?`);
    const upsert = this.db.prepare(
      `INSERT INTO perf_aggregates (section, count, sum, sum_sq, buckets_json, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(section) DO UPDATE SET
         count = count + 1,
         sum = sum + excluded.sum,
         sum_sq = sum_sq + excluded.sum_sq,
         buckets_json = excluded.buckets_json,
         updated_at = excluded.updated_at`,
    );
    for (const [section, ms] of Object.entries(timings.timings)) {
      const previous = read.get(section) as Row | undefined;
      const buckets = histogramAdd(parseNumberArray(previous?.buckets_json ?? null), ms);
      upsert.run(section, ms, ms * ms, JSON.stringify(buckets), createdAt);
    }
    if (timings.totalMs > 0) {
      const previous = read.get("total") as Row | undefined;
      const buckets = histogramAdd(
        parseNumberArray(previous?.buckets_json ?? null),
        timings.totalMs,
      );
      upsert.run(
        "total",
        timings.totalMs,
        timings.totalMs ** 2,
        JSON.stringify(buckets),
        createdAt,
      );
    }
  }
  protected assertTraceOwner(row: Row, sessionId?: string): void {
    const owner =
      row.session_id === null || row.session_id === undefined ? null : String(row.session_id);
    if (owner !== null && owner !== sessionId?.trim()) {
      throw new Error(`active graph ${String(row.id)} belongs to another session`);
    }
  }
  embeddingDocuments(afterMemoryId = "", limit = 256, missingModel?: string): EmbeddingDocument[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.statement, n.canonical_name, n.summary
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
      text: memoryEmbeddingText(row.statement, row.canonical_name),
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of embeddings) {
        upsert.run(
          item.nodeId,
          model,
          dimensions,
          JSON.stringify(item.vector),
          encodeVector(item.vector),
          now,
        );
      }
      this.db.exec("COMMIT");
      for (const item of embeddings) {
        this.updateVectorCache("node", model, item.nodeId, item.vector);
      }
      return embeddings.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  storedNodeEmbeddings(model: string, afterNodeId = "", limit = 256): ExternalNodeEmbedding[] {
    const rows = this.db
      .prepare(
        `SELECT node_id, vector_blob, vector_json FROM node_embeddings
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of embeddings) {
        upsert.run(
          item.blockId,
          model,
          dimensions,
          JSON.stringify(item.vector),
          encodeVector(item.vector),
          now,
        );
      }
      this.db.exec("COMMIT");
      for (const item of embeddings) {
        this.updateVectorCache("leaf", model, item.blockId, item.vector);
      }
      return embeddings.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  storedLeafEmbeddings(model: string, afterBlockId = "", limit = 256): ExternalLeafEmbedding[] {
    const rows = this.db
      .prepare(
        `SELECT block_id, vector_blob, vector_json FROM leaf_embeddings
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of embeddings) {
        upsert.run(
          item.memoryId,
          model,
          dimensions,
          JSON.stringify(item.vector),
          encodeVector(item.vector),
          now,
        );
      }
      this.db.exec("COMMIT");
      return embeddings.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  storedEmbeddings(model: string, afterMemoryId = "", limit = 256): ExternalEmbedding[] {
    const rows = this.db
      .prepare(
        `SELECT memory_id, vector_blob, vector_json FROM memory_embeddings
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
    this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memoryId);
    this.db
      .prepare(
        "INSERT INTO memory_fts(memory_id, statement, node_name, evidence) VALUES (?, ?, ?, ?)",
      )
      .run(
        memoryId,
        ftsIndexedText(statement),
        ftsIndexedText(node.canonicalName),
        ftsIndexedText(evidence.content),
      );
    this.db
      .prepare("INSERT OR IGNORE INTO memory_fts_registry(memory_id) VALUES (?)")
      .run(memoryId);
  }
  ftsCandidates(query: string, limit: number): string[] {
    const expression = ftsExpression(query);
    if (!expression) return [];
    const rows = this.db
      .prepare(
        "SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?",
      )
      .all(expression, limit) as Row[];
    return rows.map((row) => String(row.memory_id));
  }
  ftsCandidatesInNodes(query: string, nodeIds: string[], limit: number): string[] {
    const expression = ftsExpression(query);
    if (!expression || nodeIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT f.memory_id FROM memory_fts f
       JOIN memory_records m ON m.id = f.memory_id
       WHERE memory_fts MATCH ? AND m.node_id IN (${nodeIds.map(() => "?").join(",")})
       ORDER BY bm25(memory_fts) LIMIT ?`,
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
  memoryText(memory: Pick<MemoryRecord, "statement">, nodeId: string): string {
    const node = this.requireNode(nodeId);
    return memoryEmbeddingText(memory.statement, node.canonicalName);
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
        this.embedder.model,
        this.embedder.dimensions,
        JSON.stringify(vector),
        encodeVector(vector),
        new Date().toISOString(),
      );
  }
  refreshEmbeddings(memoryIds: string[]): void {
    const select = this.db.prepare(
      `SELECT m.id, m.statement, m.node_id, n.canonical_name, n.summary
       FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id WHERE m.id = ?`,
    );
    for (const memoryId of memoryIds) {
      const row = select.get(memoryId) as Row | undefined;
      if (row)
        this.upsertEmbedding(memoryId, memoryEmbeddingText(row.statement, row.canonical_name));
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
        `SELECT ${idColumn} AS id, dimensions, vector_blob, vector_json
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
         AND (m.expires_at IS NULL OR m.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         AND (? = 1 OR (
           (m.valid_from IS NULL OR m.valid_from <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           AND (m.valid_until IS NULL OR m.valid_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ))
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
    return rows.map((row) => {
      const result = mapSearchResult(row, 0);
      result.memory.evidenceIds = this.evidenceIds(result.memory.id);
      result.evidenceRecords = this.evidenceRecords(result.memory.evidenceIds);
      return result;
    });
  }
  evidenceRecords(ids: string[]): HistoryRecord[] {
    const statement = this.db.prepare("SELECT * FROM history_records WHERE id = ?");
    return ids.flatMap((id) => {
      const row = statement.get(id) as Row | undefined;
      return row ? [mapHistory(row)] : [];
    });
  }
}

function mapTaskBoardEntry(row: Row): TaskBoardEntry {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    sequence: Number(row.sequence),
    agentId: String(row.agent_id),
    sourceSessionId: row.source_session_id === null ? null : String(row.source_session_id),
    kind: String(row.kind) as TaskBoardKind,
    content: String(row.content),
    status: String(row.status) as TaskBoardEntry["status"],
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
    resolvedBy: row.resolved_by === null ? null : String(row.resolved_by),
    resolution: row.resolution === null ? null : String(row.resolution),
    claimedBy: row.claimed_by === null ? null : String(row.claimed_by),
    claimedAt: row.claimed_at === null ? null : String(row.claimed_at),
    claimExpiresAt: row.claim_expires_at === null ? null : String(row.claim_expires_at),
    to: row.to === null ? null : String(row.to),
    serialState:
      row.serial_state === null
        ? null
        : (String(row.serial_state) as TaskBoardEntry["serialState"]),
    ackedBy: [],
  };
}
