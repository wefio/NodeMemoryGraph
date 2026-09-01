import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OmniMemEvalBridge } from "../../evals/omnimemeval/bridge.ts";
import { parsePythonLiteral } from "../../evals/retrieval/datasets.ts";
import { aggregateByCategory, scoreQuestion } from "../../evals/retrieval/score.ts";

test("retrieval pipeline smokes: ingest, shared fallback search, and score end to end", async () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-retrieval-eval-"));
  const bridge = new OmniMemEvalBridge(root);
  try {
    await bridge.handle({
      id: 1,
      op: "add",
      userId: "alice",
      conversationId: "session-1",
      messages: [
        { role: "user", content: "My telescope is named Kepler.", chat_time: "2026-07-20" },
        { role: "assistant", content: "Nice name. Why Kepler?", chat_time: "2026-07-20" },
        { role: "user", content: "Because I love exoplanets.", chat_time: "2026-07-20" },
      ],
    });
    const result = (await bridge.handle({
      id: 2,
      op: "search",
      userId: "alice",
      query: "What is my telescope called?",
      topK: 20,
    })) as { text: string; memories: Array<{ statement: string; evidenceExcerpt?: string }> };
    assert.ok(result.memories.length > 0, "expected at least one candidate");
    const scored = scoreQuestion(
      {
        category: "smoke",
        golds: ["My telescope is named Kepler."],
        candidates: result.memories.map((memory) =>
          [memory.statement, memory.evidenceExcerpt ?? ""].filter(Boolean),
        ),
        contextText: result.text,
      },
      "gold-in-candidate",
    );
    assert.deepEqual(scored.goldRanks, [1]);
    const metrics = aggregateByCategory([scored]);
    assert.equal(metrics["overall"]!.recallAt["20"], 1);
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("parsePythonLiteral parses BEAM-style probing dicts", () => {
  const parsed = parsePythonLiteral(
    "{'fact_recall': [{'question': 'It\\'s about \"x\", cost 42', 'source_chat_ids': [3, 7], 'ok': True, 'missing': None}]}",
  ) as Record<string, Array<Record<string, unknown>>>;
  const entry = parsed["fact_recall"]![0]!;
  assert.equal(entry["question"], "It's about \"x\", cost 42");
  assert.deepEqual(entry["source_chat_ids"], [3, 7]);
  assert.equal(entry["ok"], true);
  assert.equal(entry["missing"], null);
});
