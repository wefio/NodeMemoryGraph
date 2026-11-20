const VECTOR_WEIGHT = 0.75;

function calibrate(scores: readonly number[]): (score: number) => number {
  const positive = scores.filter((score) => score > 0).sort((a, b) => a - b);
  if (!positive.length) return (score) => score;
  const middle = Math.floor(positive.length / 2);
  const median =
    positive.length % 2 ? positive[middle]! : (positive[middle - 1]! + positive[middle]!) / 2;
  if (positive[0] === positive.at(-1)) return (score) => score - median;
  const mean = positive.reduce((sum, score) => sum + score, 0) / positive.length;
  const variance = positive.reduce((sum, score) => sum + (score - mean) ** 2, 0) / positive.length;
  const deviation = Math.sqrt(variance) || 1;
  return (score) => (score - median) / deviation;
}

/** Fuse raw scores from the authorized candidate union using a fixed 3:1 vector preference. */
export function rankLocalLogOdds<T>(
  candidates: readonly T[],
  scoresOf: (candidate: T) => { id: string; vectorScore: number; bm25: number },
): Array<{ candidate: T; score: number }> {
  const scores = candidates.map(scoresOf);
  const vectorEvidence = calibrate(scores.map(({ vectorScore }) => vectorScore));
  const lexicalEvidence = calibrate(scores.map(({ bm25 }) => bm25));
  const ranked = scores.map(({ id, vectorScore, bm25 }, index) => {
    const vector = vectorEvidence(vectorScore);
    const score =
      bm25 > 0
        ? Math.SQRT2 * (VECTOR_WEIGHT * vector + (1 - VECTOR_WEIGHT) * lexicalEvidence(bm25))
        : vector;
    return { candidate: candidates[index]!, id, score };
  });
  return ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : Number(a.id > b.id)));
}
