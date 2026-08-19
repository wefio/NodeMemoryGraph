/**
 * Generates a LongMemEval search-results artifact where every context is the
 * pool-aware HyDE fusion (baseline results ∪ hyde-only results), rendered with
 * the exact bridge projection (retrieval guidance + [eventTime] statement).
 * The artifact feeds lme_responses.py (answer) + lme_eval.py (judge) so the
 * judged accuracy can be compared against the 82.33% fixed-top-20 baseline.
 *
 * Usage: node hyde-context.mjs <version-suffix> [resumeIndex]
 * Output: results/lme/nmg-<suffix>/nmg_lme_search_results.json
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NmgStore } from "../../src/core/store.ts";
import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { CachedOmniEmbeddingClient } from "./embedding-cache.ts";

const DATA = ".benchmarks/official/OmniMemEval/data/longmemeval/longmemeval_s_cleaned.json";
const VERSION = "lme500_bgefix_header_20260804";
const STORE_DIR = ".benchmarks/omnimemeval-nmg";
const CACHE_PATH = ".benchmarks/shared-embedding-cache.sqlite";
const LIMIT = 20;
const POOL_SIZE = 10;

const SUFFIX = process.argv[2] ?? "hyde-pool";
const OUT_DIR = `results/lme/nmg-${SUFFIX}`;
const OUT = join(OUT_DIR, "nmg_lme_search_results.json");

const GUIDANCE =
  "[NMG retrieval guidance] Treat relevant user facts, preferences, constraints, " +
  "tools, and prior experiences as evidence for a personalized answer. Apply them " +
  "to the current request even when the final answer did not appear verbatim in " +
  "history. Do not invent unsupported user details.";
const TEMPORAL_QUERY =
  /\b(?:when|date|days?|weeks?|months?|years?|before|after|first|last|recent|recently|ago|long|yesterday|today|tomorrow|since|until|during|between|january|february|march|april|may|june|july|august|september|october|november|december)\b|(?:19|20)\d{2}/iu;
const ASSISTANT_QUERY =
  /\b(?:assistant|previous\s+(?:chat|conversation)|earlier\s+(?:you|we)|you\s+(?:said|suggested|recommended|provided|mentioned|told|wrote|created|made|gave|listed|outlined|explained)|we\s+(?:discussed|talked|decided)|(?:(?:can|could)\s+you|you\s+could)\s+remind\s+me|your\s+(?:answer|response|recommendation|list|example))\b/iu;

const data = JSON.parse(readFileSync(DATA, "utf-8"));
const rows = Array.isArray(data) ? data : (data.rows ?? data.data ?? Object.values(data));

const LLM = {
  base: process.env.ANSWER_BASE_URL ?? "https://api.deepseek.com",
  model: process.env.ANSWER_MODEL ?? "deepseek-chat",
  key: process.env.ANSWER_API_KEY ?? "",
};

async function hydeAnswer(question, poolText) {
  const body = {
    model: LLM.model,
    temperature: 0.3,
    max_tokens: 200,
    messages: [
      {
        role: "system",
        content:
          "You write ONE short hypothetical answer (1-3 sentences) to a user's question, in " +
          "the style of a natural reply from an assistant who knows the user's personal history. " +
          "Below are memory fragments retrieved from the user's history: reuse their wording, " +
          "entities, names, dates and numbers where relevant — they are the user's actual records. " +
          "The final text will be embedded for retrieval only, not shown to anyone. No meta comments.",
      },
      {
        role: "user",
        content: `Question: ${question}\n\nRetrieved memory fragments:\n${poolText}`,
      },
    ],
  };
  const res = await fetch(`${LLM.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM.key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

function renderContext(results, includeTime) {
  if (results.length === 0) return "";
  const lines = results.map((r) => {
    const base =
      includeTime && r.memory.eventTime
        ? `[${r.memory.eventTime}] ${r.memory.statement}`
        : r.memory.statement;
    return base;
  });
  return [GUIDANCE, ...lines].join("\n");
}

process.env.NMG_EMBED_BASE_URL = "http://127.0.0.1:8000";
process.env.NMG_EMBED_MODEL = "BAAI/bge-small-en-v1.5";
process.env.NMG_EMBED_API_KEY = "dummy";
process.env.NMG_EMBED_PROFILE = "bge-en";

const delegate = await createEmbeddingClientFromEnv();
const embedding = new CachedOmniEmbeddingClient(CACHE_PATH, delegate);
const searchOpts = {
  limit: LIMIT,
  maxTier: 3,
  graphHops: 1,
  vectorGranularity: "records",
  sourceActor: undefined,
  secondPass: false,
  qppThreshold: 0.7,
  activeGraphBudget: { maxNodes: 20, maxEvidence: 20, maxTokens: 6000, maxTierBudget: 20 },
  sessionId: `hyde-${SUFFIX}`,
  taskId: "hyde-context",
};

mkdirSync(OUT_DIR, { recursive: true });
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf-8")) : {};
const SKIP = process.argv[3] ? Number(process.argv[3]) : 0;

let done = 0;
for (let idx = SKIP; idx < rows.length; idx++) {
  if (results[idx]) { done += 1; continue; }
  const row = rows[idx];
  const userId = `lme_exper_user_${SUFFIX}_${idx}`;
  // Stores are keyed by the ingest-version userId, not the output label.
  const storeUserId = `lme_exper_user_${VERSION}_${idx}`;
  const key = createHash("sha256").update(storeUserId).digest("hex").slice(0, 24);
  const store = new NmgStore(join(STORE_DIR, `${key}.sqlite`));
  const question = String(row.question ?? "");
  try {
    const opts = { ...searchOpts, sourceActor: ASSISTANT_QUERY.test(question) ? undefined : "user" };
    const [qVec] = await embedding.embedQueries([question]);
    const base = await store.searchContext(question, opts, {
      queryVector: qVec,
      model: embedding.indexId,
    });
    const poolText = base.results
      .slice(0, POOL_SIZE)
      .map((r) => r.memory.statement)
      .join("\n");
    const hyde = await hydeAnswer(question, poolText);
    const [hVec] = await embedding.embedQueries([hyde]);
    const hydeCandidates = await store.searchContext(hyde, opts, {
      queryVector: hVec,
      model: embedding.indexId,
    });
    const seen = new Set(base.results.map((r) => r.memory.id));
    const fused = [
      ...base.results,
      ...hydeCandidates.results.filter((r) => !seen.has(r.memory.id)),
    ].slice(0, LIMIT);
    const context = renderContext(fused, TEMPORAL_QUERY.test(question));
    results[idx] = [
      {
        question,
        category: row.question_type ?? "?",
        date: String(row.question_date ?? ""),
        golden_answer: String(row.answer ?? ""),
        answer_evidences: answerEvidencesFor(row),
        search_context: context,
        search_duration_ms: 0,
        status: "success",
      },
    ];
  } catch (error) {
    results[idx] = [{ question, status: "error", error: String(error).slice(0, 200) }];
  }
  store.close();
  done += 1;
  if (done % 25 === 0) {
    writeFileSync(OUT, JSON.stringify(results, null, 1));
    console.log(`progress ${idx}/${rows.length} done=${done}`);
  }
}
writeFileSync(OUT, JSON.stringify(results, null, 1));
const success = Object.values(results).filter((v) => v[0]?.status === "success").length;
console.log(`written ${OUT}: ${success} success entries`);
embedding.close();

function answerEvidencesFor(row) {
  const answerIds = new Set(row.answer_session_ids ?? []);
  const idToSession = Object.fromEntries(
    (row.haystack_session_ids ?? []).map((id, i) => [id, (row.haystack_sessions ?? [])[i]]),
  );
  const out = [];
  for (const sid of answerIds) {
    const session = idToSession[sid];
    if (!session) continue;
    for (const turn of session) {
      if (turn.has_answer) out.push(`${turn.role} : ${turn.content}`);
    }
  }
  return out;
}
