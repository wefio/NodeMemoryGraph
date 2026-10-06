import type { DatabaseSync } from "node:sqlite";

/** Default Task-Unit declaration storage, not the board's coordination header. */
export const TASK_UNIT_DECLARATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_run_tasks (
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    revision TEXT NOT NULL,
    input TEXT NOT NULL,
    dependencies TEXT NOT NULL,
    effect TEXT NOT NULL,
    wait_event TEXT,
    operation TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'snapshot',
    patch_files TEXT,
    patch_editable TEXT,
    PRIMARY KEY (run_id, task_id)
  );
`;

export interface TaskUnitDeclaration {
  taskId: string;
  position: number;
  revision: string;
  input: string;
  dependencies: string[];
  effect: string;
  waitEvent: string | null;
  operation: string;
  kind: string;
  patchFiles: string[] | null;
  patchEditable: string[] | null;
}

export interface TaskUnitDeclarationInput {
  runId: string;
  taskId: string;
  position: number;
  revision: string;
  input: string;
  dependencies: readonly string[];
  effect: string;
  waitEvent?: string | null;
  operation?: string;
  kind?: string;
  patchFiles?: readonly string[] | null;
  patchEditable?: readonly string[] | null;
}

type Row = Record<string, unknown>;

function declarationOf(input: TaskUnitDeclarationInput): TaskUnitDeclaration {
  return {
    taskId: input.taskId,
    position: input.position,
    revision: input.revision,
    input: input.input,
    dependencies: [...input.dependencies],
    effect: input.effect,
    waitEvent: input.waitEvent ?? null,
    operation: input.operation ?? "",
    kind: input.kind ?? "snapshot",
    patchFiles: input.patchFiles ? [...input.patchFiles] : null,
    patchEditable: input.patchEditable ? [...input.patchEditable] : null,
  };
}

function paths(value: unknown): string[] | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(String(value));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("invalid stored Task-Unit path list");
  }
  return parsed as string[];
}

function declarationFromRow(row: Row): TaskUnitDeclaration {
  return {
    taskId: String(row.task_id),
    position: Number(row.position),
    revision: String(row.revision),
    input: String(row.input),
    dependencies: paths(row.dependencies) ?? [],
    effect: String(row.effect),
    waitEvent: row.wait_event === null ? null : String(row.wait_event),
    operation: String(row.operation),
    kind: String(row.kind),
    patchFiles: paths(row.patch_files),
    patchEditable: paths(row.patch_editable),
  };
}

/** The caller owns the transaction; retries compare the entire authoritative definition. */
export function freezeTaskUnitDeclaration(db: DatabaseSync, input: TaskUnitDeclarationInput): void {
  if (!db.prepare("SELECT 1 FROM task_run_manifest WHERE run_id = ?").get(input.runId)) {
    throw new Error(`run ${input.runId} is not registered; a task cannot be frozen into it`);
  }
  const declaration = declarationOf(input);
  const existing = db
    .prepare("SELECT * FROM task_run_tasks WHERE run_id = ? AND task_id = ?")
    .get(input.runId, input.taskId);
  if (existing) {
    if (JSON.stringify(declarationFromRow(existing)) !== JSON.stringify(declaration)) {
      throw new Error(
        `run ${input.runId} already froze task ${input.taskId} with a different definition`,
      );
    }
    return;
  }
  db.prepare(
    "INSERT INTO task_run_tasks (run_id, task_id, position, revision, input, dependencies, effect, wait_event, operation, kind, patch_files, patch_editable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    input.runId,
    declaration.taskId,
    declaration.position,
    declaration.revision,
    declaration.input,
    JSON.stringify(declaration.dependencies),
    declaration.effect,
    declaration.waitEvent,
    declaration.operation,
    declaration.kind,
    declaration.patchFiles === null ? null : JSON.stringify(declaration.patchFiles),
    declaration.patchEditable === null ? null : JSON.stringify(declaration.patchEditable),
  );
}

export function readTaskUnitDeclarations(db: DatabaseSync, runId: string): TaskUnitDeclaration[] {
  return db
    .prepare("SELECT * FROM task_run_tasks WHERE run_id = ? ORDER BY position, task_id")
    .all(runId)
    .map(declarationFromRow);
}
