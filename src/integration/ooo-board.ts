import { createHash, randomUUID } from "node:crypto";
import { NmgStore } from "../../src/core/store.ts";
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

export const channel = "ooo-process-probe";

/** Identity of an accepted artifact: sha256 of the canonical commit the round binds
 *  dependents to. The board carries this short identity and never the bytes — the value
 *  itself stays in the round's row and in the ready-signal decision entry. A verdict is
 *  bound to this digest, so it cannot be inherited by a different artifact. */
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

/** Experiment-only authority. Uses the real board store, not a second queue.
 * Mutable execution state lives in SQLite; workers never open the database. */
export class BoardAdmission extends NmgStore {
  now = Date.now();
  afterVerify: () => Promise<void> = async () => {};
  afterCommit: () => Promise<void> = async () => {};
  readonly runId: string;
  private readonly patchTasks: Readonly<Record<string, PatchTaskSpec>>;

  constructor(
    database: string,
    plan: ProbePlan = arithmeticPlan,
    patchTasks: Readonly<Record<string, PatchTaskSpec>> = {},
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
      CREATE TABLE IF NOT EXISTS ooo_probe_meta (id INTEGER PRIMARY KEY CHECK(id=1), run_id TEXT NOT NULL, policy TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ooo_probe_checks (
        task_id TEXT PRIMARY KEY, ticket TEXT NOT NULL, terminal TEXT, cancelled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS ooo_probe_tasks (
        id TEXT PRIMARY KEY, revision TEXT NOT NULL, input TEXT NOT NULL, dependencies TEXT NOT NULL,
        entry_id TEXT UNIQUE, attempt INTEGER NOT NULL DEFAULT 0, owner TEXT, claim_time TEXT,
        input_digest TEXT, artifact TEXT, position INTEGER NOT NULL, effect TEXT NOT NULL,
        source_revision TEXT NOT NULL, observed_revision TEXT NOT NULL,
        wait_event TEXT, external_ready INTEGER NOT NULL, operation TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'snapshot', patch_files TEXT, patch_editable TEXT
      );
    `);
    // Additive migration: a round store outlives the process that created it, so a new
    // column must be added rather than assumed. Guarded by PRAGMA table_info, so it is
    // idempotent and an existing store keeps its state.
    this.ensureColumns("ooo_probe_tasks", {
      // Durable pointer to the entry whose verdict accepted this artifact. `entry_id`
      // cannot serve that role: publishReady() clears it for tasks that are neither
      // selected nor live (to release the board's serial slot), while the verdict must
      // stay reachable. A pointer, not an authority — the verdict remains the authority.
      accepted_entry_id: "TEXT",
    });
    this.ensureColumns("ooo_probe_meta", {
      cancel_reason: "TEXT",
      cancelled_at: "TEXT",
    });
    this.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO ooo_probe_meta (id, run_id, policy) VALUES (1, ?, ?)")
        .run(randomUUID(), `${policy}:${digest(plan)}`);
      const meta = this.db.prepare("SELECT * FROM ooo_probe_meta WHERE id=1").get()!;
      if (meta.policy !== `${policy}:${digest(plan)}`)
        throw new Error("probe policy changed; use a new database");
      for (const [
        position,
        [id, input, dependencies, effect, event, operation],
      ] of plan.entries()) {
        const spec = patchTasks[id];
        this.db
          .prepare(
            "INSERT OR IGNORE INTO ooo_probe_tasks (id, revision, input, dependencies, position, effect, source_revision, observed_revision, wait_event, external_ready, operation, kind, patch_files, patch_editable) VALUES (?, 'v1', ?, ?, ?, ?, 'input-v1', 'input-v1', ?, ?, ?, ?, ?, ?)",
          )
          .run(
            id,
            spec ? spec.instruction : input,
            JSON.stringify(dependencies),
            position,
            effect,
            event,
            event ? 0 : 1,
            operation ?? "",
            spec ? "patch" : "snapshot",
            spec ? JSON.stringify(spec.files) : null,
            spec ? JSON.stringify(spec.editable) : null,
          );
      }
    });
    this.publishReady();
    this.runId = String(
      this.db.prepare("SELECT run_id FROM ooo_probe_meta WHERE id=1").get()!.run_id,
    );
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
    const row = this.db.prepare("SELECT * FROM ooo_probe_tasks WHERE id=?").get(id) as unknown as
      Row | undefined;
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

  private publish(kind: "handoff" | "decision", content: string): string {
    // The real board put owns its transaction. Recover a post-put/pre-link crash by adopting
    // the existing publication instead of creating another message — but only while it is still
    // open: a *resolved* publication with the same content is a finished handoff, and adopting
    // it would link the row to an entry nobody can claim.
    const existing = this.db
      .prepare(
        "SELECT id FROM task_board_entries WHERE task_id=? AND agent_id='coordinator' AND kind=? AND content=? AND status='open' ORDER BY id LIMIT 1",
      )
      .get(channel, kind, content);
    if (existing) return String(existing.id);
    return this.putTaskBoardEntry({
      taskId: channel,
      agentId: "coordinator",
      kind,
      content,
      expiresAt: new Date(this.now + 86_400_000).toISOString(),
    }).id;
  }

  private publishReady(): void {
    // Pending publications are derived from durable rows: a tiny transactional
    // outbox, drained by this single daemon after commit and on restart/retry.
    const delivered = this.db
      .prepare("SELECT * FROM ooo_probe_tasks WHERE artifact IS NOT NULL ORDER BY id")
      .all() as unknown as Row[];
    for (const row of delivered)
      this.publish(
        "decision",
        JSON.stringify({ id: row.id, attempt: row.attempt, artifact: row.artifact }),
      );
    // A published handoff for a task that is no longer the selected one must give the board's
    // serial slot back. The plan can move past it (a waiting task became ready first, which is
    // exactly what ordered execution does), and an unclaimed, unselected handoff would then
    // block every later claim in the round. Nothing is fenced here: no ticket exists for a task
    // nobody claimed, so only the publication is retired.
    const selected = this.next();
    for (const row of this.db
      .prepare("SELECT * FROM ooo_probe_tasks WHERE entry_id IS NOT NULL ORDER BY id")
      .all() as unknown as Row[]) {
      if (row.id === selected || this.live(row)) continue;
      try {
        this.resolveTaskBoardEntry({
          taskId: channel,
          entryId: row.entry_id!,
          agentId: "coordinator",
          resolution: "no longer the selected task",
        });
      } catch {
        // Already resolved or expired: the slot is free either way.
      }
      this.db.prepare("UPDATE ooo_probe_tasks SET entry_id=NULL WHERE id=?").run(row.id);
    }
    const rows = this.db
      .prepare("SELECT * FROM ooo_probe_tasks WHERE entry_id IS NULL ORDER BY id")
      .all() as unknown as Row[];
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
      );
      this.db.prepare("UPDATE ooo_probe_tasks SET entry_id=? WHERE id=?").run(entryId, row.id);
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
          "SELECT 1 FROM ooo_probe_checks c JOIN ooo_probe_tasks t ON c.task_id=t.id WHERE t.wait_event=?",
        )
        .get(event)
    )
      throw new Error("managed check requires bound terminal evidence");
    const changed = this.db
      .prepare("UPDATE ooo_probe_tasks SET external_ready=1 WHERE wait_event=?")
      .run(event);
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
        .prepare("SELECT ticket FROM ooo_probe_checks WHERE task_id=?")
        .get(id);
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
        checkId: digest([id, attempt]).slice(0, 32),
        attempt,
        inputDigest: this.inputDigest(row),
        owner,
        expiresAt: this.now + 60_000,
      });
      this.db
        .prepare("INSERT OR REPLACE INTO ooo_probe_checks VALUES (?, ?, NULL, 0)")
        .run(id, JSON.stringify(ticket));
      return ticket;
    });
  }

  cancelCheck(ticket: CheckTicket): boolean {
    return this.transaction(() => {
      const current = this.checkRecord(ticket);
      if (!current || current.terminal !== null || current.cancelled) return false;
      this.db.prepare("UPDATE ooo_probe_checks SET cancelled=1 WHERE task_id=?").run(ticket.taskId);
      return true;
    });
  }

  private checkRecord(ticket: CheckTicket) {
    const record = this.db
      .prepare("SELECT * FROM ooo_probe_checks WHERE task_id=?")
      .get(ticket.taskId);
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
        .prepare("UPDATE ooo_probe_checks SET terminal=? WHERE task_id=?")
        .run(terminal, row.id);
      // Unknown completion is not evidence that the wait resolved.
      if (result.outcome !== "undecidable")
        this.db.prepare("UPDATE ooo_probe_tasks SET external_ready=1 WHERE id=?").run(row.id);
      return "accepted";
    });
    this.publishReady();
    return verdict;
  }

  observeRevision(id: string, revision: string): void {
    if (!revision.trim()) throw new Error("revision required");
    this.row(id);
    this.db.prepare("UPDATE ooo_probe_tasks SET observed_revision=? WHERE id=?").run(revision, id);
    this.publishReady();
  }

  next(): string | null {
    // A cancelled round selects nothing: the successor is not "the next task", it is
    // the explicit terminal decision the caller asked for.
    if (this.cancelled() !== null) return null;
    const rows = this.db
      .prepare("SELECT * FROM ooo_probe_tasks ORDER BY position")
      .all() as unknown as Row[];
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
        taskId: channel,
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
      this.db
        .prepare(
          "UPDATE ooo_probe_tasks SET attempt=?, owner=?, claim_time=?, input_digest=? WHERE id=?",
        )
        .run(attempt, agentId, entry.claimedAt, inputDigest, id);
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
    const entry = row.entry_id ? this.getTaskBoardEntryById(channel, row.entry_id) : null;
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
    await this.afterCommit();
    this.publishReady();
    return verdict;
  }

  /** The submitted board entry, validated as data and bound to the task it names. A
   *  string result is the verdict of that validation, not an error. */
  private readSubmission(
    resultId: string,
  ): { ticket: BoardTicket; artifact: string; row: Row } | "rejected" | "stale" {
    const result = this.getTaskBoardEntryById(channel, resultId);
    if (
      !result ||
      result.taskId !== channel ||
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
      this.db.prepare("UPDATE ooo_probe_tasks SET artifact=? WHERE id=?").run(commit, row.id);
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
        taskId: channel,
        entryId: row.entry_id!,
        agentId: ticket.owner,
        digest: artifactDigest(commit),
        summary: "host-verified artifact for this attempt",
        now,
      });
      this.judgeTaskBoardEntry({
        taskId: channel,
        entryId: row.entry_id!,
        agentId: "coordinator",
        verdict: "accepted",
        reason: "host verification accepted this artifact",
        now,
      });
      this.db
        .prepare("UPDATE ooo_probe_tasks SET accepted_entry_id=? WHERE id=?")
        .run(row.entry_id!, row.id);
      this.resolveTaskBoardEntry({
        taskId: channel,
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
  private acceptedArtifacts(): Record<string, string> {
    const rows = this.db
      .prepare(
        `SELECT t.id AS id, t.artifact AS artifact, t.source_revision AS source_revision,
                t.observed_revision AS observed_revision, e.verdict AS verdict,
                e.judged_digest AS judged_digest
         FROM ooo_probe_tasks t
         LEFT JOIN task_board_entries e ON e.id = t.accepted_entry_id
         WHERE t.artifact IS NOT NULL
         ORDER BY t.id`,
      )
      .all();
    const cancelled = this.cancelled() !== null;
    const accepted: Record<string, string> = {};
    for (const row of rows) {
      const commit = String(row.artifact);
      if (
        !acceptedFact({
          artifact: commit,
          digest: artifactDigest(commit),
          verdict: row.verdict === null ? null : String(row.verdict),
          judgedDigest: row.judged_digest === null ? null : String(row.judged_digest),
          currentRevision: row.source_revision === row.observed_revision,
          cancelled,
        })
      )
        continue;
      accepted[String(row.id)] = commit;
    }
    return accepted;
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
        .prepare("SELECT * FROM ooo_probe_tasks ORDER BY position")
        .all() as unknown as Row[])
        this.fenceRow(row, withdrawn);
      this.db.prepare("UPDATE ooo_probe_checks SET terminal='cancelled', cancelled=1").run();
      this.db
        .prepare("UPDATE ooo_probe_meta SET cancel_reason=?, cancelled_at=? WHERE id=1")
        .run(reason.slice(0, 1_000), new Date(this.now).toISOString());
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
          taskId: channel,
          entryId: row.entry_id,
          agentId: "coordinator",
          resolution,
        });
      } catch {
        // Already resolved or expired: nothing to withdraw.
      }
    if (row.artifact !== null || row.owner !== null) dropped.push(row.id);
    this.db
      .prepare(
        "UPDATE ooo_probe_tasks SET artifact=NULL, attempt=attempt+1, owner=NULL, claim_time=NULL, external_ready=0, entry_id=NULL WHERE id=?",
      )
      .run(row.id);
  }

  /** The round's terminal reason, or null while it is still running. */
  cancelled(): string | null {
    const meta = this.db.prepare("SELECT * FROM ooo_probe_meta WHERE id=1").get() as
      { cancel_reason?: string | null } | undefined;
    return meta?.cancel_reason ?? null;
  }

  /** Explicit terminal decision for a check that never reported: otherwise a wait only
   *  ends by accident (lease expiry), which is an infinite wait with a clock attached.
   *  Idempotent, and bound to the issued ticket: an impostor cannot end a wait. */
  abandonCheck(ticket: CheckTicket, reason: string): boolean {
    const decided = this.transaction(() => {
      const current = this.checkRecord(ticket);
      if (!current || current.terminal !== null) return false;
      this.db
        .prepare("UPDATE ooo_probe_checks SET terminal='undecidable', cancelled=1 WHERE task_id=?")
        .run(ticket.taskId);
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
        .prepare("SELECT * FROM ooo_probe_tasks ORDER BY position")
        .all() as unknown as Row[];
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
              taskId: channel,
              entryId: row.entry_id,
              agentId: "coordinator",
              resolution: "invalidated by reopen",
            });
          } catch {
            // Already resolved or expired: nothing to withdraw.
          }
        this.db
          .prepare(
            "UPDATE ooo_probe_tasks SET artifact=NULL, attempt=attempt+1, owner=NULL, claim_time=NULL, external_ready=0, entry_id=NULL WHERE id=?",
          )
          .run(taskId);
      }
    });
    this.publish("decision", `reopen ${invalidated.join(",")}: ${reason}`.slice(0, 1_000));
    this.publishReady();
    return invalidated;
  }
}
