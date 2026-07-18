import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { ExternalEmbedding } from "./types.ts";

interface SearchMatches {
  keys: BigUint64Array;
  distances: Float32Array;
}

interface NativeIndex {
  add(keys: BigUint64Array, vectors: Float32Array): void;
  search(vector: Float32Array, count: number): SearchMatches;
  save(path: string): void;
  load(path: string): void;
}

interface NativeIndexConstructor {
  new(options: Record<string, unknown>): NativeIndex;
}

const require = createRequire(import.meta.url);
const { Index } = require("usearch") as { Index: NativeIndexConstructor };

export interface AnnBuildResult {
  count: number;
  dimensions: number;
  model: string;
}

export class UsearchAnnIndex {
  readonly indexPath: string;
  readonly metadataPath: string;
  #loaded: { index: NativeIndex; dimensions: number; memoryIds: string[] } | null = null;

  constructor(indexPath: string) {
    this.indexPath = indexPath;
    this.metadataPath = `${indexPath}.json`;
  }

  build(model: string, rows: ExternalEmbedding[]): AnnBuildResult {
    return this.buildBatches(model, [rows]);
  }

  buildBatches(model: string, batches: Iterable<ExternalEmbedding[]>): AnnBuildResult {
    const iterator = batches[Symbol.iterator]();
    let current = iterator.next();
    while (!current.done && current.value.length === 0) current = iterator.next();
    const dimensions = current.done ? 0 : current.value[0]?.vector.length ?? 0;
    if (dimensions === 0) {
      throw new Error("ANN build requires consistent non-empty vectors");
    }
    mkdirSync(dirname(this.indexPath), { recursive: true });
    const index = new Index({
      metric: "cos",
      quantization: "f32",
      dimensions,
      connectivity: 16,
      expansion_add: 128,
      expansion_search: 64,
    });
    const memoryIds: string[] = [];
    while (!current.done) {
      const rows = current.value;
      if (rows.some((row) => row.vector.length !== dimensions)) {
        throw new Error("ANN build requires consistent non-empty vectors");
      }
      const keys = new BigUint64Array(rows.length);
      const vectors = new Float32Array(rows.length * dimensions);
      rows.forEach((row, rowIndex) => {
        keys[rowIndex] = BigInt(memoryIds.length + rowIndex + 1);
        vectors.set(row.vector, rowIndex * dimensions);
      });
      index.add(keys, vectors);
      memoryIds.push(...rows.map((row) => row.memoryId));
      current = iterator.next();
    }
    const temporaryIndex = `${this.indexPath}.tmp`;
    const temporaryMetadata = `${this.metadataPath}.tmp`;
    index.save(temporaryIndex);
    writeFileSync(temporaryMetadata, JSON.stringify({
      model,
      dimensions,
      memoryIds,
    }));
    renameSync(temporaryIndex, this.indexPath);
    renameSync(temporaryMetadata, this.metadataPath);
    this.#loaded = { index, dimensions, memoryIds };
    return { count: memoryIds.length, dimensions, model };
  }

  search(vector: readonly number[], count: number): string[] {
    if (!this.#loaded) {
      const metadata = JSON.parse(readFileSync(this.metadataPath, "utf8")) as {
        model: string;
        dimensions: number;
        memoryIds: string[];
      };
      const index = new Index({ dimensions: metadata.dimensions, metric: "cos" });
      index.load(this.indexPath);
      this.#loaded = { index, dimensions: metadata.dimensions, memoryIds: metadata.memoryIds };
    }
    const loaded = this.#loaded;
    if (vector.length !== loaded.dimensions) {
      throw new Error(`query has ${vector.length} dimensions; index expects ${loaded.dimensions}`);
    }
    const matches = loaded.index.search(
      new Float32Array(vector), Math.min(count, loaded.memoryIds.length));
    return [...matches.keys].map((key) => loaded.memoryIds[Number(key) - 1]!).filter(Boolean);
  }
}
