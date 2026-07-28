/**
 * Offline QPP signal audit — recomputes the QPP score from persisted trace
 * selections in an existing LongMemEval matched run and correlates it with the
 * per-question outcome recorded in report.json. No LLM calls: qpp is a pure
 * function of the selections + memory types, which are already in the sqlite.
 *
 * This is the Stage 1 calibration prototype: it harvests (qpp, outcome) pairs
 * so we can see whether low QPP actually predicts wrong / partial-evidence
 * answers before wiring the real second-pass trigger.
 *
 * Usage: node --experimental-strip-types evals/omnimemeval/audit-qpp-signal.ts \
 *        evals/longmemeval/results/<run-dir>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

import { shouldTriggerSecondPass, DEFAULT_QPP_THRESHOLD } from "../../src/core/qpp.ts";
import type { QppCandidate } from "../../src/core/types.ts";

interface Outcome {
  questionId: string;
  questionType: string;
  passed: boolean;
  retrievalPassed: boolean | null;
}

interface Row {
  questionId: string;
  questionType: string;
  query: string;
  qpp: number;
  trigger: boolean;
  reason: string;
  nSelections: number;
  top1: number;
  variance: number;
  intentCoverage: number;
  reasonHealth: number;
  passed: boolean;
  retrievalPassed: boolean | null;
}

const resultsDir = process.argv[2];
if (!resultsDir) {
  console.error("usage: audit-qpp-signal.ts <longmemeval-results-dir>");
  process.exit(1);
}

const report = JSON.parse(readFileSync(resolve(resultsDir, "report.json"), "utf8")) as {
  results: Array<{ questionId: string; mode: string; questionType: string; passed: boolean; retrievalPassed: boolean | null }>;
};
const outcomeByQuestion = new Map<string, Outcome>();
for (const r of report.results) {
  if (r.mode === "nmg-deterministic") {
    outcomeByQuestion.set(r.questionId, {
      questionId: r.questionId,
      questionType: r.questionType,
      passed: r.passed,
      retrievalPassed: r.retrievalPassed,
    });
  }
}

const armsDir = resolve(resultsDir, "arms");
const rows: Row[] = [];
for (const questionId of readdirSorted(armsDir)) {
  const outcome = outcomeByQuestion.get(questionId);
  if (!outcome) continue;
  const detDir = resolve(armsDir, questionId, "nmg-deterministic");
  let dbPath: string | null = null;
  try {
    for (const repeat of readdirSorted(detDir)) {
      const candidate = resolve(detDir, repeat, "nmg.sqlite");
      if (exists(candidate)) { dbPath = candidate; break; }
    }
  } catch {
    // no nmg-deterministic arm for this question
  }
  if (!dbPath) continue;

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const typeRows = db.prepare("SELECT id, memory_type FROM memory_records").all() as
      Array<{ id: string; memory_type: string }>;
    const memoryType = new Map(typeRows.map((r) => [r.id, r.memory_type]));
    const traceRows = db
      .prepare("SELECT query, selections_json AS sels FROM retrieval_traces")
      .all() as Array<{ query: string; sels: string }>;
    // Pick the trace with the most selections (the main recall pass).
    let best: { query: string; candidates: QppCandidate[] } | null = null;
    for (const t of traceRows) {
      const sels = JSON.parse(t.sels || "[]") as Array<{
        memoryId: string;
        source: string;
        reason: string;
        scores?: { usefulness?: number };
      }>;
      const candidates: QppCandidate[] = sels.map((s) => ({
        usefulness: s.scores?.usefulness ?? 0,
        reason: s.reason,
        memoryType: (memoryType.get(s.memoryId) ?? "fact") as QppCandidate["memoryType"],
        isDirect: s.source === "direct",
      }));
      if (!best || candidates.length > best.candidates.length) {
        best = { query: t.query, candidates };
      }
    }
    if (!best) continue;
    const decision = shouldTriggerSecondPass(best.query, best.candidates);
    rows.push({
      questionId,
      questionType: outcome.questionType,
      query: best.query,
      qpp: decision.qpp,
      trigger: decision.trigger,
      reason: decision.reason,
      nSelections: best.candidates.length,
      top1: decision.components.top1,
      variance: decision.components.variance,
      intentCoverage: decision.components.intentCoverage,
      reasonHealth: decision.components.reasonHealth,
      passed: outcome.passed,
      retrievalPassed: outcome.retrievalPassed,
    });
  } finally {
    db.close();
  }
}

if (rows.length === 0) {
  console.log("No nmg-deterministic traces with selections found.");
  process.exit(0);
}

// Per-question table.
console.log(`\n=== QPP vs outcome (n=${rows.length}, threshold=${DEFAULT_QPP_THRESHOLD}) ===`);
console.log("qid          type                  qpp    trig reason            nSel top1 var  ic   rh   pass ret");
for (const r of rows.sort((a, b) => a.qpp - b.qpp)) {
  console.log(
    pad(r.questionId, 12) + " " +
    pad(r.questionType, 20) + " " +
    r.qpp.toFixed(2) + "  " +
    (r.trigger ? "TRIG" : "ok  ") + " " +
    pad(r.reason, 17) + " " +
    pad(String(r.nSelections), 4) + " " +
    r.top1.toFixed(2) + " " +
    r.variance.toFixed(2) + " " +
    r.intentCoverage.toFixed(2) + " " +
    r.reasonHealth.toFixed(2) + " " +
    (r.passed ? "P" : "F") + "   " +
    (r.retrievalPassed === null ? "-" : r.retrievalPassed ? "P" : "F"),
  );
}

// Bucket: would-trigger vs not.
const trig = rows.filter((r) => r.trigger);
const ok = rows.filter((r) => !r.trigger);
const acc = (rs: Row[]) => (rs.length === 0 ? NaN : rs.filter((r) => r.passed).length / rs.length);
const ret = (rs: Row[]) => {
  const m = rs.filter((r) => r.retrievalPassed !== null);
  return m.length === 0 ? NaN : m.filter((r) => r.retrievalPassed).length / m.length;
};
console.log("\n=== bucket: Stage-0 trigger decision ===");
console.log(`would-trigger (qpp<τ or guardrail): n=${trig.length}, answer-acc=${fmt(acc(trig))}, retrieval-acc=${fmt(ret(trig))}`);
console.log(`would-skip     (qpp≥τ):              n=${ok.length}, answer-acc=${fmt(acc(ok))}, retrieval-acc=${fmt(ret(ok))}`);

// Bucket: tertiles by qpp.
const sorted = [...rows].sort((a, b) => a.qpp - b.qpp);
const t = Math.ceil(sorted.length / 3);
const low = sorted.slice(0, t);
const high = sorted.slice(sorted.length - t);
console.log("\n=== bucket: qpp tertiles ===");
console.log(`low-qpp:    n=${low.length}, qpp∈[${low[0]?.qpp.toFixed(2)},${low.at(-1)?.qpp.toFixed(2)}], answer-acc=${fmt(acc(low))}, retrieval-acc=${fmt(ret(low))}`);
console.log(`high-qpp:   n=${high.length}, qpp∈[${high[0]?.qpp.toFixed(2)},${high.at(-1)?.qpp.toFixed(2)}], answer-acc=${fmt(acc(high))}, retrieval-acc=${fmt(ret(high))}`);

// Component health.
const allConv = rows.filter((r) => r.intentCoverage === 0.5).length;
console.log(`\nintentCoverage neutral (no intent family matched): ${allConv}/${rows.length}`);
console.log(`reasonHealth=0 (all hybrid_match) rows: ${rows.filter((r) => r.reasonHealth === 0).length}/${rows.length}`);

function fmt(x: number): string {
  return Number.isNaN(x) ? "n/a" : x.toFixed(2);
}
function readdirSorted(p: string): string[] {
  return readdirSync(p).sort();
}
function exists(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}
function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
