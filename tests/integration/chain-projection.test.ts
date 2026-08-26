import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryContext } from "../../src/core/types.ts";
import { projectLogicalChains } from "../../src/integration/chain-projection.ts";

function logicalChainContext(): MemoryContext {
  const chainId = "logical-merge";
  const result = (id: string, statement: string, position: number) =>
    ({
      memory: {
        id,
        statement,
        memoryType: "fact",
        tier: 1,
        truthStatus: "asserted",
        scope: { project: "atlas" },
      },
      node: { canonicalName: `Atlas ${id}` },
      evidence: { content: statement },
      chainMemberships: [
        { chainId, position, chainType: "logical", topic: "Atlas merge evidence" },
      ],
    }) as MemoryContext["results"][number];

  return {
    results: [
      result("memory-a", "Atlas input A is available.", 0),
      result("memory-b", "Atlas combines both inputs.", 2),
      result("memory-c", "Atlas input C is available.", 1),
    ],
    relations: [],
    chainEdges: [
      { chainId, sourceMemoryId: "memory-a", targetMemoryId: "memory-b", edgeType: "order" },
      { chainId, sourceMemoryId: "memory-c", targetMemoryId: "memory-b", edgeType: "order" },
    ],
  };
}

test("shared logical-chain projection deduplicates converging evidence", () => {
  const projection = projectLogicalChains(logicalChainContext());

  assert.deepEqual(Object.fromEntries(projection.labels), {
    "memory-a": "A",
    "memory-b": "B",
    "memory-c": "C",
  });
  assert.equal(projection.chains.length, 1);
  assert.equal(projection.chains[0]?.topic, "Atlas merge evidence");
  assert.deepEqual(projection.chains[0]?.lines, ["A & C --> B"]);
  assert.match(projection.text, /<nmg_logical_chains>/u);
  assert.doesNotMatch(projection.text, /Atlas input A/u);
});

test("shared logical-chain projection can be disabled without affecting evidence", () => {
  const projection = projectLogicalChains(logicalChainContext(), 0);

  assert.equal(projection.text, "");
  assert.equal(projection.chains.length, 0);
  assert.equal(projection.labels.size, 0);
});
