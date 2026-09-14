import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { NmgStore } from "../../src/core/store.ts";
import type { TransactionPort } from "../../src/core/store/base.ts";
import { acceptedFact } from "./task-semantics.ts";
import { checkResultValid, sameCheck, type CheckTicket, type CheckResult } from "./ooo-check.ts";
import {
  patchCandidate,
  patchSubmission,
  preparePatchWork,
  type ConclusionKind,
  type FrozenPatchTask,
  type PatchBudget,
  type PatchLimits,
  type PatchSubmission,
} from "./ooo-patch.ts";

export type ProbeOperation = SnapshotWork["operation"];

/** Host-owned patch task definition: the worker never supplies the frozen input,
 *  the editable allowlist, or the check that decides acceptance. */
export interface PatchTaskSpec {
  instruction: string;
  files: Readonly<Record<string, string>>;
  editable: readonly string[];
  /** Readable subset of `files`, frozen into the digest so both sides agree on it. */
  visible?: readonly string[];
  /** Conclusion kinds this task's acceptance rule admits; the rest are not offered. */
  admittedConclusions?: readonly ConclusionKind[];
  budget?: PatchBudget;
  limits?: PatchLimits;
  verify: (submission: PatchSubmission) => Promise<"accept" | "reject" | "undecidable">;
}
import { nextTask, snapshotAnswer, type SnapshotWork } from "./ooo-execution.ts";

export type ProbePlan = readonly (readonly [
  string,
  string,
  readonly string[],
  string,
  string | null,
  ProbeOperation | null,
])[];
const arithmeticPlan: ProbePlan = [
  ["A", "2", [], "read-only", "interface-response", "double"],
  ["B", "3", [], "read-only", null, "double"],
  ["C", "sum", ["A", "B"], "isolated-artifact", null, "sum"],
];

/** A run's board channel. One channel per run, so two rounds sharing a store cannot see,
 *  claim, or block each other's entries — a channel is the board's only boundary. */
export function roundChannel(runId: string): string {
  return `ooo-probe:${runId}`;
}

/** Identity of an accepted artifact: sha256 of the canonical commit the round binds
 *  dependents to. The board carries this short identity and never the bytes — the value
 *  itself stays in the round's row and in the ready-signal decision entry. A verdict is
 *  bound to this digest, so it cannot be inherited by a different artifact. */
/** The round's own retention owner. Stable across processes and restarts, because an
 *  entry pinned by a round must be releasable by the same name later. */
const RETENTION_OWNER = "coordinator";

export function artifactDigest(commit: string): string {
  return createHash("sha256").update(commit).digest("hex");
}
const policy = "narrow-snapshot-work/v3";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

interface Row {
  id: string;
  revision: string;
  input: string;
  dependencies: string;
  entry_id: string | null;
  attempt: number;
  owner: string | null;
  claim_time: string | null;
  input_digest: string | null;
  artifact: string | null;
  position: number;
  effect: string;
  source_revision: string;
  observed_revision: string;
  wait_event: string | null;
  external_ready: number;
  operation: string;
  kind: string;
  patch_files: string | null;
  patch_editable: string | null;
}
/** A worker-supplied submission payload, admitted only when it has the two fields the
 *  protocol needs. Everything else in it is ignored, never trusted. */
function parsePayload(content: string): { ticket: BoardTicket; artifact: string } | null {
  let candidate: unknown;
  try {
    candidate = JSON.parse(content);
  } catch {
    return null;
  }
  if (!candidate || typeof candidate !== "object") return null;
  const { ticket, artifact } = candidate as { ticket?: unknown; artifact?: unknown };
  if (!ticket || typeof ticket !== "object" || typeof artifact !== "string") return null;
  if (typeof (ticket as BoardTicket).taskId !== "string") return null;
  return { ticket: ticket as BoardTicket, artifact };
}

export interface BoardTicket {
  runId: string;
  taskId: string;
  revision: string;
  attempt: number;
  owner: string;
  claimedAt: string;
  inputDigest: string;
  input: string;
  dependencies: Record<string, string>;
  operation: ProbeOperation | null;
  // The frozen work itself, plus the digest that names it: typing it as a hand-listed
  // subset is what let the ticket silently omit every field added later.
  patch?: FrozenPatchTask & { digest: string };
}

/** Which run of a store to open. Omitted, a store with exactly one run continues it and a
 *  store with several refuses the ambiguity rather than guessing. */
/** The accepted artifacts by task id, read off a connection the caller owns. */
export function readAccepted(db: DatabaseSync, runId: string): Record<string, string> {
  const rows = db
    .prepare(
      "SELECT id, artifact, source_revision, observed_revision FROM ooo_probe_task_view " +
        "WHERE run_id=? AND artifact IS NOT NULL ORDER BY id",
    )
    .all(runId) as unknown as Row[];
  // The verdict is looked up on the board by the digest of THIS attempt's artifact — no
  // pointer column, because acceptance is the board's fact and retention keeps the entry
  // readable. A verdict about another digest never transfers, and a later rejection of
  // this digest withdraws acceptance.
  const verdictOf = db.prepare(
    `SELECT verdict, judged_digest FROM task_board_entries
       WHERE task_id = ? AND deliverable_digest = ? AND verdict IS NOT NULL
       ORDER BY judged_at DESC LIMIT 1`,
  );
  const cancelled = readCancelled(db, runId) !== null;
  const accepted: Record<string, string> = {};
  for (const row of rows) {
    const commit = String(row.artifact);
    const digest = artifactDigest(commit);
    const recorded = verdictOf.get(roundChannel(runId), digest) as unknown as
      { verdict: string | null; judged_digest: string | null } | undefined;
    if (
      !acceptedFact({
        artifact: commit,
        digest,
        verdict: recorded?.verdict ?? null,
        judgedDigest: recorded?.judged_digest ?? null,
        currentRevision: row.source_revision === row.observed_revision,
        cancelled,
      })
    )
      continue;
    accepted[String(row.id)] = commit;
  }
  return accepted;
}
/** The round's terminal reason, or null while it is still running. */
export function readCancelled(db: DatabaseSync, runId: string): string | null {
  const runs = db.prepare("SELECT cancel_reason FROM ooo_probe_runs WHERE run_id=?").get(runId) as
    { cancel_reason?: string | null } | undefined;
  return runs?.cancel_reason ?? null;
}
/** The owner's narrow query port: typed reads only, no write, no raw connection, no SQL and no close.
 *  Constructing it creates nothing; the offline host opens its own read-only handle and asks for the
 *  same port, so one implementation serves both paths. */
export interface RoundQueryPort {
  readonly cancelled: () => string | null;
  readonly accepted: () => Record<string, string>;
}

/** The offline host's read-only path: a true read-only handle, no migration, no initialisation and no
 *  publish, and nothing created when the file, the schema or the run is missing. The caller owns the
 *  handle it gets back. */
export function openRoundQuery(
  databasePath: string,
  runId?: string,
): { readonly port: RoundQueryPort; readonly close: () => void } {
  if (!existsSync(databasePath))
    throw new Error("this round store does not exist; a read-only view does not create one");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  // A refusal has to close the handle it just opened: an open handle keeps the file locked on Windows.
  // An explicit annotation on the variable is what lets the compiler narrow after the call.
  const refuse: (message: string) => never = (message) => {
    try {
      db.close();
    } catch {
      // Best effort; the refusal is what the caller needs.
    }
    throw new Error(message);
  };
  const table = (name: string) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
  if (!table("ooo_probe_runs"))
    refuse("this store carries no round schema; a read-only view does not migrate it");
  // A store with several runs refuses to guess, exactly as the writable path does; naming the run is
  // the caller's job, because picking one is an answer to somebody's evidence.
  const runs = db
    .prepare("SELECT run_id FROM ooo_probe_runs ORDER BY created_at")
    .all() as unknown as {
    run_id: string;
  }[];
  if (runId !== undefined && !runs.some((run) => run.run_id === runId))
    refuse(`this store holds no run ${runId}`);
  const resolved = runId ?? (runs.length === 1 ? runs[0]!.run_id : undefined);
  if (resolved === undefined)
    refuse(
      runs.length === 0
        ? "this store holds no run to read"
        : `this store holds ${runs.length} runs; name the one to read`,
    );
  return {
    port: {
      cancelled: () => readCancelled(db, resolved),
      accepted: () => readAccepted(db, resolved),
    },
    close: () => db.close(),
  };
}

export interface BoardAdmissionOptions {
  runId?: string;
}

/** Experiment-only authority. Uses the real board store, not a second queue.
 * Mutable execution state lives in SQLite; workers never open the database. */
export class BoardAdmission extends NmgStore {
  now = Date.now();
  afterVerify: () => Promise<void> = async () => {};
  afterCommit: () => Promise<void> = async () => {};
  readonly runId: string;
  /** The board channel this run publishes to; never shared with another run. */
  readonly channel: string;
  private readonly patchTasks: Readonly<Record<string, PatchTaskSpec>>;

  constructor(
    database: string,
    plan: ProbePlan = arithmeticPlan,
    patchTasks: Readonly<Record<string, PatchTaskSpec>> = {},
    options: BoardAdmissionOptions = {},
  ) {
    super(database);
    this.patchTasks = patchTasks;
    // A snapshot task can never carry host patch definitions. The opposite
    // direction is checked at claim time, because a round may install a task's
    // frozen envelope after construction but before it becomes claimable.
    for (const [id, , , , , operation] of plan)
      if (operation !== null && Object.hasOwn(patchTasks, id))
        throw new Error("patch tasks and snapshot operations are mutually exclusive");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ooo_probe_runs (
        run_id TEXT PRIMARY KEY, policy TEXT NOT NULL, cancel_reason TEXT, cancelled_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    this.createCheckTable();
    this.createManifestTables();
    this.migrateToTaskTables();
    // The additive `accepted_entry_id` column this store used to carry is gone with the table
    // that held it. It was a pointer to the entry whose verdict accepted an artifact, and the
    // verdict is looked up by artifact digest now — a migrated store keeps the artifact plus the
    // entries that decide it, and keeps no stale pointer that a reader could mistake for one.
    const wanted = `${policy}:${digest(plan)}`;
    const runs = this.db
      .prepare("SELECT run_id, policy FROM ooo_probe_runs ORDER BY created_at")
      .all() as unknown as { run_id: string; policy: string }[];
    // A store with several runs refuses to guess which one was meant: adopting the newest and
    // starting another are both silent answers to somebody's evidence.
    let runId = options.runId ?? (runs.length === 1 ? runs[0]!.run_id : null);
    if (runId === null && runs.length === 0) runId = randomUUID();
    if (runId === null)
      this.refuse(`this store holds ${runs.length} runs; name the one to open with { runId }`);
    const recorded = runs.find((run) => run.run_id === runId);
    if (recorded && recorded.policy !== wanted)
      this.refuse("probe policy changed; use a new database");
    this.runId = runId;
    this.channel = roundChannel(runId);
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO ooo_probe_runs (run_id, policy, created_at) VALUES (?, ?, ?)",
        )
        .run(runId, wanted, new Date(this.now).toISOString());
      for (const [
        position,
        [id, input, dependencies, effect, event, operation],
      ] of plan.entries()) {
        const spec = patchTasks[id];
        // What the run froze, written once: the manifest is never updated afterwards. Beside it
        // the facts of this task start empty (attempts and the external-ready event are facts the
        // board does not carry), and the derived row is not created at all — a task with no
        // derived row reads as one nobody has claimed.
        this.db
          .prepare(
            "INSERT OR IGNORE INTO ooo_probe_manifest (run_id, id, revision, input, dependencies, position, effect, source_revision, wait_event, operation, kind, patch_files, patch_editable) VALUES (?, ?, 'v1', ?, ?, ?, ?, 'input-v1', ?, ?, ?, ?, ?)",
          )
          .run(
            runId,
            id,
            spec ? spec.instruction : input,
            JSON.stringify(dependencies),
            position,
            effect,
            event,
            operation ?? "",
            spec ? "patch" : "snapshot",
            spec ? JSON.stringify(spec.files) : null,
            spec ? JSON.stringify(spec.editable) : null,
          );
        this.db
          .prepare(
            "INSERT OR IGNORE INTO ooo_probe_facts (run_id, id, attempt, external_ready) VALUES (?, ?, 0, ?)",
          )
          .run(runId, id, event ? 0 : 1);
      }
    });
    this.publishReady();
  }

  /**
   * Three tables, because a task row carried three kinds of fact and the difference decides what
   * may be rebuilt: what the run froze (immutable), what it appended (facts the board does not
   * have), and what is recomputable from the frozen manifest (the digest of the input this attempt
   * was claimed against). The claim holder is *not* in the last group: the board stops reporting
   * `claimedBy` once the round resolves the entry, so who claimed is a fact, and a rebuild that
   * tried to re-derive it would quietly lose it. Reads go through `ooo_probe_task_view`, which is a
   * projection and not storage.
   */
  private createManifestTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ooo_probe_manifest (
        run_id TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, input TEXT NOT NULL,
        dependencies TEXT NOT NULL, position INTEGER NOT NULL, effect TEXT NOT NULL,
        source_revision TEXT NOT NULL, wait_event TEXT, operation TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'snapshot', patch_files TEXT, patch_editable TEXT,
        PRIMARY KEY (run_id, id)
      );
      CREATE TABLE IF NOT EXISTS ooo_probe_facts (
        run_id TEXT NOT NULL, id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
        artifact TEXT, entry_id TEXT, external_ready INTEGER NOT NULL DEFAULT 0,
        observed_revision TEXT, owner TEXT, claim_time TEXT,
        PRIMARY KEY (run_id, id), UNIQUE (run_id, entry_id)
      );
      CREATE TABLE IF NOT EXISTS ooo_probe_derived (
        run_id TEXT NOT NULL, id TEXT NOT NULL, input_digest TEXT, PRIMARY KEY (run_id, id)
      );
      DROP VIEW IF EXISTS ooo_probe_task_view;
      CREATE VIEW ooo_probe_task_view AS
        SELECT m.run_id, m.id, m.revision, m.input, m.dependencies, m.position, m.effect,
          m.source_revision, m.wait_event, m.operation, m.kind, m.patch_files, m.patch_editable,
          COALESCE(f.attempt, 0) AS attempt, f.artifact, f.entry_id,
          COALESCE(f.external_ready, 0) AS external_ready,
          COALESCE(f.observed_revision, m.source_revision) AS observed_revision,
          f.owner, f.claim_time, d.input_digest
        FROM ooo_probe_manifest m
        LEFT JOIN ooo_probe_facts f ON f.run_id = m.run_id AND f.id = m.id
        LEFT JOIN ooo_probe_derived d ON d.run_id = m.run_id AND d.id = m.id;
    `);
  }

  private createCheckTable(name = "ooo_probe_checks") {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${name} (
        run_id TEXT NOT NULL, task_id TEXT NOT NULL, ticket TEXT NOT NULL, terminal TEXT,
        cancelled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, task_id)
      );
    `);
  }

  /**
   * Bring a store written before this split up to it: the old single task table is copied into the
   * manifest, the facts and the derived cache, and the old table is dropped. Both earlier shapes
   * are accepted — the pre-namespace one, which states its run in the single-row meta table, and
   * the run-scoped one — because a round's rows are its evidence, and re-attributing or discarding
   * them would be worse than migrating them.
   */
  private migrateToTaskTables(): void {
    const columns = (table: string) =>
      new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(
          (column) => column.name,
        ),
      );
    const meta = columns("ooo_probe_meta");
    const tasks = columns("ooo_probe_tasks");
    const checks = columns("ooo_probe_checks");
    if (tasks.size === 0) {
      if (meta.size > 0) throw new Error("legacy round store has meta but no task table");
      return;
    }
    const scoped = tasks.has("run_id");
    // A pre-namespace store states its run in the single-row meta table. Without that row the
    // rows cannot be attributed to a run, and inventing one would manufacture history.
    const legacy = meta.size
      ? (this.db.prepare("SELECT * FROM ooo_probe_meta WHERE id=1").get() as unknown as
          | { run_id: string; policy: string; cancel_reason?: string; cancelled_at?: string }
          | undefined)
      : undefined;
    if (meta.size > 0 && !legacy) throw new Error("legacy round store has no meta row");
    if (!scoped && !legacy)
      throw new Error(
        "legacy round store has rows but no run identity; refusing to attribute them",
      );
    const runId = legacy?.run_id ?? "";
    const needsChecks = checks.size > 0 && !checks.has("run_id");
    this.transaction(() => {
      if (legacy)
        this.db
          .prepare(
            "INSERT OR IGNORE INTO ooo_probe_runs (run_id, policy, cancel_reason, cancelled_at, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            legacy.run_id,
            legacy.policy,
            legacy.cancel_reason ?? null,
            legacy.cancelled_at ?? null,
            new Date(this.now).toISOString(),
          );
      this.db.exec("ALTER TABLE ooo_probe_tasks RENAME TO ooo_probe_tasks_pre_split");
      // Filling the missing run column first keeps the copy below a single statement per table
      // instead of one variant per shape.
      if (!scoped) {
        this.db.exec("ALTER TABLE ooo_probe_tasks_pre_split ADD COLUMN run_id TEXT");
        this.db.prepare("UPDATE ooo_probe_tasks_pre_split SET run_id=?").run(runId);
      }
      this.createManifestTables();
      this.db.exec(`
        INSERT INTO ooo_probe_manifest (run_id, id, revision, input, dependencies, position,
          effect, source_revision, wait_event, operation, kind, patch_files, patch_editable)
        SELECT run_id, id, revision, input, dependencies, position, effect, source_revision,
          wait_event, operation, kind, patch_files, patch_editable
        FROM ooo_probe_tasks_pre_split;
        INSERT INTO ooo_probe_facts (run_id, id, attempt, artifact, entry_id, external_ready,
          observed_revision, owner, claim_time)
        SELECT run_id, id, attempt, artifact, entry_id, external_ready, observed_revision,
          owner, claim_time
        FROM ooo_probe_tasks_pre_split;
        INSERT INTO ooo_probe_derived (run_id, id, input_digest)
        SELECT run_id, id, input_digest
        FROM ooo_probe_tasks_pre_split;
      `);
      this.db.exec("DROP TABLE ooo_probe_tasks_pre_split");
      if (meta.size > 0) this.db.exec("DROP TABLE ooo_probe_meta");
      if (needsChecks) {
        this.db.exec("ALTER TABLE ooo_probe_checks RENAME TO ooo_probe_checks_legacy");
        this.createCheckTable("ooo_probe_checks_scoped");
        this.db
          .prepare(
            `INSERT INTO ooo_probe_checks_scoped (run_id, task_id, ticket, terminal, cancelled)
             SELECT ?, task_id, ticket, terminal, cancelled FROM ooo_probe_checks_legacy`,
          )
          .run(runId);
        this.db.exec("DROP TABLE ooo_probe_checks_legacy");
        this.db.exec("ALTER TABLE ooo_probe_checks_scoped RENAME TO ooo_probe_checks");
      }
    });
  }

  /**
   * One transition, on the store's boundary. The port is what lets a write that owns a boundary of
   * its own (a board publication) join this one instead of opening a second BEGIN, and only the
   * store decides whether the transition commits.
   */
  private transaction<T>(work: (port: TransactionPort) => T): T {
    return this.writeTransaction(work);
  }

  private ensureColumns(table: string, columns: Readonly<Record<string, string>>) {
    const existing = new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    for (const [name, type] of Object.entries(columns))
      if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }

  private row(id: string): Row {
    const row = this.db
      .prepare("SELECT * FROM ooo_probe_task_view WHERE run_id=? AND id=?")
      .get(this.runId, id) as unknown as Row | undefined;
    if (!row) throw new Error("unknown task");
    return row;
  }

  private inputs(row: Row): Record<string, string> {
    const accepted = this.acceptedArtifacts();
    return Object.fromEntries(
      (JSON.parse(row.dependencies) as string[]).map((id) => {
        const value = accepted[id];
        // An accepted artifact is the only value a dependent may bind to: bytes whose
        // verdict is pending, rejected, or about a retired revision are not an input.
        // An unknown id is still reported as unknown, because "no such task" and "not
        // accepted yet" send a reader to different places.
        if (value === undefined) {
          this.row(id);
          throw new Error("unfulfilled dependencies");
        }
        return [id, value];
      }),
    );
  }

  /** Bytes exist. This is a delivery fact, not acceptance: it is what the arbitration in
   *  submit()/commitArtifact() compares against, and it is not what releases a dependent. */
  private delivered(row: Row): boolean {
    return row.artifact !== null;
  }

  /** A task with no snapshot operation is a patch task; its host envelope is looked
   *  up live because a round installs it before the task becomes claimable. */
  private patchSpec(row: Row): PatchTaskSpec | null {
    return row.operation ? null : (this.patchTasks[row.id] ?? null);
  }

  /** Read from the live host spec, not from row columns: a round may install a
   *  task's frozen envelope after construction but before it becomes claimable. */
  private patchFrozen(row: Row, attempt: number) {
    const spec = this.patchSpec(row);
    if (!spec) throw new Error("not a patch task");
    return preparePatchWork({
      taskId: row.id,
      attempt,
      instruction: spec.instruction,
      files: spec.files,
      editable: spec.editable,
      visible: spec.visible,
      admittedConclusions: spec.admittedConclusions,
      budget: spec.budget,
      limits: spec.limits,
    });
  }

  private inputDigest(row: Row): string {
    if (this.patchSpec(row)) return this.patchFrozen(row, row.attempt > 0 ? row.attempt : 1).digest;
    return digest([
      policy,
      row.revision,
      row.source_revision,
      row.operation,
      row.input,
      this.inputs(row),
    ]);
  }

  /**
   * Publish a board entry, joining the transition this call belongs to when it is given a port.
   * Without one it opens its own boundary, which is why a caller inside a transition must pass it:
   * a second BEGIN is refused rather than nested.
   */
  private publish(kind: "handoff" | "decision", content: string, port?: TransactionPort): string {
    // The real board put owns its transaction. Recover a post-put/pre-link crash by adopting
    // the existing publication instead of creating another message — but only while it is still
    // open: a *resolved* publication with the same content is a finished handoff, and adopting
    // it would link the row to an entry nobody can claim.
    const existing = this.db
      .prepare(
        "SELECT id FROM task_board_entries WHERE task_id=? AND agent_id='coordinator' AND kind=? AND content=? AND status='open' ORDER BY id LIMIT 1",
      )
      .get(this.channel, kind, content);
    if (existing) return String(existing.id);
    return this.putTaskBoardEntry(
      {
        taskId: this.channel,
        agentId: "coordinator",
        kind,
        content,
        expiresAt: new Date(this.now + 86_400_000).toISOString(),
      },
      port,
    ).id;
  }

  private publishReady(port?: TransactionPort): void {
    // Pending publications are derived from durable rows: a tiny transactional
    // outbox, drained by this single daemon after commit and on restart/retry.
    const delivered = this.db
      .prepare(
        "SELECT * FROM ooo_probe_task_view WHERE run_id=? AND artifact IS NOT NULL ORDER BY id",
      )
      .all(this.runId) as unknown as Row[];
    for (const row of delivered)
      this.publish(
        "decision",
        JSON.stringify({ id: row.id, attempt: row.attempt, artifact: row.artifact }),
        port,
      );
    // A published handoff for a task that is no longer the selected one must give the board's
    // serial slot back. The plan can move past it (a waiting task became ready first, which is
    // exactly what ordered execution does), and an unclaimed, unselected handoff would then
    // block every later claim in the round. Nothing is fenced here: no ticket exists for a task
    // nobody claimed, so only the publication is retired.
    const selected = this.next();
    for (const row of this.db
      .prepare(
        "SELECT * FROM ooo_probe_task_view WHERE run_id=? AND entry_id IS NOT NULL ORDER BY id",
      )
      .all(this.runId) as unknown as Row[]) {
      if (row.id === selected || this.live(row)) continue;
      try {
        this.resolveTaskBoardEntry({
          taskId: this.channel,
          entryId: row.entry_id!,
          agentId: "coordinator",
          resolution: "no longer the selected task",
        });
      } catch {
        // Already resolved or expired: the slot is free either way.
      }
      // A handoff nobody used is not evidence: its pin goes with it. A row whose artifact
      // was delivered keeps its pin, because the verdict that accepts it must stay
      // readable past this entry's own TTL.
      if (!this.delivered(row))
        this.releaseTaskBoardRetention({
          taskId: this.channel,
          entryId: row.entry_id!,
          owner: RETENTION_OWNER,
        });
      this.db
        .prepare("UPDATE ooo_probe_facts SET entry_id=NULL WHERE run_id=? AND id=?")
        .run(this.runId, row.id);
    }
    const rows = this.db
      .prepare("SELECT * FROM ooo_probe_task_view WHERE run_id=? AND entry_id IS NULL ORDER BY id")
      .all(this.runId) as unknown as Row[];
    const accepted = this.acceptedArtifacts();
    for (const row of rows) {
      // Do not occupy the board's serial outstanding slot with a waiting task.
      if (row.id !== selected) continue;
      if ((JSON.parse(row.dependencies) as string[]).some((id) => !Object.hasOwn(accepted, id)))
        continue;
      const entryId = this.publish(
        "handoff",
        // The attempt is part of the publication identity: a reopened task must get a
        // new claimable entry, while a crash retry of the same attempt still adopts
        // the entry it already published.
        JSON.stringify({
          id: row.id,
          revision: row.revision,
          attempt: row.attempt,
          input: row.input,
        }),
        port,
      );
      this.db
        .prepare("UPDATE ooo_probe_facts SET entry_id=? WHERE run_id=? AND id=?")
        .run(entryId, this.runId, row.id);
      // Pin what the round is about to reference. Without this the entry could be pruned
      // on its own TTL while the round still needs its verdict, and acceptance would
      // silently disappear from a round that is still running.
      this.retainTaskBoardEntry({
        taskId: this.channel,
        entryId,
        owner: RETENTION_OWNER,
        reason: `round ${this.runId ?? "initial"} handoff for ${row.id}`,
        now: new Date(this.now).toISOString(),
      });
    }
  }

  refresh(): void {
    this.publishReady();
  }

  /** Fixture coordinator controls; not available on the worker HTTP endpoint. */
  externalReady(event: string): void {
    if (this.cancelled() !== null) throw new Error("round cancelled");
    if (
      this.db
        .prepare(
          "SELECT 1 FROM ooo_probe_checks c JOIN ooo_probe_task_view t ON c.task_id=t.id AND c.run_id=t.run_id WHERE t.run_id=? AND t.wait_event=?",
        )
        .get(this.runId, event)
    )
      throw new Error("managed check requires bound terminal evidence");
    const changed = this.db
      .prepare(
        // `wait_event` is part of the frozen manifest, so the fact is written to the tasks whose
        // manifest says they are waiting on this event. A view over three tables is not updatable,
        // which is why this is a subquery rather than a single-table predicate.
        "UPDATE ooo_probe_facts SET external_ready=1 WHERE run_id=? AND id IN (SELECT id FROM ooo_probe_manifest WHERE run_id=? AND wait_event=?)",
      )
      .run(this.runId, this.runId, event);
    if (!changed.changes) throw new Error("unknown external event");
    this.publishReady();
  }

  /** Coordinator-only. A check has its own lease; it does not claim an Agent runner. */
  issueCheck(id: string, owner: string): Readonly<CheckTicket> {
    if (!owner.trim()) throw new Error("check owner required");
    if (this.cancelled() !== null) throw new Error("round cancelled");
    return this.transaction(() => {
      const row = this.row(id);
      if (!row.wait_event || row.external_ready || this.delivered(row))
        throw new Error("task is not waiting");
      if (row.source_revision !== row.observed_revision) throw new Error("stale check input");
      const previous = this.db
        .prepare("SELECT ticket FROM ooo_probe_checks WHERE run_id=? AND task_id=?")
        .get(this.runId, id);
      const attempt = previous
        ? (JSON.parse(String(previous.ticket)) as CheckTicket).attempt + 1
        : 1;
      if (!Number.isSafeInteger(attempt)) throw new Error("check attempt exhausted");
      const ticket = Object.freeze({
        runId: this.runId,
        taskId: id,
        // Derived from the round's own state, never from a clock or a random source. The
        // identity ends up inside the frozen instruction the worker is handed, so a random
        // id made every round's envelope different and a logged round unreplayable: the
        // host refused the recorded artifact for a digest it could no longer reproduce.
        // Its scope is the store, and one store is one round, so this stays unique where
        // it has to be.
        // Deliberately NOT run-scoped: a check id is what a round log records, and a replay runs
        // under a new runId while reproducing the same attempts. Uniqueness in the store is the
        // (run_id, task_id) key, so two runs may share a check id without colliding.
        checkId: digest([id, attempt]).slice(0, 32),
        attempt,
        inputDigest: this.inputDigest(row),
        owner,
        expiresAt: this.now + 60_000,
      });
      this.db
        .prepare(
          "INSERT OR REPLACE INTO ooo_probe_checks (run_id, task_id, ticket, terminal, cancelled) VALUES (?, ?, ?, NULL, 0)",
        )
        .run(this.runId, id, JSON.stringify(ticket));
      return ticket;
    });
  }

  cancelCheck(ticket: CheckTicket): boolean {
    return this.transaction(() => {
      const current = this.checkRecord(ticket);
      if (!current || current.terminal !== null || current.cancelled) return false;
      this.db
        .prepare("UPDATE ooo_probe_checks SET cancelled=1 WHERE run_id=? AND task_id=?")
        .run(this.runId, ticket.taskId);
      return true;
    });
  }

  private checkRecord(ticket: CheckTicket) {
    const record = this.db
      .prepare("SELECT * FROM ooo_probe_checks WHERE run_id=? AND task_id=?")
      .get(this.runId, ticket.taskId);
    return record && sameCheck(ticket, JSON.parse(String(record.ticket)) as CheckTicket)
      ? record
      : null;
  }

  /** Trusted check-host result only; not a worker-accessible endpoint. */
  submitCheck(result: CheckResult): string {
    if (!result?.ticket || !checkResultValid(result)) return "rejected";
    const verdict = this.transaction(() => {
      const record = this.checkRecord(result.ticket);
      if (!record || record.cancelled) return "stale";
      const row = this.row(result.ticket.taskId);
      if (
        row.source_revision !== row.observed_revision ||
        result.ticket.inputDigest !== this.inputDigest(row)
      )
        return "stale";
      const terminal = JSON.stringify([result.outcome, result.log]);
      if (record.terminal !== null) return record.terminal === terminal ? "duplicate" : "rejected";
      if (result.ticket.expiresAt <= this.now) return "stale";
      this.db
        .prepare("UPDATE ooo_probe_checks SET terminal=? WHERE run_id=? AND task_id=?")
        .run(terminal, this.runId, row.id);
      // Unknown completion is not evidence that the wait resolved.
      if (result.outcome !== "undecidable")
        this.db
          .prepare("UPDATE ooo_probe_facts SET external_ready=1 WHERE run_id=? AND id=?")
          .run(this.runId, row.id);
      return "accepted";
    });
    this.publishReady();
    return verdict;
  }

  observeRevision(id: string, revision: string): void {
    if (!revision.trim()) throw new Error("revision required");
    this.row(id);
    this.db
      .prepare("UPDATE ooo_probe_facts SET observed_revision=? WHERE run_id=? AND id=?")
      .run(revision, this.runId, id);
    this.publishReady();
  }

  next(): string | null {
    // A cancelled round selects nothing: the successor is not "the next task", it is
    // the explicit terminal decision the caller asked for.
    if (this.cancelled() !== null) return null;
    const rows = this.db
      .prepare("SELECT * FROM ooo_probe_task_view WHERE run_id=? ORDER BY position")
      .all(this.runId) as unknown as Row[];
    const accepted = this.acceptedArtifacts();
    // A task whose artifact is delivered but no longer accepted is not selectable: the
    // bytes still exist, so it cannot be claimed again either, and selecting it would
    // publish a handoff nobody can claim. The coordinator recovers it with reopen().
    const schedulable = rows.filter(
      (row) => !this.delivered(row) || Object.hasOwn(accepted, row.id),
    );
    return nextTask(
      schedulable.map((row) => ({
        id: row.id,
        effect: row.effect,
        sourceVersion: row.source_revision,
        observedVersion: row.observed_revision,
        dependencies: JSON.parse(row.dependencies) as string[],
        accepted: Object.hasOwn(accepted, row.id),
        claimed: this.live(row),
        externalEvent: row.wait_event ?? undefined,
        externalReady: row.external_ready === 1,
      })),
    );
  }

  claim(id: string, agentId: string): BoardTicket {
    if (!id || !agentId) throw new Error("task and agent required");
    if (this.cancelled() !== null) throw new Error("round cancelled");
    return this.transaction(() => {
      const row = this.claimableRow(id);
      const dependencies = this.inputs(row);
      const entry = this.claimTaskBoardEntry({
        taskId: this.channel,
        entryId: row.entry_id!,
        agentId,
        leaseSeconds: 60,
        now: new Date(this.now).toISOString(),
      });
      // Two different counters, deliberately not merged: the board entry's
      // `attempt` fences claims WITHIN one entry, while this one is the round's
      // generation for the TASK, which must advance across entry reissues —
      // reopen() withdraws a handoff and publishes a new entry, whose board
      // attempt starts over. Deriving the generation from the entry would let a
      // retired attempt be re-claimed under the same generation (measured: the
      // recovery test caught exactly that), so the task generation stays here.
      const attempt = row.attempt + 1;
      if (!Number.isSafeInteger(attempt)) throw new Error("attempt exhausted");
      const spec = this.patchSpec(row);
      if (!row.operation && !spec) throw new Error("patch task has no host spec");
      const frozen = spec ? this.patchFrozen({ ...row, attempt }, attempt) : null;
      const inputDigest = frozen ? frozen.digest : this.inputDigest(row);
      // The attempt, the holder and the claim time are facts: the board stops reporting its claim
      // once the entry is resolved, so they cannot be re-derived. The input digest is the cache,
      // recomputable from the frozen manifest at any time.
      this.db
        .prepare(
          "UPDATE ooo_probe_facts SET attempt=?, owner=?, claim_time=? WHERE run_id=? AND id=?",
        )
        .run(attempt, agentId, entry.claimedAt, this.runId, id);
      this.putInputDigest(id, inputDigest);
      return {
        runId: this.runId,
        taskId: id,
        revision: row.revision,
        attempt,
        owner: agentId,
        claimedAt: entry.claimedAt!,
        inputDigest,
        input: row.input,
        operation: spec ? null : (row.operation as ProbeOperation),
        dependencies,
        patch: frozen ? { ...frozen.work, digest: frozen.digest } : undefined,
      };
    });
  }

  /** Every reason a task cannot be claimed right now, checked inside the claim
   *  transaction so selection and claim see the same state. */
  private claimableRow(id: string): Row {
    const row = this.row(id);
    if (this.delivered(row))
      throw new Error(
        Object.hasOwn(this.acceptedArtifacts(), row.id)
          ? "task completed"
          : "task delivered but not accepted; the coordinator must reopen it",
      );
    // Three distinct refusals, each named for what it is; they used to share one misleading
    // message ("unfulfilled dependencies") that sent readers after a dependency problem that
    // did not exist. Dependencies are checked first because they explain *why* nothing was
    // published, which is the more useful answer when both are true.
    const accepted = this.acceptedArtifacts();
    if ((JSON.parse(row.dependencies) as string[]).some((id) => !Object.hasOwn(accepted, id)))
      throw new Error("unfulfilled dependencies");
    if (!row.entry_id) throw new Error("no published handoff for this task");
    if (this.live(row)) throw new Error("task already claimed");
    if (this.next() !== id) throw new Error("task not selected by narrow dispatch");
    return row;
  }

  private bound(ticket: BoardTicket, row: Row): boolean {
    try {
      return (
        row.source_revision === row.observed_revision &&
        ticket.runId === this.runId &&
        ticket.revision === row.revision &&
        ticket.attempt === row.attempt &&
        ticket.owner === row.owner &&
        ticket.claimedAt === row.claim_time &&
        ticket.inputDigest === row.input_digest &&
        ticket.inputDigest === this.inputDigest(row)
      );
    } catch {
      return false;
    }
  }

  private live(row: Row): boolean {
    const entry = row.entry_id ? this.getTaskBoardEntryById(this.channel, row.entry_id) : null;
    return (
      entry !== null &&
      entry.status === "open" &&
      entry.claimedBy === row.owner &&
      entry.claimedAt === row.claim_time &&
      entry.claimExpiresAt !== null &&
      Date.parse(entry.claimExpiresAt) > this.now &&
      Date.parse(entry.expiresAt) > this.now
    );
  }

  /** Host-side comparison value for a submitted artifact. Patch proposals must
   *  satisfy the frozen contract before they can even be compared or verified. */
  private proposalCommit(row: Row, artifact: string): string | null {
    try {
      if (this.patchSpec(row)) {
        const frozen = this.patchFrozen(row, row.attempt);
        let submission: PatchSubmission;
        try {
          submission = patchSubmission(frozen, artifact);
        } catch {
          // Fall back to the patch form; an invalid envelope stays invalid below.
          submission = { kind: "patch", files: patchCandidate(frozen, artifact) };
        }
        return JSON.stringify(submission);
      }
      const expected = snapshotAnswer({
        operation: row.operation as ProbeOperation,
        input: row.input,
        dependencies: this.inputs(row),
      });
      return artifact === expected ? artifact : null;
    } catch {
      return null;
    }
  }

  /** The last post-commit notification failure, or null. A commit that landed is not undone by a
   *  subscriber that could not be reached, so the two outcomes are reported separately: a caller
   *  that reads a failed notification as "the submission failed" submits the same work twice. */
  private notificationFailure: string | null = null;

  lastNotificationFailure(): string | null {
    return this.notificationFailure;
  }

  async submit(resultId: string): Promise<string> {
    const parsed = this.readSubmission(resultId);
    if (typeof parsed === "string") return parsed;
    const { ticket, artifact, row } = parsed;
    const commit = this.proposalCommit(row, artifact);
    if (this.delivered(row)) {
      this.publishReady();
      return commit !== null && row.artifact === commit ? "duplicate" : "rejected";
    }
    if (!this.live(row)) return "stale";
    if (commit === null) return "rejected";
    // Candidate text is re-derived from the same frozen input the host owns; a
    // worker-supplied "passed" field or verdict never reaches this decision.
    if (this.patchSpec(row) && !(await this.verifyCandidate(row, commit))) return "rejected";
    await this.afterVerify();
    const verdict = this.commitArtifact(ticket, commit);
    // Past this line the round has the artifact: `verdict` is what happened. Everything below is
    // notification, and failing to reach a subscriber is recorded rather than thrown, because the
    // commit is not undone and a caller must not be told it was.
    try {
      await this.afterCommit();
      this.publishReady();
    } catch (error) {
      this.notificationFailure = error instanceof Error ? error.message : String(error);
    }
    return verdict;
  }

  /** The submitted board entry, validated as data and bound to the task it names. A
   *  string result is the verdict of that validation, not an error. */
  private readSubmission(
    resultId: string,
  ): { ticket: BoardTicket; artifact: string; row: Row } | "rejected" | "stale" {
    const result = this.getTaskBoardEntryById(this.channel, resultId);
    if (
      !result ||
      result.taskId !== this.channel ||
      result.kind !== "result" ||
      Date.parse(result.expiresAt) <= this.now
    )
      return "rejected";
    const payload = parsePayload(result.content);
    if (!payload) return "rejected";
    const { ticket, artifact } = payload;
    if (result.agentId !== ticket.owner) return "rejected";
    let row: Row;
    try {
      row = this.row(ticket.taskId);
    } catch {
      return "rejected";
    }
    return this.bound(ticket, row) ? { ticket, artifact, row } : "stale";
  }

  /** A patch task's verification is a host call that may throw or abstain; only an
   *  explicit accept is acceptance. */
  private async verifyCandidate(row: Row, commit: string): Promise<boolean> {
    try {
      const outcome = await this.patchSpec(row)!.verify(JSON.parse(commit) as PatchSubmission);
      return outcome === "accept";
    } catch {
      return false;
    }
  }

  /** The commit re-checks the fence inside its own transaction: verification is await-
   *  capable, so the ticket may have been retired while it ran. A rejected attempt keeps
   *  its claim — only a reissued attempt (new digest) or a lapsed lease fences it. */
  private commitArtifact(ticket: BoardTicket, commit: string): string {
    return this.transaction(() => {
      const row = this.row(ticket.taskId);
      if (!this.bound(ticket, row)) return "stale";
      if (this.delivered(row)) return row.artifact === commit ? "duplicate" : "rejected";
      if (!this.live(row)) return "stale";
      this.db
        .prepare("UPDATE ooo_probe_facts SET artifact=? WHERE run_id=? AND id=?")
        .run(commit, this.runId, row.id);
      // Acceptance is recorded as protocol, not as a self-report. The artifact is
      // delivered against the claim it belongs to — the holder's own attempt, so
      // deliveredBy is the agent that produced it, recorded by the coordinator on
      // its behalf (the store's rule is "the live claim holder", which is exactly
      // that agent) — and then judged by the coordinator, who is by construction
      // not the deliverer. The resolve below stays the lifecycle close; it is no
      // longer the only evidence that the work was accepted.
      // `now` comes from the round's injected clock: a deterministic round must not
      // read wall-clock time inside a protocol write.
      const now = new Date(this.now).toISOString();
      this.deliverTaskBoardEntry({
        taskId: this.channel,
        entryId: row.entry_id!,
        agentId: ticket.owner,
        digest: artifactDigest(commit),
        summary: "host-verified artifact for this attempt",
        now,
      });
      this.judgeTaskBoardEntry({
        taskId: this.channel,
        entryId: row.entry_id!,
        agentId: "coordinator",
        verdict: "accepted",
        reason: "host verification accepted this artifact",
        now,
      });
      // No pointer column is written here any more. `accepted_entry_id` cached a derived
      // fact (this artifact was accepted) in the round's private table, which meant two
      // places could disagree about it. The entry is the authority, the round finds it by
      // the digest of the artifact it holds, and the retention in publishReady() keeps
      // that entry readable past its own TTL — so the fact stays derivable instead of
      // being stored twice.
      this.resolveTaskBoardEntry({
        taskId: this.channel,
        entryId: row.entry_id!,
        agentId: "coordinator",
        resolution: "verified current attempt",
      });
      return "accepted";
    });
  }

  /** The tasks whose artifact is accepted right now, by task id — one query, one rule.
   *
   *  The board verdict is what makes an artifact accepted; the private column only holds
   *  the value dependents bind to. Both facts are required, the verdict must name THIS
   *  artifact's digest, and the revision it was built from must still be current — the
   *  rule itself lives in acceptedFact(), because dependency release, selection and this
   *  query must not be able to disagree about what "accepted" means. In particular a row
   *  whose entry was later judged rejected (an outside reviewer can do that) stops
   *  counting, and the round fails closed: dependents stay blocked until the coordinator
   *  explicitly reopens the task. */
  /** Release every pin this round holds on a row: the one on the handoff it published and
   *  the one on the entry that carries the verdict for its artifact. Dual on purpose —
   *  publishReady() clears `entry_id` for a task that is no longer selected, so a release
   *  that only knew the entry id would leak the pin on the verdict, and a release that only
   *  knew the artifact would leak the pin on an unused handoff. Both are idempotent. */
  private releaseRowRetention(row: Row): void {
    if (row.entry_id)
      this.releaseTaskBoardRetention({
        taskId: this.channel,
        entryId: row.entry_id,
        owner: RETENTION_OWNER,
      });
    if (row.artifact !== null) this.releaseArtifactRetention(row.artifact);
  }

  /** Release this round's pins on the entries that carried `commit`'s verdict. Derived
   *  from the artifact digest rather than a stored pointer, so it also works after
   *  publishReady() has cleared `entry_id` for a task that is no longer selected. */
  private releaseArtifactRetention(commit: string): void {
    const digest = artifactDigest(commit);
    const entries = this.db
      .prepare("SELECT id FROM task_board_entries WHERE task_id = ? AND deliverable_digest = ?")
      .all(this.channel, digest) as unknown as { id: string }[];
    for (const entry of entries)
      this.releaseTaskBoardRetention({
        taskId: this.channel,
        entryId: String(entry.id),
        owner: RETENTION_OWNER,
      });
  }

  acceptedArtifacts(): Record<string, string> {
    return readAccepted(this.db, this.runId);
  }

  /** The accepted artifacts, by task id — the values dependents bind to. */
  accepted(): Record<string, string> {
    return this.acceptedArtifacts();
  }

  /** Invalidates a task's accepted artifact (or live claim) so it must run again, and
   *  invalidates the accepted dependents whose acceptance rested on it.
   *
   *  The attempt bump is what does the fencing: `inputDigest()` feeds on the attempt
   *  and on dependency artifacts, so every in-flight ticket and every artifact bound
   *  to the old value stops matching. Nothing is repaired in place — the caller must
   *  reinstall the task's host spec and reissue its check before it can run again. */
  /** Ends the round. Cancellation is not a value change: it is the round's terminal
   *  decision, so every task is fenced (the attempt advances, which retires every live
   *  ticket and claim), outstanding handoffs are withdrawn, and no task is selectable
   *  afterwards. A late artifact submitted under the retired attempt is rejected as
   *  stale rather than accepted into a round nobody is waiting for. */
  cancel(reason: string): string[] {
    // The first decision is the one that took effect, so cancelling twice is a no-op that
    // keeps the original reason: a later caller must not rewrite what the round terminated on.
    const already = this.cancelled();
    if (already !== null) return [];
    const withdrawn: string[] = [];
    this.transaction(() => {
      for (const row of this.db
        .prepare("SELECT * FROM ooo_probe_task_view WHERE run_id=? ORDER BY position")
        .all(this.runId) as unknown as Row[])
        this.fenceRow(row, withdrawn);
      this.db
        .prepare("UPDATE ooo_probe_checks SET terminal='cancelled', cancelled=1 WHERE run_id=?")
        .run(this.runId);
      this.db
        .prepare("UPDATE ooo_probe_runs SET cancel_reason=?, cancelled_at=? WHERE run_id=?")
        .run(reason.slice(0, 1_000), new Date(this.now).toISOString(), this.runId);
    });
    this.publish("decision", `cancel: ${reason}`.slice(0, 1_000));
    return withdrawn;
  }

  /** Withdraws one task's published handoff and leaves it unclaimed, because the
   *  coordinator has decided not to dispatch it (its premise did not hold). The attempt
   *  still advances, so an artifact produced for the withdrawn attempt arrives stale.
   *
   *  This is not bookkeeping: the board serializes actionable entries, so a handoff left
   *  outstanding for a task nobody will claim blocks every later claim in the round. The
   *  refusal has to close what it published. */
  withdrawHandoff(taskId: string, reason: string): void {
    this.transaction(() => {
      this.fenceRow(this.row(taskId), [], reason);
    });
    this.publish("decision", `withdrawn: ${taskId}: ${reason}`.slice(0, 1_000));
  }

  /** Retires one row: resolves its published entry, then fences it so every live ticket
   *  and artifact bound to the old attempt stops matching. */
  private fenceRow(row: Row, dropped: string[], resolution = "round cancelled"): void {
    if (row.entry_id)
      try {
        this.resolveTaskBoardEntry({
          taskId: this.channel,
          entryId: row.entry_id,
          agentId: "coordinator",
          resolution,
        });
      } catch {
        // Already resolved or expired: nothing to withdraw.
      }
    // The artifact is being cleared, so the round no longer relies on this entry's
    // verdict: the pins go with the value they protected.
    this.releaseRowRetention(row);
    if (row.artifact !== null || row.owner !== null) dropped.push(row.id);
    this.db
      .prepare(
        "UPDATE ooo_probe_facts SET artifact=NULL, attempt=attempt+1, owner=NULL, claim_time=NULL, external_ready=0, entry_id=NULL WHERE run_id=? AND id=?",
      )
      .run(this.runId, row.id);
    this.putInputDigest(row.id, null);
  }

  /** Warm the cache for one task. There is exactly one derived column, and this is its writer. */
  private putInputDigest(id: string, digest: string | null): void {
    this.db
      .prepare(
        `INSERT INTO ooo_probe_derived (run_id, id, input_digest) VALUES (?, ?, ?)
         ON CONFLICT(run_id, id) DO UPDATE SET input_digest=excluded.input_digest`,
      )
      .run(this.runId, id, digest);
  }

  /**
   * Rebuild the cache from what decides it: the frozen manifest names the input digest of the
   * attempt a task was claimed at. Nothing here is authoritative, so this is safe to call whenever
   * the cache is suspect  -  and if it produces a different answer than the cache held, the cache was
   * wrong, not the sources.
   */
  refreshDerived(): number {
    const rows = this.db
      .prepare("SELECT * FROM ooo_probe_task_view WHERE run_id=? ORDER BY position")
      .all(this.runId) as unknown as Row[];
    return this.transaction(() => {
      let rebuilt = 0;
      for (const row of rows) {
        const frozen =
          row.attempt >= 1 && this.patchTasks[row.id] !== undefined
            ? this.patchFrozen(row, row.attempt)
            : null;
        // A task with no attempt has no digest to record: the ticket mints one at claim time.
        this.putInputDigest(
          row.id,
          row.attempt >= 1 ? (frozen?.digest ?? this.inputDigest(row)) : null,
        );
        rebuilt += 1;
      }
      return rebuilt;
    });
  }

  /** Refusing a store must not leave its file handle behind: the caller is told to open a
   *  different database, and on Windows an open handle keeps that file locked. */
  private refuse(message: string): never {
    this.db.close();
    throw new Error(message);
  }

  /** The round's terminal reason, or null while it is still running. */
  cancelled(): string | null {
    return readCancelled(this.db, this.runId);
  }

  /** Explicit terminal decision for a check that never reported: otherwise a wait only
   *  ends by accident (lease expiry), which is an infinite wait with a clock attached.
   *  Idempotent, and bound to the issued ticket: an impostor cannot end a wait. */
  abandonCheck(ticket: CheckTicket, reason: string): boolean {
    const decided = this.transaction(() => {
      const current = this.checkRecord(ticket);
      if (!current || current.terminal !== null) return false;
      this.db
        .prepare(
          "UPDATE ooo_probe_checks SET terminal='undecidable', cancelled=1 WHERE run_id=? AND task_id=?",
        )
        .run(this.runId, ticket.taskId);
      return true;
    });
    if (decided)
      this.publish("decision", `undecidable check on ${ticket.taskId}: ${reason}`.slice(0, 1_000));
    return decided;
  }

  reopen(id: string, reason: string): string[] {
    const invalidated: string[] = [];
    this.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM ooo_probe_task_view WHERE run_id=? ORDER BY position")
        .all(this.runId) as unknown as Row[];
      const affected = new Set([id]);
      // Transitive dependents: an artifact built from a value that no longer exists
      // must not stay accepted.
      for (let grew = true; grew;) {
        grew = false;
        for (const row of rows) {
          if (affected.has(row.id)) continue;
          if ((JSON.parse(row.dependencies) as string[]).some((dep) => affected.has(dep))) {
            affected.add(row.id);
            grew = true;
          }
        }
      }
      for (const taskId of affected) {
        const row = this.row(taskId);
        if (row.artifact !== null) invalidated.push(taskId);
        // A handoff published for the old value still occupies the board's serial
        // slot, so it is withdrawn with the artifact it described.
        if (row.entry_id)
          try {
            this.resolveTaskBoardEntry({
              taskId: this.channel,
              entryId: row.entry_id,
              agentId: "coordinator",
              resolution: "invalidated by reopen",
            });
          } catch {
            // Already resolved or expired: nothing to withdraw.
          }
        // Same rule as fenceRow: the values these verdicts protected are being cleared, so
        // the pins are no longer the round's to hold.
        this.releaseRowRetention(row);
        this.db
          .prepare(
            "UPDATE ooo_probe_facts SET artifact=NULL, attempt=attempt+1, owner=NULL, claim_time=NULL, external_ready=0, entry_id=NULL WHERE run_id=? AND id=?",
          )
          .run(this.runId, taskId);
        this.putInputDigest(taskId, null);
      }
    });
    this.publish("decision", `reopen ${invalidated.join(",")}: ${reason}`.slice(0, 1_000));
    this.publishReady();
    return invalidated;
  }
}
