import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  latestAutomaticRecallEvidence,
  officialRetrievalForMemoryIds,
} from "../../../evals/longmemeval/retrieval-evidence.ts";
import { NmgStore } from "../../../src/core/store.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("LongMemEval automatic recall evidence", () => {
  it("reconstructs injected headers and official session recall from the latest trace", () => {
    const directory = mkdtempSync(join(tmpdir(), "nmg-longmem-evidence-"));
    directories.push(directory);
    const store = new NmgStore(join(directory, "nmg.sqlite"));
    let memoryId = "";
    try {
      memoryId = store.remember({
        statement: "My personal best charity 5K time was 25:50.",
        nodeName: "Running records",
        sourceRef: "longmemeval:q-1:session-7:3",
        tier: 0,
      }).memory.id;
      store.searchContext("personal best charity 5K time", { limit: 8, maxTier: 1 });
    } finally {
      store.close();
    }

    const evidence = latestAutomaticRecallEvidence(directory, "q-1", ["session-7"]);

    assert.equal(evidence?.source, "automatic_headers");
    assert.match(evidence?.text ?? "", /25:50/);
    assert.deepEqual(evidence?.rankedSessionIds, ["session-7"]);
    assert.equal(evidence?.officialMetrics?.recallAny, 1);
    assert.equal(evidence?.officialMetrics?.recallAll, 1);
    assert.equal(
      officialRetrievalForMemoryIds(directory, [memoryId], "q-1", ["session-7"])?.recallAll,
      1,
    );
  });
});
