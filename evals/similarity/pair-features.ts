function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

function wordTokens(value: string): string[] {
  return normalizeText(value).match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function charNgrams(value: string, n: number): Map<string, number> {
  const result = new Map<string, number>();
  for (const word of wordTokens(value)) {
    const chars = Array.from(word);
    for (let index = 0; index + n <= chars.length; index += 1) {
      const gram = chars.slice(index, index + n).join("");
      result.set(gram, (result.get(gram) ?? 0) + 1);
    }
  }
  return result;
}

function overlap(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) {
  let intersection = 0;
  let union = 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [key, value] of a) {
    const other = b.get(key) ?? 0;
    intersection += Math.min(value, other);
    union += Math.max(value, other);
    dot += value * other;
    normA += value * value;
  }
  for (const [key, value] of b) {
    if (!a.has(key)) union += value;
    normB += value * value;
  }
  const sizeA = [...a.values()].reduce((sum, count) => sum + count, 0);
  const sizeB = [...b.values()].reduce((sum, count) => sum + count, 0);
  const cosine = normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
  return {
    jaccard: union === 0 ? 0 : intersection / union,
    coverageA: sizeA === 0 ? 0 : intersection / sizeA,
    coverageB: sizeB === 0 ? 0 : intersection / sizeB,
    cosine,
  };
}

export function pairFeatures(left: string, right: string): number[] {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  const leftWords = new Set(wordTokens(left));
  const rightWords = new Set(wordTokens(right));
  const wordOverlap = overlap(
    new Map([...leftWords].map((word) => [word, 1])),
    new Map([...rightWords].map((word) => [word, 1])),
  );
  const characters = [1, 2, 3, 4].map((n) => overlap(charNgrams(left, n), charNgrams(right, n)));
  const leftLength = Array.from(normalizedLeft.replaceAll(" ", "")).length;
  const rightLength = Array.from(normalizedRight.replaceAll(" ", "")).length;
  const lengthRatio = Math.min(leftLength, rightLength) / Math.max(1, leftLength, rightLength);
  return [
    normalizedLeft === normalizedRight ? 1 : 0,
    lengthRatio,
    wordOverlap.jaccard,
    wordOverlap.coverageA,
    wordOverlap.coverageB,
    characters[0]!.jaccard,
    characters[0]!.coverageA,
    characters[1]!.jaccard,
    characters[1]!.coverageA,
    characters[2]!.jaccard,
    characters[2]!.coverageA,
    characters[3]!.jaccard,
    characters[3]!.coverageA,
    characters[0]!.cosine,
    characters[1]!.cosine,
    characters[2]!.cosine,
    characters[3]!.cosine,
  ];
}

export function characterNgramCosine(left: string, right: string): number {
  const grams = [1, 2, 3, 4].map((n) => overlap(charNgrams(left, n), charNgrams(right, n)).cosine);
  return grams.reduce((sum, value) => sum + value, 0) / grams.length;
}
