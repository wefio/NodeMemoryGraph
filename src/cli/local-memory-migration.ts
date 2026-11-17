import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { activatedLocalMemory, SqliteMemoryBackend } from "../core/memory/sqlite-backend.ts";

export async function openLocalMemory(path: string, namespace: string) {
  const backupPath = activatedLocalMemory(path) ? undefined : await backupLegacyMemory(path);
  const backend = new SqliteMemoryBackend(path, namespace);
  try {
    backend.activateLocal();
    return { backend, backupPath };
  } catch (error) {
    await backend.close();
    throw error;
  }
}

async function backupLegacyMemory(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    if (
      !source
        .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_records'")
        .get()
    )
      return undefined;
    const copy = `${path}.before-unified-${randomUUID()}.sqlite`;
    await backup(source, copy);
    return copy;
  } finally {
    source.close();
  }
}
