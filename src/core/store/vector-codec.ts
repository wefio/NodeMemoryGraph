/**
 * Encoding and decoding of embedding vectors stored in SQLite.
 *
 * Vectors are persisted twice during the ongoing migration to binary storage:
 * `vector_blob` (little-endian float32, compact and fast) and legacy
 * `vector_json`. Readers prefer the blob and fall back to JSON, so rows written
 * before the binary column existed stay readable.
 *
 * Shared by the schema migration and the store itself, so it lives outside both.
 */

type Row = Record<string, string | number | Uint8Array | null>;

export function encodeVector(vector: readonly number[]): Buffer {
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

/** Read a vector from a row, preferring the binary column over legacy JSON. */
export function storedVector(row: Row, prefix = ""): number[] {
  const blob = row[`${prefix}vector_blob`];
  return blob instanceof Uint8Array
    ? parseVector(blob)
    : parseVector(row[`${prefix}vector_json`] as string | undefined);
}

/**
 * Decode either storage form. Returns an empty vector for absent or malformed
 * values rather than throwing: a corrupt embedding should degrade retrieval
 * quality, not break the read path.
 */
export function parseVector(value: string | number | Uint8Array | null | undefined): number[] {
  if (value instanceof Uint8Array) {
    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const vector: number[] = [];
    for (let offset = 0; offset + 4 <= buffer.byteLength; offset += 4) {
      vector.push(buffer.readFloatLE(offset));
    }
    return vector;
  }
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
      : [];
  } catch {
    return [];
  }
}
