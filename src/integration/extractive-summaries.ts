// Deterministic, LLM-free retrieval-index summaries for the HTTP memory service.
// The store stays model-free by design: pendingLeafSummaries collects capped
// member statements, an external provider writes text, setLeafSummary persists
// it as index metadata that is matched against queries but never returned as
// evidence and never enters deduplication or ranking inputs.

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "than",
  "that",
  "this",
  "these",
  "those",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "done",
  "have",
  "has",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "shall",
  "may",
  "might",
  "must",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "about",
  "into",
  "over",
  "after",
  "before",
  "we",
  "you",
  "he",
  "she",
  "it",
  "they",
  "them",
  "his",
  "her",
  "their",
  "our",
  "your",
  "my",
  "me",
  "him",
  "us",
  "i",
  "not",
  "no",
  "yes",
  "so",
  "up",
  "out",
  "there",
  "here",
  "when",
  "while",
  "near",
  "again",
  "very",
  "just",
  "also",
  "的",
  "了",
  "是",
  "在",
  "我",
  "他",
  "她",
  "它们",
  "和",
  "与",
  "吗",
  "呢",
  "吧",
]);

/** Latin words plus CJK segments; deterministic ordering everywhere. */
function tokens(text: string) {
  const matches =
    String(text)
      .toLowerCase()
      .match(/[a-z0-9]+|[\u4e00-\u9fff]+/gu) ?? [];
  return matches.filter((token) => !STOPWORDS.has(token));
}

function topTerms(statements: readonly string[], count: number) {
  const frequency = new Map<string, number>();
  for (const statement of statements) {
    for (const token of tokens(statement)) {
      if (token.length < (/[a-z0-9]/u.test(token[0]) ? 3 : 2)) continue;
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  return [...frequency]
    .sort(
      ([left, leftCount], [right, rightCount]) =>
        rightCount - leftCount || left.localeCompare(right),
    )
    .slice(0, count)
    .map(([token]) => token);
}

function firstSentences(statements: readonly string[], maxChars: number) {
  const seen = new Set<string>();
  let text = "";
  for (const statement of statements) {
    const sentence = String(statement)
      .split(/(?<=[.!?。！？])\s*/)[0]
      ?.trim();
    if (!sentence || seen.has(sentence)) continue;
    seen.add(sentence);
    const addition = text ? ` ${sentence}` : sentence;
    if (text && text.length + addition.length > maxChars) break;
    text += addition;
    if (text.length >= maxChars) break;
  }
  return text;
}

/** Digest text for the leaf FTS index: discriminative terms then first sentences. */
export function extractiveDigest(statements: Iterable<string>, { maxChars = 700 } = {}) {
  const statementsList = [...statements].filter((statement) => String(statement).trim());
  if (!statementsList.length) throw new Error("extractive digest requires statements");
  const terms = topTerms(statementsList, 6).join(", ");
  return `${terms}. ${firstSentences(statementsList, Math.max(80, maxChars - terms.length))}`.trim();
}

/** Node-summary compensation for the missing LLM writer. The node identity
 * name stays the stable session key; this text lands on the non-identity
 * summary surface consumed by lexical scoring and node embedding fallback. */
export function extractiveNodeSummary(statements: Iterable<string>, date?: string) {
  const terms = topTerms([...statements], 6).join(", ");
  return `${date ? `${date} ` : ""}${terms}`.trim();
}
