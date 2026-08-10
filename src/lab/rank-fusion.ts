export interface RankedRoute {
  ids: readonly string[];
  weight?: number;
}

export interface FusedRank {
  id: string;
  score: number;
  bestRank: number;
}

/** Weighted reciprocal-rank fusion. Routes are deduplicated before scoring. */
export function reciprocalRankFusion(
  routes: readonly RankedRoute[],
  limit: number,
  rankConstant = 60,
): FusedRank[] {
  const scores = new Map<string, FusedRank>();
  for (const route of routes) {
    const weight = Number.isFinite(route.weight) ? Math.max(0, route.weight ?? 1) : 1;
    const seen = new Set<string>();
    for (const [index, id] of route.ids.entries()) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const rank = index + 1;
      const current = scores.get(id) ?? { id, score: 0, bestRank: rank };
      current.score += weight / (Math.max(0, rankConstant) + rank);
      current.bestRank = Math.min(current.bestRank, rank);
      scores.set(id, current);
    }
  }
  return [...scores.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.bestRank - right.bestRank ||
        left.id.localeCompare(right.id),
    )
    .slice(0, Math.max(0, Math.floor(limit)));
}
