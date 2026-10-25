import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateResultTokens,
  selectWithinActiveGraphBudget,
} from "../../src/core/store/active-graph.ts";
import { SOURCE_EXCERPT_CHARS } from "../../src/integration/agent-surface.ts";
import type { MemorySearchResult } from "../../src/core/types.ts";

function result(
  overrides: {
    statement?: string;
    summary?: string;
    evidence?: string;
  } = {},
): MemorySearchResult {
  return {
    memory: {
      id: "m1",
      nodeId: "n1",
      evidenceId: "e1",
      evidenceIds: ["e1"],
      statement: overrides.statement ?? "x".repeat(1_000),
      markers: [],
      eventTime: "2023-05-30T00:00:00+00:00",
      memoryType: "fact",
      truthStatus: "asserted",
      scope: { userId: "u1" },
    },
    node: {
      id: "n1",
      canonicalName: "batch-abc",
      summary: overrides.summary ?? "s".repeat(1_500),
    },
    evidence: {
      id: "e1",
      sourceRef: "ref",
      content: overrides.evidence ?? "e".repeat(3_000),
    },
    score: 1,
    combinedScore: 1,
  } as unknown as MemorySearchResult;
}

const budget = {
  maxNodes: 20,
  maxEdges: 40,
  maxEvidence: 20,
  maxTokens: 6_000,
  maxGraphHops: 2,
  maxLocalTier: 2,
  maxTierBudget: 20,
  maxLatencyMs: 5_000,
} as const;

test("a node summary the surface never prints does not consume budget", () => {
  // The evidence surface prints statement, a details line, and at most a
  // SOURCE excerpt. Node summaries are node-level metadata shared by every
  // record of that node, so charging them per record multiplied them by the
  // node's record count and crowded the page: measured on LongMemEval, a 6,000
  // token budget returned 6.9 records instead of the ~16 the rendered text
  // allows.
  const small = estimateResultTokens(result({ summary: "s".repeat(10) }));
  const huge = estimateResultTokens(result({ summary: "s".repeat(50_000) }));
  assert.equal(huge, small);
});

test("source evidence is charged at the rendered excerpt, not in full", () => {
  const rendered = estimateResultTokens(result({ evidence: "e".repeat(SOURCE_EXCERPT_CHARS) }));
  const full = estimateResultTokens(result({ evidence: "e".repeat(50_000) }));
  assert.equal(full, rendered);
});

test("evidence identical to the statement costs no extra source line", () => {
  const statement = "x".repeat(400);
  const same = estimateResultTokens(result({ statement, evidence: statement }));
  const longer = estimateResultTokens(result({ statement, evidence: "e".repeat(400) }));
  assert.ok(same < longer);
});

test("a 6,000 token budget fits a full page when records are rendered-sized", () => {
  const candidates = Array.from({ length: 20 }, (_, index) => {
    const candidate = result();
    (candidate.memory as { id: string }).id = `m${index}`;
    return candidate;
  });
  const selection = selectWithinActiveGraphBudget(candidates, budget, 20);
  // 1,000-char statement + excerpt + details is roughly 370 tokens, so the
  // budget must admit the whole page rather than ~7 records.
  assert.ok(
    selection.results.length >= 15,
    `expected at least 15 records, got ${selection.results.length}`,
  );
});
