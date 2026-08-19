/**
 * HyDE probe (small batch): does a hypothetical-answer second query improve
 * LongMemEval evidence recall over the plain query?
 *
 * Baseline: searchContext(question, fixed20) -> context -> evidence recall
 * HyDE:     LLM writes a hypothetical answer -> searchContext(hyde) ->
 *           union (original results first, hyde-only appended) -> recall
 *
 * Recall mirrors audit-longmemeval-retrieval.py: normalized evidence text
 * must be a substring of the normalized context.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import { NmgStore } from "../../src/core/store.ts";
import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { CachedOmniEmbeddingClient } from "./embedding-cache.ts";

const DATA = ".benchmarks/official/OmniMemEval/data/longmemeval/longmemeval_s_cleaned.json";
const VERSION = "lme500_bgefix_header_20260804"; // userId suffix matching existing stores
const STORE_DIR = ".benchmarks/omnimemeval-nmg";
const CACHE_PATH = ".benchmarks/shared-embedding-cache.sqlite";
const N = Number(process.argv[2] ?? "8"); // questions per batch
const IDX_ARG = process.argv[3]; // comma list of explicit indices (baseline-only mode: "scan")
const POOL_MODE = process.argv[4] === "pool"; // candidate-aware HyDE: feed top-10 baseline pool

const fs = await import("node:fs");
const data = JSON.parse(fs.readFileSync(DATA, "utf-8"));
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
function recallRate(context, evidences) {
  const ctx = normalize(context);
  const hits = evidences.map((e) => {
    const m = ROLE_PREFIX.exec(e);
    const content = m ? e.slice(m[0].length) : e;
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
  const system = poolText
    ? "You write ONE short hypothetical answer (1-3 sentences) to a user's question, in " +
      "the style of a natural reply from an assistant who knows the user's personal history. " +
      "Below are memory fragments retrieved from the user's history: reuse their wording, " +
      "entities, names, dates and numbers where relevant — they are the user's actual records. " +
      "The final text will be embedded for retrieval only, not shown to anyone. No meta comments."
    : "You write ONE short hypothetical answer (1-3 sentences) to a user's question, " +
      "in the style of a natural reply from an assistant who knows the user's personal " +
      "history (travel, purchases, preferences, events, schedules). Include plausible " +
      "concrete details (names, dates, numbers, places) even if invented — the text will " +
      "be embedded for retrieval, not shown to anyone. No meta comments, no disclaimers.";
  const user = poolText
    ? `Question: ${question}\n\nRetrieved memory fragments:\n${poolText}`
    : `Question: ${question}`;
  const body = {
    model: LLM.model,
    temperature: 0.3,
    max_tokens: 200,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  };
  const res = await fetch(`${LLM.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM.key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

// pick N rows: explicit indices if given, else spread across question types
const picked = [];
if (IDX_ARG && IDX_ARG !== "scan") {
  picked.push(...IDX_ARG.split(",").map(Number).filter((v) => Number.isFinite(v) && v >= 0 && v < rows.length));
} else {
  const byType = new Map();
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].question_type ?? "?";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(i);
  }
  const types = [...byType.keys()];
  for (let t = 0; picked.length < N; t++) {
    const type = types[t % types.length];
    const pool = byType.get(type);
    if (pool.length) picked.push(pool.shift());
  }
}

process.env.NMG_EMBED_BASE_URL = "http://127.0.0.1:8000";
process.env.NMG_EMBED_MODEL = "BAAI/bge-small-en-v1.5";
process.env.NMG_EMBED_API_KEY = "dummy";
process.env.NMG_EMBED_PROFILE = "bge-en";

const delegate = await createEmbeddingClientFromEnv();
const embedding = new CachedOmniEmbeddingClient(CACHE_PATH, delegate);
const searchOpts = {
  limit: 20,
  maxTier: 3,
  graphHops: 1,
  vectorGranularity: "records",
  sourceActor: undefined,
  secondPass: false,
  qppThreshold: 0.7,
  activeGraphBudget: { maxNodes: 20, maxEvidence: 20, maxTokens: 6000, maxTierBudget: 20 },
  sessionId: "hyde-probe",
  taskId: "hyde-probe",
};

const rowsSummary = { base: [0, 0], hyde: [0, 0], rates: [] }; // [any, n]
console.log(`HYDE probe: ${picked.length} questions`);
console.log("idx | type | #ev | base any/rate | hyde any/rate | hyde text");
for (const idx of picked) {
  const row = rows[idx];
  const userId = `lme_exper_user_${VERSION}_${idx}`;
  const key = createHash("sha256").update(userId).digest("hex").slice(0, 24);
  const store = new NmgStore(join(STORE_DIR, `${key}.sqlite`));
  const evidences = evidencesFor(row);
  const question = String(row.question ?? "");

  const [qVec] = await embedding.embedQueries([question]);
  const base = await store.searchContext(question, searchOpts, {
    queryVector: qVec,
    model: embedding.indexId,
  });
  const baseCtx = contextText(base.results);
  const baseR = recallRate(baseCtx, evidences);
  if (IDX_ARG === "scan") {
    console.log(`${idx} | ${row.question_type ?? "?"} | ${evidences.length} | base any=${baseR.any ? "Y" : "n"} rate=${(baseR.rate * 100).toFixed(0)}% | ${question.slice(0, 70)}`);
    store.close();
    continue;
  }

  let hydeCtx = baseCtx;
  let hydeR = baseR;
  let hyde = "";
  if (evidences.length > 0) {
    const poolText = POOL_MODE
      ? base.results
          .slice(0, 10)
          .map((r) => r.memory.statement)
          .join("\n")
      : null;
    hyde = await hydeAnswer(question, poolText);
    const [hVec] = await embedding.embedQueries([hyde]);
    const hydeCandidates = await store.searchContext(hyde, searchOpts, {
      queryVector: hVec,
      model: embedding.indexId,
    });
    const seen = new Set(base.results.map((r) => r.memory.id));
    const extra = hydeCandidates.results.filter((r) => !seen.has(r.memory.id));
    hydeCtx = contextText([...base.results, ...extra]);
    hydeR = recallRate(hydeCtx, evidences);
  }

  rowsSummary.base[0] += baseR.any ? 1 : 0;
  rowsSummary.base[1] += baseR.n > 0 ? 1 : 0;
  rowsSummary.hyde[0] += hydeR.any ? 1 : 0;
  rowsSummary.hyde[1] += hydeR.n > 0 ? 1 : 0;
  rowsSummary.rates.push([baseR.rate, hydeR.rate]);
  console.log(
    `${idx} | ${row.question_type ?? "?"} | ${evidences.length} | ` +
      `${baseR.any ? "Y" : "n"} ${(baseR.rate * 100).toFixed(0)}% | ` +
      `${hydeR.any ? "Y" : "n"} ${(hydeR.rate * 100).toFixed(0)}% | ${hyde.slice(0, 60)}`,
  );
  store.close();
}
const n = rowsSummary.base[1];
const anyDelta = n ? (rowsSummary.hyde[0] - rowsSummary.base[0]) : 0;
const meanRate = (arr) => arr.reduce((a, [b, h]) => a + (h - b), 0) / Math.max(1, arr.length);
console.log(
  `\nSUMMARY: any-evidence base=${rowsSummary.base[0]}/${n} hyde=${rowsSummary.hyde[0]}/${n} ` +
    `(delta ${anyDelta >= 0 ? "+" : ""}${anyDelta})  ` +
    `mean evidence-rate delta ${(meanRate(rowsSummary.rates) * 100).toFixed(1)}pp`,
);
embedding.close();
