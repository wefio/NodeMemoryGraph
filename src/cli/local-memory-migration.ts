import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { SqliteMemoryBackend } from "../core/memory/sqlite-backend.ts";
import { hasLegacyMemoryTables } from "../core/memory/sqlite-legacy-retirement.ts";

export async function openLocalMemory(path: string, namespace: string) {
  const backend = new SqliteMemoryBackend(path, namespace);
  try {
    const backupPath = await activateWithBackup(path, backend);
    return { backend, backupPath };
  } catch (error) {
    await backend.close();
    throw error;
  }
}

async function activateWithBackup(path: string, backend: SqliteMemoryBackend) {
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    if (!hasLegacyMemoryTables(source)) {
      backend.activateLocal();
      return undefined;
    }
    const version = sqliteDataVersion(source);
    const copy = `${path}.before-unified-${randomUUID()}.sqlite`;
    await backup(source, copy);
    backend.activateLocal(() => {
      if (sqliteDataVersion(source) !== version)
        throw new Error(
          "SQLite changed while the legacy memory backup was being made. Retry migration.",
        );
    });
    return copy;
  } finally {
    source.close();
  }
}

function sqliteDataVersion(db: DatabaseSync) {
  return db.prepare("PRAGMA data_version").get()!.data_version;
}
