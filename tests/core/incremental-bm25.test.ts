import assert from "node:assert/strict";
import test from "node:test";
import {
  ComputeMemoCache,
  INPUT_NODE_ID,
  findParetoOptimalGraphs,
  replaceGraphNode,
  runSyncGraphExperiments,
} from "../../src/core/compute-graph.ts";
import { IncrementalBm25Index } from "../../src/core/memory/incremental-bm25.ts";
import {
  DEFAULT_PIECEWISE_RERANK_GRAPH,
  HEAD_BM25F_R3_SUBGRAPH,
  HEAD_QTF_R3_SUBGRAPH,
  RERANK_COMPUTE_REGISTRY,
  createPiecewiseRerankGraph,
  type RerankCandidate,
  type RerankContext,
  type ScoredCandidateId,
} from "../../src/core/memory/piecewise-rerank.ts";

test("IncrementalBm25Index updates post/dl/total incrementally and recomputes N, avg, df at query time", () => {
  const index = new IncrementalBm25Index();
  assert.deepEqual(index.top("espresso", 5), []);

  // Phase 1: N = 2, "roast" appears in doc1 and doc2; "espresso" only in doc1.
  index.add("d1", "espresso grinder roast calibration");
  index.add("d2", "pour over roast profile");
  assert.equal(index.size, 2);
  assert.equal(index.dl.length, 2);
  assert.ok(index.total > 0);
  assert.equal(index.post.get("espresso")?.length, 1);

  const r1 = index.top("espresso roast", 5, { variant: "bm25", k1: 1.5, b: 0.75 });
  assert.equal(r1[0]?.id, "d1");
  const d2ScoreBefore = r1.find((x) => x.id === "d2")!.score;

  // Phase 2: Add unrelated documents; N grows from 2 -> 6 and avg shifts, boosting IDF("roast") dynamically!
  index.add("d3", "kubernetes cluster rollout monitoring");
  index.add("d4", "postgres database vacuum maintenance");
  index.add("d5", "tokyo travel itinerary shinkansen");
  index.add("d6", "typescript strict compiler config");
  assert.equal(index.size, 6);

  const r2 = index.top("espresso roast", 5, { variant: "bm25", k1: 1.5, b: 0.75 });
  const d2ScoreAfter = r2.find((x) => x.id === "d2")!.score;
  assert.ok(
    d2ScoreAfter > d2ScoreBefore,
    "Dynamic query-time N/df increase should raise IDF score",
  );

  // Duplicate doc id is rejected cleanly
  assert.throws(() => index.add("d1", "duplicate"), /already indexed/);
});

test("IncrementalBm25Index computes standard BM25, BM25L, BM25+, ATIRE BM25, and BM25+QTF accurately", () => {
  const idx = new IncrementalBm25Index();
  idx.add("short", "rarekeyword alpha");
  const filler = Array.from({ length: 120 }, (_, i) => `paddingword${i}`).join(" ");
  idx.add("long", `rarekeyword ${filler}`);

  const std = idx.top("rarekeyword", 2, { variant: "bm25", k1: 1.5, b: 0.75 });
  const bm25l = idx.top("rarekeyword", 2, { variant: "bm25l", k1: 1.5, b: 0.75, delta: 0.5 });
  const bm25p = idx.top("rarekeyword", 2, { variant: "bm25_plus", k1: 1.5, b: 0.75, delta: 1.0 });
  const atire = idx.top("rarekeyword", 2, { variant: "bm25_atire" });
  const qtf = idx.top("rarekeyword rarekeyword", 2, { variant: "bm25_qtf", k3: 8.0 });

  assert.equal(std[0]?.id, "short");
  assert.equal(bm25l[0]?.id, "short");
  assert.equal(bm25p[0]?.id, "short");
  assert.equal(atire[0]?.id, "short");
  assert.ok(
    qtf[0]!.score > std[0]!.score,
    "QTF saturation scales repeated query terms above single term",
  );

  // BM25+ guarantees long document lower bound >= idf * delta
  const longStd = std.find((x) => x.id === "long")!.score;
  const longPlus = bm25p.find((x) => x.id === "long")!.score;
  const idfExpected = Math.log(1 + (2 - 2 + 0.5) / (2 + 0.5));
  assert.ok(longPlus > longStd + idfExpected * 0.99);
});

test("incremental_bm25_score swaps into HEAD_BM25F_R3_SUBGRAPH and composes in Pareto sweeps", () => {
  const candidates: RerankCandidate[] = [
    {
      id: "c1",
      statement: "General weekly sync notes with teammates about coffee",
      combinedScore: 0.9,
      eventTime: "2026-10-01T10:00:00Z",
      sessionId: "s1",
      nodeId: "n1",
    },
    {
      id: "c2",
      statement: "Exact calibration steps for Eureka Atom espresso grinder burr alignment",
      combinedScore: 0.85,
      eventTime: "2026-10-02T10:00:00Z",
      sessionId: "s1",
      nodeId: "n2",
    },
    {
      id: "c3",
      statement: "Unrelated infrastructure deployment checklist",
      combinedScore: 0.8,
      eventTime: "2026-10-03T10:00:00Z",
      sessionId: "s2",
      nodeId: "n3",
    },
  ];
  const baseInput: ScoredCandidateId[] = candidates.map((c) => ({
    id: c.id,
    score: c.combinedScore,
  }));
  const context: RerankContext = {
    queryText: "espresso grinder burr alignment calibration",
    candidates,
  };

  const headStdBm25 = replaceGraphNode(HEAD_BM25F_R3_SUBGRAPH, "bm25f", {
    op: "incremental_bm25_score",
    params: { variant: "bm25", k1: 1.5, b: 0.75, weight: 0.15 },
  });
  const headBm25Plus = replaceGraphNode(HEAD_BM25F_R3_SUBGRAPH, "bm25f", {
    op: "incremental_bm25_score",
    params: { variant: "bm25_plus", k1: 1.5, b: 0.75, delta: 1.0, weight: 0.15 },
  });

  const gBm25 = replaceGraphNode(
    DEFAULT_PIECEWISE_RERANK_GRAPH,
    "head_r3",
    { op: "subgraph", subgraph: headStdBm25 },
    "G_INC_BM25",
  );
  const gBm25Plus = replaceGraphNode(
    DEFAULT_PIECEWISE_RERANK_GRAPH,
    "head_r3",
    { op: "subgraph", subgraph: headBm25Plus },
    "G_INC_BM25_PLUS",
  );

  const outcome = runSyncGraphExperiments(
    [{ ...DEFAULT_PIECEWISE_RERANK_GRAPH, id: "G_DEFAULT_BM25F" }, gBm25, gBm25Plus],
    RERANK_COMPUTE_REGISTRY,
    baseInput,
    context,
    new ComputeMemoCache(),
  );
  assert.ok(outcome.cacheHits >= 2, "Shared mid/tail subgraphs should hit ComputeMemoCache");
  assert.equal((outcome.results.get("G_INC_BM25") as string[])[0], "c2");
  assert.equal((outcome.results.get("G_INC_BM25_PLUS") as string[])[0], "c2");
  assert.ok(INPUT_NODE_ID.length > 0);
  const frontier = findParetoOptimalGraphs(
    [
      { id: "G_DEFAULT_BM25F", top1: 0, lat: 1 },
      { id: "G_INC_BM25", top1: 1, lat: 0.9 },
    ],
    [(x) => x.top1, (x) => -x.lat],
  );
  assert.deepEqual(
    frontier.map((x) => x.id),
    ["G_INC_BM25"],
  );
  const defaultHead = DEFAULT_PIECEWISE_RERANK_GRAPH.nodes.find((n) => n.id === "head_r3");
  assert.equal(defaultHead?.subgraph?.id, HEAD_QTF_R3_SUBGRAPH.id);
  assert.equal(defaultHead?.subgraph?.nodes[0]?.op, "incremental_bm25_score");
  assert.equal(defaultHead?.subgraph?.nodes[0]?.params?.variant, "bm25_qtf");
  const legacyBm25fGraph = createPiecewiseRerankGraph({ bm25fWeight: 0.1 });
  assert.equal(
    legacyBm25fGraph.nodes.find((n) => n.id === "head_r3")?.subgraph?.nodes[0]?.op,
    "bm25f_field_score",
  );
});
