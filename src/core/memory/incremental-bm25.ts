import type { ComputeOperator } from "../compute-graph.ts";
import { eventDateIndexText, normalize } from "../memory-normalization.ts";
import { recallTriggersFromStoredMarkers } from "../recall-triggers.ts";
import type { RerankCandidate, RerankContext, ScoredCandidateId } from "./piecewise-rerank.ts";

export type Bm25Variant = "bm25" | "bm25l" | "bm25_plus" | "bm25_atire" | "bm25_qtf";

export interface Bm25QueryOptions {
  readonly variant?: Bm25Variant;
  readonly k1?: number;
  readonly b?: number;
  readonly delta?: number;
  readonly k3?: number;
}

export interface IncrementalBm25Hit {
  readonly id: string;
  readonly score: number;
}

const STOP_WORDS = new Set([
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

const CJK_DETECT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3005\u30FC\uFF70]/u;
const CJK_RUN_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3005\u30FC\uFF70]{2,}/gu;
const ASCII_ALPHA_RE = /^[a-z]+$/u;
const MAX_STEM_CACHE_ENTRIES = 16_384;
const STEM_CACHE = new Map<string, string>();
const CANDIDATE_TOKENS_CACHE = new WeakMap<RerankCandidate, readonly string[]>();

const STEP2_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ["ational", "ate"],
  ["tional", "tion"],
  ["enci", "ence"],
  ["anci", "ance"],
  ["izer", "ize"],
  ["bli", "ble"],
  ["alli", "al"],
  ["entli", "ent"],
  ["eli", "e"],
  ["ousli", "ous"],
  ["ization", "ize"],
  ["ation", "ate"],
  ["ator", "ate"],
  ["alism", "al"],
  ["iveness", "ive"],
  ["fulness", "ful"],
  ["ousness", "ous"],
  ["aliti", "al"],
  ["iviti", "ive"],
  ["biliti", "ble"],
  ["logi", "log"],
];

const STEP3_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ["icate", "ic"],
  ["ative", ""],
  ["alize", "al"],
  ["iciti", "ic"],
  ["ical", "ic"],
  ["ful", ""],
  ["ness", ""],
];

const STEP4_SUFFIXES = [
  "al",
  "ance",
  "ence",
  "er",
  "ic",
  "able",
  "ible",
  "ant",
  "ement",
  "ment",
  "ent",
  "ou",
  "ism",
  "ate",
  "iti",
  "ous",
  "ive",
  "ize",
] as const;

function isConsonant(word: string, i: number): boolean {
  const ch = word.charCodeAt(i);
  if (ch === 97 || ch === 101 || ch === 105 || ch === 111 || ch === 117) return false;
  if (ch === 121) return i === 0 ? true : !isConsonant(word, i - 1);
  return true;
}

function measure(word: string): number {
  let n = 0;
  let inVowel = false;
  for (let i = 0; i < word.length; i += 1) {
    const cons = isConsonant(word, i);
    if (cons && inVowel) {
      n += 1;
      inVowel = false;
    } else if (!cons) {
      inVowel = true;
    }
  }
  return n;
}

function hasVowel(word: string): boolean {
  for (let i = 0; i < word.length; i += 1) {
    if (!isConsonant(word, i)) return true;
  }
  return false;
}

function endsDoubleConsonant(word: string): boolean {
  const len = word.length;
  if (len < 2 || word[len - 1] !== word[len - 2]) return false;
  return isConsonant(word, len - 1);
}

function endsCvc(word: string): boolean {
  const len = word.length;
  if (len < 3) return false;
  const ch = word[len - 1]!;
  if (ch === "w" || ch === "x" || ch === "y") return false;
  return isConsonant(word, len - 1) && !isConsonant(word, len - 2) && isConsonant(word, len - 3);
}

function porterStep1a(w: string): string {
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ies")) return w.slice(0, -2);
  if (w.endsWith("ss")) return w;
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

function fixStep1bTail(stem: string): string {
  if (stem.endsWith("at") || stem.endsWith("bl") || stem.endsWith("iz")) return `${stem}e`;
  if (endsDoubleConsonant(stem) && !"lsz".includes(stem[stem.length - 1]!)) {
    return stem.slice(0, -1);
  }
  if (measure(stem) === 1 && endsCvc(stem)) return `${stem}e`;
  return stem;
}

function porterStep1b(w: string): string {
  if (w.endsWith("eed")) {
    const stem = w.slice(0, -3);
    return measure(stem) > 0 ? w.slice(0, -1) : w;
  }
  const suffix = w.endsWith("ed") ? "ed" : w.endsWith("ing") ? "ing" : "";
  if (!suffix) return w;
  const stem = w.slice(0, -suffix.length);
  return hasVowel(stem) ? fixStep1bTail(stem) : w;
}

function replaceMeasured(
  word: string,
  table: ReadonlyArray<readonly [string, string]>,
  minMeasure: number,
): string {
  for (const [suffix, rep] of table) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, -suffix.length);
    return measure(stem) > minMeasure ? `${stem}${rep}` : word;
  }
  return word;
}

function porterStep4(w: string): string {
  if (w.endsWith("ion")) {
    const stem = w.slice(0, -3);
    if (measure(stem) > 1 && (stem.endsWith("s") || stem.endsWith("t"))) return stem;
  }
  for (const suffix of STEP4_SUFFIXES) {
    if (!w.endsWith(suffix)) continue;
    const stem = w.slice(0, -suffix.length);
    return measure(stem) > 1 ? stem : w;
  }
  return w;
}

function porterStep5(w: string): string {
  let out = w;
  if (out.endsWith("e")) {
    const stem = out.slice(0, -1);
    const m = measure(stem);
    if (m > 1 || (m === 1 && !endsCvc(stem))) out = stem;
  }
  if (out.endsWith("l") && endsDoubleConsonant(out) && measure(out.slice(0, -1)) > 1) {
    out = out.slice(0, -1);
  }
  return out;
}

/** Standard Porter (1980) stemmer for English ASCII tokens >= 3 chars. */
export function porterStemAscii(word: string): string {
  if (word.length < 3 || !ASCII_ALPHA_RE.test(word)) return word;
  const cached = STEM_CACHE.get(word);
  if (cached !== undefined) return cached;
  let w = porterStep1b(porterStep1a(word));
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = `${w.slice(0, -1)}i`;
  w = replaceMeasured(w, STEP2_SUFFIXES, 0);
  w = replaceMeasured(w, STEP3_SUFFIXES, 0);
  w = porterStep4(w);
  const out = porterStep5(w);
  if (STEM_CACHE.size >= MAX_STEM_CACHE_ENTRIES) STEM_CACHE.clear();
  STEM_CACHE.set(word, out);
  return out;
}

/** Bag-of-words tokenizer preserving exact multiplicities for TF and document lengths. */
export function tokenizeForIncrementalBm25(text: string): string[] {
  if (!text) return [];
  const norm = normalize(text);
  const rawTokens = norm.match(/[\p{L}\p{N}_+.#-]+/gu);
  if (!rawTokens) return [];
  const hasCjk = CJK_DETECT_RE.test(norm);
  const out: string[] = [];
  for (const token of rawTokens) {
    if (token.length >= 2 && !STOP_WORDS.has(token)) {
      out.push(ASCII_ALPHA_RE.test(token) ? porterStemAscii(token) : token);
    }
    if (!hasCjk) continue;
    for (const match of token.matchAll(CJK_RUN_RE)) {
      const run = match[0];
      for (let i = 0; i < run.length - 1; i += 1) {
        out.push(run.slice(i, i + 2));
      }
    }
  }
  return out;
}

function resolveDefaults(options?: Bm25QueryOptions): {
  variant: Bm25Variant;
  k1: number;
  b: number;
  delta: number;
  k3: number;
} {
  const variant = options?.variant ?? "bm25";
  return {
    variant,
    k1: options?.k1 ?? (variant === "bm25_atire" ? 0.9 : 1.5),
    b: options?.b ?? (variant === "bm25_atire" ? 0.4 : 0.75),
    delta: options?.delta ?? (variant === "bm25l" ? 0.5 : 1.0),
    k3: options?.k3 ?? 8.0,
  };
}

function termContribution(
  variant: Bm25Variant,
  tf: number,
  qtf: number,
  dl: number,
  avg: number,
  idf: number,
  cfg: { k1: number; b: number; delta: number; k3: number },
): number {
  const norm = 1 - cfg.b + cfg.b * (dl / Math.max(1e-9, avg));
  if (variant === "bm25l") {
    const ctd = tf / Math.max(0.25, norm);
    const sat = ((cfg.k1 + 1) * (ctd + cfg.delta)) / (cfg.k1 + ctd + cfg.delta);
    return idf * sat;
  }
  const baseTf = (tf * (cfg.k1 + 1)) / (tf + cfg.k1 * norm);
  if (variant === "bm25_plus") return idf * (baseTf + cfg.delta);
  if (variant === "bm25_qtf") {
    const qSat = ((cfg.k3 + 1) * qtf) / (cfg.k3 + qtf);
    return idf * baseTf * qSat;
  }
  return idf * baseTf;
}

function queryTermCounts(query: string | readonly string[]): Map<string, number> {
  const tokens = typeof query === "string" ? tokenizeForIncrementalBm25(query) : query;
  const counts = new Map<string, number>();
  for (const w of tokens) counts.set(w, (counts.get(w) ?? 0) + 1);
  return counts;
}

export interface PostingEntry {
  readonly docIdx: number;
  readonly tf: number;
}

/**
 * Incremental inverted-index BM25 engine.
 * `add()` maintains only `post[w]`, `dl`, and `total`;
 * `top()` recomputes `N = len(dl)`, `avg = total / N`, `df = len(pl)`, IDF, and BM25 dynamically at query time.
 */
export class IncrementalBm25Index {
  readonly post = new Map<string, PostingEntry[]>();
  readonly dl: number[] = [];
  readonly docIds: string[] = [];
  private readonly docIdxById = new Map<string, number>();
  total = 0;

  get size(): number {
    return this.dl.length;
  }

  add(id: string, textOrTokens: string | readonly string[]): number {
    if (this.docIdxById.has(id)) {
      throw new Error(`Document '${id}' already indexed in IncrementalBm25Index`);
    }
    const tokens =
      typeof textOrTokens === "string" ? tokenizeForIncrementalBm25(textOrTokens) : textOrTokens;
    const docIdx = this.dl.length;
    this.docIdxById.set(id, docIdx);
    this.docIds.push(id);
    this.dl.push(tokens.length);
    this.total += tokens.length;

    const counts = new Map<string, number>();
    for (const w of tokens) counts.set(w, (counts.get(w) ?? 0) + 1);
    for (const [w, tf] of counts) {
      let pl = this.post.get(w);
      if (!pl) {
        pl = [];
        this.post.set(w, pl);
      }
      pl.push({ docIdx, tf });
    }
    return docIdx;
  }

  private scoreMap(
    query: string | readonly string[],
    options?: Bm25QueryOptions,
  ): Map<number, number> {
    const N = this.dl.length;
    const scores = new Map<number, number>();
    if (N === 0) return scores;
    const avg = Math.max(1e-9, this.total / N);
    const cfg = resolveDefaults(options);
    const qCounts = queryTermCounts(query);

    for (const [w, qtf] of qCounts) {
      const pl = this.post.get(w);
      const df = pl ? pl.length : 0;
      if (df === 0) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const { docIdx, tf } of pl!) {
        const delta = termContribution(cfg.variant, tf, qtf, this.dl[docIdx]!, avg, idf, cfg);
        scores.set(docIdx, (scores.get(docIdx) ?? 0) + delta);
      }
    }
    return scores;
  }

  /** Score and return top-k matching document IDs using current N, avg, and df. */
  top(
    query: string | readonly string[],
    k: number,
    options?: Bm25QueryOptions,
  ): IncrementalBm25Hit[] {
    if (k <= 0 || this.dl.length === 0) return [];
    const scores = this.scoreMap(query, options);
    const out: IncrementalBm25Hit[] = [];
    for (const [docIdx, score] of scores) {
      if (score > 0) out.push({ id: this.docIds[docIdx]!, score });
    }
    out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : Number(a.id > b.id)));
    return out.slice(0, k);
  }

  /** Compute dynamic scores for an explicit subset of already-indexed document IDs. */
  scoreSubset(
    query: string | readonly string[],
    targetIds: Iterable<string>,
    options?: Bm25QueryOptions,
  ): Map<string, number> {
    const scores = this.scoreMap(query, options);
    const result = new Map<string, number>();
    for (const id of targetIds) {
      const idx = this.docIdxById.get(id);
      if (idx === undefined) continue;
      const score = scores.get(idx);
      if (score !== undefined && score > 0) result.set(id, score);
    }
    return result;
  }
}

function numParam(
  params: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function compareScored(left: ScoredCandidateId, right: ScoredCandidateId): number {
  return right.score - left.score || (left.id < right.id ? -1 : Number(left.id > right.id));
}

function candidateDocumentText(candidate: RerankCandidate): string {
  const triggers = recallTriggersFromStoredMarkers(candidate.markers ?? []).join(" ");
  const dates = eventDateIndexText(candidate.eventTime);
  return `${candidate.statement} ${triggers} ${dates}`.trim();
}

function tokensForCandidate(candidate: RerankCandidate): readonly string[] {
  const cached = CANDIDATE_TOKENS_CACHE.get(candidate);
  if (cached !== undefined) return cached;
  const tokens = Object.freeze(tokenizeForIncrementalBm25(candidateDocumentText(candidate)));
  CANDIDATE_TOKENS_CACHE.set(candidate, tokens);
  return tokens;
}

/**
 * Composable ComputeGraph operator running IncrementalBm25Index over a candidate pool.
 * Supports variants: "bm25" (k1=1.5, b=0.75), "bm25l", "bm25_plus", "bm25_atire", "bm25_qtf".
 */
export const incrementalBm25ScoreOperator: ComputeOperator<RerankContext> = (
  inputs,
  context,
  params,
) => {
  const base = Array.isArray(inputs.default)
    ? (inputs.default as ScoredCandidateId[])
    : context.candidates.map((c) => ({ id: c.id, score: c.combinedScore })).sort(compareScored);
  if (context.candidates.length < 2) return base;

  const queryTokens = tokenizeForIncrementalBm25(context.queryText);
  if (!queryTokens.length) return base;

  const weight = numParam(params, "weight", 0.1);
  const poolSize = Math.max(2, Math.floor(numParam(params, "poolSize", 200)));
  const poolEntries = base.slice(0, poolSize);
  const byId = new Map(context.candidates.map((c) => [c.id, c]));

  const index = new IncrementalBm25Index();
  for (const entry of poolEntries) {
    const candidate = byId.get(entry.id);
    if (candidate) index.add(candidate.id, tokensForCandidate(candidate));
  }

  const opts: Bm25QueryOptions = {
    variant: (typeof params.variant === "string" ? params.variant : "bm25") as Bm25Variant,
    ...(typeof params.k1 === "number" ? { k1: params.k1 } : {}),
    ...(typeof params.b === "number" ? { b: params.b } : {}),
    ...(typeof params.delta === "number" ? { delta: params.delta } : {}),
    ...(typeof params.k3 === "number" ? { k3: params.k3 } : {}),
  };
  const hits = index.top(queryTokens, index.size, opts);
  const maxScore = hits[0]?.score ?? 0;
  if (maxScore <= 0) return base;
  const hitMap = new Map(hits.map((h) => [h.id, h.score / maxScore]));

  const reorderedPool = poolEntries
    .map((entry) => ({
      id: entry.id,
      score: entry.score + weight * (hitMap.get(entry.id) ?? 0),
    }))
    .sort(compareScored);
  return [...reorderedPool, ...base.slice(poolSize)];
};
