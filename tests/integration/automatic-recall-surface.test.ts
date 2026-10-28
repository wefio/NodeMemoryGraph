import assert from "node:assert/strict";
import test from "node:test";
import { prepareAutomaticRecallSurface } from "../../src/integration/agent-surface.ts";
import { compactSearchContext } from "../../src/integration/search-projection.ts";
import { confirmInformationOutput } from "../../src/integration/information-output.ts";
import { searchResultFixture } from "../helpers/search-result.ts";

test("automatic recall budgets wrappers and admits only whole source-bound previews", () => {
  const context = compactSearchContext({
    results: Array.from({ length: 80 }, (_, i) =>
      searchResultFixture(`memory-${i}`, "Exact private detail. ".repeat(40)),
    ),
    relations: [],
    activeGraph: { id: "graph" },
    retrieval: { mode: "lexical", degraded: true, reason: "embedding_unavailable" },
  } as never);
  const output = prepareAutomaticRecallSurface(context, {
    preamble: "Automatic candidates; retrieve exact evidence before use.",
    postamble: "Follow-up guidance ".repeat(40),
    maxCharacters: 2_000,
  });
  assert.ok(output.text.length <= 2_000);
  assert.ok(output.included.length > 0 && output.included.length < 80);
  assert.ok(output.omitted.length > 0);
  for (const entry of output.included) {
    assert.equal(entry.disclosure, "preview");
    assert.equal(entry.source.kind, "memory");
    if (entry.source.kind === "memory") {
      assert.equal(entry.source.activeGraphId, "graph");
      assert.match(output.text, new RegExp(`memory=${entry.source.memoryId}(?:;|\\s)`));
    }
  }
  for (const view of output.omitted) {
    if (view.source?.kind === "memory") assert.ok(!output.text.includes(view.body));
  }
  assert.match(output.text, /candidate preview; not exact evidence/);
  assert.match(output.text, /degraded retrieval/);
  assert.deepEqual(
    confirmInformationOutput(output, { sessionId: "s", text: output.text.slice(1) }).entries,
    [],
  );
});
