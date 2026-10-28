/** Query windowing for embedding.
 *
 * An embedding model only sees its own token window, so a long query embedded as
 * one string keeps the opening and silently drops the rest — the request would
 * succeed while ranking on a fraction of the question. Payload caps are sized to
 * the platform body (see `MAX_QUERY_CHARS` in `worker.mjs`), so a long query is
 * legitimate input that still has to be searchable.
 *
 * Two layouts, chosen by whether the budget covers the text:
 *
 *   n = min(ceil(L / W), MAX_QUERY_WINDOWS), W = QUERY_CHUNK_CHARS
 *
 *   L <= n*W   the budget covers the text: cut it into n equal, contiguous,
 *              disjoint segments that share one boundary-snapped cut point per
 *              seam. Nothing is dropped and nothing is embedded twice.
 *   L >  n*W   budget-bound: n windows of W, the first at the start and the last
 *              anchored at the end, with the uncovered text spread evenly between
 *              them. The middle is then sampled, not contiguous.
 *
 * Measured on 281 LoCoMo multi-hop questions against the previous layout (tile
 * forward from the start, then one end-anchored window): the previous layout left
 * a single contiguous blind block, and a question placed in the middle of the text
 * scored exactly what it scored with no splitting at all, while this layout found
 * it (36,000 characters: 4.63% vs 2.14% full-page coverage, 8W/0L, p=0.0078).
 * Equal segments also beat the forward tiling on the end-anchored condition once
 * the text was long enough, and never lost the opening.
 *
 * Windows are searched as separate features and fused by maximum. Mean pooling was
 * measured as losing recall whenever a query's parts point in different directions,
 * so nothing in the product pools them.
 */

export const QUERY_CHUNK_CHARS = 2000;
/** Windows one clause may be searched by. This is a ceiling, not an allocation:
 *  `selectQueryFeatures` still shares `MAX_QUERY_FEATURES` across clauses. */
export const MAX_QUERY_WINDOWS = 10;
/** Features one request may embed, across every clause. */
export const MAX_QUERY_FEATURES = 24;

const BOUNDARIES = ["\n", ". ", "? ", "! ", "。", "；", "，"];

/** Nearest boundary at or after `ideal`, bounded so a segment cannot swallow its
 *  neighbour. Shared between the two segments it separates, which is what keeps
 *  equal segmentation gap-free. */
function snapCut(text, ideal, previous, end) {
  const ceiling = Math.min(end - 1, ideal + 400);
  for (let at = Math.max(ideal, previous + 1); at <= ceiling; at += 1) {
    const slice = text.slice(at, at + 2);
    if (BOUNDARIES.some((boundary) => slice.startsWith(boundary))) return at + 1;
  }
  return Math.min(Math.max(ideal, previous + 1), ceiling);
}

/** Bounded, non-overlapping windows covering both ends of the text. */
export function planQueryWindows(text, options = {}) {
  const windowChars = options.windowChars ?? QUERY_CHUNK_CHARS;
  const maxWindows = options.maxWindows ?? MAX_QUERY_WINDOWS;
  const length = text.length;
  if (length <= windowChars) return [text];
  const count = Math.min(Math.ceil(length / windowChars), Math.max(2, maxWindows));
  if (length <= count * windowChars) {
    const cuts = [0];
    for (let index = 1; index < count; index += 1)
      cuts.push(snapCut(text, Math.round((index * length) / count), cuts[index - 1], length));
    cuts.push(length);
    return cuts
      .slice(1)
      .map((end, index) => text.slice(cuts[index], end))
      .filter((window) => window.length > 0);
  }
  const stride = (length - count * windowChars) / (count - 1) + windowChars;
  // Pinned ends: the opening is what the question usually states, and the tail is
  // where a question appended after a transcript sits.
  const startAt = (index) =>
    index === 0 ? 0 : index === count - 1 ? length - windowChars : Math.round(index * stride);
  return Array.from({ length: count }, (_unused, index) =>
    text.slice(startAt(index), startAt(index) + windowChars),
  );
}

/** The features to embed for each clause, in the order they should be spent.
 *
 * The first feature is the clause itself: the model's own token window sees the
 * opening with more context than any character window can, and measured
 * head-aligned recall depends on it. The first planned window is therefore
 * dropped — it covers the opening again, and dropping it measured identical to
 * keeping it on every condition at 6,000 and 36,000 characters (36,000:
 * 11.39% vs 11.03% on the head-aligned condition, 0 losses) while saving one
 * embedding call per clause.
 *
 * What remains is the end-anchored tail first, then the interior windows, shared
 * round-robin across clauses: a scarce feature budget buys both ends for every
 * clause before any clause gets a third window, and one very long clause cannot
 * starve the others. A clause that fits one window contributes one feature. */
export function selectQueryFeatures(
  queries,
  maxFeatures = MAX_QUERY_FEATURES,
  maxWindows = MAX_QUERY_WINDOWS,
) {
  const plans = queries.map((text) => planQueryWindows(text, { maxWindows }));
  const features = queries.map((text) => [text]);
  const pending = plans.map((windows) =>
    windows.length <= 1 ? [] : [windows[windows.length - 1], ...windows.slice(1, -1)],
  );
  const cursors = pending.map(() => 0);
  let remaining = Math.max(0, maxFeatures - features.length);
  let progressed = true;
  while (remaining > 0 && progressed) {
    progressed = false;
    for (let index = 0; index < pending.length && remaining > 0; index += 1) {
      const next = cursors[index];
      if (next >= pending[index].length) continue;
      cursors[index] = next + 1;
      features[index].push(pending[index][next]);
      remaining -= 1;
      progressed = true;
    }
  }
  return features;
}
