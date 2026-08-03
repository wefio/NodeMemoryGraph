#!/usr/bin/env node
/**
 * Generate an experiment manifest for a LongMemEval run: code commit, prompt
 * template hashes, LLM runtime parameters, dataset hash, and result summary
 * with failure samples. Written into <result-dir>/experiment_manifest.json so
 * every run is reproducible and "prompt didn't change but score moved" can be
 * traced to a template/parameter/dataset/code delta.
 *
 * Usage:
 *   node experiment-manifest.mjs --result-dir <dir> --env-file <path>
 *
 * The env-file is the OmniMemEval env used for the run (ANSWER_MODEL etc.).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const resultDir = arg("--result-dir");
const envFile = arg("--env-file");
if (!resultDir || !existsSync(join(resultDir, "nmg_lme_judged.json"))) {
  console.error("--result-dir must point at a run with nmg_lme_judged.json");
  process.exit(1);
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const fileHash = (path) => {
  try {
    return sha256(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** Hash the concatenated string literal assigned to a constant, handling
 *  both `"a" + "b"` (TS) and `( "a" "b" )` (Python) forms. */
function constStrings(path, name) {
  try {
    const text = readFileSync(path, "utf8");
    const idx = text.indexOf(`${name} =`);
    if (idx < 0) return null;
    const re = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
    re.lastIndex = idx + name.length;
    let out = "";
    for (;;) {
      const m = re.exec(text);
      if (!m) break;
      out += m[0].slice(1, -1);
      // Only continue across whitespace, +, and ( ) glue.
      const gap = text.slice(re.lastIndex).match(/^[\s+()]*/) ?? [""];
      re.lastIndex += gap[0].length;
      const next = text[re.lastIndex];
      if (next !== '"' && next !== "'" && next !== "`") break;
    }
    return sha256(out);
  } catch {
    return null;
  }
}

function paramIn(path, key) {
  try {
    const text = readFileSync(path, "utf8");
    const m = text.match(new RegExp(`${key}\\s*=\\s*([0-9.]+)`));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// ── Code identity ───────────────────────────────────────────────────────────
let commit = "unknown", dirty = [];
try {
  commit = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
  dirty = execSync("git status --porcelain", { cwd: ROOT })
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(0, 3).trim() + " " + l.slice(3).trim().split(" ")[0]);
} catch { /* not a git checkout */ }

// ── Prompt templates ────────────────────────────────────────────────────────
const omni = join(ROOT, ".benchmarks/official/OmniMemEval");
const promptsPy = join(omni, "scripts/utils/prompts.py");
const bridgeTs = join(ROOT, "evals/omnimemeval/bridge.ts");
const nmgIndexTs = join(ROOT, ".pi/extensions/nmg/index.ts");
const nmgClientPy = join(omni, "scripts/client_factory/nmg_client.py");

const templates = {
  retrieval_guidance: {
    file: "evals/omnimemeval/bridge.ts",
    file_hash: fileHash(bridgeTs),
    base_guidance_hash: constStrings(bridgeTs, "BASE_RETRIEVAL_GUIDANCE"),
    forget_guidance_hash: constStrings(bridgeTs, "FORGET_RETRIEVAL_GUIDANCE"),
  },
  answer_prompt: {
    file: "scripts/utils/prompts.py (LME_ANSWER_PROMPT)",
    file_hash: fileHash(promptsPy),
    prompt_hash: constStrings(promptsPy, "LME_ANSWER_PROMPT"),
  },
  judge_prompt: {
    file: "scripts/utils/prompts.py (JUDGE_SYSTEM_PROMPT / JUDGE_PROMPT)",
    judge_system_hash: constStrings(promptsPy, "JUDGE_SYSTEM_PROMPT"),
    judge_prompt_hash: constStrings(promptsPy, "JUDGE_PROMPT"),
  },
  nmg_policy_extension: {
    file: ".pi/extensions/nmg/index.ts",
    file_hash: fileHash(nmgIndexTs),
  },
  nmg_bridge_adapter: {
    file: "scripts/client_factory/nmg_client.py",
    file_hash: fileHash(nmgClientPy),
  },
};

// ── Runtime parameters (env file + LLM client defaults) ────────────────────
const env = {};
if (envFile && existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const llmClientPy = join(omni, "scripts/utils/llm_client.py");
const llmClientText = existsSync(llmClientPy) ? readFileSync(llmClientPy, "utf8") : "";
const defaultParams = {
  // temperature/max_tokens are pinned per-stage in the LME scripts, not the client.
  answer_temperature: paramIn(join(omni, "scripts/longmemeval/lme_responses.py"), "temperature"),
  judge_temperature: paramIn(join(omni, "scripts/longmemeval/lme_eval.py"), "temperature"),
};

// ── Dataset ────────────────────────────────────────────────────────────────
const datasetPath = join(omni, "data/longmemeval/longmemeval_s_cleaned.json");
let dataset = { path: null, sha256: null, questions: null };
if (existsSync(datasetPath)) {
  const raw = readFileSync(datasetPath, "utf8");
  dataset = { path: "data/longmemeval/longmemeval_s_cleaned.json", sha256: sha256(raw), questions: JSON.parse(raw).length };
}

// ── Results ────────────────────────────────────────────────────────────────
// any-evidence / evidence recall come from the search artifact (audit script
// matches answer_evidences against the retrieved context); answer accuracy
// comes from the judged artifact. This is the same triple reported as
// baseline (94.15% any / 87.95% overall / 81.2% answer acc).
const searchResults = join(resultDir, "nmg_lme_search_results.json");
const judgedPath = join(resultDir, "nmg_lme_judged.json");
let audit = {};
try {
  audit = JSON.parse(
    execSync(
      `python "${join(ROOT, "evals/omnimemeval/audit-longmemeval-retrieval.py")}" "${searchResults}" "${judgedPath}"`,
      { cwd: ROOT },
    ).toString(),
  );
} catch (error) {
  console.error("warning: audit-longmemeval-retrieval failed:", error.message);
}

const judged = JSON.parse(readFileSync(judgedPath, "utf8"));
const byCat = {};
let n = 0, correct = 0, anyHit = 0;
const failures = [];
for (const [uid, e] of Object.entries(judged)) {
  if (e.status !== "success") continue;
  n += 1;
  const jj = e.llm_judgments ?? {};
  const vals = Object.values(jj);
  const ok = vals.length > 0 && vals.every(Boolean);
  const any = vals.some(Boolean);
  if (ok) correct += 1;
  if (any) anyHit += 1;
  const cat = e.category ?? "unknown";
  byCat[cat] ??= { n: 0, correct: 0, anyHit: 0 };
  byCat[cat].n += 1;
  if (ok) byCat[cat].correct += 1;
  if (any) byCat[cat].anyHit += 1;
  if (!any) {
    failures.push({
      user: uid,
      category: cat,
      question: e.question,
      golden_answer: e.golden_answer,
    });
  }
}
const categoryBreakdown = Object.fromEntries(
  Object.entries(byCat).map(([c, v]) => [
    c,
    { n: v.n, correct_pct: +(100 * v.correct / v.n).toFixed(2), any_evidence_pct: +(100 * v.anyHit / v.n).toFixed(2) },
  ]),
);

const manifest = {
  experiment: {
    result_dir: resultDir.replace(/\\/g, "/").split("/").pop(),
    generated_at: new Date().toISOString(),
  },
  code: { commit, dirty },
  prompt_templates: templates,
  runtime: {
    env: {
      ANSWER_MODEL: env.ANSWER_MODEL ?? null,
      ANSWER_BASE_URL: env.ANSWER_BASE_URL ?? null,
      EVAL_MODEL: env.EVAL_MODEL ?? null,
      EVAL_BASE_URL: env.EVAL_BASE_URL ?? null,
      NMG_EMBED_MODEL: env.NMG_EMBED_MODEL ?? null,
      NMG_EMBED_PROFILE: env.NMG_EMBED_PROFILE ?? null,
      NMG_QPP_SECOND_PASS: env.NMG_QPP_SECOND_PASS ?? null,
    },
    llm_defaults: defaultParams,
  },
  dataset,
  results: {
    questions: audit.questions ?? n,
    any_evidence_recall_pct: audit.anyEvidenceRate != null ? +(audit.anyEvidenceRate * 100).toFixed(2) : null,
    evidence_recall_pct: audit.evidenceRecall != null ? +(audit.evidenceRecall * 100).toFixed(2) : null,
    all_evidence_recall_pct: audit.allEvidenceRate != null ? +(audit.allEvidenceRate * 100).toFixed(2) : null,
    answer_accuracy_pct: audit.answerAccuracy?.judged ? +(audit.answerAccuracy.judged.accuracy * 100).toFixed(2) : null,
    mean_context_chars: audit.meanContextCharacters ?? null,
    judged_users: n,
    failures: failures.length,
    category_evidence_recall: audit.categoryEvidenceRecall ?? null,
    category_answer_accuracy: audit.answerAccuracy ?? null,
    category_breakdown: categoryBreakdown,
  },
  failure_samples: failures.slice(0, 5),
};

writeFileSync(join(resultDir, "experiment_manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
