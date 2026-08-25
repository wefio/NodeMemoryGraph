import type { MemoryNode, MemorySearchResult, MemoryType, RecallCue } from "../types.ts";

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

/**
 * Query intent families used both by {@link contextUsefulness} (bonus tuning)
 * and by QPP intent coverage. The canonical source of "which memory types a
 * query expects". Add new families here, not as inline regexes.
 */
export interface QueryIntentFamily {
  name: "list_count" | "recommend" | "assistant";
  pattern: RegExp;
  expectedTypes: readonly MemoryType[];
}

export const QUERY_INTENT_FAMILIES: readonly QueryIntentFamily[] = [
  {
    name: "list_count",
    pattern: /\b(?:how many|how much|list|all|count)\b|(?:多少|几个|列出|全部)/iu,
    expectedTypes: ["derived", "event", "fact", "state"],
  },
  {
    name: "recommend",
    pattern: /\b(?:recommend|suggest|preference)\b|(?:推荐|建议|偏好)/iu,
    expectedTypes: ["preference", "constraint"],
  },
  {
    name: "assistant",
    pattern: /\b(?:assistant|you said|previous chat)\b|(?:你说过|助手|之前的对话)/iu,
    expectedTypes: ["conversation_evidence"],
  },
];

/** Intent families whose pattern matches the query (normalized). */
export function queryIntentFamilies(query: string): QueryIntentFamily[] {
  const normalized = normalize(query);
  return QUERY_INTENT_FAMILIES.filter((family) => family.pattern.test(normalized));
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

/**
 * SQLite unicode61 keeps a contiguous Han run as one token. Append explicit
 * character bigrams so a longer recall question can match a shorter Chinese
 * phrase (and vice versa) without requiring a platform-specific tokenizer.
 * The original text remains indexed for exact phrase and non-Han retrieval.
 */
export function ftsIndexedText(value: string): string {
  const bigrams: string[] = [];
  for (const match of value.matchAll(/\p{Script=Han}+/gu)) {
    const run = match[0];
    for (let index = 0; index < run.length - 1; index += 1) {
      bigrams.push(run.slice(index, index + 2));
    }
  }
  return bigrams.length > 0 ? `${value} ${[...new Set(bigrams)].join(" ")}` : value;
}

export function lexicalNodeScore(query: string, node: MemoryNode): number {
  if (!query) return 0;
  const haystack = normalize(`${node.canonicalName} ${node.summary}`);
  if (haystack.includes(query)) return 1;
  const terms = searchTerms(query);
  if (terms.length === 0) return 0;
  return terms.filter((term) => haystack.includes(term)).length / terms.length;
}

export interface HybridWeights {
  lexical: number;
  vector: number;
  route: number;
}

/** Legacy weights: keyword-dominant (0.5/0.35/0.15). QPP thresholds and graph
 *  activation are calibrated on this scale — keep as the default so those
 *  paths are untouched. */
export const DEFAULT_HYBRID_WEIGHTS: HybridWeights = { lexical: 0.5, vector: 0.35, route: 0.15 };

/** Balanced AutoMem-style weights (0.35/0.35/0.30): semantic similarity carries
 *  as much rank weight as exact term overlap, so low-lexical high-vector
 *  memories (e.g. a promotion record asked about in different wording) are not
 *  dominated by keyword hits. Used only for candidate ranking in
 *  searchWithVector; QPP/graph activation keep the legacy scale.
 *
 *  Experiment 2026-08-07 (HaluMem single persona, t17): 0.811 vs legacy 0.8232.
 *  Balanced weights lifted Dynamic Update (2/6→3/6) and Multi-hop, but lost
 *  Memory Conflict (0.872→0.795) and Generalization; net worse. The Dynamic
 *  gain was already covered by the temporal as-of ranking (t14, 3/6 at 0.823).
 *  Kept as a documented alternative, NOT the active ranking. */
export const BALANCED_HYBRID_WEIGHTS: HybridWeights = { lexical: 0.35, vector: 0.35, route: 0.3 };

export function hybridScore(
  lexical: number,
  vector: number,
  route: number,
  weights: HybridWeights = DEFAULT_HYBRID_WEIGHTS,
): number {
  const boundedLexical = lexical <= 0 ? 0 : lexical / (lexical + 10);
  return (
    boundedLexical * weights.lexical +
    Math.max(0, vector) * weights.vector +
    Math.max(0, route) * weights.route
  );
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

/** Query terms that literally occur in the candidate's indexed text. Empty for
 *  pure-semantic or graph-route recalls; used by header formatters to explain
 *  "why was this recalled" without exposing the whole evidence. */
export function recallHitTerms(query: string, result: MemorySearchResult): string[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const haystack = normalize(
    `${result.memory.statement} ${result.node.canonicalName} ${result.node.summary}`,
  );
  return terms.filter((term) => haystack.includes(term));
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
  "an",
  "and",
  "are",
  "at",
  "be",
  "been",
  "being",
  "between",
  "but",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "if",
  "in",
  "into",
  "is",
  "many",
  "much",
  "of",
  "on",
  "or",
  "the",
  "then",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "with",
]);

export function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

/**
 * Query-term extraction for overlap scoring: whitespace-split terms (≥3
 * chars), CJK bigram shingles when the query is a single CJK run (no word
 * boundaries), or the lone term as-is — bigramming a single Latin word would
 * substring-match half the lexicon.
 */
export function queryOverlapTerms(query: string): string[] {
  const queryText = normalize(query);
  if (queryText.includes(" ")) {
    return queryText.split(" ").filter((term) => term.length >= 3);
  }
  if (/[\u4e00-\u9fff]/u.test(queryText)) {
    return Array.from({ length: Math.max(0, queryText.length - 1) }, (_, i) =>
      queryText.slice(i, i + 2),
    );
  }
  return [queryText];
}

/** Overlap score of a statement against pre-extracted query terms: sum of
 *  matched term lengths, 0 when nothing matches. */
export function termOverlapScore(terms: readonly string[], statement: string): number {
  const haystack = normalize(statement);
  return terms.reduce(
    (score, term) => score + (term && haystack.includes(term) ? term.length : 0),
    0,
  );
}

/**
 * Statement-level normalization for duplicate detection: NFKC, lowercased,
 * punctuation stripped, whitespace collapsed. Two statements that normalize
 * equal are the same fact written again regardless of surface formatting
 * (case, spacing, trailing punctuation, quotes).
 */
export function normalizeStatement(value: string): string {
  return normalize(value)
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Lexical similarity in [0,1] between two normalized statements (Jaccard over
 * word sets with a token-count cap for long statements). Used to flag
 * near-duplicate candidates for an external LLM judge — NMG itself only
 * acts on exact normalized equality.
 */
export function statementSimilarity(left: string, right: string): number {
  const a = normalizeStatement(left).split(" ").filter(Boolean);
  const b = normalizeStatement(right).split(" ").filter(Boolean);
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const tok of setA) {
    if (setB.has(tok)) inter += 1;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}
