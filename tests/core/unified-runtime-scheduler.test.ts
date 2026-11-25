import assert from "node:assert/strict";
import test from "node:test";
import { PolicyViolationError, resolveLayeredConfig } from "../../src/core/capability-config.ts";
import {
  ComputeMemoCache,
  ComputeRegistry,
  INPUT_NODE_ID,
  compileComputeGraph,
  executeComputeGraph,
  evaluateSyncComputeGraph,
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
  withRuntimePolicy,
} from "../../src/core/runtime/index.ts";
import {
  rankCandidatesForSearch,
  rerankCandidatesWithGraph,
} from "../../src/core/memory/piecewise-rerank.ts";
import { resolveEffectiveNmgConfig } from "../../src/integration/runtime-config.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("independent production graphs arbitrate named resources together", async () => {
  const entered = latch();
  const release = latch();
  const trace: string[] = [];
  const registry = new ComputeRegistry()
    .register(
      "write",
      async () => {
        entered.resolve();
        await release.promise;
        trace.push("write");
      },
      { effect: "write", resources: { writes: ["runtime-regression-db"] } },
    )
    .register("read", () => trace.push("read"), {
      effect: "read",
      resources: { reads: ["runtime-regression-db"] },
    });
  const graph = (op: string) => ({ id: op, nodes: [{ id: op, op }], edges: [], output: op });
  const write = executeComputeGraph(graph("write"), registry, null, null);
  await entered.promise;
  const read = executeComputeGraph(graph("read"), registry, null, null);
  await sleep(5);
  release.resolve();
  await Promise.all([write, read]);
  assert.deepEqual(trace, ["write", "read"]);
});

test("timed-out writes hold their resource until the operation settles", async () => {
  const scheduler = new UnifiedRuntimeScheduler();
  const release = latch();
  const trace: string[] = [];
  try {
    await assert.rejects(
      scheduler.runTask(
        async () => {
          await release.promise;
          trace.push("write");
        },
        { timeoutMs: 5, effect: "write", resources: { writes: ["db"] } },
      ),
      /timed out/,
    );
    const read = scheduler.runTask(() => trace.push("read"), { resources: { reads: ["db"] } });
    await sleep(5);
    release.resolve();
    await read;
    assert.deepEqual(trace, ["write", "read"]);
  } finally {
    release.resolve();
    await scheduler.close();
  }
});

test("graph failure drains already-started I/O before returning to the snapshot owner", async () => {
  const ioStarted = latch();
  const releaseIo = latch();
  const trace: string[] = [];
  const registry = new ComputeRegistry()
    .register(
      "read",
      async () => {
        ioStarted.resolve();
        await releaseIo.promise;
        trace.push("io-settled");
      },
      { effect: "read", parallelSafe: true },
    )
    .register(
      "fail",
      async () => {
        await ioStarted.promise;
        trace.push("failed");
        throw new Error("graph failed");
      },
      { effect: "read", parallelSafe: true },
    )
    .register("join", () => trace.push("joined"));
  const graph = {
    id: "snapshot-ownership",
    nodes: ["read", "fail", "join"].map((op) => ({ id: op, op })),
    edges: [
      { from: "read", to: "join" },
      { from: "fail", to: "join", port: "failure" },
    ],
    output: "join",
  };
  const result = assert
    .rejects(executeComputeGraph(graph, registry, null, null), /graph failed/)
    .then(() => trace.push("snapshot-closed"));
  await ioStarted.promise;
  await sleep(5);
  assert.deepEqual(trace, ["failed"]);
  releaseIo.resolve();
  await result;
  assert.deepEqual(trace, ["failed", "io-settled", "snapshot-closed"]);
});

test("two ports fed by one node count as one readiness dependency", async () => {
  const release = latch();
  const registry = new ComputeRegistry()
    .register("fast", () => 1, { effect: "pure" })
    .register(
      "slow",
      async () => {
        await release.promise;
        return 2;
      },
      {
        effect: "read",
        parallelSafe: true,
      },
    )
    .register("join", (i) => [i.left, i.right, i.slow], { effect: "pure" });
  const graph = {
    id: "same-source-two-ports",
    nodes: ["fast", "slow", "join"].map((op) => ({ id: op, op })),
    edges: [
      { from: "fast", to: "join", port: "left" },
      { from: "fast", to: "join", port: "right" },
      { from: "slow", to: "join", port: "slow" },
    ],
    output: "join",
  };
  const result = executeComputeGraph(graph, registry, null, null);
  await sleep(2);
  release.resolve();
  assert.deepEqual(await result, [1, 1, 2]);
});

test("nested graphs reuse background admission and resource re-entry fails before deadlock", async () => {
  const scheduler = new UnifiedRuntimeScheduler({ maxConcurrentBackground: 1 });
  const registry = new ComputeRegistry().register("identity", (i) => i.default, {
    effect: "read",
    resources: { reads: ["nested-db"] },
  });
  const child = { id: "child", nodes: [{ id: "node", op: "identity" }], edges: [], output: "node" };
  const parent = {
    id: "parent",
    nodes: [{ id: "node", op: "subgraph", subgraph: child }],
    edges: [],
    output: "node",
  };
  try {
    assert.equal(
      await scheduler.runTask(() => executeComputeGraph(parent, registry, 42, null), {
        priority: "background",
      }),
      42,
    );
    await assert.rejects(
      scheduler.runTask(() => executeComputeGraph(child, registry, 42, null), {
        resources: { writes: ["nested-db"] },
      }),
      /resource-holding task/,
    );
    assert.equal(evaluateSyncComputeGraph(child, registry, 7, null), 7);
  } finally {
    await scheduler.close();
  }
});

test("production graph singleflight shares only compatible cacheable nodes", async () => {
  let calls = 0;
  const registry = new ComputeRegistry().register(
    "pure-result",
    async () => {
      calls += 1;
      await sleep(10);
      return { value: [1] };
    },
    { effect: "pure" },
  );
  const graph = {
    id: "flight",
    nodes: [{ id: "out", op: "pure-result" }],
    edges: [],
    output: "out",
  };
  const memo = new ComputeMemoCache();
  const run = (configIdentity: string) =>
    executeComputeGraph<null, { value: number[] }>(graph, registry, null, null, memo, {
      configIdentity,
    });
  const [a, b] = await Promise.all([run("same"), run("same")]);
  a.value.push(2);
  assert.deepEqual(b, { value: [1] });
  assert.equal(calls, 1);
  await run("different");
  assert.equal(calls, 2);
  assert.equal(memo.set("shared", { bytes: new Uint8Array(new SharedArrayBuffer(4)) }), false);
});

test("bound runtime policy selects the executable rerank Worker and preserves the inline result", async () => {
  const governor = new HostLoadGovernor();
  governor.sampleHost = () => ({
    ...governor.evaluateSample({ eventLoopUtilization: 0, p99DelayMs: 0, nowMs: Date.now() }),
    recommendedWorkers: 4,
  });
  const pool = new LocalWorkerThreadPool({ maxWorkers: 2 });
  // Timing is tested by the benchmark. This test forces a deterministic warm-target estimate.
  pool.estimatedQueueWaitMs = () => 0;
  const original = pool.execute.bind(pool);
  let workerCalls = 0;
  pool.execute = (...args) => {
    workerCalls += 1;
    return original(...args);
  };
  const domain = new SchedulingDomain("host", [new SchedulingDomain("local", [pool])]);
  const scheduler = new UnifiedRuntimeScheduler({ domain, governor });
  const candidates = Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    statement: "Database migration record " + i,
    combinedScore: 40 - i,
    eventTime: null,
    sessionId: null,
    nodeId: String(i),
  }));
  scheduler.costModel.observe("piecewise_rank_ids", { cpuMs: 21, itemCount: 40 });
  const l1 = { runtime: { objective: "throughput" as const, minOffloadCpuMs: 0.1, maxWorkers: 1 } };
  const inline = resolveEffectiveNmgConfig({ l1, l2: { runtime: { minOffloadCpuMs: 100 } } });
  const offload = resolveEffectiveNmgConfig({ l1 });
  const latency = resolveEffectiveNmgConfig({ l1, l2: { runtime: { objective: "latency" } } });
  try {
    const expected = rerankCandidatesWithGraph(candidates, "database");
    const run = () => rankCandidatesForSearch(candidates, "database");
    const placed = await withRuntimePolicy(offload.runtime, run, scheduler);
    assert.deepEqual(placed, expected);
    assert.equal(workerCalls, 1);
    assert.deepEqual(await withRuntimePolicy(inline.runtime, run, scheduler), expected);
    assert.equal(workerCalls, 1);
    scheduler.costModel.observe("piecewise_rank_ids", { cpuMs: 21, itemCount: 40 });
    assert.deepEqual(await withRuntimePolicy(latency.runtime, run, scheduler), expected);
    assert.equal(workerCalls, 1);
    assert.equal(inline.resultIdentityHash, offload.resultIdentityHash);
  } finally {
    await scheduler.close();
  }
});

test("Worker abort and serialization failure leave a usable pool", async () => {
  const pool = new LocalWorkerThreadPool({ maxWorkers: 1 });
  const request = {
    op: "identity_rank",
    inputs: { default: [{ id: "x", score: 1 }] },
    context: { candidates: [] },
    params: {},
  };
  try {
    const expected = (await pool.execute(request)).value;
    await assert.rejects(pool.execute({ ...request, context: { bad: () => 1 } }), /clone/i);
    const abort = new AbortController();
    const canceled = pool.execute(request, abort.signal);
    abort.abort(new Error("stop Worker"));
    await assert.rejects(canceled, /stop Worker/);
    assert.deepEqual((await pool.execute(request)).value, expected);
  } finally {
    await pool.close();
  }
});

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
    const workerResult = await domain.execute({
      op: "identity_rank",
      inputs: { default: [{ id: "candidate", score: 3 }] },
      context: { candidates: [] },
      params: {},
    });
    assert.deepEqual(workerResult.value, [{ id: "candidate", score: 3 }]);

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
