import assert from "node:assert/strict";
import test from "node:test";

import {
  exactLookupAnchor,
  ftsIndexedText,
  rerankEqualScoresByQueryCoverage,
  searchTerms,
  surfaceTrigramExpression,
} from "../../../src/core/store/search-ranking.ts";

test("query coverage resolves lexical score ties without crossing score boundaries", () => {
  const candidates = [
    { id: "partial", score: 4, text: "Atlas project notes" },
    { id: "complete", score: 4, text: "Atlas project uses SQLite" },
    { id: "lower", score: 2, text: "Atlas project uses SQLite" },
  ];
  const rank = (items: typeof candidates) =>
    rerankEqualScoresByQueryCoverage(
      "Atlas project SQLite",
      items,
      (item) => item.score,
      (item) => item.text,
    );
  const ranked = rank(candidates);
  assert.deepEqual(
    ranked.map((item) => item.id),
    ["complete", "partial", "lower"],
  );
  assert.deepEqual(rank(ranked), ranked, "reranking is stable on repeated calls");
  assert.deepEqual(
    candidates.map((item) => item.id),
    ["partial", "complete", "lower"],
  );
});

test("searchTerms emits Han bigrams for 3- and 4-char Han tokens and mixed ASCII+Han tokens", () => {
  assert.deepEqual(searchTerms("记忆图谱"), ["记忆图谱", "记忆", "忆图", "图谱"]);
  assert.deepEqual(searchTerms("检索器"), ["检索器", "检索", "索器"]);
  assert.deepEqual(searchTerms("NMG记忆图谱"), ["NMG记忆图谱", "记忆", "忆图", "图谱"]);
});

test("surfaceTrigramExpression extracts verbatim anchors and 3+ Han runs without triggering prose exact lookup", () => {
  assert.equal(surfaceTrigramExpression("ordinary lexical prose"), "");
  assert.equal(surfaceTrigramExpression("图谱"), "");
  assert.equal(surfaceTrigramExpression('"exact phrase"'), '"exact phrase"');
  assert.equal(
    surfaceTrigramExpression("src/core/memory/sqlite-backend.ts"),
    '"src/core/memory/sqlite-backend.ts"',
  );
  assert.equal(surfaceTrigramExpression("v1.2.3"), '"v1.2.3"');
  assert.equal(surfaceTrigramExpression("ERR_CONNECTION_REFUSED"), '"err_connection_refused"');
  assert.equal(surfaceTrigramExpression("FulltextKnapsack"), '"fulltextknapsack"');
  assert.equal(surfaceTrigramExpression("记住 记忆图谱 和 检索器"), '"记忆图谱" OR "检索器"');
  assert.equal(surfaceTrigramExpression("Mention ONLY and ONLY four items."), "");
  assert.equal(surfaceTrigramExpression("Check summary: soon."), "");
  assert.equal(surfaceTrigramExpression(".env"), '".env"');
  assert.equal(surfaceTrigramExpression("OOM"), '"oom"');
  assert.equal(exactLookupAnchor("记忆图谱检索方案"), undefined);
});

test("CJK bigrams and trigram substring extraction cover Japanese kana and Korean Hangul", () => {
  const indexedJa = ftsIndexedText("記憶データベースを構築した").split(/\s+/u);
  assert.ok(indexedJa.includes("デー"));
  assert.ok(indexedJa.includes("ータ"));
  const indexedKo = ftsIndexedText("데이터베이스를실행했다").split(/\s+/u);
  assert.ok(indexedKo.includes("데이"));
  assert.ok(indexedKo.includes("이터"));

  assert.deepEqual(searchTerms("データベース"), [
    "データベース",
    "デー",
    "ータ",
    "タベ",
    "ベー",
    "ース",
  ]);
  assert.deepEqual(searchTerms("데이터베이스"), [
    "데이터베이스",
    "데이",
    "이터",
    "터베",
    "베이",
    "이스",
  ]);
  assert.equal(surfaceTrigramExpression("記憶データベース"), '"記憶データベース"');
  assert.equal(surfaceTrigramExpression("검색엔진"), '"검색엔진"');
});
