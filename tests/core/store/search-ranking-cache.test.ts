import assert from "node:assert/strict";
import { test } from "node:test";
import { lexicalScore, searchTerms } from "../../../src/core/store/search-ranking.ts";

const rows = [
  {
    m_statement: "The Cedar museum opens next week.",
    n_canonical_name: "Cedar",
    n_summary: "museum",
    m_markers_json: "[]",
  },
  {
    m_statement: "A blue circle in the diagram.",
    n_canonical_name: "diagram",
    n_summary: "",
    m_markers_json: "[]",
  },
  {
    m_statement: "诊所明天开业。",
    n_canonical_name: "诊所",
    n_summary: "开业",
    m_markers_json: "[]",
  },
];

for (const query of ["cedar museum", "blue circle", "诊所 开业", "next week", "qxvnotfound", ""]) {
  test(`prepared query terms preserve exact lexical scores and ordering: ${query}`, () => {
    const prepared = Object.freeze(searchTerms(query));
    const original = [...prepared];
    const fallback = rows.map((row) => lexicalScore(query, row));
    const reused = rows.map((row) => lexicalScore(query, row, prepared));
    assert.deepEqual(reused, fallback);
    assert.deepEqual([...prepared], original);
    const order = (scores: number[]) =>
      scores
        .map((score, index) => ({ score, index }))
        .sort((a, b) => b.score - a.score || a.index - b.index);
    assert.deepEqual(order(reused), order(fallback));
  });
}
