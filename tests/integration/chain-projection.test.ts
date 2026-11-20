import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryContext } from "../../src/core/types.ts";
import { searchResultFixture } from "../helpers/search-result.ts";
import {
  projectLogicalChains,
  projectTemporalChain,
} from "../../src/integration/chain-projection.ts";

function logicalChainContext(): MemoryContext {
  const chainId = "logical-merge";
  const result = (id: string, statement: string, position: number) => ({
    ...searchResultFixture(id, statement),
    chainMemberships: [
      { chainId, position, chainType: "logical" as const, topic: "Atlas merge evidence" },
    ],
  });

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

test("time chains group equal dates, compare offsets, and keep unresolved time separate", () => {
  const times = [
    "2026-08-20T15:00:00.000Z",
    "2026-08-20T12:00:00+02:00",
    "2026-08-20T15:00:00Z",
    "last week",
    "2023/05/28 (Sun) 02:37",
    null,
  ];
  const results = times.map((time, i) => {
    const result = searchResultFixture(String(i), "Evidence");
    result.memory.eventTime = time;
    return result;
  });
  const timeline = projectTemporalChain(results.map(({ memory }) => memory));
  assert.equal(
    timeline.text,
    [
      "Event time:",
      "2023-05-28 02:37 E",
      "2026-08-20T12:00+02:00 B",
      "2026-08-20T15:00Z A,C",
      "Unresolved event time by record:",
      "last week D",
    ].join("\n"),
  );
  assert.deepEqual([...timeline.labels.values()], ["A", "B", "C", "D", "E"]);
});
