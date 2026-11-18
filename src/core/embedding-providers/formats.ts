import { createHash } from "node:crypto";
import { EmbeddingHttpError } from "./http.ts";

export type EmbeddingPurpose = "query" | "document";
export type EmbeddingStorageVector = number[] | Float32Array;

type JsonReason =
  "native-json" | "field-rejected" | "numeric-response" | "invalid-base64" | "different-vectors";
type FormatDecision =
  | { format: "json"; reason: JsonReason }
  | { format: "base64-f32le"; reason: "verified"; dimensions: number };
export type EmbeddingFormatRecord = FormatDecision & {
  endpointOrigin: string;
  model: string;
  purpose: EmbeddingPurpose;
  checkedAt: number;
};

export interface EmbeddingFormatStore {
  read(key: string): EmbeddingFormatRecord | undefined;
  write(key: string, record: EmbeddingFormatRecord): void;
}

export type OpenAIEmbeddingRow = { index: number; embedding: number[] | string };
type LoadRows = (base64: boolean) => Promise<OpenAIEmbeddingRow[]>;
type FormatScope = {
  endpoint: string;
  model: string;
  indexId: string;
  credential?: string;
  dimensions?: number;
};
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export function embeddingFormats(
  store: EmbeddingFormatStore | undefined,
  scope: FormatScope,
): EmbeddingFormats | undefined {
  return store ? new EmbeddingFormats(store, scope) : undefined;
}

export class EmbeddingFormats {
  private readonly keyPrefix: string;
  private readonly origin: string;
  private readonly store: EmbeddingFormatStore;
  private readonly model: string;
  private readonly configuredDimensions?: number;
  private readonly records = new Map<EmbeddingPurpose, EmbeddingFormatRecord | undefined>();
  private readonly probing = new Set<EmbeddingPurpose>();

  constructor(store: EmbeddingFormatStore, scope: FormatScope) {
    const url = new URL(scope.endpoint);
    this.store = store;
    this.model = scope.model;
    this.configuredDimensions = scope.dimensions;
    this.origin = url.origin;
    this.keyPrefix = createHash("sha256")
      .update(
        JSON.stringify([
          "embedding-format-v1",
          url.href,
          scope.model,
          scope.indexId,
          scope.credential ?? "",
        ]),
      )
      .digest("hex");
  }

  noteNativeJson(purpose: EmbeddingPurpose): void {
    if (!this.get(purpose)) this.record(purpose, { format: "json", reason: "native-json" });
  }

  async load(
    purpose: EmbeddingPurpose,
    rows: LoadRows,
    canProbe: boolean,
    signal?: AbortSignal,
  ): Promise<EmbeddingStorageVector[]> {
    const known = this.get(purpose);
    if (known?.format === "base64-f32le")
      return this.tryBase64(purpose, rows, known.dimensions, signal);
    if (known || !canProbe || this.probing.has(purpose)) return numericVectors(await rows(false));

    this.probing.add(purpose);
    try {
      return await this.tryBase64(purpose, rows, undefined, signal);
    } finally {
      this.probing.delete(purpose);
    }
  }

  private async tryBase64(
    purpose: EmbeddingPurpose,
    load: LoadRows,
    confirmedDimensions: number | undefined,
    signal?: AbortSignal,
  ): Promise<EmbeddingStorageVector[]> {
    let rows: OpenAIEmbeddingRow[];
    try {
      rows = await load(true);
    } catch (error) {
      signal?.throwIfAborted();
      if (!rejectsEncoding(error)) throw error;
      return this.fallback(purpose, load, "field-rejected", signal);
    }
    signal?.throwIfAborted();
    if (rows.every((row) => Array.isArray(row.embedding))) {
      const vectors = numericVectors(rows);
      this.record(purpose, { format: "json", reason: "numeric-response" });
      return vectors;
    }
    const packed = packedVectors(rows, confirmedDimensions ?? this.configuredDimensions);
    if (!packed) return this.fallback(purpose, load, "invalid-base64", signal);
    if (confirmedDimensions !== undefined) return packed;

    const numeric = numericVectors(await load(false));
    signal?.throwIfAborted();
    if (!sameNumbers(packed, numeric, purpose)) {
      this.record(purpose, { format: "json", reason: "different-vectors" });
      return numeric;
    }
    this.record(purpose, {
      format: "base64-f32le",
      reason: "verified",
      dimensions: packed[0]!.length,
    });
    return packed;
  }

  private async fallback(
    purpose: EmbeddingPurpose,
    load: LoadRows,
    reason: JsonReason,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const numeric = numericVectors(await load(false));
    signal?.throwIfAborted();
    this.record(purpose, { format: "json", reason });
    return numeric;
  }

  private get(purpose: EmbeddingPurpose): EmbeddingFormatRecord | undefined {
    if (!this.records.has(purpose)) this.records.set(purpose, this.store.read(this.key(purpose)));
    const record = this.records.get(purpose);
    if (!record || Date.now() - record.checkedAt >= FRESH_MS) return undefined;
    if (
      record.purpose !== purpose ||
      record.endpointOrigin !== this.origin ||
      record.model !== this.model
    )
      return undefined;
    return record;
  }

  private record(purpose: EmbeddingPurpose, decision: FormatDecision): void {
    const record = {
      ...decision,
      endpointOrigin: this.origin,
      model: this.model,
      purpose,
      checkedAt: Date.now(),
    };
    this.records.set(purpose, record);
    this.store.write(this.key(purpose), record);
  }

  private key(purpose: EmbeddingPurpose): string {
    return `${this.keyPrefix}-${purpose}`;
  }
}

export function numericVectors(rows: OpenAIEmbeddingRow[]): number[][] {
  return rows.map(({ embedding }) => {
    if (!Array.isArray(embedding)) throw new Error("Expected a JSON embedding array");
    return embedding;
  });
}

function rejectsEncoding(error: unknown): boolean {
  return (
    error instanceof EmbeddingHttpError &&
    (error.status === 400 || error.status === 422) &&
    /encoding_format/i.test(error.message) &&
    /unsupported|not supported|unrecognized|unknown|unexpected|invalid|extra_forbidden|not permitted|not allowed/i.test(
      error.message,
    )
  );
}

function packedVectors(
  rows: OpenAIEmbeddingRow[],
  dimensions?: number,
): Float32Array[] | undefined {
  const vectors: Float32Array[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.index !== index || typeof row.embedding !== "string") return undefined;
    const vector = decodeBase64(row.embedding);
    dimensions ??= vector?.length;
    if (!vector || vector.length !== dimensions) return undefined;
    vectors.push(vector);
  }
  return vectors.length ? vectors : undefined;
}

function decodeBase64(value: string): Float32Array | undefined {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length % FLOAT_BYTES !== 0) return undefined;
  const dimensions = bytes.length / FLOAT_BYTES;
  const vector =
    LITTLE_ENDIAN && bytes.byteOffset % FLOAT_BYTES === 0
      ? new Float32Array(bytes.buffer, bytes.byteOffset, dimensions)
      : Float32Array.from({ length: dimensions }, (_, index) =>
          bytes.readFloatLE(index * FLOAT_BYTES),
        );
  return vector.every(Number.isFinite) ? vector : undefined;
}

function sameNumbers(
  packed: Float32Array[],
  numeric: number[][],
  purpose: EmbeddingPurpose,
): boolean {
  const expected = purpose === "document" ? Math.fround : (value: number) => value;
  return packed.every((vector, index) => {
    const row = numeric[index];
    return (
      row?.length === vector.length &&
      vector.every((value, column) => Object.is(value, expected(row[column]!)))
    );
  });
}
