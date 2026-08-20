export type UnifiedEvidenceKind = "id" | "text";

export interface UnifiedEvidenceScore {
  kind: UnifiedEvidenceKind;
  any: number;
  all: number;
  recall: number;
  ndcg?: number;
}

/**
 * Cross-benchmark row shape that preserves the official score without
 * pretending every benchmark has a binary success label or evidence labels.
 */
export interface UnifiedRowScore {
  taskScore: number;
  taskSuccess: boolean | null;
  evidence: UnifiedEvidenceScore | null;
}

export function binaryRowScore(
  score: number,
  evidence: UnifiedEvidenceScore | null = null,
): UnifiedRowScore {
  return { taskScore: score, taskSuccess: score === 1, evidence };
}

export function continuousRowScore(
  score: number,
  evidence: UnifiedEvidenceScore | null = null,
): UnifiedRowScore {
  return { taskScore: score, taskSuccess: null, evidence };
}

export function scoreEvidenceIds(
  retrievedIds: readonly string[] | null | undefined,
  expectedIds: readonly string[] | null | undefined,
): UnifiedEvidenceScore | null {
  if (!expectedIds || expectedIds.length === 0 || retrievedIds === null || retrievedIds === undefined) {
    return null;
  }
  const expected = new Set(expectedIds);
  const hits = new Set(retrievedIds.filter((id) => expected.has(id)));
  const recall = hits.size / expected.size;
  return {
    kind: "id",
    any: hits.size > 0 ? 1 : 0,
    all: hits.size === expected.size ? 1 : 0,
    recall,
  };
}
