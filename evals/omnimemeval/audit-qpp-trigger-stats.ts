/**
 * Aggregate real QPP trigger decisions from OmniMemEval trace databases.
 *
 * Reads retrieval_traces.qpp_json from every OmniMemEval sqlite under
 * .benchmarks/ and reports: trigger rate, reason distribution, Fibonacci
 * expansion stop reasons, stage counts, and qpp score distribution.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = new URL("../../.benchmarks/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function sqliteFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...sqliteFiles(full));
    else if (entry.name.endsWith(".sqlite")) out.push(full);
  }
  return out;
}

const files = sqliteFiles(ROOT).filter((f) => f.includes("omnimemeval"));
console.log(`trace databases: ${files.length}`);

let traces = 0;
let withExpansion = 0;
const reason = new Map<string, number>();
const stopped = new Map<string, number>();
const stages: number[] = [];
const qppScores: number[] = [];
const triggers: Record<string, number> = { trigger: 0, ok: 0 };
const top1: number[] = [];

for (const file of files) {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    continue;
  }
  let rows: Array<{ qpp_json: string }>;
  try {
    rows = db.prepare("SELECT qpp_json FROM retrieval_traces").all() as Array<{
      qpp_json: string;
    }>;
  } catch {
    db.close();
    continue; // older schema without qpp_json
  }
  for (const row of rows) {
    traces += 1;
    let qpp: {
      trigger?: boolean;
      reason?: string;
      qpp?: number;
      components?: { top1?: number };
      expansion?: { stoppedBecause?: string; stages?: unknown[] };
    };
    try {
      qpp = JSON.parse(row.qpp_json);
    } catch {
      continue;
    }
    if (qpp.trigger === true) triggers.trigger += 1;
    else if (qpp.trigger === false) triggers.ok += 1;
    if (qpp.reason) reason.set(qpp.reason, (reason.get(qpp.reason) ?? 0) + 1);
    if (typeof qpp.qpp === "number") qppScores.push(qpp.qpp);
    if (typeof qpp.components?.top1 === "number") top1.push(qpp.components.top1);
    if (qpp.expansion) {
      withExpansion += 1;
      const why = qpp.expansion.stoppedBecause ?? "unknown";
      stopped.set(why, (stopped.get(why) ?? 0) + 1);
      stages.push(qpp.expansion.stages?.length ?? 0);
    }
  }
  db.close();
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
function percent(part: number, total: number): string {
  return total === 0 ? "0%" : `${((part / total) * 100).toFixed(1)}%`;
}

console.log(`traces: ${traces} | with expansion: ${withExpansion} (${percent(withExpansion, traces)})`);
console.log(`trigger: ${triggers.trigger} (${percent(triggers.trigger, traces)}) | ok: ${triggers.ok} (${percent(triggers.ok, traces)})`);
console.log("reason distribution:");
for (const [k, v] of [...reason.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${v} (${percent(v, traces)})`);
}
console.log("expansion stoppedBecause:");
for (const [k, v] of [...stopped.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${v} (${percent(v, withExpansion)})`);
}
console.log(`stages per expansion: mean ${mean(stages).toFixed(2)} | max ${stages.length ? Math.max(...stages) : 0}`);
console.log(`qpp score: mean ${mean(qppScores).toFixed(3)} | n=${qppScores.length}`);
console.log(`top1: mean ${mean(top1).toFixed(3)} | n=${top1.length}`);
