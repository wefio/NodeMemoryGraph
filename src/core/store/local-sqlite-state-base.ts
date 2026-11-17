import { ensureLocalDaemonSchema } from "./schema.ts";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { PerfSnapshot, TaskBoardEntry, TaskBoardKind, TaskBoardPreview } from "../types.ts";
import { TASK_BOARD_VERDICTS, WORLD_BOARD_ID } from "../types.ts";
import { boardEntryView } from "../board-entry-view.ts";
import { BROADCAST_PREFIX } from "../board-notifications.ts";
import { histogramAdd } from "../perf.ts";
import {
  freezeTaskUnitDeclaration,
  readTaskUnitDeclarations,
  type TaskUnitDeclaration,
  type TaskUnitDeclarationInput,
} from "../../integration/task-unit-declaration-store.ts";
import { parseNumberArray } from "./row-parse.ts";
import type { TransactionPort } from "./store-ctor.ts";
import { type StoreRow as Row } from "./search-ranking.ts";

/** A callback that would keep a transaction open across an await is refused where it is handed in. */
function refuseThenable(value: unknown, message: string): void {
  const thenable =
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
  if (thenable) throw new Error(message);
}

export class LocalSqliteStateBase {
  /** True when this store came from the read-only factory rather than a shared connection. */
  protected readOnly = false;
  protected db: DatabaseSync;
  /** The open write transaction, if any. A port is the only way to join it. */
  private openTransaction: {
    port: TransactionPort;
    rollbackOnly: boolean;
  } | null = null;
  /** The run whose coordinated write scope is open, if any: the store's own state, set only by
   *  `coordinateRunWrite` while its callback runs. */
  private coordinatedRun: string | null = null;
  private transactionGeneration = 0;
  /** Set when ROLLBACK itself failed: the connection's state is unknown, so it takes no more work. */
  private connectionQuarantined = false;

  /** A read-only factory neither creates the file nor migrates an old one. Both refusals are named
   *  here rather than surfacing as a driver-level "unable to open database file" with no reason, and
   *  the decisions live here so the constructor is not the file's largest decision point. */
  #refuseUnusableReadOnlyOpen(databasePath: string): void {
    if (!this.readOnly) return;
    if (!existsSync(databasePath))
      throw new Error("this store does not exist; a read-only open does not create one");
  }

  #refuseUnrecognisableReadOnlyOpen(): void {
    if (!this.readOnly) return;
    if (this.hasSchema()) return;
    throw new Error("this store has no recognisable schema; a read-only open does not migrate it");
  }

  constructor(databasePath: string, options: { readOnly?: boolean } = {}) {
    mkdirSync(dirname(databasePath), { recursive: true });
    // A read-only open is a different factory, not a mode of the shared connection: it gets a
    // handle that cannot write, and it neither migrates nor checkpoints.
    this.readOnly = options.readOnly === true;
    // A read-only factory neither creates the file nor migrates an old one, so both refusals happen
    // here rather than surfacing as a driver-level "unable to open database file" with no reason.
    this.#refuseUnusableReadOnlyOpen(databasePath);
    this.db = new DatabaseSync(databasePath, readOnlyOpenOptions(this.readOnly));
    try {
      // `journal_mode` rewrites the database header, so a read-only handle must not set it; the
      // remaining pragmas are connection-local and harmless.
      this.db.exec(
        this.readOnly
          ? `PRAGMA foreign_keys = ON;
             PRAGMA cache_size = -64000;
             PRAGMA temp_store = MEMORY;
             PRAGMA mmap_size = 268435456;
             PRAGMA busy_timeout = 5000;`
          : `PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA cache_size = -64000;
             PRAGMA temp_store = MEMORY;
             PRAGMA mmap_size = 268435456;
             PRAGMA busy_timeout = 5000;`,
      );
      if (!this.readOnly) this.initializeSchema();
      // An existing file with no recognisable schema is not an empty store: reporting it as one would
      // hide an unknown format behind default empties.
      this.#refuseUnrecognisableReadOnlyOpen();
      // checkpoint-on-open: fold any -wal left behind by a force-exit shutdown
      // (where close() never ran) into the main DB and truncate it, so WAL can
      // never accumulate across restarts. SQLite auto-recovers WAL frames on
      // open. Conditional on a non-empty -wal: normal close() already
      // checkpoints, so the common open path skips the blocking TRUNCATE
      // (stg-v2 review ③a; wal_checkpoint is synchronous disk I/O that stalls
      // the event loop when the WAL is large).
      if (!this.readOnly && existsSync(`${databasePath}-wal`)) {
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

  protected initializeSchema(): void {
    ensureLocalDaemonSchema(this.db);
  }

  protected hasSchema(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='task_board_entries'")
      .get();
  }

  close(): void {
    // WAL checkpoint before close: without this the daemon's force-exit
    // shutdown leaves -wal files behind (v1 measured ~1.5G across 1681
    // session STG stores). TRUNCATE folds WAL into the main DB then resets it.
    if (!this.readOnly)
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // ignore — closing anyway
      }
    this.db.close();
  }

  /**
   * Run one coordinated transition for a run: exactly one write transaction, and inside it the
   * scope that lets the run's own managed entries be written. It is deliberately not a way to wrap
   * a whole round or an asynchronous RPC in a database transaction - the callback is synchronous
   * and the boundary closes with it - and it refuses a run this store cannot name, so a scope can
   * never authorize writes for a run state that does not exist.
   */
  coordinateRunWrite<T>(runId: string, work: (port: TransactionPort) => T): T {
    if (!this.taskRunManifestExists(runId))
      throw new Error(
        `run ${runId} is not registered; a managed write needs the run it belongs to`,
      );
    return this.writeTransaction((port) => {
      const previous = this.coordinatedRun;
      this.coordinatedRun = runId;
      try {
        return work(port);
      } finally {
        this.coordinatedRun = previous;
      }
    });
  }

  /**
   * A board write on an entry a run manages belongs to that run's coordinated scope, and the
   * scope is the store's own state rather than the caller's claim - so a direct call on a managed
   * entry is refused instead of applied beside the run. An entry no run manages returns here
   * without a transaction: the ordinary board path is unchanged, including its cost.
   */
  private requireManagedWriteScope(entryId: string): void {
    const binding = this.taskRunForEntry(entryId);
    if (!binding) return;
    if (this.coordinatedRun === binding.runId) return;
    throw new Error(
      `entry ${entryId} is managed by run ${binding.runId}: its lifecycle writes go through the run's coordinated transition, not the board verb directly`,
    );
  }

  /**
   * The store owns the transaction boundary: this is the only place that runs BEGIN/COMMIT. A
   * caller already inside a transition must join it with the port this issued rather than open a
   * second one, and a write entry reached inside a live transaction without that port is refused
   * instead of guessed at — `openTransaction` is the store's own state, never the caller's claim.
   */
  writeTransaction<T>(callback: (port: TransactionPort) => T): T {
    if (this.openTransaction)
      throw new Error("a write transaction is already open: join it with the port it issued");
    if (this.connectionQuarantined)
      throw new Error("this connection is quarantined after a failed rollback");
    this.db.exec("BEGIN IMMEDIATE");
    const port: TransactionPort = { generation: ++this.transactionGeneration };
    this.openTransaction = { port, rollbackOnly: false };
    let value: T;
    try {
      value = callback(port);
      refuseThenable(value, "a write transaction callback must be synchronous");
    } catch (error) {
      this.openTransaction = null;
      this.rollback();
      // The original failure is what the caller needs to see, whether ROLLBACK worked or not.
      throw error;
    }
    const state = this.openTransaction;
    this.openTransaction = null;
    if (state?.rollbackOnly) {
      this.rollback();
      throw new Error("the transaction was marked rollback-only by a failing operation");
    }
    try {
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback();
      throw error;
    }
    return value;
  }

  /**
   * Join the transition a port was issued for, synchronously and only while its callback runs. A
   * port from another store, a port whose callback has returned, and a second BEGIN are all
   * refused: nothing here infers authority from a flag or a depth counter.
   */
  withPort<T>(port: TransactionPort, work: () => T): T {
    const state = this.openTransaction;
    if (!state || state.port !== port)
      throw new Error("this port is not the store's live transaction scope");
    try {
      const value = work();
      refuseThenable(value, "work inside a transaction must be synchronous");
      return value;
    } catch (error) {
      // Even if the caller catches this, the work up to the failure already happened. Only the
      // outermost decides whether anything commits, and it will not.
      state.rollbackOnly = true;
      throw error;
    }
  }

  private rollback(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      this.connectionQuarantined = true;
    }
  }

  putTaskBoardEntry(
    input: {
      taskId: string;
      agentId: string;
      sourceSessionId?: string;
      kind: TaskBoardKind;
      content: string;
      expiresAt: string;
      /** Directed delivery: stable agent_name to wake for this entry. */
      to?: string;
      eventId?: string;
    },
    port?: TransactionPort,
  ): TaskBoardEntry {
    // Standalone and composed writes share this implementation: outside a transition this opens
    // one, and inside one it joins the open transition instead of running a second BEGIN.
    return port
      ? this.withPort(port, () => this.insertTaskBoardEntry(input))
      : this.writeTransaction(() => this.insertTaskBoardEntry(input));
  }

  /** The write itself, owning no boundary: whichever transaction is open decides whether it lands. */
  private insertTaskBoardEntry(input: {
    taskId: string;
    agentId: string;
    sourceSessionId?: string;
    kind: TaskBoardKind;
    content: string;
    expiresAt: string;
    to?: string;
    eventId?: string;
  }): TaskBoardEntry {
    const now = new Date().toISOString();
    this.pruneExpiredTaskBoardEntries(now, input.taskId);
    let id: string;
    {
      // Global monotonic counter (single row, never recycled). The id =
      // <createdAtMs>_<counter> is time-sortable, insertion-ordered for
      // same-millisecond entries, and globally unique across all channels.
      // It is the opaque continuation cursor; clients never parse it.
      this.db
        .prepare(
          "INSERT INTO task_board_counters (id, counter) VALUES (1, 1) " +
            "ON CONFLICT(id) DO UPDATE SET counter = counter + 1",
        )
        .run();
      const counterRow = this.db
        .prepare("SELECT counter FROM task_board_counters WHERE id = 1")
        .get() as Row;
      const counter = Number(counterRow.counter);
      id = `${String(Date.parse(now)).padStart(13, "0")}_${String(counter).padStart(6, "0")}`;
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
             status, created_at, expires_at, [to], serial_state, coordination_event_id
           ) VALUES (?, ?, 0, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.taskId,
          input.agentId,
          input.sourceSessionId ?? null,
          input.kind,
          input.content,
          now,
          input.expiresAt,
          input.to ?? null,
          serialState,
          input.eventId ?? null,
        );
    }
    if (input.kind === "goal" && input.to == null)
      this.associateBoardEventWork(input.eventId, input.agentId);
    return this.taskBoardEntry(id)!;
  }

  /** Work participation is historical; explicit subscription opt-outs are never reset. */
  private associateBoardEventWork(eventId: string | null | undefined, agentId: string): void {
    if (!eventId) return;
    this.db
      .prepare(
        "INSERT INTO coordination_event_members(event_id,agent_id,subscribed,associated) VALUES(?,?,1,1) ON CONFLICT(event_id,agent_id) DO UPDATE SET associated=1",
      )
      .run(eventId, agentId);
  }

  readTaskBoard(input: {
    taskId: string;
    agentId?: string;
    pendingForSession?: string;
    afterCursor?: string;
    limit?: number;
    includeResolved?: boolean;
    now?: string;
  }): { entries: TaskBoardEntry[]; nextCursor: string | null } {
    const now = input.now ?? new Date().toISOString();
    const pending = pendingWakeRead(input, now, false);
    this.pruneExpiredTaskBoardEntries(now, input.taskId);
    // The cursor is the opaque id of the last entry the caller already saw.
    // Resolve it to its (created_at, id) ordering position; entries strictly
    // after that position are the incremental continuation. A cursor that
    // names no entry (e.g. it expired) starts from the beginning — safe
    // because expiry prunes exactly the entries such a cursor could have
    // referenced.
    let afterCreatedAt = "0000-01-01T00:00:00.000Z";
    let afterId = "";
    if (input.afterCursor != null) {
      const cursorRow = this.db
        .prepare("SELECT created_at FROM task_board_entries WHERE id = ?")
        .get(input.afterCursor) as Row | undefined;
      if (cursorRow) {
        afterCreatedAt = String(cursorRow.created_at);
        afterId = input.afterCursor;
      }
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM task_board_entries
         WHERE task_id = ?
           AND (created_at > ? OR (created_at = ? AND id > ?))
           AND (? = 1 OR status = 'open')
           ${pending.sql}
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(
        input.taskId,
        afterCreatedAt,
        afterCreatedAt,
        afterId,
        input.includeResolved ? 1 : 0,
        ...pending.args,
        Math.max(1, Math.min(input.limit ?? 50, 200)),
      ) as Row[];
    const rawEntries = rows.map(mapTaskBoardEntry);
    const ackMap = this.taskBoardAckMap(rawEntries.map((entry) => entry.id));
    for (const entry of rawEntries) entry.ackedBy = ackMap.get(entry.id) ?? [];
    return {
      entries: rawEntries,
      nextCursor: rawEntries.at(-1)?.id ?? input.afterCursor ?? null,
    };
  }
  /** Open point-to-point entries addressed to this stable agent identity.
   * Unlike channel reads, this inbox spans named boards so directed delivery
   * does not require the recipient to discover and subscribe first. */
  readDirectedTaskBoard(input: {
    agentId: string;
    agentName: string;
    pendingForSession?: string;
    limit?: number;
    now?: string;
  }): TaskBoardEntry[] {
    const now = input.now ?? new Date().toISOString();
    const pending = pendingWakeRead(input, now, true);
    this.pruneExpiredTaskBoardEntries(now);
    const targets = [...new Set([input.agentId.trim(), input.agentName.trim()].filter(Boolean))];
    if (targets.length === 0) return [];
    const placeholders = targets.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM task_board_entries
         WHERE status = 'open' AND expires_at > ? AND [to] IN (${placeholders})
           ${pending.sql}
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(
        now,
        ...targets,
        ...pending.args,
        Math.max(1, Math.min(input.limit ?? 50, 200)),
      ) as Row[];
    const entries = rows.map(mapTaskBoardEntry);
    const ackMap = this.taskBoardAckMap(entries.map((entry) => entry.id));
    for (const entry of entries) entry.ackedBy = ackMap.get(entry.id) ?? [];
    return entries;
  }
  /** Actionable-for-me inbox (F2 in the board-governance proposal): the open
   *  actionable work (handoff/question/blocker) across all boards this agent
   *  should act on — either addressed to it directly, or the currently offered
   *  broadcast actionable (un-directed 'outstanding') on a channel. Bounded: at
   *  most one outstanding broadcast per channel plus all directed entries, so
   *  unlike a full channel scan it stays a compact todo read. Ordering (oldest
   *  first) matches readDirectedTaskBoard. */
  readInboxTaskBoard(input: {
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
         WHERE status = 'open' AND expires_at > ?
           AND notification_origin = 0 AND (kind IN ('handoff', 'question', 'blocker') OR coordination_notice = 1 OR notification_source_id IS NOT NULL)
           AND ([to] IN (${placeholders}) OR ([to] IS NULL AND serial_state = 'outstanding'))
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(now, ...targets, Math.max(1, Math.min(input.limit ?? 50, 200))) as Row[];
    const entries = rows.map(mapTaskBoardEntry);
    const ackMap = this.taskBoardAckMap(entries.map((entry) => entry.id));
    for (const entry of entries) entry.ackedBy = ackMap.get(entry.id) ?? [];
    return entries;
  }
  /** Compact, low-context view over one channel's open entries (F1 in the
   *  board-governance proposal). Returns a bounded per-entry projection that
   *  omits the full body — the long content/evidence stays out of the wire
   *  until the reader asks for it via a full read or an explicit expansion of a
   *  `memory=<id>` pointer. Ordering and cursor semantics match readTaskBoard so
   *  an incremental sync can page over the compact view without re-reading
   *  full bodies. */
  readTaskBoardPreviews(input: {
    taskId: string;
    afterCursor?: string;
    limit?: number;
    includeResolved?: boolean;
    now?: string;
  }): { previews: TaskBoardPreview[]; nextCursor: string | null } {
    const { entries, nextCursor } = this.readTaskBoard(input);
    const previews = entries.map((entry) => ({
      id: entry.id,
      taskId: entry.taskId,
      kind: entry.kind,
      status: entry.status,
      agentId: entry.agentId,
      to: entry.to,
      claimedBy: entry.claimedBy,
      serialState: entry.serialState,
      ackCount: entry.ackedBy.length,
      createdAt: entry.createdAt,
      resolvedAt: entry.resolvedAt,
      deliveredBy: entry.deliveredBy,
      deliverableDigest: entry.deliverableDigest,
      verdict: entry.verdict,
      judgedBy: entry.judgedBy,
      ...(entry.eventId ? { eventId: entry.eventId } : {}),
      ...(entry.eventNotice ? { eventNotice: true, eventRevision: entry.eventRevision } : {}),
      preview: boardEntryView(entry.content),
    }));
    return { previews, nextCursor };
  }
  resolveTaskBoardEntry(input: {
    taskId: string;
    entryId: string;
    agentId: string;
    resolution?: string;
  }): TaskBoardEntry {
    this.requireManagedWriteScope(input.entryId);
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
  /** Reviewable finalize (P1 veto): an independent reviewer — not the agent who
   * resolved the entry — flags a self-reported resolve as contested. The entry
   * stays resolved (board lifecycle/serial promotion are untouched); the veto
   * is an auditable mark so downstream does not accept the resolve as validated
   * completion (de-biases false-complete for the converge calibrator). */
  vetoTaskBoardEntry(input: {
    taskId: string;
    entryId: string;
    agentId: string;
    reason?: string;
  }): TaskBoardEntry {
    this.requireManagedWriteScope(input.entryId);
    const existing = this.taskBoardEntry(input.entryId);
    if (!existing || existing.taskId !== input.taskId) {
      throw new Error(`task board entry not found in task ${input.taskId}`);
    }
    if (existing.status !== "resolved") {
      throw new Error(`only a resolved entry can be vetoed (${input.entryId})`);
    }
    if (existing.resolvedBy !== null && existing.resolvedBy === input.agentId) {
      throw new Error(`the resolver cannot veto its own resolve (${input.entryId})`);
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE task_board_entries
         SET vetoed_by = ?, vetoed_at = ?, veto_reason = ?
         WHERE id = ? AND task_id = ?`,
      )
      .run(input.agentId, now, input.reason ?? null, input.entryId, input.taskId);
    return this.taskBoardEntry(input.entryId)!;
  }
  /** Deliver the claim holder's artifact for the current attempt (P1 slice).
   * Only a live claim holder may deliver: an artifact nobody claimed the work
   * for is not a deliverable, and the claim is what makes someone answerable
   * for it. The digest names the artifact; a re-delivery inside the same
   * attempt replaces it and voids any verdict about the previous digest (a
   * verdict must never be inherited by a different artifact). */
  deliverTaskBoardEntry(input: {
    taskId: string;
    entryId: string;
    agentId: string;
    digest: string;
    ref?: string;
    summary?: string;
    now?: string;
  }): TaskBoardEntry {
    this.requireManagedWriteScope(input.entryId);
    const now = input.now ?? new Date().toISOString();
    const existing = this.taskBoardEntry(input.entryId);
    if (!existing || existing.taskId !== input.taskId) {
      throw new Error(`task board entry not found in task ${input.taskId}`);
    }
    if (existing.status !== "open") {
      throw new Error(
        `task board entry ${input.entryId} is ${existing.status}; a deliverable belongs to an open claim, not to a finalized entry`,
      );
    }
    if (!this.taskBoardClaimLive(existing, now) || existing.claimedBy !== input.agentId) {
      throw new Error(
        `task board entry ${input.entryId} deliverable requires the live claim holder (holder: ${existing.claimedBy ?? "none"})`,
      );
    }
    const result = this.db
      .prepare(
        `UPDATE task_board_entries
         SET delivered_by = ?, delivered_at = ?, deliverable_digest = ?, deliverable_ref = ?,
             deliverable_summary = ?, judged_by = NULL, judged_at = NULL, verdict = NULL,
             verdict_reason = NULL, judged_digest = NULL
         WHERE id = ? AND task_id = ? AND status = 'open'
           AND claimed_by = ? AND claim_expires_at IS NOT NULL AND claim_expires_at > ?`,
      )
      .run(
        input.agentId,
        now,
        input.digest,
        input.ref ?? null,
        input.summary ?? null,
        input.entryId,
        input.taskId,
        input.agentId,
        now,
      );
    if (Number(result.changes) === 0) {
      throw new Error(
        `task board entry ${input.entryId} lost its claim while delivering (released, expired, or reassigned); retry under a fresh claim`,
      );
    }
    return this.taskBoardEntry(input.entryId)!;
  }
  /** Independent verdict on a delivered artifact (P1 slice). Acceptance is a
   * protocol invariant, not a convention: the deliverer can never judge its own
   * deliverable (mirrors "the resolver cannot veto its own resolve"). The
   * verdict records the digest it judged, so it cannot be inherited by a
   * different artifact, and `undecidable` stays distinct from `rejected`. */
  judgeTaskBoardEntry(input: {
    taskId: string;
    entryId: string;
    agentId: string;
    verdict: (typeof TASK_BOARD_VERDICTS)[number];
    reason?: string;
    now?: string;
  }): TaskBoardEntry {
    this.requireManagedWriteScope(input.entryId);
    const now = input.now ?? new Date().toISOString();
    const existing = this.taskBoardEntry(input.entryId);
    if (!existing || existing.taskId !== input.taskId) {
      throw new Error(`task board entry not found in task ${input.taskId}`);
    }
    if (!TASK_BOARD_VERDICTS.includes(input.verdict)) {
      throw new Error(
        `unknown task board verdict ${input.verdict}; expected one of ${TASK_BOARD_VERDICTS.join(", ")}`,
      );
    }
    if (existing.deliveredBy === null || existing.deliverableDigest === null) {
      throw new Error(`task board entry ${input.entryId} has no deliverable to judge`);
    }
    if (existing.deliveredBy === input.agentId) {
      throw new Error(
        `the deliverer cannot judge its own deliverable (${input.entryId}); an independent judge is required`,
      );
    }
    const result = this.db
      .prepare(
        `UPDATE task_board_entries
         SET judged_by = ?, judged_at = ?, verdict = ?, verdict_reason = ?, judged_digest = ?
         WHERE id = ? AND task_id = ? AND deliverable_digest = ?`,
      )
      .run(
        input.agentId,
        now,
        input.verdict,
        input.reason ?? null,
        existing.deliverableDigest,
        input.entryId,
        input.taskId,
        existing.deliverableDigest,
      );
    if (Number(result.changes) === 0) {
      throw new Error(
        `task board entry ${input.entryId} deliverable changed while judging; judge the current digest`,
      );
    }
    return this.taskBoardEntry(input.entryId)!;
  }
  /** True when a board entry carries a live claim (holder set, lease not expired). */
  private taskBoardClaimLive(entry: TaskBoardEntry, now: string): boolean {
    return taskBoardClaimIsLive(entry, now);
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
          "AND serial_state = 'pending' ORDER BY created_at ASC, id ASC LIMIT 1",
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
    this.requireManagedWriteScope(input.entryId);
    const now = input.now ?? new Date().toISOString();
    this.pruneExpiredTaskBoardEntries(now, input.taskId);
    const existing = this.taskBoardEntry(input.entryId);
    if (!existing || existing.taskId !== input.taskId) {
      throw new Error(`task board entry not found in task ${input.taskId}`);
    }
    if (existing.eventNotice || existing.notificationSourceId)
      throw new Error("Updates are notices, not claimable tasks");
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
    // Attempt fencing: renewing your own live claim is the same attempt; any
    // other claim starts attempt N+1 and clears the previous attempt's
    // deliverable and verdict. Without this, work reassigned to another agent
    // could still be read through a stale artifact (or a verdict about it).
    const renewed = existing.claimedBy === input.agentId && this.taskBoardClaimLive(existing, now);
    if (!renewed) {
      this.db
        .prepare(
          `UPDATE task_board_entries
           SET attempt = attempt + 1,
               delivered_by = NULL, delivered_at = NULL, deliverable_digest = NULL,
               deliverable_ref = NULL, deliverable_summary = NULL,
               judged_by = NULL, judged_at = NULL, verdict = NULL,
               verdict_reason = NULL, judged_digest = NULL
           WHERE id = ?`,
        )
        .run(input.entryId);
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
    this.associateBoardEventWork(existing.eventId, input.agentId);
    return this.taskBoardEntry(input.entryId)!;
  }
  /** Release a claim back to the open pool. Only the current holder may release. */
  releaseTaskBoardEntry(input: {
    taskId: string;
    entryId: string;
    agentId: string;
  }): TaskBoardEntry {
    this.requireManagedWriteScope(input.entryId);
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
    presenceToken?: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO task_board_agents(
           id, agent_name, description, version, url, capabilities, skills,
           supported_interfaces, presence_token, is_online, last_seen_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent_name = excluded.agent_name,
           description = excluded.description,
           version = excluded.version,
           url = excluded.url,
           capabilities = excluded.capabilities,
           skills = excluded.skills,
           supported_interfaces = excluded.supported_interfaces,
           presence_token = excluded.presence_token,
           is_online = 1,
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
        input.presenceToken ?? null,
        now,
        now,
      );
  }

  /** System-layer heartbeat: refresh last_seen so the agent stays online.
   * Keyed by the stable id (never the mutable display name). */
  heartbeatTaskBoardAgent(input: { id: string; presenceToken?: string }): void {
    this.db
      .prepare(
        "UPDATE task_board_agents SET last_seen_at = ? WHERE id = ? AND is_online=1 AND presence_token IS ?",
      )
      .run(new Date().toISOString(), input.id, input.presenceToken ?? null);
  }

  /** Withdraw presence while retaining identity, notes and historical attribution. */
  unregisterTaskBoardAgent(input: { id: string; presenceToken?: string }): void {
    this.db
      .prepare("UPDATE task_board_agents SET is_online=0 WHERE id=? AND presence_token IS ?")
      .run(input.id, input.presenceToken ?? null);
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
      "FROM task_board_agents WHERE is_online=1 AND last_seen_at >= ?";
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
    this.requireManagedWriteScope(input.entryId);
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
  /** Pin a board entry against ordinary TTL pruning. The pin belongs to (entry, owner)
   *  so two consumers can retain the same entry independently and each releases only its
   *  own; `retainedUntil` bounds it when the caller can name an end (a run whose evidence
   *  must outlive its own TTL passes nothing and relies on release).
   *
   *  Retention exists so that a derived fact does not need its own column: an entry that
   *  is still referenced stays readable, and a consumer can re-derive the fact from it. */
  retainTaskBoardEntry(input: {
    taskId: string;
    entryId: string;
    owner: string;
    reason: string;
    retainedUntil?: string | null;
    now?: string;
  }): boolean {
    this.requireManagedWriteScope(input.entryId);
    const { taskId, entryId, owner, reason } = input;
    if (!taskId || !entryId) throw new Error("retention requires a channel and an entry");
    if (!owner.trim()) throw new Error("retention owner required");
    if (!reason.trim()) throw new Error("retention reason required");
    const until = input.retainedUntil ?? null;
    if (until !== null && Number.isNaN(Date.parse(until)))
      throw new Error("retainedUntil must be an ISO timestamp");
    if (!this.getTaskBoardEntryById(taskId, entryId))
      throw new Error("no such entry in this channel");
    this.db
      .prepare(
        `INSERT INTO task_board_retentions (entry_id, owner, reason, retained_at, retained_until)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(entry_id, owner) DO UPDATE SET reason = excluded.reason,
           retained_until = excluded.retained_until`,
      )
      .run(entryId, owner, reason, input.now ?? new Date().toISOString(), until);
    return true;
  }

  /** Release this owner's pin. Other owners' pins on the same entry are untouched, and
   *  the entry becomes prunable only when the last of them is gone. */
  releaseTaskBoardRetention(input: { taskId: string; entryId: string; owner: string }): boolean {
    this.requireManagedWriteScope(input.entryId);
    if (!input.taskId || !input.entryId)
      throw new Error("retention requires a channel and an entry");
    if (!input.owner.trim()) throw new Error("retention owner required");
    return (
      Number(
        this.db
          .prepare("DELETE FROM task_board_retentions WHERE entry_id = ? AND owner = ?")
          .run(input.entryId, input.owner).changes,
      ) > 0
    );
  }

  listTaskBoardRetentions(input: { taskId: string; entryId?: string }): Array<{
    entryId: string;
    owner: string;
    reason: string;
    retainedAt: string;
    retainedUntil: string | null;
  }> {
    const rows = (
      input.entryId
        ? this.db
            .prepare(
              `SELECT r.* FROM task_board_retentions r JOIN task_board_entries e ON e.id = r.entry_id
               WHERE e.task_id = ? AND r.entry_id = ? ORDER BY r.owner`,
            )
            .all(input.taskId, input.entryId)
        : this.db
            .prepare(
              `SELECT r.* FROM task_board_retentions r JOIN task_board_entries e ON e.id = r.entry_id
               WHERE e.task_id = ? ORDER BY r.entry_id, r.owner`,
            )
            .all(input.taskId)
    ) as Row[];
    return rows.map((row) => ({
      entryId: String(row.entry_id),
      owner: String(row.owner),
      reason: String(row.reason),
      retainedAt: String(row.retained_at),
      retainedUntil: row.retained_until === null ? null : String(row.retained_until),
    }));
  }

  /** A pin whose bound has passed stops pinning, so a caller that can name an end does not
   *  leak retention forever. Unbounded pins are released explicitly. */
  private expireStaleRetentions(now: string): void {
    this.db
      .prepare(
        "DELETE FROM task_board_retentions WHERE retained_until IS NOT NULL AND retained_until <= ?",
      )
      .run(now);
  }

  pruneExpiredTaskBoardEntries(now = new Date().toISOString(), taskId?: string): number {
    this.expireStaleRetentions(now);
    // RAII: an expired entry's receipts die with it (same binding as resolve), except
    // where a retention still pins the entry — a retained entry must outlive its TTL.
    if (taskId) {
      this.db
        .prepare(
          `DELETE FROM task_board_deliveries WHERE entry_id IN (
             SELECT id FROM task_board_entries WHERE task_id = ? AND expires_at <= ?
               AND id NOT IN (SELECT entry_id FROM task_board_retentions))`,
        )
        .run(taskId, now);
      this.db
        .prepare(
          `DELETE FROM task_board_acks WHERE entry_id IN (
             SELECT id FROM task_board_entries WHERE task_id = ? AND expires_at <= ?
               AND id NOT IN (SELECT entry_id FROM task_board_retentions))`,
        )
        .run(taskId, now);
      const changed = Number(
        this.db
          .prepare(
            `DELETE FROM task_board_entries WHERE task_id = ? AND expires_at <= ?
               AND id NOT IN (SELECT entry_id FROM task_board_retentions)`,
          )
          .run(taskId, now).changes,
      );
      this.promoteNextSerialPending(taskId);
      return changed;
    }
    // Collect channels whose blocking outstanding just expired, so their
    // pending queue can move after the delete (idempotent per channel).
    // Serial handoff: if an expired entry was the blocking outstanding, promote
    // the earliest pending of that channel after the delete. A retained entry is not
    // expired for pruning purposes, so it cannot free the slot either.
    const expiredOutstandingTasks = (
      this.db
        .prepare(
          "SELECT DISTINCT task_id FROM task_board_entries " +
            "WHERE serial_state = 'outstanding' AND expires_at <= ? " +
            "AND id NOT IN (SELECT entry_id FROM task_board_retentions)",
        )
        .all(now) as Row[]
    ).map((row) => String(row.task_id));
    this.db
      .prepare(
        `DELETE FROM task_board_deliveries WHERE entry_id IN (
           SELECT id FROM task_board_entries WHERE expires_at <= ?
             AND id NOT IN (SELECT entry_id FROM task_board_retentions))`,
      )
      .run(now);
    this.db
      .prepare(
        `DELETE FROM task_board_acks WHERE entry_id IN (
           SELECT id FROM task_board_entries WHERE expires_at <= ?
             AND id NOT IN (SELECT entry_id FROM task_board_retentions))`,
      )
      .run(now);
    const changed = Number(
      this.db
        .prepare(
          `DELETE FROM task_board_entries WHERE expires_at <= ?
             AND id NOT IN (SELECT entry_id FROM task_board_retentions)`,
        )
        .run(now).changes,
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
           WHERE expires_at > ? AND status = 'open' AND task_id != ? AND coordination_notice = 0
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

  // ---- Task run records. The writable half of the run namespace: a run's frozen manifest, its
  // frozen task plan, and the facts it appends. Each write takes an optional port, so a caller
  // that already holds the store's transaction joins it instead of opening a second one - the
  // board write and the run fact of one transition have to land together or not at all. Nothing
  // here creates a table or a connection: the schema owns both (src/core/store/schema.ts).

  /** Register a run's frozen identity. A retry after a lost response is a no-op; a second
   *  registration that names a different plan or policy is refused, because a run cannot be
   *  re-opened onto a different plan without becoming a different run. */
  registerTaskRun(
    input: {
      runId: string;
      planDigest: string;
      policy: string;
      revision: string;
      retention: string;
    },
    port?: TransactionPort,
  ): void {
    return port
      ? this.withPort(port, () => this.insertTaskRunManifest(input))
      : this.writeTransaction(() => this.insertTaskRunManifest(input));
  }

  private insertTaskRunManifest(input: {
    runId: string;
    planDigest: string;
    policy: string;
    revision: string;
    retention: string;
  }): void {
    const existing = this.db
      .prepare("SELECT plan_digest, policy FROM task_run_manifest WHERE run_id = ?")
      .get(input.runId) as Row | undefined;
    if (existing) {
      if (
        String(existing.plan_digest) !== input.planDigest ||
        String(existing.policy) !== input.policy
      )
        throw new Error(
          `run ${input.runId} already froze a different plan; a new plan is a new run, not an overwrite`,
        );
      return;
    }
    this.db
      .prepare(
        "INSERT INTO task_run_manifest (run_id, plan_digest, policy, revision, retention, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.runId,
        input.planDigest,
        input.policy,
        input.revision,
        input.retention,
        new Date().toISOString(),
      );
  }

  /** Freeze one task of a run's plan. Frozen means frozen: the same task id with a different
   *  input, position or operation is refused rather than replaced, since the plan is the thing
   *  every later decision is read against. */
  freezeTaskRunTask(input: TaskUnitDeclarationInput, port?: TransactionPort): void {
    // Compatibility entrypoint for the default protocol. The store supplies the
    // connection and transaction; its adapter owns declaration encoding and equality.
    const write = () => freezeTaskUnitDeclaration(this.db, input);
    return port ? this.withPort(port, write) : this.writeTransaction(write);
  }

  /** Append one run fact, if it is not already there. The fact's own identity (run, kind, task,
   *  attempt) is the duplicate key, which is what makes a retry after a lost response append once
   *  instead of twice; `recorded: false` says the fact was already known, and is not a failure. */
  appendTaskRunFact(
    input: {
      runId: string;
      kind: string;
      taskId?: string;
      attempt?: number;
      entryId?: string | null;
      payload?: string | null;
    },
    port?: TransactionPort,
  ): { sequence: number; recorded: boolean } {
    return port
      ? this.withPort(port, () => this.insertTaskRunFact(input))
      : this.writeTransaction(() => this.insertTaskRunFact(input));
  }

  private insertTaskRunFact(input: {
    runId: string;
    kind: string;
    taskId?: string;
    attempt?: number;
    entryId?: string | null;
    payload?: string | null;
  }): { sequence: number; recorded: boolean } {
    const taskId = input.taskId ?? "";
    const attempt = input.attempt ?? 0;
    const known = this.db
      .prepare(
        "SELECT sequence FROM task_run_facts WHERE run_id = ? AND kind = ? AND task_id = ? AND attempt = ?",
      )
      .get(input.runId, input.kind, taskId, attempt) as Row | undefined;
    if (known) return { sequence: Number(known.sequence), recorded: false };
    if (!this.taskRunManifestExists(input.runId))
      throw new Error(`run ${input.runId} is not registered; a fact cannot be appended to it`);
    const next = this.db
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM task_run_facts WHERE run_id = ?")
      .get(input.runId) as Row;
    const sequence = Number(next.next);
    this.db
      .prepare(
        "INSERT INTO task_run_facts (run_id, sequence, kind, task_id, attempt, entry_id, payload, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.runId,
        sequence,
        input.kind,
        taskId,
        attempt,
        input.entryId ?? null,
        input.payload ?? null,
        new Date().toISOString(),
      );
    return { sequence, recorded: true };
  }

  /** The run's frozen identity, or null when this store holds no such run. A read: it registers
   *  nothing and appends nothing, which is what lets a query path use it. */
  taskRunManifest(runId: string): {
    runId: string;
    planDigest: string;
    policy: string;
    revision: string;
    retention: string;
    createdAt: string;
  } | null {
    const row = this.db.prepare("SELECT * FROM task_run_manifest WHERE run_id = ?").get(runId) as
      Row | undefined;
    if (!row) return null;
    return {
      runId: String(row.run_id),
      planDigest: String(row.plan_digest),
      policy: String(row.policy),
      revision: String(row.revision),
      retention: String(row.retention),
      createdAt: String(row.created_at),
    };
  }

  /** The tasks the run froze, in plan order. */
  taskRunTasks(runId: string): TaskUnitDeclaration[] {
    return readTaskUnitDeclarations(this.db, runId);
  }

  /** The run's appended facts in sequence order. `through` is how a caller asks for the facts as of
   *  one point in the log, which is what a replay or a re-derivation needs. */
  taskRunFacts(
    runId: string,
    through?: number,
  ): {
    sequence: number;
    kind: string;
    taskId: string;
    attempt: number;
    entryId: string | null;
    payload: string | null;
    recordedAt: string;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM task_run_facts WHERE run_id = ? AND sequence <= ? ORDER BY sequence")
      .all(runId, through ?? Number.MAX_SAFE_INTEGER) as Row[];
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      kind: String(row.kind),
      taskId: String(row.task_id),
      attempt: Number(row.attempt),
      entryId: row.entry_id === null ? null : String(row.entry_id),
      payload: row.payload === null ? null : String(row.payload),
      recordedAt: String(row.recorded_at),
    }));
  }

  /** Which run a board entry is bound to, or null when nothing here manages it. This is the one
   *  question a caller holding only an entry id can ask: an entry bound by two runs is refused
   *  rather than answered with one of them. */
  taskRunForEntry(
    entryId: string,
  ): { runId: string; kind: string; taskId: string; attempt: number } | null {
    const rows = this.db
      .prepare(
        "SELECT run_id, kind, task_id, attempt FROM task_run_facts WHERE entry_id = ? ORDER BY sequence",
      )
      .all(entryId) as Row[];
    if (rows.length === 0) return null;
    const runs = new Set(rows.map((row) => String(row.run_id)));
    if (runs.size > 1)
      throw new Error(
        `entry ${entryId} is bound by ${runs.size} runs; a managed entry belongs to one`,
      );
    const first = rows[0]!;
    return {
      runId: String(first.run_id),
      kind: String(first.kind),
      taskId: String(first.task_id),
      attempt: Number(first.attempt),
    };
  }

  private taskRunManifestExists(runId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM task_run_manifest WHERE run_id = ?").get(runId) !== undefined
    );
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
}

/** True when a board entry carries a live claim (holder set, lease not expired). One home for the
 *  predicate: eligibility outside this module reads it too, so a second copy of it would be a second
 *  opinion about whether a task is already being worked on. */
export function taskBoardClaimIsLive(entry: TaskBoardEntry, now: string): boolean {
  return entry.claimedBy !== null && entry.claimExpiresAt !== null && entry.claimExpiresAt > now;
}

function mapTaskBoardEntry(row: Row): TaskBoardEntry {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    agentId: String(row.agent_id),
    sourceSessionId: optionalText(row.source_session_id),
    kind: String(row.kind) as TaskBoardKind,
    content: String(row.content),
    status: String(row.status) as TaskBoardEntry["status"],
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    resolvedAt: optionalText(row.resolved_at),
    resolvedBy: optionalText(row.resolved_by),
    resolution: optionalText(row.resolution),
    claimedBy: optionalText(row.claimed_by),
    claimedAt: optionalText(row.claimed_at),
    claimExpiresAt: optionalText(row.claim_expires_at),
    to: optionalText(row.to),
    serialState: optionalText(row.serial_state) as TaskBoardEntry["serialState"],
    vetoedBy: optionalText(row.vetoed_by),
    vetoedAt: optionalText(row.vetoed_at),
    vetoReason: optionalText(row.veto_reason),
    attempt: Number(row.attempt ?? 0),
    deliveredBy: optionalText(row.delivered_by),
    deliveredAt: optionalText(row.delivered_at),
    deliverableDigest: optionalText(row.deliverable_digest),
    deliverableRef: optionalText(row.deliverable_ref),
    deliverableSummary: optionalText(row.deliverable_summary),
    judgedBy: optionalText(row.judged_by),
    judgedAt: optionalText(row.judged_at),
    verdict: optionalText(row.verdict) as TaskBoardEntry["verdict"],
    verdictReason: optionalText(row.verdict_reason),
    judgedDigest: optionalText(row.judged_digest),
    ackedBy: [],
    ...(row.notification_origin === 1 ? { notificationOrigin: true } : {}),
    ...(typeof row.notification_source_id === "string"
      ? {
          notificationSourceId: row.notification_source_id,
          notificationChannelId: String(row.notification_channel_id),
          notificationScopes: JSON.parse(
            String(row.notification_scopes_json),
          ) as import("../board-notifications.ts").BoardNotificationScope[],
          invitation: row.notification_invitation === 1,
        }
      : {}),
    ...(typeof row.coordination_event_id === "string"
      ? { eventId: row.coordination_event_id }
      : {}),
    ...(row.coordination_notice === 1
      ? { eventNotice: true, eventRevision: Number(row.coordination_event_revision) }
      : {}),
  };
}

/** A nullable TEXT column as `string | null`. Written once rather than as one
 *  ternary per field: the row mapper is a list of fields, not a decision tree,
 *  and an absent nullable column has no value to invent. */
function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Filter before LIMIT so delivered, silent, self-authored or leased rows do
 * not permanently occupy the first wake page. Ordinary reads retain history. */
function pendingWakeRead(
  input: { pendingForSession?: string; agentId?: string },
  now: string,
  directed: boolean,
): { sql: string; args: string[] } {
  if (!input.pendingForSession) return { sql: "", args: [] };
  if (!input.agentId) throw Error("Pending wake reads require agentId");
  return {
    sql: `AND notification_origin=0
      AND (kind IN ('handoff','question','blocker') OR coordination_notice=1 OR notification_source_id IS NOT NULL)
      AND (serial_state IS NULL OR serial_state!='pending')
      AND (claim_expires_at IS NULL OR claim_expires_at<=?)
      AND ((source_session_id IS NULL AND agent_id!=?) OR (source_session_id IS NOT NULL AND source_session_id!=?))
      AND content NOT LIKE ?
      AND NOT EXISTS (SELECT 1 FROM task_board_deliveries d WHERE d.entry_id=task_board_entries.id AND d.session_id=?)
      AND NOT EXISTS (SELECT 1 FROM task_board_acks a WHERE a.entry_id=task_board_entries.id AND a.agent_id=?)
      ${directed ? "" : "AND [to] IS NULL"}`,
    args: [
      now,
      input.agentId,
      input.pendingForSession,
      BROADCAST_PREFIX + "%",
      input.pendingForSession,
      input.agentId,
    ],
  };
}

/** The handle options for one open: a read-only factory gets a handle that cannot write, which is a
 *  different factory rather than a mode of the shared connection. */
function readOnlyOpenOptions(readOnly: boolean): { readOnly?: true } {
  return readOnly ? { readOnly: true } : {};
}
