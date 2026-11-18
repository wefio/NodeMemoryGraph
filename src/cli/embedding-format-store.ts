import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EmbeddingFormatRecord,
  EmbeddingFormatStore,
} from "../core/embedding-providers/formats.ts";

/** Each capability has its own atomically replaced file for concurrent local processes. */
export function localEmbeddingFormatStore(dataDirectory: string): EmbeddingFormatStore {
  const directory = join(dataDirectory, "embedding-formats");
  return {
    read(key) {
      try {
        const record: unknown = JSON.parse(readFileSync(join(directory, key + ".json"), "utf8"));
        return isFormatRecord(record) ? record : undefined;
      } catch {
        return undefined;
      }
    },
    write(key, record) {
      const path = join(directory, key + ".json");
      const temporary = path + "." + randomUUID();
      try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n", {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        renameSync(temporary, path);
      } catch {
        // A local capability cache cannot make an embedding request fail.
        try {
          rmSync(temporary, { force: true });
        } catch {
          // The process still has its in-memory format decision.
        }
      }
    },
  };
}

const JSON_REASONS = new Set([
  "native-json",
  "field-rejected",
  "numeric-response",
  "invalid-base64",
  "different-vectors",
]);

function isFormatRecord(value: unknown): value is EmbeddingFormatRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.endpointOrigin !== "string" ||
    typeof record.model !== "string" ||
    (record.purpose !== "query" && record.purpose !== "document") ||
    typeof record.checkedAt !== "number" ||
    !Number.isFinite(record.checkedAt) ||
    record.checkedAt > Date.now()
  )
    return false;
  if (record.format === "json") return JSON_REASONS.has(String(record.reason));
  return (
    record.format === "base64-f32le" &&
    record.reason === "verified" &&
    typeof record.dimensions === "number" &&
    Number.isSafeInteger(record.dimensions) &&
    record.dimensions > 0
  );
}
