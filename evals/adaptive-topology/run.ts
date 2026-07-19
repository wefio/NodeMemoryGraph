import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { NmgStore } from "../../src/core/store.ts";
import type { VectorEmbedder } from "../../src/core/types.ts";

const cases = Math.max(5, Number.parseInt(process.env.NMG_ADAPTIVE_CASES ?? "30", 10));
const totals = {
  flatRecall: 0,
  fixedRecall: 0,
  adaptiveRecall: 0,
  heuristicRoute: 0,
  learnedRoute: 0,
  proposals: 0,
  falseProposals: 0,
};
const latency = { flat: [] as number[], fixed: [] as number[], adaptive: [] as number[] };

for (let index = 0; index < cases; index += 1) {
  const directory = mkdtempSync(join(tmpdir(), "nmg-adaptive-eval-"));
  const embedder: VectorEmbedder = {
    model: `controlled-${index}`,
    dimensions: 2,
    embed(text) {
      return text.includes(`route-${index}`) ? [1, 0] : [0, 1];
    },
  };
  const store = new NmgStore(join(directory, "nmg.sqlite"), embedder);
  try {
    const entry = store.remember({
      statement: `route-${index} identifies the relevant project`,
      nodeName: `Entry ${index}`,
      memoryType: "fact",
      tier: 0,
    });
    const evidence = store.remember({
      statement: `The held-out answer is value-${index}`,
      nodeName: `Evidence ${index}`,
      memoryType: "fact",
      tier: 2,
    });
    const query = `route-${index}`;

    let started = performance.now();
    const flat = store.search(query, { maxTier: 3, limit: 4, retrievalMode: "hashing" });
    latency.flat.push(performance.now() - started);
    totals.flatRecall += Number(flat.some((result) => result.memory.id === evidence.memory.id));

    started = performance.now();
    const fixed = store.searchContext(query, { maxTier: 3, limit: 4, graphHops: 0 });
    latency.fixed.push(performance.now() - started);
    totals.fixedRecall += Number(fixed.results.some(
      (result) => result.memory.id === evidence.memory.id,
    ));

    totals.heuristicRoute += Number(store.routeNodes(query, 1)[0]?.node.id === evidence.node.id);
    for (let observation = 0; observation < 3; observation += 1) {
      store.recordRetrievalTrace({
        query: `${query} observation ${observation}`,
        resultMemoryIds: [entry.memory.id, evidence.memory.id],
        resultNodeIds: [entry.node.id, evidence.node.id],
        usefulMemoryIds: [entry.memory.id, evidence.memory.id],
      });
    }
    const proposals = store.proposeTopologyChanges({
      minObservations: 3,
      minGain: 0.7,
      cooldownMs: 60_000,
    });
    const link = proposals.find((proposal) => proposal.type === "link");
    totals.proposals += Number(Boolean(link));
    totals.falseProposals += proposals.filter((proposal) =>
      proposal.type !== "link" || !proposal.sourceNodeIds.includes(entry.node.id) ||
      !proposal.sourceNodeIds.includes(evidence.node.id)).length;
    if (link) store.reviewTopologyProposal(link.id, "accept");

    started = performance.now();
    const adaptive = store.searchContext(query, { maxTier: 3, limit: 4, graphHops: 1 });
    latency.adaptive.push(performance.now() - started);
    totals.adaptiveRecall += Number(adaptive.results.some(
      (result) => result.memory.id === evidence.memory.id,
    ));

    for (let label = 0; label < 3; label += 1) store.trainRouter(query, [evidence.node.id]);
    totals.learnedRoute += Number(store.routeNodes(query, 1)[0]?.node.id === evidence.node.id);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const report = {
  cases,
  recall: {
    flat: totals.flatRecall / cases,
    fixedGraph: totals.fixedRecall / cases,
    adaptiveGraph: totals.adaptiveRecall / cases,
  },
  routingAccuracy: {
    heuristic: totals.heuristicRoute / cases,
    learnedAfterLabels: totals.learnedRoute / cases,
  },
  proposalPrecision: totals.proposals === 0
    ? 0
    : (totals.proposals - totals.falseProposals) / totals.proposals,
  latencyMs: {
    flatP50: percentile(latency.flat, 0.5),
    fixedP50: percentile(latency.fixed, 0.5),
    adaptiveP50: percentile(latency.adaptive, 0.5),
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.recall.adaptiveGraph <= report.recall.fixedGraph ||
    report.routingAccuracy.learnedAfterLabels <= report.routingAccuracy.heuristic ||
    report.proposalPrecision < 1) {
  process.exitCode = 1;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}
