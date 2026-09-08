import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { NmgStore } from "../src/core/store.ts";
import { searchMemoryContext } from "../src/integration/search.ts";
import {
  executeProbeRow,
  summarizeProbe,
  type RecallProbeRow,
} from "../src/lab/recall-probe.ts";

/**
 * Deterministic controlled recall probe over a store snapshot.
 *
 * Opens an NmgStore snapshot (not the live daemon store), runs real retrieval
 * — lexically, so no embedding provider is needed and results are deterministic
 * — for each manifest row {query, expectMemoryId, variants?}, and reports
 * whether each trigger recalls its memory (on_target/gap) and stays robust
 * under controlled perturbation. No external gold, no LLM, no judge.
 *
 * Usage:
 *   node tools/recall-probe.ts --store <nmg.sqlite> --manifest <rows.json> [--out DIR]
 *
 * manifest: [ { "groupId": "…", "query": "…", "expectMemoryId": "…", "variants": ["…"] } ]
 */

function readRows(path: string): RecallProbeRow[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as RecallProbeRow[];
  return parsed.map((row) => ({ variants: [], ...row }));
}

async function main(argv: string[]): Promise<number> {
  let storePath: string | undefined;
  let manifestPath: string | undefined;
  let outDir: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--store") storePath = argv[++index];
    else if (argument === "--manifest") manifestPath = argv[++index];
    else if (argument === "--out") outDir = argv[++index];
    else if (argument === "--json") json = true;
  }
  if (!storePath || !manifestPath) {
    process.stderr.write(
      "usage: recall-probe --store <nmg.sqlite> --manifest <rows.json> [--out DIR] [--json]\n",
    );
    return 2;
  }
  const rows = readRows(resolve(manifestPath));
  const store = new NmgStore(resolve(storePath));
  const retrieve = async (query: string): Promise<string[]> => {
    const context = await searchMemoryContext(store, undefined, query, {});
    return (context.results ?? []).map((result) => result.memory.id);
  };
  const executions = [];
  for (const row of rows) {
    executions.push(await executeProbeRow(row, retrieve));
  }
  const summary = summarizeProbe(executions);
  const report = { executions, summary };
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "recall-probe.json"), JSON.stringify(report, null, 2), "utf8");
  }
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(
      `rows=${executions.length} gaps=[${summary.gaps.join(",")}] ` +
        `robust=[${summary.robust.join(",")}] fragile=${summary.fragile.length}\n`,
    );
    for (const fragile of summary.fragile) {
      process.stdout.write(`  fragile ${fragile.groupId} under: ${fragile.failedVariants.join(" | ")}\n`);
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      process.stderr.write(`${error}\n`);
      process.exitCode = 1;
    },
  );
}
