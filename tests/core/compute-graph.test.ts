import assert from "node:assert/strict";
import test from "node:test";
import {
  ComputeMemoCache,
  ComputeRegistry,
  INPUT_NODE_ID,
  diffGraphSpecs,
  evaluateSyncComputeGraph,
  executeComputeGraph,
  findParetoOptimalGraphs,
  graphAsOperator,
  replaceGraphNode,
  runGraphExperiments,
  runSyncGraphExperiments,
  type ComputeGraphSpec,
} from "../../src/core/compute-graph.ts";

test("compute graph runs hierarchical subgraphs as operators and inline subgraph nodes", async () => {
  const counts = { scale: 0, offset: 0, merge: 0 };
  const registry = new ComputeRegistry<{ bias: number }>()
    .register("scale", (inputs, _ctx, params) => {
      counts.scale += 1;
      const base = inputs.default as number;
      return base * Number(params.factor ?? 1);
    })
    .register("offset", (inputs, ctx, params) => {
      counts.offset += 1;
      const base = inputs.default as number;
      return base + ctx.bias + Number(params.delta ?? 0);
    })
    .register("merge", (inputs) => {
      counts.merge += 1;
      return Number(inputs.left) + Number(inputs.right);
    });

  const childGraph: ComputeGraphSpec = {
    id: "child-affine",
    nodes: [
      { id: "mul", op: "scale", params: { factor: 3 } },
      { id: "add", op: "offset", params: { delta: 4 } },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "mul" },
      { from: "mul", to: "add" },
    ],
    output: "add",
  };

  registry.register("affine_subgraph_op", graphAsOperator(childGraph, registry));

  const parentGraph: ComputeGraphSpec = {
    id: "parent-hierarchical",
    nodes: [
      { id: "left_branch", op: "affine_subgraph_op" },
      { id: "right_branch", op: "subgraph", subgraph: childGraph },
      { id: "sum", op: "merge" },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "left_branch" },
      { from: INPUT_NODE_ID, to: "right_branch" },
      { from: "left_branch", to: "sum", port: "left" },
      { from: "right_branch", to: "sum", port: "right" },
    ],
    output: "sum",
  };

  // For input=5, bias=2: child(5) = 5*3 + 2 + 4 = 21; both branches = 21 + 21 = 42.
  const outAsync = await executeComputeGraph<number, number, { bias: number }>(
    parentGraph,
    registry,
    5,
    { bias: 2 },
  );
  assert.equal(outAsync, 42);
  assert.deepEqual(counts, { scale: 2, offset: 2, merge: 1 });

  const outSync = evaluateSyncComputeGraph<number, number, { bias: number }>(
    childGraph,
    registry,
    5,
    { bias: 2 },
  );
  assert.equal(outSync, 21);
});

test("compute graph validates cycles, dangling edges, missing outputs, and sync guard", async () => {
  const registry = new ComputeRegistry()
    .register("id", (inputs) => inputs.default)
    .register("async_op", async (inputs) => inputs.default);

  assert.throws(
    () =>
      evaluateSyncComputeGraph(
        {
          id: "cyclic",
          nodes: [
            { id: "a", op: "id" },
            { id: "b", op: "id" },
          ],
          edges: [
            { from: "a", to: "b" },
            { from: "b", to: "a" },
          ],
          output: "b",
        },
        registry,
        1,
        {},
      ),
    /cycle/i,
  );

  await assert.rejects(
    executeComputeGraph(
      {
        id: "dangling",
        nodes: [{ id: "a", op: "id" }],
        edges: [{ from: "missing", to: "a" }],
        output: "a",
      },
      registry,
      1,
      {},
    ),
    /Dangling edge source/,
  );

  assert.throws(
    () =>
      evaluateSyncComputeGraph(
        {
          id: "sync-fails-async",
          nodes: [{ id: "a", op: "async_op" }],
          edges: [{ from: INPUT_NODE_ID, to: "a" }],
          output: "a",
        },
        registry,
        1,
        {},
      ),
    /async node/i,
  );
});

test("runGraphExperiments shares upstream prefix cache, diffs graphs, and computes Pareto front", async () => {
  const calls = { recall: 0, fusion: 0, head: 0 };
  const registry = new ComputeRegistry()
    .register("recall", (inputs) => {
      calls.recall += 1;
      return `${String(inputs.default)}:recalled`;
    })
    .register("fusion", (inputs) => {
      calls.fusion += 1;
      return `${String(inputs.default)}:fused`;
    })
    .register("rerank", (inputs, _ctx, params) => {
      calls.head += 1;
      return `${String(inputs.default)}:rerank(${String(params.mode)})`;
    });

  const baseSpec: ComputeGraphSpec = {
    id: "baseline",
    nodes: [
      { id: "recall", op: "recall" },
      { id: "fusion", op: "fusion" },
      { id: "rerank", op: "rerank", params: { mode: "none" } },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "recall" },
      { from: "recall", to: "fusion" },
      { from: "fusion", to: "rerank" },
    ],
    output: "rerank",
  };

  const altSpec = replaceGraphNode(
    baseSpec,
    "rerank",
    { op: "rerank", params: { mode: "piecewise" } },
    "piecewise",
  );
  assert.deepEqual(diffGraphSpecs(baseSpec, altSpec), [{ nodeId: "rerank", status: "modified" }]);

  const outcome = await runGraphExperiments<string, string, unknown>(
    [baseSpec, altSpec],
    registry,
    "q",
    {},
  );
  assert.equal(outcome.results.get("baseline"), "q:recalled:fused:rerank(none)");
  assert.equal(outcome.results.get("piecewise"), "q:recalled:fused:rerank(piecewise)");
  // Shared recall + fusion run once; only the replaced rerank node runs twice.
  assert.deepEqual(calls, { recall: 1, fusion: 1, head: 2 });
  assert.equal(outcome.cacheHits, 2);
  assert.equal(outcome.executedNodes, 4);

  const memo = new ComputeMemoCache();
  await executeComputeGraph(baseSpec, registry, "q2", {}, memo);
  await executeComputeGraph(altSpec, registry, "q2", {}, memo);
  assert.equal(memo.hits, 2);

  const frontier = findParetoOptimalGraphs(
    [
      { name: "dominated", r1: 0.2, all20: 0.6, r100: 0.8, safe: true },
      { name: "unsafe", r1: 0.5, all20: 0.9, r100: 0.95, safe: false },
      { name: "winner_a", r1: 0.3, all20: 0.65, r100: 0.84, safe: true },
      { name: "winner_b", r1: 0.28, all20: 0.68, r100: 0.83, safe: true },
    ],
    [(x) => x.r1, (x) => x.all20, (x) => x.r100],
    (x) => x.safe,
  );
  assert.deepEqual(
    frontier.map((x) => x.name),
    ["winner_a", "winner_b"],
  );

  calls.recall = 0;
  calls.fusion = 0;
  calls.head = 0;
  const syncOutcome = runSyncGraphExperiments<string, string, unknown>(
    [baseSpec, altSpec],
    registry,
    "q-sync",
    {},
  );
  assert.equal(syncOutcome.results.get("baseline"), "q-sync:recalled:fused:rerank(none)");
  assert.equal(syncOutcome.results.get("piecewise"), "q-sync:recalled:fused:rerank(piecewise)");
  assert.deepEqual(calls, { recall: 1, fusion: 1, head: 2 });
  assert.equal(syncOutcome.cacheHits, 2);
});

test("ComputeMemoCache includes execution context, function props, and operator re-registration fingerprints", async () => {
  interface Ctx {
    queryText: string;
    keyFn: (x: string) => string;
  }
  const childSpec: ComputeGraphSpec = {
    id: "child-op-graph",
    nodes: [{ id: "step", op: "ctx_op" }],
    edges: [{ from: INPUT_NODE_ID, to: "step" }],
    output: "step",
  };
  const rootSpec: ComputeGraphSpec = {
    id: "root-op-graph",
    nodes: [{ id: "wrapped", op: "subgraph", subgraph: childSpec }],
    edges: [{ from: INPUT_NODE_ID, to: "wrapped" }],
    output: "wrapped",
  };

  let runs = 0;
  const registry = new ComputeRegistry<Ctx>().register("ctx_op", (inputs, ctx) => {
    runs += 1;
    return `${String(inputs.default)}|${ctx.queryText}|${ctx.keyFn("k")}|v1`;
  });

  const memo = new ComputeMemoCache();
  const sharedInput = ["item-a", "item-b"];
  const keyA = (x: string) => `${x}:A`;
  const keyB = (x: string) => `${x}:B`;

  // 1) Initial execution misses and caches both root subgraph and inner child.
  assert.equal(
    evaluateSyncComputeGraph(
      rootSpec,
      registry,
      sharedInput,
      { queryText: "q1", keyFn: keyA },
      memo,
    ),
    "item-a,item-b|q1|k:A|v1",
  );
  assert.equal(runs, 1);

  // 2) Same input, context, and operator implementation -> full cache hit on outer subgraph node.
  assert.equal(
    evaluateSyncComputeGraph(
      rootSpec,
      registry,
      sharedInput,
      { queryText: "q1", keyFn: keyA },
      memo,
    ),
    "item-a,item-b|q1|k:A|v1",
  );
  assert.equal(runs, 1);
  assert.equal(memo.hits, 1);

  // 3) Changing scalar context.queryText misses cache despite identical input.
  assert.equal(
    evaluateSyncComputeGraph(
      rootSpec,
      registry,
      sharedInput,
      { queryText: "q2", keyFn: keyA },
      memo,
    ),
    "item-a,item-b|q2|k:A|v1",
  );
  assert.equal(runs, 2);

  // 4) Changing functional context property misses cache too.
  assert.equal(
    evaluateSyncComputeGraph(
      rootSpec,
      registry,
      sharedInput,
      { queryText: "q2", keyFn: keyB },
      memo,
    ),
    "item-a,item-b|q2|k:B|v1",
  );
  assert.equal(runs, 3);

  // 5) Re-registering the inner operator under the same name invalidates outer + inner cache entries.
  registry.register("ctx_op", (inputs, ctx) => {
    runs += 1;
    return `${String(inputs.default)}|${ctx.queryText}|${ctx.keyFn("k")}|v2`;
  });
  assert.equal(
    evaluateSyncComputeGraph(
      rootSpec,
      registry,
      sharedInput,
      { queryText: "q2", keyFn: keyB },
      memo,
    ),
    "item-a,item-b|q2|k:B|v2",
  );
  assert.equal(runs, 4);

  // Async execution also respects re-registration and context fingerprints.
  assert.equal(
    await executeComputeGraph(
      rootSpec,
      registry,
      sharedInput,
      { queryText: "q3", keyFn: keyB },
      memo,
    ),
    "item-a,item-b|q3|k:B|v2",
  );
  assert.equal(runs, 5);
});
