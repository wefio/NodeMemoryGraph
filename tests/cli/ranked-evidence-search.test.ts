import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PortableMemoryService } from "../../src/cli/portable-memory.ts";
import type { EvidenceRankingCandidate } from "../../src/core/memory/evidence-ranking.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

for (const kind of ["sqlite", "lancedb"] as const) {
  test(
    kind + ": portable memory ranks the whole shortlist before applying the page limit",
    async (t) => {
      const directory = mkdtempSync(join(tmpdir(), "nmg-ranked-page-"));
      const options =
        kind === "sqlite"
          ? { kind, path: join(directory, "memory.sqlite"), namespace: "rank" }
          : { kind, uri: join(directory, "lancedb"), namespace: "rank" };
      const batches: EvidenceRankingCandidate[][] = [];
      let failing = false;
      let preferred = "";
      const service = new PortableMemoryService(options, false, undefined, undefined, {
        async score(query, candidates) {
          assert.equal(query, "inventory");
          batches.push([...candidates]);
          if (failing) return [Number.NaN];
          return candidates.map((row) => (row.source === preferred ? 1 : 0.001));
        },
      });
      const baseline = new PortableMemoryService(options);
      t.after(async () => {
        await baseline.close();
        await service.close();
        removeTempDirectory(directory);
      });
      const entries = [
        "Inventory list contains paper clips",
        "Inventory list contains shipping labels",
        "Inventory list contains mailing envelopes",
        "Inventory list contains spare tape",
        "Inventory list contains preferred cardboard boxes",
        "Inventory list contains office folders",
      ];
      await service.rememberMany(
        entries.map((statement, i) => ({
          nodeName: `supply ${i}`,
          statement,
          scope: { project: "atlas" },
        })),
      );
      const before = await baseline.search({ query: "inventory", scope: { project: "atlas" } });
      preferred = before.results.at(-1)!.evidence.content;
      const current = await service.search({
        query: "inventory",
        scope: { project: "atlas" },
        limit: 4,
      });
      const ids = (value: typeof before) => value.results.map((row) => row.memory.id);
      assert.equal(batches.length, 1);
      assert.equal(batches[0]!.length, before.results.length);
      assert.equal(current.results[0]?.evidence.content, preferred);
      assert.equal(current.results.length, 4);

      const single = await service.search({
        query: "inventory",
        scope: { project: "atlas" },
        limit: 1,
      });
      assert.equal(batches.length, 2);
      assert.equal(batches[1]!.length, before.results.length);
      assert.deepEqual(ids(single), [current.results[0]!.memory.id]);

      failing = true;
      const fallback = await service.search({
        query: "inventory",
        scope: { project: "atlas" },
        limit: 4,
      });
      assert.equal(fallback.evidencePage?.ranked, false);
      assert.equal(fallback.retrieval?.reason, "evidence_reranker_unavailable");
      assert.deepEqual(ids(fallback).slice(0, 3), ids(before).slice(0, 3));

      const [entry] = current.results;
      const evidence = await service.get({ memoryIds: [entry!.memory.id] });
      assert.deepEqual(evidence.results[0]?.evidence, entry!.evidence);
    },
  );
}
