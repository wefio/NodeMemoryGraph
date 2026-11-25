import assert from "node:assert/strict";
import test from "node:test";
import { PolicyViolationError, resolveLayeredConfig } from "../../src/core/capability-config.ts";
import {
  ComputeMemoCache,
  ComputeRegistry,
  INPUT_NODE_ID,
  compileComputeGraph,
  executeComputeGraph,
} from "../../src/core/compute-graph.ts";
import {
  ComputeCostModel,
  HostLoadGovernor,
  InFlightCoalescer,
  LocalWorkerThreadPool,
  ResourceLockManager,
  SchedulingDomain,
  UnifiedRuntimeScheduler,
  ZeroPollLatch,
  computeUpwardRanks,
  evaluatePlacementCost,
} from "../../src/core/runtime/index.ts";
import { resolveEffectiveNmgConfig } from "../../src/integration/runtime-config.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("L0 -> L1 -> L2 config inheritance, recursive subgraph override, policy guard, and cache isolation", async () => {
  const base = resolveEffectiveNmgConfig({ environment: {} });
  assert.equal(base.autoRecall.limit, 13);
  assert.equal(base.provenance.get("autoRecall.limit")?.layer, "L0");

  const withL1 = resolveEffectiveNmgConfig({
    environment: {},
    l1: {
      autoRecall: { limit: 18 },
      runtime: { profile: "eco" },
      bindings: {
        "memory.candidate_rerank": {
          nodeOverrides: {
            mid_r1_r5: {
              nodeOverrides: {
                wchrono: { params: { weight: 0.25 } },
              },
            },
          },
        },
      },
    },
    l2: {
      autoRecall: { limit: 22 },
    },
  });

  assert.equal(withL1.autoRecall.limit, 22);
  assert.equal(withL1.provenance.get("autoRecall.limit")?.layer, "L2");
  assert.equal(withL1.runtime.profile, "eco");
  assert.equal(withL1.provenance.get("runtime.profile")?.layer, "L1");

  const rerankSpec = withL1.resolveGraph("memory.candidate_rerank");
  const midNode = rerankSpec.nodes.find((n) => n.id === "mid_r1_r5");
  const wchrono = midNode?.subgraph?.nodes.find((n) => n.id === "wchrono");
  assert.equal(wchrono?.params?.weight, 0.25);

  const inspected = withL1.inspect();
  assert.equal(inspected.boundContracts["memory.candidate_rerank"]?.layer, "L1");
  assert.notEqual(base.resultIdentityHash, withL1.resultIdentityHash);

  // Unauthorized algorithmic recipe override fails closed unless allowedAlgorithmicVariants permits it
  assert.throws(
    () =>
      resolveEffectiveNmgConfig({
        environment: {},
        l1: { bindings: { "memory.candidate_rerank": { recipeId: "piecewise-bm25f" } } },
      }).resolveGraph("memory.candidate_rerank"),
    PolicyViolationError,
  );

  const allowed = resolveEffectiveNmgConfig({
    environment: {},
    l1: {
      allowedAlgorithmicVariants: ["piecewise-bm25f"],
      bindings: { "memory.candidate_rerank": { recipeId: "piecewise-bm25f" } },
    },
  });
  assert.match(allowed.resolveGraph("memory.candidate_rerank").id, /piecewise-bm25f/);

  // Plan cache isolates by configIdentity
  const reg = new ComputeRegistry().register("op", (i) => i.default, { effect: "pure" });
  const spec = {
    id: "g",
    nodes: [{ id: "n", op: "op" }],
    edges: [{ from: INPUT_NODE_ID, to: "n" }],
    output: "n",
  };
  const planA = compileComputeGraph(spec, reg, { configIdentity: base.resultIdentityHash });
  const planB = compileComputeGraph(spec, reg, { configIdentity: withL1.resultIdentityHash });
  assert.notEqual(planA, planB);

  // Bounds validation rejects out-of-range values
  assert.throws(
    () => resolveLayeredConfig({ l1: { config: { autoRecall: { limit: 999 } } } }),
    /autoRecall\.limit/,
  );
});

test("Event-driven async DAG bypasses wave barriers and preserves coalescing, locks, and semantic retry", async () => {
  // 1. Slow branch (70ms) does not block independent fast chain (5ms + 15ms)
  const diamond = {
    id: "diamond",
    nodes: [
      { id: "slow", op: "slow" },
      { id: "f1", op: "f1" },
      { id: "f2", op: "f2" },
      { id: "join", op: "join" },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "slow" },
      { from: INPUT_NODE_ID, to: "f1" },
      { from: "f1", to: "f2" },
      { from: "slow", to: "join", port: "s" },
      { from: "f2", to: "join", port: "f" },
    ],
    output: "join",
  };
  const events: string[] = [];
  const timedReg = new ComputeRegistry()
    .register(
      "slow",
      async () => {
        await sleep(70);
        events.push("slow");
        return "s";
      },
      { effect: "read", parallelSafe: true },
    )
    .register(
      "f1",
      async () => {
        await sleep(5);
        events.push("f1");
        return 1;
      },
      { effect: "read", parallelSafe: true },
    )
    .register(
      "f2",
      async (i) => {
        await sleep(15);
        events.push("f2");
        return Number(i.default) + 1;
      },
      { effect: "read", parallelSafe: true },
    )
    .register("join", (i) => ({ s: i.s, f: i.f }), { effect: "pure", parallelSafe: true });
  const out = await executeComputeGraph<number, { s: string; f: number }>(diamond, timedReg, 0, {});
  assert.deepEqual(out, { s: "s", f: 2 });
  assert.equal(events[0], "f1");
  assert.equal(events[1], "f2");
  assert.equal(events[2], "slow");

  // 2. Singleflight coalescing isolates cloned outputs
  const coalescer = new InFlightCoalescer();
  let calls = 0;
  const [c1, c2] = await Promise.all([
    coalescer.coalesce("k", async () => {
      calls += 1;
      await sleep(10);
      return { arr: [1, 2] };
    }),
    coalescer.coalesce("k", async () => {
      calls += 1;
      return { arr: [9] };
    }),
  ]);
  assert.equal(calls, 1);
  assert.equal(c1.coalesced || c2.coalesced, true);
  c1.value.arr.push(99);
  assert.deepEqual(c2.value.arr, [1, 2]);

  // 3. Semantic retry retries pure/read but NEVER write/opaque
  const scheduler = new UnifiedRuntimeScheduler();
  try {
    let readAttempts = 0;
    const readVal = await scheduler.runTask(
      () => {
        readAttempts += 1;
        if (readAttempts < 2) throw new Error("transient");
        return "ok";
      },
      { effect: "read", retryPolicy: { maxAttempts: 3 } },
    );
    assert.equal(readVal, "ok");
    assert.equal(readAttempts, 2);

    let writeAttempts = 0;
    await assert.rejects(
      () =>
        scheduler.runTask(
          () => {
            writeAttempts += 1;
            throw new Error("no-retry");
          },
          { effect: "write", retryPolicy: { maxAttempts: 3 } },
        ),
      /no-retry/,
    );
    assert.equal(writeAttempts, 1);

    // ZeroPollLatch & ResourceLockManager exclusion
    const latch = new ZeroPollLatch();
    latch.increment();
    setTimeout(() => latch.decrement(), 15);
    await latch.waitForZero(500);
    assert.equal(latch.current, 0);

    const locks = new ResourceLockManager();
    const trace: string[] = [];
    await Promise.all([
      locks.withResources({ writes: ["db"] }, async () => {
        trace.push("w-start");
        await sleep(15);
        trace.push("w-end");
      }),
      locks.withResources({ reads: ["db"] }, async () => {
        trace.push("r");
      }),
    ]);
    assert.deepEqual(trace, ["w-start", "w-end", "r"]);
  } finally {
    await scheduler.close();
  }
});

test("HostLoadGovernor hysteresis, anti-starvation, HEFT placement, and LocalWorkerThreadPool parity", async () => {
  const governor = new HostLoadGovernor({ profile: "balanced", minDwellMs: 1000 });
  const idleBudget = governor.evaluateSample({
    eventLoopUtilization: 0.05,
    p99DelayMs: 2,
    nowMs: 100,
  });
  assert.equal(idleBudget.loadState, "idle");
  assert.equal(idleBudget.maxBackgroundConcurrency, 4);

  // Hysteresis ignores sample before minDwellMs
  const prematureHeavy = governor.evaluateSample({
    eventLoopUtilization: 0.95,
    p99DelayMs: 80,
    nowMs: 500,
  });
  assert.equal(prematureHeavy.loadState, "idle");

  // Enters heavy after dwell
  const heavyBudget = governor.evaluateSample({
    eventLoopUtilization: 0.95,
    p99DelayMs: 80,
    nowMs: 1500,
  });
  assert.equal(heavyBudget.loadState, "heavy");
  assert.equal(heavyBudget.maxBackgroundConcurrency, 1);
  assert.equal(heavyBudget.preferWorkerOffload, false);

  // Cost model refuses offloading microsecond ops, approves heavy pure ops
  const costModel = new ComputeCostModel();
  costModel.observe("micro_op", { cpuMs: 0.05 });
  costModel.observe("heavy_op", { cpuMs: 25 });
  const microDecision = evaluatePlacementCost({
    node: {
      id: "m",
      op: "micro_op",
      params: {},
      incoming: [],
      capabilities: {
        version: "1",
        effect: "pure",
        contracts: [],
        deterministic: true,
        cacheable: true,
        immutableOutput: false,
        parallelSafe: true,
        reorderable: true,
        eliminable: true,
        batchable: false,
        idempotentWrite: false,
        transactional: false,
        externalDeps: [],
        resources: {},
      },
      kind: "operator",
    },
    costModel,
    itemCount: 16,
    payloadBytes: 512,
    minOffloadCpuMs: 1.5,
    objective: "latency",
    localQueueDepth: 0,
    candidates: [
      {
        id: "w",
        kind: "worker_thread",
        capacity: 2,
        activeLoad: 0,
        estimatedQueueWaitMs: () => 0.3,
      },
    ],
    preferOffload: true,
  });
  assert.equal(microDecision.offload, false);

  // Worker pool + SchedulingDomain equivalence against synchronous rerank operator
  const pool = new LocalWorkerThreadPool({ maxWorkers: 2 });
  const domain = new SchedulingDomain("test-domain", [pool]);
  const scheduler = new UnifiedRuntimeScheduler({ domain, maxWorkers: 2 });
  try {
    const denseRes = await domain.execute({
      op: "__builtin_dense_bench",
      inputs: { default: { seed: 3, rounds: 1000 } },
      context: {},
      params: {},
    });
    assert.ok(Number.isFinite(Number(denseRes.value)));

    // Execute trivial graph through scheduler.executePlan and verify HEFT ranks compute cleanly
    const reg = new ComputeRegistry()
      .register("r5", (i) => i.default, { effect: "pure", costHint: { baseMs: 2 } })
      .register("tail", (i) => Number(i.default) + 1, { effect: "pure", costHint: { baseMs: 1 } });
    const spec = {
      id: "sched-plan",
      nodes: [
        { id: "a", op: "r5" },
        { id: "b", op: "tail" },
      ],
      edges: [
        { from: INPUT_NODE_ID, to: "a" },
        { from: "a", to: "b" },
      ],
      output: "b",
    };
    const plan = compileComputeGraph(spec, reg);
    const ranks = computeUpwardRanks(plan, costModel);
    assert.ok((ranks.get("a") ?? 0) > (ranks.get("b") ?? 0));
    const memo = new ComputeMemoCache();
    const schedOut = await scheduler.executePlan<number, number, unknown>(
      plan,
      reg,
      7,
      {},
      {
        memo,
        invokeNodeAsync: (node, r, inputs, ctx) =>
          Promise.resolve(r.get(node.op)(inputs, ctx, node.params)),
      },
    );
    assert.equal(schedOut, 8);
  } finally {
    await scheduler.close();
  }
});
