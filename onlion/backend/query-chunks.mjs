/** Query chunking for embedding.
 *
 * An embedding model only sees its own token window, so a very long query
 * embedded as one string keeps the opening and silently drops the rest — the
 * request would succeed while ranking on a fraction of the question. Payload
 * caps are sized to the platform body (see `MAX_QUERY_CHARS` in `worker.mjs`), so
 * a long query is legitimate input that still has to produce a usable vector.
 *
 * Split the text into bounded windows, embed every window, and pool them into a
 * single unit-length vector, so one long query still yields one query vector and
 * the ranking path stays unchanged. Short queries take the unchanged single-chunk
 * path: `splitQueryChunks` returns exactly one chunk and pooling is skipped.
 *
 * The window budget is deliberately finite. Lexical retrieval always sees the
 * whole text, so a tail beyond the budget is still matched by terms; only its
 * dense contribution is dropped, which is stated here rather than left implicit.
 */

export const QUERY_CHUNK_CHARS = 2000;
export const MAX_QUERY_CHUNKS = 8;

/** Prefer a paragraph, sentence, or clause boundary in the second half of the
 *  window, so a chunk does not end mid-sentence when a boundary is available. */
function boundaryBefore(window) {
  const candidates = [
    window.lastIndexOf("\n"),
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
    window.lastIndexOf("。"),
    window.lastIndexOf("；"),
    window.lastIndexOf("，"),
  ].filter((index) => index > 0);
  const best = Math.max(-1, ...candidates);
  return best > window.length / 2 ? best + 1 : window.length;
}

/** Bounded, non-overlapping windows covering the head of the query. */
export function splitQueryChunks(text, options = {}) {
  const limit = options.maxChunks ?? MAX_QUERY_CHUNKS;
  const size = options.chunkChars ?? QUERY_CHUNK_CHARS;
  if (text.length <= size) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length && chunks.length < limit) {
    const remaining = text.length - start;
    if (chunks.length === limit - 1) {
      // Last window: take the rest of the budget, not everything, so one long
      // query cannot turn into an unbounded embedding request.
      chunks.push(text.slice(start, start + Math.min(size, remaining)));
      break;
    }
    const window = text.slice(start, Math.min(start + size, text.length));
    const cut = boundaryBefore(window);
    chunks.push(text.slice(start, start + cut));
    start += cut;
  }
  return chunks;
}

/** Unit-length mean of the chunk vectors. Embedding vectors are stored
 *  normalized, so the pooled query must be normalized too or cosine ranking
 *  would shift with the number of chunks. */
export function poolQueryVectors(vectors) {
  const first = vectors[0];
  if (!first) throw new Error("poolQueryVectors requires at least one vector");
  const dims = first.length;
  const pooled = new Array(dims).fill(0);
  for (const vector of vectors) {
    if (vector.length !== dims) throw new Error("chunk vectors must share a dimension");
    for (let i = 0; i < dims; i += 1) pooled[i] += vector[i];
  }
  let norm = 0;
  for (let i = 0; i < dims; i += 1) {
    pooled[i] /= vectors.length;
    norm += pooled[i] * pooled[i];
  }
  norm = Math.sqrt(norm);
  if (!norm) return pooled;
  for (let i = 0; i < dims; i += 1) pooled[i] /= norm;
  return pooled;
}
