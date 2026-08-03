import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { encodeVector, parseVector } from "../../src/core/store/vector-codec.ts";

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

type InputKind = "document" | "query";

interface CacheRow {
  vector_blob: Uint8Array;
}

interface EmbeddingClient {
  readonly indexId: string;
  embedQueries(inputs: string[]): Promise<number[][]>;
  embedDocuments(inputs: string[]): Promise<number[][]>;
}

export class CachedOmniEmbeddingClient implements EmbeddingClient {
  readonly indexId: string;
  readonly #delegate: EmbeddingClient;
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(databasePath: string, delegate: EmbeddingClient) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#delegate = delegate;
    this.indexId = delegate.indexId;
    this.#db = new DatabaseSync(databasePath);
    // Parallel bridge workers open the same cache file and their CREATE TABLE
    // IF NOT EXISTS can collide on SQLite's schema lock (SQLITE_BUSY on DDL is
    // immediate, busy_timeout does not cover it). Retry the init DDL a few
    // times so a transient peer holds never fails the whole search.
    const init = `
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS embedding_cache (
        index_id TEXT NOT NULL,
        input_kind TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        vector_blob BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (index_id, input_kind, text_hash)
      );
    `;
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.#db.exec(init);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        sleep(250);
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  embedQueries(inputs: string[]): Promise<number[][]> {
    return this.#embed("query", inputs, (missing) => this.#delegate.embedQueries(missing));
  }

  embedDocuments(inputs: string[]): Promise<number[][]> {
    return this.#embed("document", inputs, (missing) => this.#delegate.embedDocuments(missing));
  }

  async #embed(
    kind: InputKind,
    inputs: string[],
    fetchMissing: (inputs: string[]) => Promise<number[][]>,
  ): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const read = this.#db.prepare(
      "SELECT vector_blob FROM embedding_cache WHERE index_id = ? AND input_kind = ? AND text_hash = ?",
    );
    const vectors = new Map<string, number[]>();
    const missingByHash = new Map<string, string>();
    for (const input of inputs) {
      const hash = textHash(input);
      const row = read.get(this.indexId, kind, hash) as CacheRow | undefined;
      if (row) vectors.set(hash, parseVector(row.vector_blob));
      else missingByHash.set(hash, input);
    }

    const missing = [...missingByHash.entries()];
    if (missing.length > 0) {
      const fetched = await fetchMissing(missing.map(([, input]) => input));
      if (fetched.length !== missing.length) {
        throw new Error(`embedding provider returned ${fetched.length} vectors for ${missing.length} inputs`);
      }
      const insert = this.#db.prepare(
        `INSERT OR IGNORE INTO embedding_cache
         (index_id, input_kind, text_hash, vector_blob, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const createdAt = new Date().toISOString();
      for (const [index, [hash]] of missing.entries()) {
        const vector = fetched[index]!;
        insert.run(this.indexId, kind, hash, encodeVector(vector), createdAt);
        vectors.set(hash, vector);
      }
    }
    return inputs.map((input) => vectors.get(textHash(input))!);
  }
}

function textHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
