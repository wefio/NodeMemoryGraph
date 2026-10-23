// Recompute static-multipath-recall v4 summaries from a saved rows.jsonl
// without re-searching: paired comparisons against the eligible projection,
// plus the fixed-text-budget views. Lets anyone independently re-derive the
// summary (and re-derive it under a corrected contract) from the raw rows.
//
// Usage: node --experimental-strip-types evals/omnimemeval/research/audits/recompute-multipath-summary.ts <rows-or-run-dir>

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pairedComparison } from "./locomo-audit-shared.ts";

const root = resolve(import.meta.dirname, "../../../..");
const arg = process.argv[2];
if (!arg) throw new Error("usage: recompute-multipath-summary.ts <rows.jsonl | run-directory>");
const runDir = resolve(
  root,
  arg.endsWith("rows.jsonl") ? "" : arg,
  arg.endsWith("rows.jsonl") ? arg : "",
);
const rowsPath = arg.endsWith("rows.jsonl") ? resolve(root, arg) : resolve(runDir, "rows.jsonl");
const rows = readFileSync(rowsPath, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const manifest = JSON.parse(
  readFileSync(resolve(root, "evals/locomo/results/locomo-eligible-manifest.json"), "utf8"),
);
const eligible = new Set<string>(manifest.eligibleIds);

const normalized = rows.map((row: Record<string, unknown>) => {
  const budgetViews = row.budgetViews as Record<string, { hitPositions: number[] }> | undefined;
  return budgetViews
    ? {
        ...row,
        budgetB: budgetViews.B,
        budgetD20max: budgetViews.D20max,
        budgetD100max: budgetViews.D100max,
      }
    : row;
});
const valid = normalized.filter((row) => !row.error) as Array<Record<string, unknown>>;
const multi = valid.filter((row) => Number(row.category) === 1);
const reg = valid.filter((row) => Number(row.category) !== 1);
const out = {
  manifestSha256: manifest.sha256,
  multiHop: {
    B: pairedComparison(multi, "A", "B", eligible),
    D20max: pairedComparison(multi, "A", "D20max", eligible),
    D20rr: pairedComparison(multi, "A", "D20rr", eligible),
    D100max: pairedComparison(multi, "A", "D100max", eligible),
    D100rr: pairedComparison(multi, "A", "D100rr", eligible),
  },
  regression: {
    B: pairedComparison(reg, "A", "B", eligible),
    D20max: pairedComparison(reg, "A", "D20max", eligible),
    D100max: pairedComparison(reg, "A", "D100max", eligible),
  },
  textBudgetViews: {
    multiHop: {
      B: pairedComparison(multi, "A", "budgetB", eligible),
      D20max: pairedComparison(multi, "A", "budgetD20max", eligible),
      D100max: pairedComparison(multi, "A", "budgetD100max", eligible),
    },
    regression: {
      B: pairedComparison(reg, "A", "budgetB", eligible),
      D100max: pairedComparison(reg, "A", "budgetD100max", eligible),
    },
  },
};
const summaryPath = rowsPath.replace("rows.jsonl", "summary.recomputed.json");
writeFileSync(summaryPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
console.error(`summary written: ${summaryPath}`);
