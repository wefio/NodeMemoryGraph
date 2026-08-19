/**
 * Full-corpus pool-aware HyDE probe (LongMemEval 500).
 *
 * For every question with evidence:
 *   1. baseline search (fixed20 config, same as the 94.15% baseline run)
 *   2. LLM writes a hypothetical answer grounded in the top-10 baseline pool
 *   3. second search with the hyde clause, unioned with the baseline results
 *   4. evidence recall computed with the official audit normalize semantics
 *
 * Outputs a per-question JSON (resume-friendly) plus a summary line. The
 * baseline is recomputed here with the same context rendering as the hyde
 * side (statement-joined), so base-vs-hyde deltas are internally consistent;
 * the official 94.15% is listed separately for reference.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NmgStore } from "../../src/core/store.ts";
import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { CachedOmniEmbeddingClient } from "./embedding-cache.ts";

const DATA = ".benchmarks/official/OmniMemEval/data/longmemeval/longmemeval_s_cleaned.json";
const VERSION = "lme500_bgefix_header_20260804";
const STORE_DIR = ".benchmarks/omnimemeval-nmg";
const CACHE_PATH = ".benchmarks/shared-embedding-cache.sqlite";
const OUT = ".benchmarks/omnimemeval-nmg/hyde-full-results.json";
const LIMIT = 20;
const POOL_SIZE = 10;

const data = JSON.parse(readFileSync(DATA, "utf-8"));
const rows = Array.isArray(data) ? data : (data.rows ?? data.data ?? Object.values(data));

const LLM = {
  base: process.env.ANSWER_BASE_URL ?? "https://api.deepseek.com",
  model: process.env.ANSWER_MODEL ?? "deepseek-chat",
  key: process.env.ANSWER_API_KEY ?? "",
};

const ROLE_PREFIX = /^(user|assistant|system|tool)\s*:\s*/i;
function normalize(value) {
  return (value.match(/\w+/gu) ?? []).join(" ").toLowerCase();
}
function evidencesFor(row) {
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
function recallStats(context, evidences) {
  const ctx = normalize(context);
  const hits = evidences.map((ev) => {
    const m = ROLE_PREFIX.exec(ev);
    const content = m ? ev.slice(m[0].length) : ev;
    return Boolean(content.trim()) && ctx.includes(normalize(content));
  });
  return {
    any: hits.length > 0 && hits.some(Boolean),
    all: hits.length > 0 && hits.every(Boolean),
    rate: hits.length === 0 ? 0 : hits.filter(Boolean).length / hits.length,
    n: hits.length,
  };
}
function contextText(results) {
  return results.map((r) => r.memory.statement).join("\n");
}
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

process.env.NMG_EMBED_BASE_URL = "http://127.0.0.1:8000";
process.env.NMG_EMBED_MODEL = "BAAI/bge-small-en-v1.5";
process.env.NMG_EMBED_API_KEY = "dummy";
process.env.NMG_EMBED_PROFILE = "bge-en";

const delegate = await createEmbeddingClientFromEnv();
const embedding = new CachedOmniEmbeddingClient(CACHE_PATH, delegate);
const ASSISTANT_QUERY = /\b(?:assistant|previous\s+(?:chat|conversation)|earlier\s+(?:you|we)|you\s+(?:said|suggested|recommended|provided|mentioned|told|wrote|created|made|gave|listed|outlined|explained)|we\s+(?:discussed|talked|decided)|(?:(?:can|could)\s+you|you\s+could)\s+remind\s+me|your\s+(?:answer|response|recommendation|list|example))\b/iu;

const searchOpts = {
  limit: LIMIT,
  maxTier: 3,
  graphHops: 1,
  vectorGranularity: "records",
  sourceActor: undefined,
  secondPass: false,
  qppThreshold: 0.7,
  activeGraphBudget: { maxNodes: 20, maxEvidence: 20, maxTokens: 6000, maxTierBudget: 20 },
  sessionId: "hyde-full",
  taskId: "hyde-full",
};

const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf-8")) : {};
const SKIP = process.argv[2] ? Number(process.argv[2]) : 0; // resume after index

let baseAny = 0;
let hydeAny = 0;
let baseHits = 0;
let hydeHits = 0;
let evidenceN = 0;
let questions = 0;
const rescued = [];
const regressed = [];
const missingEv = [];

for (let idx = SKIP; idx < rows.length; idx++) {
  if (results[idx]) continue; // already done
  const row = rows[idx];
  const evidences = evidencesFor(row);
  if (evidences.length === 0) {
    missingEv.push(idx);
    results[idx] = { skipped: "no_evidence" };
    continue;
  }
  const userId = `lme_exper_user_${VERSION}_${idx}`;
  const key = createHash("sha256").update(userId).digest("hex").slice(0, 24);
  const store = new NmgStore(join(STORE_DIR, `${key}.sqlite`));
  const question = String(row.question ?? "");
  try {
    const opts = { ...searchOpts, sourceActor: ASSISTANT_QUERY.test(question) ? undefined : "user" };
  const [qVec] = await embedding.embedQueries([question]);
    const base = await store.searchContext(question, opts, {
      queryVector: qVec,
      model: embedding.indexId,
    });
    const baseCtx = contextText(base.results);
    const baseR = recallStats(baseCtx, evidences);

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
    const extra = hydeCandidates.results.filter((r) => !seen.has(r.memory.id));
    const hydeR = recallStats(contextText([...base.results, ...extra]), evidences);

    baseAny += baseR.any ? 1 : 0;
    hydeAny += hydeR.any ? 1 : 0;
    baseHits += baseR.rate * baseR.n;
    hydeHits += hydeR.rate * hydeR.n;
    evidenceN += baseR.n;
    questions += 1;
    if (!baseR.any && hydeR.any) rescued.push(idx);
    if (baseR.any && !hydeR.any) regressed.push(idx);
    results[idx] = {
      question: question.slice(0, 100),
      category: row.question_type ?? "?",
      evidenceCount: baseR.n,
      baseAny: baseR.any,
      hydeAny: hydeR.any,
      baseRate: +baseR.rate.toFixed(3),
      hydeRate: +hydeR.rate.toFixed(3),
      hyde: hyde.slice(0, 120),
    };
  } catch (error) {
    results[idx] = { error: String(error).slice(0, 300) };
  }
  store.close();
  if (idx % 25 === 0) {
    writeFileSync(OUT, JSON.stringify(results, null, 1));
    console.log(`progress ${idx}/${rows.length}  questions=${questions}  baseAny=${baseAny}/${questions}  hydeAny=${hydeAny}/${questions}  rescued=${rescued.length}`);
  }
}
writeFileSync(OUT, JSON.stringify(results, null, 1));

console.log(`\n=== FULL POOL-AWARE HYDE (${questions} questions with evidence) ===`);
console.log(`any-evidence: base ${(100 * baseAny / Math.max(1, questions)).toFixed(2)}% (${baseAny}/${questions})  ->  hyde ${(100 * hydeAny / Math.max(1, questions)).toFixed(2)}% (${hydeAny}/${questions})  delta ${(100 * (hydeAny - baseAny) / Math.max(1, questions)).toFixed(2)}pp`);
console.log(`evidence-rate: base ${(100 * baseHits / Math.max(1, evidenceN)).toFixed(2)}%  ->  hyde ${(100 * hydeHits / Math.max(1, evidenceN)).toFixed(2)}%`);
console.log(`rescued (base-fail -> hyde-hit): ${rescued.join(",") || "none"}`);
console.log(`regressed (base-hit -> hyde-fail): ${regressed.join(",") || "none"}`);
console.log(`no-evidence questions skipped: ${missingEv.length}`);
console.log(`errors: ${Object.values(results).filter((r) => r?.error).length}`);
embedding.close();
