import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatMemoryContext,
  formatRecallIndex,
  formatResidentKernel,
} from "../.pi/extensions/nmg/index.ts";
import { decideMemoryLoad, NmgStore } from "../src/index.ts";

const directory = mkdtempSync(join(tmpdir(), "nmg-recall-compression-"));
const store = new NmgStore(join(directory, "nmg.sqlite"));
try {
  const memories = [
    ["Project Atlas runtime", "Project Atlas currently uses Python 3.12.4 for its data-processing services."],
    ["Project Atlas database", "Project Atlas stores local development state in SQLite and production state in PostgreSQL."],
    ["Project Atlas deployment", "Project Atlas deploys through a staged Windows-to-Linux container workflow."],
    ["Project Atlas testing", "Project Atlas requires unit, integration, and cross-session memory tests before release."],
    ["Project Atlas preference", "The user prefers concise Chinese explanations for Project Atlas architecture decisions."],
    ["Project Atlas history", "Project Atlas previously evaluated several agent harnesses before selecting Pi."],
    ["Project Atlas indexing", "Project Atlas combines lexical, vector, graph, and learned-route retrieval scores."],
    ["Project Atlas maintenance", "Project Atlas batches memory-tier maintenance instead of rebuilding after every access."],
  ] as const;
  for (const [nodeName, statement] of memories) {
    store.remember({ nodeName, statement, tier: 1 });
  }
  store.remember({
    nodeName: "Project Atlas release constraint",
    statement: "Project Atlas must pass tests before release.",
    memoryType: "constraint",
    tier: 0,
    importance: 0.9,
  });

  const explicitQuery = "What did we decide before for Project Atlas?";
  const recommendationQuery = "How should we plan the next Project Atlas release?";
  const ordinaryQuery = "Explain how a B-tree works.";
  const full = formatMemoryContext(store.searchContext(explicitQuery, {
    maxTier: 1,
    limit: 8,
    graphHops: 1,
  }));
  const compressed = formatRecallIndex(store.recallCues(recommendationQuery, { limit: 5 }));
  const kernel = formatResidentKernel(store.residentKernel());
  const report = {
    decisions: {
      explicit: decideMemoryLoad(explicitQuery).mode,
      recommendation: decideMemoryLoad(recommendationQuery).mode,
      ordinary: decideMemoryLoad(ordinaryQuery).mode,
    },
    residentKernelCharacters: kernel.length,
    fullCharacters: full.length,
    recallCueCharacters: compressed.length,
    approximateFullTokens: Math.ceil(full.length / 4),
    approximateRecallCueTokens: Math.ceil(compressed.length / 4),
    reduction: full.length === 0 ? 0 : 1 - compressed.length / full.length,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
