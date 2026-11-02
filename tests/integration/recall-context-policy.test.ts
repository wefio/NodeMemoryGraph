import assert from "node:assert/strict";
import test from "node:test";
import { RecallContextPolicy } from "../../src/integration/recall-context-policy.ts";
import { searchResultFixture } from "../helpers/search-result.ts";
import { compactSearchContext } from "../../src/integration/search-projection.ts";
import { prepareAutomaticRecallSurface } from "../../src/integration/agent-surface.ts";
import type { MemoryContext } from "../../src/core/types.ts";

test("contextual ordering preserves recall@20 membership, follows continuations and releases old topics", () => {
  const policy = new RecallContextPolicy();
  const results = Array.from({ length: 20 }, (_, i) =>
    searchResultFixture(
      String(i),
      i === 18
        ? "哲学自由与责任 philosophy freedom responsibility"
        : "v2t 验收 sha256 token statistics",
    ),
  );
  policy.observe("s", "v2t 验收 token statistics", "/a");
  policy.observe("s", "哲学中的自由与责任 philosophy freedom responsibility", "/a");
  const ranked = policy.rank("s", "/a", "哲学中的自由与责任", results);
  assert.equal(ranked[0]?.memory.id, "18");
  assert.deepEqual(
    new Set(ranked.map((r) => r.memory.id)),
    new Set(results.map((r) => r.memory.id)),
  );
  assert.equal(policy.rank("s", "/a", "继续", results)[0]?.memory.id, "18");
  assert.deepEqual(
    results.map((r) => r.memory.id),
    Array.from({ length: 20 }, (_, i) => String(i)),
  );
  assert.equal(policy.rank("s", "/other", "继续", results)[0]?.memory.id, "0");
  assert.equal(policy.rank("other", "/a", "继续", results)[0]?.memory.id, "0");
});

test("display profiles change only admitted views and remain session-local ephemeral settings", () => {
  const policy = new RecallContextPolicy();
  assert.equal(policy.mode("s"), "compact");
  policy.setMode("s", "full");
  assert.equal(policy.mode("s"), "full");
  assert.equal(policy.mode("other"), "compact");
  assert.equal(new RecallContextPolicy().mode("s"), "compact");
  for (let i = 0; i < 40; i++) policy.observe(`extra-${i}`, "Different context", "/a");
  assert.equal(
    policy.mode("s"),
    "full",
    "context eviction must not reset explicit display settings",
  );
  const context: MemoryContext = {
    results: Array.from({ length: 20 }, (_, i) => searchResultFixture(String(i), "😀".repeat(400))),
    relations: [],
  };
  const brief = prepareAutomaticRecallSurface(
    compactSearchContext({ ...context, recallDisplayMode: "compact" }),
  );
  const full = prepareAutomaticRecallSurface(
    compactSearchContext({ ...context, recallDisplayMode: "full" }),
  );
  assert.equal(brief.included.length, 10);
  assert.ok(brief.text.length < full.text.length);
  assert.ok(!brief.text.includes("😀".repeat(160)));
  assert.ok(full.text.includes("😀".repeat(400)));
  assert.ok(brief.included.every((entry) => entry.disclosure === "preview"));
  assert.equal(context.results.length, 20);
  const withdrawn = searchResultFixture("withdrawn", "Sensitive withdrawn detail");
  withdrawn.memory.markers.push({ kind: "forget" });
  const redacted = prepareAutomaticRecallSurface(
    compactSearchContext({ results: [withdrawn], relations: [], recallDisplayMode: "full" }),
  );
  assert.doesNotMatch(redacted.text, /Sensitive withdrawn detail/);
  policy.clear("s");
  assert.equal(policy.mode("s"), "compact");
});
