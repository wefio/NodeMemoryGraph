import type { MemoryBackend } from "./backend.ts";

export type MemoryBackendOptions =
  | { kind: "sqlite"; path: string; namespace: string }
  | { kind: "lancedb"; uri: string; namespace: string; storageOptions?: Record<string, string> };

/** Lazy imports keep native Lance and node:sqlite out of the other backend's runtime. */
export async function openMemoryBackend(options: MemoryBackendOptions): Promise<MemoryBackend> {
  if (options.kind === "sqlite") {
    const { SqliteMemoryBackend } = await import("./sqlite-backend.ts");
    return new SqliteMemoryBackend(options.path, options.namespace);
  }
  if (options.kind === "lancedb") {
    const { LanceMemoryBackend } = await import("./lance-backend.ts");
    return LanceMemoryBackend.open(options.uri, options.namespace, options.storageOptions);
  }
  throw new Error("Unsupported memory backend");
}
