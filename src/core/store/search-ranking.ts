import type { MemoryNode, MemorySearchResult, RecallCue } from "../types.ts";

export type StoreRow = Record<string, string | number | Uint8Array | null>;

export function contextUsefulness(query: string, result: MemorySearchResult): number {
  const normalized = normalize(query);
  const type = result.memory.memoryType;
  let bonus = 0;
  if (/\b(?:how many|how much|list|all|count)\b|(?:多少|几个|列出|全部)/iu.test(normalized)) {
    if (["derived", "event", "fact", "state"].includes(type)) bonus += 0.25;
    if (type === "conversation_evidence") bonus -= 0.15;
    if (type === "strategy") bonus -= 0.1;
  }
  if (/\b(?:recommend|suggest|preference)\b|(?:推荐|建议|偏好)/iu.test(normalized)) {
    if (type === "preference") bonus += 0.3;
    if (type === "constraint") bonus += 0.15;
  }
  if (
    /\b(?:assistant|you said|previous chat)\b|(?:你说过|助手|之前的对话)/iu.test(normalized) &&
    type === "conversation_evidence"
  ) {
    bonus += 0.25;
  }
  return result.combinedScore + bonus;
}

export function lexicalScore(query: string, row: StoreRow): number {
  const haystack = normalize(`${row.m_statement} ${row.n_canonical_name} ${row.n_summary}`);
  if (haystack.includes(query)) return 10 + query.length;
  const terms = searchTerms(query);
  return terms.reduce((score, term) => score + (haystack.includes(term) ? term.length : 0), 0);
}

export function memoryEmbeddingText(statement: unknown, canonicalName: unknown): string {
  return `${String(canonicalName)}: ${String(statement)}`;
}

export function ftsExpression(query: string): string {
  return searchTerms(normalize(query))
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

export function lexicalNodeScore(query: string, node: MemoryNode): number {
  if (!query) return 0;
  const haystack = normalize(`${node.canonicalName} ${node.summary}`);
  if (haystack.includes(query)) return 1;
  const terms = searchTerms(query);
  if (terms.length === 0) return 0;
  return terms.filter((term) => haystack.includes(term)).length / terms.length;
}

export function hybridScore(lexical: number, vector: number, route: number): number {
  const boundedLexical = lexical <= 0 ? 0 : lexical / (lexical + 10);
  return boundedLexical * 0.5 + Math.max(0, vector) * 0.35 + Math.max(0, route) * 0.15;
}

export function mergeSemanticCandidates(
  query: string,
  values: MemorySearchResult[],
  limit = 8,
): MemorySearchResult[] {
  return values
    .filter(
      (result, index, all) =>
        all.findIndex((candidate) => candidate.memory.id === result.memory.id) === index,
    )
    .sort((left, right) => contextUsefulness(query, right) - contextUsefulness(query, left))
    .slice(0, Math.max(1, Math.min(limit, 50)));
}

export function recallReason(result: MemorySearchResult): RecallCue["reason"] {
  const scores = [
    [
      "lexical_match",
      result.lexicalScore > 0 ? result.lexicalScore / (result.lexicalScore + 10) : 0,
    ],
    ["vector_match", Math.max(0, result.vectorScore)],
    ["learned_route", Math.max(0, result.routeScore)],
  ] as const;
  const ordered = [...scores].sort((left, right) => right[1] - left[1]);
  if ((ordered[0]?.[1] ?? 0) <= 0) return "hybrid_match";
  return ordered[0]![0];
}

export function hierarchyWeight(row: StoreRow): number {
  const frequency = Math.log2(2 + Number(row.access_count ?? 0));
  const importance = 0.5 + Number(row.importance ?? 0);
  const lastAccessed = row.last_accessed_at ? Date.parse(String(row.last_accessed_at)) : 0;
  const ageDays = lastAccessed > 0 ? Math.max(0, (Date.now() - lastAccessed) / 86_400_000) : 365;
  const recency = 1 / (1 + ageDays / 30);
  return Math.max(Number.EPSILON, frequency * importance * (0.5 + recency));
}

export function searchTerms(value: string): string[] {
  const tokens = value.match(/[\p{L}\p{N}_+.#-]+/gu) ?? [];
  const terms = new Set<string>();
  for (const token of tokens) {
    if (token.length >= 2 && !ENGLISH_SEARCH_STOP_WORDS.has(token)) terms.add(token);
    if (/\p{Script=Han}/u.test(token) && token.length > 4) {
      for (let index = 0; index < token.length - 1; index += 1) {
        terms.add(token.slice(index, index + 2));
      }
    }
  }
  return [...terms];
}

const ENGLISH_SEARCH_STOP_WORDS = new Set([
  "an", "and", "are", "at", "be", "been", "being", "between", "but", "by",
  "did", "do", "does", "for", "from", "had", "has", "have", "how", "if",
  "in", "into", "is", "many", "much", "of", "on", "or", "the", "then",
  "to", "was", "were", "what", "when", "where", "which", "who", "whom",
  "whose", "why", "with",
]);

export function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}
