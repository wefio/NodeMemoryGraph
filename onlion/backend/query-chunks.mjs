/** Query chunking for embedding.
 *
 * An embedding model only sees its own token window, so a very long query
 * embedded as one string keeps the opening and silently drops the rest — the
 * request would succeed while ranking on a fraction of the question. Payload caps
 * are sized to the platform body (see `MAX_QUERY_CHARS` in `worker.mjs`), so a
 * long query is legitimate input that still has to be searchable.
 *
 * `splitQueryChunks` returns bounded windows that always cover both ends of the
 * text: the first `limit - 1` windows walk forward from the start, and the final
 * window is anchored at the end. Without that anchor the windows only reach
 * `limit * size` characters (8 x 2,000 = 16,000) and anything past it was never
 * searched at all, so a query whose informative part sat at the very end was
 * invisible regardless of how the feature budget was spent. The middle of a very
 * long query is still skipped — that is the bounded cost, and it is the least
 * informative of the three regions.
 *
 * `poolQueryVectors` remains for callers that need one vector per query. The
 * worker does not use it: measuring mean pooling against per-feature maximum
 * showed pooling loses recall whenever the query's parts point in different
 * directions, so the worker searches head and windows as separate features.
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

/** First boundary inside a window, so an end-anchored window does not begin
 *  mid-sentence when a boundary appears early in it. */
function firstBoundary(window) {
  const candidates = [
    window.indexOf("\n"),
    window.indexOf(". "),
    window.indexOf("? "),
    window.indexOf("! "),
    window.indexOf("。"),
    window.indexOf("；"),
    window.indexOf("，"),
  ].filter((index) => index > 0);
  const best = candidates.length === 0 ? -1 : Math.min(...candidates);
  return best > 0 && best < window.length / 2 ? best + 1 : 0;
}

/** Bounded, non-overlapping windows covering the head and the tail of the text. */
export function splitQueryChunks(text, options = {}) {
  const limit = options.maxChunks ?? MAX_QUERY_CHUNKS;
  const size = options.chunkChars ?? QUERY_CHUNK_CHARS;
  if (text.length <= size) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length && chunks.length < Math.max(1, limit - 1)) {
    // A sliver is not worth its own retrieval pass: fold it into the window just
    // closed rather than spending a feature on a few dozen characters.
    if (chunks.length > 0 && text.length - start <= size / 4) {
      chunks[chunks.length - 1] += text.slice(start);
      break;
    }
    const window = text.slice(start, Math.min(start + size, text.length));
    const cut = boundaryBefore(window);
    chunks.push(text.slice(start, start + cut));
    start += cut;
  }
  if (start >= text.length) return chunks;
  // A sliver is not worth its own retrieval pass: fold it into the previous
  // window instead of spending a feature on a few dozen characters.
  if (text.length - start < size / 4) {
    chunks[chunks.length - 1] += text.slice(start);
    return chunks;
  }
  const tail = text.slice(Math.max(0, text.length - size));
  const from = firstBoundary(tail);
  chunks.push(from > 0 ? tail.slice(from) : tail);
  return chunks;
}

/** Unit-length mean of the chunk vectors. Embedding vectors are stored
 *  normalized, so a pooled query must be normalized too or cosine ranking would
 *  shift with the number of chunks. */
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
