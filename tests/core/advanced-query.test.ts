import test from "node:test";
import assert from "node:assert/strict";

import { applyAdvancedFilters, extractEventWindow, parseAdvancedQuery } from "../../src/core/store/advanced-query.ts";

function fakeResult(overrides: {
  statement: string;
  memoryType?: string;
  stateKey?: string | null;
  eventTime?: string | null;
  canonicalName?: string;
}) {
  return {
    memory: {
      statement: overrides.statement,
      memoryType: overrides.memoryType ?? "fact",
      stateKey: overrides.stateKey ?? null,
      eventTime: overrides.eventTime ?? null,
    },
    node: { canonicalName: overrides.canonicalName ?? "node" },
  };
}

test("parseAdvancedQuery keeps plain natural language intact", () => {
  const parsed = parseAdvancedQuery("迈阿密 酒店 推荐");
  assert.equal(parsed.semantic, "迈阿密 酒店 推荐");
  assert.deepEqual(parsed.filters.excludeTerms, []);
});

test("parseAdvancedQuery extracts type list filter", () => {
  const parsed = parseAdvancedQuery("迈阿密 酒店 type:preference,constraint");
  assert.equal(parsed.semantic, "迈阿密 酒店");
  assert.deepEqual(parsed.filters.types, ["preference", "constraint"]);
});

test("parseAdvancedQuery extracts node filter with quoted value", () => {
  const parsed = parseAdvancedQuery('node:"Conversation a1b2" 潜水');
  assert.equal(parsed.semantic, "潜水");
  assert.deepEqual(parsed.filters.nodeNames, ["Conversation a1b2"]);
});

test("parseAdvancedQuery extracts state key and time range", () => {
  const parsed = parseAdvancedQuery("航班 time:2026-01-01..2026-06-30 state:travel_pref");
  assert.equal(parsed.semantic, "航班");
  assert.deepEqual(parsed.filters.stateKeys, ["travel_pref"]);
  assert.equal(parsed.filters.eventTimeFrom, "2026-01-01");
  assert.equal(parsed.filters.eventTimeTo, "2026-06-30");
});

test("parseAdvancedQuery collects -exclusions and strips them", () => {
  const parsed = parseAdvancedQuery("餐厅 -快餐 -外卖");
  assert.equal(parsed.semantic, "餐厅");
  assert.deepEqual(parsed.filters.excludeTerms, ["快餐", "外卖"]);
});

test("parseAdvancedQuery quoted phrase stays in semantic text", () => {
  const parsed = parseAdvancedQuery('"滨海 大道" 跑步');
  assert.ok(parsed.semantic.includes("滨海 大道"));
});

test("applyAdvancedFilters filters by type and node", () => {
  const results = [
    fakeResult({ statement: "喜欢日料", memoryType: "preference" }),
    fakeResult({ statement: "去过东京", memoryType: "event", canonicalName: "Conversation abc" }),
  ];
  const byType = applyAdvancedFilters(results, { types: ["preference"], excludeTerms: [] });
  assert.equal(byType.length, 1);
  assert.equal(byType[0].memory.memoryType, "preference");
  const byNode = applyAdvancedFilters(results, { nodeNames: ["conversation abc"], excludeTerms: [] });
  assert.equal(byNode.length, 1);
  assert.equal(byNode[0].memory.statement, "去过东京");
});

test("applyAdvancedFilters filters by time range and exclusions", () => {
  const results = [
    fakeResult({ statement: "五月去了京都", eventTime: "2026-05-01" }),
    fakeResult({ statement: "一月去了北海道", eventTime: "2026-01-15" }),
    fakeResult({ statement: "订了快餐外卖", eventTime: "2026-03-01" }),
  ];
  const ranged = applyAdvancedFilters(results, {
    excludeTerms: [],
    eventTimeFrom: "2026-02-01",
    eventTimeTo: "2026-06-30",
  });
  assert.deepEqual(ranged.map((r) => r.memory.statement), ["五月去了京都", "订了快餐外卖"]);
  const excluded = applyAdvancedFilters(results, { excludeTerms: ["快餐"], types: undefined });
  assert.equal(excluded.length, 2);
  assert.ok(!excluded.some((r) => r.memory.statement.includes("快餐")));
});

test("extractEventWindow: as of <date> → inclusive through that day", () => {
  const w = extractEventWindow("What is Martin Mark's current mental health status as of Mar 10, 2029?");
  assert.equal(w.to, "2029-03-11");
  assert.equal(w.from, undefined);
});

test("extractEventWindow: on <date> → that exact day", () => {
  const w = extractEventWindow("What sports activity did Donald engage in on September 13, 2029?");
  assert.equal(w.from, "2029-09-13");
  assert.equal(w.to, "2029-09-14");
});

test("extractEventWindow: from <d1> to <d2> → range", () => {
  const w = extractEventWindow("How did Karen's motivation evolve from February 28, 2035, to February 28, 2036?");
  assert.equal(w.from, "2035-02-28");
  assert.equal(w.to, "2036-02-29");
});

test("extractEventWindow: ISO date + after", () => {
  assert.deepEqual(extractEventWindow("events after 2029-05-20"), { from: "2029-05-20" });
});

test("extractEventWindow: no date → empty", () => {
  assert.deepEqual(extractEventWindow("What is the person's name?"), {});
});

test("parseAdvancedQuery: explicit time: wins over natural language", () => {
  const p = parseAdvancedQuery("mental health time:2029-01-01..2029-06-30 as of Mar 10, 2029");
  assert.equal(p.filters.eventTimeFrom, "2029-01-01");
  assert.equal(p.filters.eventTimeTo, "2029-06-30");
});

test("parseAdvancedQuery: applies natural date", () => {
  const p = parseAdvancedQuery("What is the status as of Mar 10, 2029?");
  assert.equal(p.filters.eventTimeTo, "2029-03-11");
});
