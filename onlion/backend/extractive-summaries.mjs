// Deterministic, LLM-free retrieval-index summaries for the AML service.
// The store stays model-free by design: pendingLeafSummaries collects capped
// member statements, an external provider writes text, setLeafSummary persists
// it as index metadata that is matched against queries but never returned as
// evidence and never enters deduplication or ranking inputs.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this',
  'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'done', 'have', 'has', 'had', 'will', 'would', 'can',
  'could', 'should', 'shall', 'may', 'might', 'must', 'of', 'to', 'in', 'on',
  'at', 'by', 'for', 'with', 'from', 'about', 'into', 'over', 'after', 'before',
  'we', 'you', 'he', 'she', 'it', 'they', 'them', 'his', 'her', 'their', 'our',
  'your', 'my', 'me', 'him', 'us', 'i', 'not', 'no', 'yes', 'so', 'up', 'out',
  'there', 'here', 'when', 'while', 'near', 'again', 'very', 'just', 'also',
  '的', '了', '是', '在', '我', '他', '她', '它们', '和', '与', '吗', '呢', '吧',
]);

/** Latin words plus CJK segments; deterministic ordering everywhere. */
function tokens(text) {
  const matches = String(text).toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/gu) ?? [];
  return matches.filter((token) => !STOPWORDS.has(token));
}

function topTerms(statements, count) {
  const frequency = new Map();
  for (const statement of statements) {
    for (const token of tokens(statement)) {
      if (token.length < (/[a-z0-9]/u.test(token[0]) ? 3 : 2)) continue;
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  return [...frequency]
    .sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || left.localeCompare(right))
    .slice(0, count)
    .map(([token]) => token);
}

function firstSentences(statements, maxChars) {
  const seen = new Set();
  let text = '';
  for (const statement of statements) {
    const sentence = String(statement).split(/(?<=[.!?。！？])\s*/)[0]?.trim();
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
export function extractiveDigest(statements, { maxChars = 700 } = {}) {
  const statementsList = [...statements].filter((statement) => String(statement).trim());
  if (!statementsList.length) throw new Error('extractive digest requires statements');
  const terms = topTerms(statementsList, 6).join(', ');
  return `${terms}. ${firstSentences(statementsList, Math.max(80, maxChars - terms.length))}`.trim();
}

/** Node-summary compensation for the missing LLM writer. The node identity
 * name stays the stable session key; this text lands on the non-identity
 * summary surface consumed by lexical scoring and node embedding fallback. */
export function extractiveNodeSummary(statements, date) {
  const terms = topTerms([...statements], 6).join(', ');
  return `${date ? `${date} ` : ''}${terms}`.trim();
}

/** Extractive LeafSummaryProvider: same shape as the LLM providers, no I/O. */
export function createExtractiveLeafProvider() {
  return {
    model: 'aml-extractive-v1',
    summarize: ({ statements }) => extractiveDigest(statements),
  };
}

/** Materialize dirty leaf blocks, write leaf digests, then refresh the node
 *  tier for multi-block nodes (the store's minBlocks gate keeps single-block
 *  nodes unduplicated). With OR fts semantics the node tier is a coarser
 *  index over leaf digests, valuable once vector routing and multi-node
 *  stores join; leaf FTS remains the primary lexical routing surface.
 *  Retries stale leaf rejections once. */
export function runExtractiveLeafSummaries(store, { limit = 64 } = {}) {
  const provider = createExtractiveLeafProvider();
  let written = 0;
  for (const nodeId of store.dirtyLeafNodeIds()) store.rebuildLeafBlocks(nodeId);
  let tasks = store.pendingLeafSummaries({ limit });
  for (let pass = 0; pass < 2 && tasks.length; pass++) {
    const rejected = [];
    for (const task of tasks) {
      const persisted = store.setLeafSummary(
        task.blockId, extractiveDigest(task.statements), provider.model, task.membersKey,
      );
      if (persisted) written++;
      else rejected.push(task);
    }
    tasks = rejected.length ? store.pendingLeafSummaries({ limit }) : [];
  }
  for (const task of store.pendingNodeSummaries({ limit })) {
    if (store.setNodeSummary(task.nodeId, extractiveDigest(task.statements, { maxChars: 500 }), provider.model, task.memberCount)) written++;
  }
  return written;
}
