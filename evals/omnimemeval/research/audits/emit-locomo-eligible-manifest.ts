// Emit the frozen eligible-question manifest for the LoCoMo zero-LLM probes.
//
// Writes evals/locomo/results/locomo-eligible-manifest.json: the eligible
// question-ID projection (every atomic evidence label resolves to an existing
// turn, official semicolon/comma splitting), the excluded questions with their
// missing labels, per-category counts, and the sha256 identity of the ID set.
// All arms (baseline, depth, neighbor) must score on exactly this projection.
//
// Usage: node --experimental-strip-types evals/omnimemeval/research/audits/emit-locomo-eligible-manifest.ts

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvironmentFile } from "../../../local-env.ts";
import { loadLocomo } from "../../../benchmarks/loaders.ts";
import { buildEligibilityManifest } from "./locomo-audit-shared.ts";

const root = resolve(import.meta.dirname, "../../../..");
const env = loadEnvironmentFile(resolve(root, ".env.nmg-locomo-audit"));
const dataPath = [
  env.NMG_LOCOMO_DATA,
  resolve(root, ".benchmarks/official/LoCoMo/data/locomo10.json"),
].find((path) => path && existsSync(path));
if (!dataPath) throw new Error("locomo10.json not found (set NMG_LOCOMO_DATA)");

const cases = loadLocomo(dataPath);
const manifest = buildEligibilityManifest(cases);
const byCategory: Record<string, number> = {};
for (const item of cases) {
  if (!manifest.eligibleIds.includes(item.id)) continue;
  const category = String(item.officialMetadata.category);
  byCategory[category] = (byCategory[category] ?? 0) + 1;
}
const artifact = {
  ...manifest,
  eligibleByCategory: byCategory,
  totalQuestions: cases.length,
  dataset: dataPath,
  generatedAt: new Date().toISOString(),
};
const output = resolve(root, "evals/locomo/results", "locomo-eligible-manifest.json");
writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      output,
      eligible: manifest.eligibleIds.length,
      excluded: manifest.excluded.length,
      eligibleByCategory: byCategory,
      sha256: manifest.sha256,
    },
    null,
    2,
  ),
);
