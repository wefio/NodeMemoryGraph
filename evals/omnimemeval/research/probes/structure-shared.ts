/** Shared plumbing for the structural-index probes.
 *
 * These three helpers are byte-identical in the graph and routing probes, which
 * each read the same baked vectors and normalise the same text. They live here so
 * a change to the vector file format or to normalisation cannot silently diverge
 * between probes that are compared against each other in the experiment record.
 */

import fs from "node:fs";

/** Read a `.ids.json` + `.vecs.f32` pair into id → vector. */
export function readVectors(stem: string): Map<string, Float32Array> {
  const ids = JSON.parse(fs.readFileSync(`${stem}.ids.json`, "utf8")) as string[];
  const buffer = fs.readFileSync(`${stem}.vecs.f32`);
  const flat = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  const dims = ids.length === 0 ? 0 : flat.length / ids.length;
  const map = new Map<string, Float32Array>();
  ids.forEach((id, i) => map.set(id, flat.subarray(i * dims, (i + 1) * dims)));
  return map;
}

export function centroidOf(vectors: readonly Float32Array[]): Float32Array {
  const dims = vectors[0]?.length ?? 0;
  const sum = new Float32Array(dims);
  for (const vector of vectors) for (let i = 0; i < dims; i += 1) sum[i]! += vector[i]!;
  const count = Math.max(1, vectors.length);
  for (let i = 0; i < dims; i += 1) sum[i]! /= count;
  return sum;
}

/** Lowercase, collapse whitespace. Gold matching compares these strings. */
export const norm = (value: unknown) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
