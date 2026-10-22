import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { renderTemporalEvidence } from "../../src/integration/temporal-evidence.ts";
import { projectAmlMemory } from "../../src/integration/aml-projection.ts";
import { renderEvidenceSurface, renderSearchSurface } from "../../src/integration/agent-surface.ts";
import { compactSearchContext } from "../../src/integration/search-projection.ts";
import { searchResultFixture } from "../helpers/search-result.ts";

const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/temporal-context.json", import.meta.url), "utf8"),
) as Array<{ query: string; content: string; time: string | null; dated: boolean }>;

for (const item of fixtures) {
  test(`shared temporal evidence: ${item.query} / ${item.content}`, () => {
    assert.equal(
      renderTemporalEvidence(item.content, item.time, item.query),
      item.dated ? `[Timestamp: ${item.time}] ${item.content}` : item.content,
    );
  });
}

test("temporal rendering is idempotent and does not rewrite source text", () => {
  const content = "[Timestamp: 2023-01-20] I visited yesterday.";
  assert.equal(renderTemporalEvidence(content, "2023-01-20", "When?"), content);
});

test("AML projection preserves historical time separately from storage creation", () => {
  const memory = searchResultFixture("historical", "I visited yesterday.").memory;
  memory.eventTime = "2023-01-20T16:04:00Z";
  memory.createdAt = "2026-10-22T00:00:00Z";
  const original = structuredClone(memory);
  const row = projectAmlMemory(memory, "Which museum?", 0.8);
  assert.equal(row.id, memory.id);
  assert.equal(row.score, 0.8);
  assert.equal(row.content, "[Timestamp: 2023-01-20T16:04:00Z] I visited yesterday.");
  assert.equal(row.event_time, memory.eventTime);
  assert.equal(row.created_at, memory.eventTime, "legacy AML alias remains historical");
  assert.equal(row.stored_at, memory.createdAt);
  assert.equal(row.raw_content, memory.statement);
  assert.deepEqual(memory, original);
});

test("AML never fabricates historical time from a new write's creation time", () => {
  const memory = searchResultFixture("unknown-time", "I visited yesterday.").memory;
  memory.eventTime = null;
  const row = projectAmlMemory(memory, "When?", 1);
  assert.equal(row.content, memory.statement);
  assert.equal(row.event_time, null);
  assert.equal(row.created_at, undefined);
});

test("AML exact text uses the shared withdrawal protection", () => {
  const memory = searchResultFixture("withdrawn", "private withdrawn statement").memory;
  memory.markers = [{ kind: "forget", attributes: {} }];
  const row = projectAmlMemory(memory, "When?", 1);
  assert.doesNotMatch(JSON.stringify(row), /private withdrawn statement/u);
});

test("ordinary NMG projections and evidence already retain eventTime", () => {
  const result = searchResultFixture("same-time", "The clinic is called Cedar.");
  result.memory.eventTime = "2023-01-20";
  const context = { results: [result], relations: [] };
  assert.equal(compactSearchContext(context).candidates[0].eventTime, "2023-01-20");
  assert.match(renderSearchSurface(context), /time=2023-01-20/u);
  assert.match(renderEvidenceSurface(context), /time=2023-01-20/u);
});
