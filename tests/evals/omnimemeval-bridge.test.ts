import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OmniMemEvalBridge, projectMemoryContext } from "../../evals/omnimemeval/bridge.ts";
import { NmgStore } from "../../src/core/store.ts";

test("OmniMemEval bridge ingests and retrieves isolated user memories", async () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-omni-"));
  const bridge = new OmniMemEvalBridge(root);
  try {
    const added = (await bridge.handle({
      id: 1,
      op: "add",
      userId: "alice",
      conversationId: "session-1",
      messages: [
        {
          role: "user",
          content: "My telescope is named Kepler.",
          chat_time: "2026-07-20",
        },
        {
          role: "assistant",
          content: "In the previous chat, I assigned Admon the Sunday day shift.",
        },
      ],
    })) as { added: number; memories: string[] };
    assert.equal(added.added, 2);
    assert.deepEqual(added.memories, [
      "My telescope is named Kepler.",
      "In the previous chat, I assigned Admon the Sunday day shift.",
    ]);

    const alice = (await bridge.handle({
      id: 2,
      op: "search",
      userId: "alice",
      query: "What is my telescope named?",
      topK: 4,
    })) as { text: string; timings?: { totalMs: number } };
    const bob = (await bridge.handle({
      id: 3,
      op: "search",
      userId: "bob",
      query: "What is my telescope named?",
      topK: 4,
    })) as { text: string };

    assert.match(alice.text, /NMG memory search results: 1 candidate record/);
    assert.match(alice.text, /order is not a guarantee of relevance/);
    assert.doesNotMatch(alice.text, /retrieval guidance/);
    assert.match(alice.text, /Kepler/);
    assert.ok(alice.timings);
    assert.ok(alice.timings.totalMs >= 0);
    assert.doesNotMatch(alice.text, /\[forget\]/);
    assert.doesNotMatch(alice.text, /2026-07-20/);
    assert.equal(bob.text, "");

    const temporalRecall = (await bridge.handle({
      id: 4,
      op: "search",
      userId: "alice",
      query: "When did I name my telescope?",
      topK: 4,
    })) as { text: string };
    assert.match(temporalRecall.text, /\[2026-07-20\] My telescope is named Kepler/);

    const datedRecall = (await bridge.handle({
      id: 5,
      op: "search",
      userId: "alice",
      query: "What telescope did I have in July 2026?",
      topK: 4,
    })) as { text: string };
    assert.match(datedRecall.text, /\[2026-07-20\] My telescope is named Kepler/);

    const assistantRecall = (await bridge.handle({
      id: 6,
      op: "search",
      userId: "alice",
      query:
        "I'm checking our previous conversation. Can you remind me what rotation you recommended for Admon on Sunday?",
      topK: 4,
    })) as { text: string };
    assert.match(assistantRecall.text, /Admon the Sunday day shift/);

    await bridge.handle({ id: 7, op: "delete", userId: "alice" });
    const perfRows = readFileSync(join(root, "search-perf.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { userId: string; timings?: { totalMs: number } });
    assert.ok(perfRows.some((row) => row.userId === "alice" && row.timings));
    const deleted = (await bridge.handle({
      id: 8,
      op: "search",
      userId: "alice",
      query: "Kepler telescope",
      topK: 4,
    })) as { text: string };
    assert.equal(deleted.text, "");
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("OmniMemEval batches pending record vectors before search", async () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-omni-records-"));
  const calls = { documents: 0, queries: 0 };
  const embeddingClient = {
    indexId: "test-records@v1",
    async embedDocuments(inputs: string[]) {
      calls.documents += inputs.length;
      return inputs.map((input) => [input.includes("Kepler") ? 1 : 0, 0]);
    },
    async embedQueries(inputs: string[]) {
      calls.queries += inputs.length;
      return inputs.map(() => [1, 0]);
    },
  };
  let bridge = new OmniMemEvalBridge(root, { embeddingClient });
  try {
    await bridge.handle({
      id: 1,
      op: "add",
      userId: "alice",
      messages: [{ role: "user", content: "My telescope is named Kepler." }],
    });
    assert.equal(calls.documents, 0);
    const result = (await bridge.handle({
      id: 2,
      op: "search",
      userId: "alice",
      query: "What is my telescope named?",
      topK: 4,
    })) as { retrievalMode: string; text: string };
    assert.equal(result.retrievalMode, "records");
    assert.match(result.text, /Kepler/);
    assert.equal(calls.documents, 1);

    await bridge.handle({
      id: 3,
      op: "search",
      userId: "alice",
      query: "What is my telescope named?",
      topK: 4,
    });
    assert.equal(calls.documents, 1);

    await bridge.handle({
      id: 4,
      op: "add",
      userId: "alice",
      messages: [{ role: "user", content: "Kepler is stored in the observatory." }],
    });
    assert.equal(calls.documents, 1);
    await bridge.handle({
      id: 5,
      op: "search",
      userId: "alice",
      query: "Where is Kepler stored?",
      topK: 4,
    });
    assert.equal(calls.documents, 2);
    assert.equal(calls.queries, 2, "repeated query uses the persistent cache");

    await bridge.handle({ id: 6, op: "delete", userId: "alice" });
    bridge.close();
    bridge = new OmniMemEvalBridge(root, { embeddingClient });
    await bridge.handle({
      id: 7,
      op: "add",
      userId: "bob",
      messages: [{ role: "user", content: "My telescope is named Kepler." }],
    });
    await bridge.handle({
      id: 8,
      op: "search",
      userId: "bob",
      query: "What is my telescope named?",
      topK: 4,
    });
    assert.equal(calls.documents, 2, "document vector survives user deletion");
    assert.equal(calls.queries, 2, "query vector survives bridge restart");
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("OmniMemEval benchmark keeps full warm-pool retrieval for recall measurement", async () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-omni-wide-budget-"));
  const embeddingClient = {
    indexId: "test-wide-budget@v1",
    async embedDocuments(inputs: string[]) {
      return inputs.map(() => [1, 0]);
    },
    async embedQueries() {
      return [[1, 0]];
    },
  };
  const bridge = new OmniMemEvalBridge(root, { embeddingClient, secondPass: false });
  try {
    await bridge.handle({
      id: 1,
      op: "add",
      userId: "alice",
      messages: Array.from({ length: 6 }, (_, index) => ({
        role: "user",
        content: `Stable preference number ${index + 1}.`,
      })),
    });
    const result = (await bridge.handle({
      id: 2,
      op: "search",
      userId: "alice",
      query: "What are my stable preferences?",
      topK: 6,
    })) as { memories: unknown[] };
    assert.equal(result.memories.length, 6);
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("OmniMemEval uses progressive QPP by default and permits a fixed-window baseline", async () => {
  const normalRoot = mkdtempSync(join(tmpdir(), "nmg-omni-qpp-normal-"));
  const adaptiveRoot = mkdtempSync(join(tmpdir(), "nmg-omni-qpp-adaptive-"));
  const safePrefixRoot = mkdtempSync(join(tmpdir(), "nmg-omni-qpp-prefix-"));
  const normal = new OmniMemEvalBridge(normalRoot, { secondPass: false });
  const adaptive = new OmniMemEvalBridge(adaptiveRoot);
  const safePrefix = new OmniMemEvalBridge(safePrefixRoot, {
    secondPass: true,
    qppInitialEvidenceTarget: 2,
  });
  const messages = [
    "I run five kilometres before breakfast on Monday.",
    "I run five kilometres before breakfast on Tuesday.",
    "I run five kilometres before breakfast on Wednesday.",
    "I run five kilometres before breakfast on Thursday.",
  ].map((content) => ({ role: "user", content }));
  try {
    await normal.handle({ id: 1, op: "add", userId: "alice", messages });
    await adaptive.handle({ id: 2, op: "add", userId: "alice", messages });
    await safePrefix.handle({ id: 3, op: "add", userId: "alice", messages });

    const normalResult = (await normal.handle({
      id: 4,
      op: "search",
      userId: "alice",
      query: "On which days do I run five kilometres before breakfast?",
      topK: 4,
    })) as { memories: unknown[] };
    const adaptiveResult = (await adaptive.handle({
      id: 5,
      op: "search",
      userId: "alice",
      query: "On which days do I run five kilometres before breakfast?",
      topK: 4,
    })) as { memories: unknown[] };
    const safePrefixResult = (await safePrefix.handle({
      id: 6,
      op: "search",
      userId: "alice",
      query: "On which days do I run five kilometres before breakfast?",
      topK: 4,
    })) as { memories: unknown[] };

    assert.equal(normalResult.memories.length, 4);
    // Progressive default now starts at the configured initial target (13):
    // with a 4-record pool the walk returns the whole pool in one pass.
    assert.equal(adaptiveResult.memories.length, 4);
    assert.equal(safePrefixResult.memories.length, 2);
  } finally {
    normal.close();
    adaptive.close();
    safePrefix.close();
    rmSync(normalRoot, { recursive: true, force: true });
    rmSync(adaptiveRoot, { recursive: true, force: true });
    rmSync(safePrefixRoot, { recursive: true, force: true });
  }
});

test("OmniMemEval replaces an explicitly forgotten memory with a tagged revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-omni-forget-"));
  const bridge = new OmniMemEvalBridge(root);
  try {
    await bridge.handle({
      id: 1,
      op: "add",
      userId: "alice",
      conversationId: "before-forget",
      messages: [
        {
          role: "user",
          content:
            "I feel isolated working from home and miss collaborative in-person brainstorms.",
        },
        {
          role: "user",
          content: "I prefer jasmine tea in the afternoon.",
        },
      ],
    });
    await bridge.handle({
      id: 2,
      op: "add",
      userId: "alice",
      conversationId: "forget-request",
      messages: [
        {
          role: "user",
          content:
            "Please forget that I feel isolated working from home and miss collaborative in-person brainstorms.",
        },
        {
          role: "user",
          content: "I prefer collaborative whiteboard sessions over written status updates.",
        },
        {
          role: "user",
          content:
            "Please forget that I prefer collaborative whiteboard sessions over written status updates.",
        },
      ],
    });

    const forgotten = (await bridge.handle({
      id: 3,
      op: "search",
      userId: "alice",
      query: "How did I feel about working from home and collaboration?",
      topK: 10,
    })) as {
      text: string;
      memories: Array<{
        statement: string;
        markers: Array<{ kind: string; attributes?: Record<string, unknown> }>;
      }>;
    };
    // Revoked records show metadata but withhold the statement: the model
    // sees the revocation exists (id/time) without content to cite.
    assert.match(forgotten.text, /\(content withdrawn\) memory=/);
    assert.doesNotMatch(forgotten.text, /I feel isolated working from home/i);
    assert.doesNotMatch(forgotten.text, /collaborative whiteboard sessions/i);
    assert.doesNotMatch(forgotten.text, /Please forget/i);
    const revocation = forgotten.memories.find((memory) =>
      memory.markers.some((marker) => marker.kind === "forget"),
    );
    assert.ok(revocation);
    assert.equal(revocation.statement.startsWith("[forget]"), false);
    assert.deepEqual(revocation.markers, [{ kind: "forget", attributes: { effect: "revoke" } }]);

    const retained = (await bridge.handle({
      id: 4,
      op: "search",
      userId: "alice",
      query: "What tea do I prefer?",
      topK: 10,
    })) as { text: string };
    assert.match(retained.text, /jasmine tea/i);
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic retrieval exposes a tagged revocation boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-omni-revocation-"));
  const bridge = new OmniMemEvalBridge(root, {
    embeddingClient: {
      indexId: "test-revocations@v1",
      async embedDocuments(inputs) {
        return inputs.map((input) =>
          /isolated|collaborative|brainstorms/i.test(input) ? [1, 0] : [0, 1],
        );
      },
      async embedQueries() {
        return [[1, 0]];
      },
    },
  });
  try {
    await bridge.handle({
      id: 1,
      op: "add",
      userId: "alice",
      messages: [
        {
          role: "user",
          content:
            "I feel isolated working from home and miss collaborative in-person brainstorms.",
        },
        {
          role: "user",
          content:
            "Please forget that I feel isolated working from home and miss collaborative in-person brainstorms.",
        },
        {
          role: "user",
          content: "I prefer collaborative whiteboard sessions over written status updates.",
        },
        {
          role: "user",
          content:
            "Please forget that I prefer collaborative whiteboard sessions over written status updates.",
        },
      ],
    });

    const result = (await bridge.handle({
      id: 2,
      op: "search",
      userId: "alice",
      query: "How can I recreate collaboration while studying online?",
      topK: 10,
    })) as {
      text: string;
      memories: Array<{ statement: string; markers: Array<{ kind: string }> }>;
    };
    assert.match(result.text, /\(content withdrawn\) memory=/);
    assert.doesNotMatch(result.text, /feel isolated working from home/i);
    assert.doesNotMatch(result.text, /collaborative whiteboard sessions/i);
    assert.doesNotMatch(result.text, /Please forget/i);
    const revocations = result.memories.filter(
      (memory) =>
        memory.statement.startsWith("[forget]") === false &&
        memory.markers.some((marker) => marker.kind === "forget"),
    );
    // The Fibonacci walk may stop at one or two revocations; the structured
    // marker is projected to [forget] exactly once (projectMemoryContext
    // dedupes control markers) — the assertion is about the tagged boundary.
    assert.ok(revocations.length >= 1, "at least one tagged revocation surfaced");
    // projectMemoryContext renders tagged lines ("<A:short-id> [forget] …" in
    // the default idtime mode) and dedupes control markers, so exactly one
    // tagged [forget] line appears.
    assert.equal(result.text.match(/^<[A-Z]+:[0-9a-f]{8}> \[forget\]/gm)?.length, 1);
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});

;

;

;

;

test("idtime render mode keeps [time] on temporal member lines and drops the timeline block", () => {
  const root = mkdtempSync(join(tmpdir(), "chainrender-idtime-"));
  try {
    const store = new NmgStore(join(root, "nmg.sqlite"));
    const times = ["2024-03-15", "2024-03-16", "2024-03-17"];
    const cm: string[] = [];
    for (let i = 0; i < times.length; i += 1) {
      const m = store.remember({ nodeName: "事故", nodeKind: "topic", nodeSummary: "事故", statement: `事件${i + 1}`, eventTime: times[i], sessionId: "s1", sourceActor: "user" });
      cm.push(m.memory.id);
    }
    const tc = store.createMemoryChain({ chainType: "temporal", topic: "事故时间线", ownerSessionId: "s1" });
    cm.forEach((m, i) => store.addMemoryToChain({ chainId: tc.id, memoryId: m, position: i }));
    const ctx = store.searchContext("事件", { sessionId: "s1", limit: 8, expandChains: true });
    const memories = ctx.results.map((r) => ({
      memoryId: r.memory.id, nodeId: r.node.id, statement: r.memory.statement,
      markers: r.memory.markers, eventTime: r.memory.eventTime, score: r.combinedScore,
      sourceRef: r.evidence.sourceRef, chainId: r.chainId, chainPosition: r.chainPosition, chainType: r.chainType,
      chainMemberships: r.chainMemberships,
    }));
    const { lines } = projectMemoryContext(memories, true, new Map(), "idtime");
    const text = lines.join("\n");
    // Lines keep [time] even for temporal members.
    assert.ok(text.includes("[2024-03-15]"), "temporal member lines keep [time] in idtime mode");
    // No Mermaid timeline block — chronology lives on the line.
    assert.ok(!text.includes("timeline"), "no timeline block in idtime mode");
    assert.match(lines[0]!, /^<[A-Z]+:[0-9a-f]{8}> /, "lines are <letter:short-id>-tagged");
    store.close();
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle-lock noise */ }
  }
});

;

;

test("id render mode renders a branching DAG chain as a Mermaid flowchart with forks", () => {
  const root = mkdtempSync(join(tmpdir(), "chainrender-dag-"));
  try {
    const store = new NmgStore(join(root, "nmg.sqlite"));
    const ids: string[] = [];
    for (const s of ["根因：脚本误操作", "后果A：写入阻塞", "后果B：数据丢失", "后续：回滚恢复"]) {
      const m = store.remember({ nodeName: "事故", nodeKind: "topic", nodeSummary: "事故", statement: s, sessionId: "s1", sourceActor: "user" });
      ids.push(m.memory.id);
    }
    const [a, b, c, d] = ids;
    const chain = store.createMemoryChain({ chainType: "logical", topic: "分叉事故", ownerSessionId: "s1" });
    // a --> b, a --> c (branch), c --> d
    store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: a, targetMemoryId: b });
    store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: a, targetMemoryId: c });
    store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: c, targetMemoryId: d });
    const ctx = store.searchContext("脚本误操作", { sessionId: "s1", limit: 8, expandChains: true });
    const memories = ctx.results.map((r) => ({
      memoryId: r.memory.id, nodeId: r.node.id, statement: r.memory.statement,
      markers: r.memory.markers, eventTime: r.memory.eventTime, score: r.combinedScore,
      sourceRef: r.evidence.sourceRef, chainId: r.chainId, chainPosition: r.chainPosition, chainType: r.chainType,
      chainMemberships: r.chainMemberships,
    }));
    const chainEdges = new Map<string, Array<{ sourceMemoryId: string; targetMemoryId: string }>>();
    for (const e of ctx.chainEdges ?? []) {
      const list = chainEdges.get(e.chainId) ?? [];
      list.push({ sourceMemoryId: e.sourceMemoryId, targetMemoryId: e.targetMemoryId });
      chainEdges.set(e.chainId, list);
    }
    const { lines } = projectMemoryContext(memories, true, new Map(), "idtime", chainEdges);
    const text = lines.join("\n");
    assert.match(text, /flowchart LR/, "branching chain renders as a flowchart");
    assert.ok(text.includes(" & "), "fork is rendered with Mermaid & syntax");
    const fork = [...text.matchAll(/^\s+([0-9a-f]{8}) --> ([0-9a-f]{8}) & ([0-9a-f]{8})$/gm)];
    assert.equal(fork.length, 1, "one fork row: source --> t1 & t2");
    store.close();
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle-lock noise */ }
  }
});

;

test("a memory in multiple chains renders in every chain block", () => {
  const root = mkdtempSync(join(tmpdir(), "multichain-"));
  try {
    const store = new NmgStore(join(root, "nmg.sqlite"));
    const m = store.remember({ nodeName: "预算", nodeKind: "topic", nodeSummary: "预算", statement: "2024年度预算8000万", sessionId: "s1", sourceActor: "user", eventTime: "2024-01-01" });
    const A = store.createMemoryChain({ chainType: "temporal", topic: "预算年度演进", ownerSessionId: "s1" });
    const B = store.createMemoryChain({ chainType: "logical", topic: "预算依赖链", ownerSessionId: "s1" });
    const m2023 = store.remember({ nodeName: "预算", nodeKind: "topic", nodeSummary: "预算", statement: "2023年度预算6500万", sessionId: "s1", sourceActor: "user", eventTime: "2023-01-01" });
    store.addMemoryToChain({ chainId: A.id, memoryId: m2023.memory.id, position: 0 });
    store.addMemoryToChain({ chainId: A.id, memoryId: m.memory.id, position: 1 });
    const dep = store.remember({ nodeName: "选型", nodeKind: "topic", nodeSummary: "选型", statement: "技术选型依赖预算规模", sessionId: "s1", sourceActor: "user" });
    store.addMemoryToChain({ chainId: B.id, memoryId: m.memory.id, position: 0 });
    store.addMemoryToChain({ chainId: B.id, memoryId: dep.memory.id, position: 1 });

    const ctx = store.searchContext("2024年预算", { sessionId: "s1", limit: 8, expandChains: true });
    const hit = ctx.results.find((r) => r.memory.statement.includes("2024年度"));
    assert.ok(hit && hit.chainMemberships && hit.chainMemberships.length === 2, "both memberships collected");
    const memories = ctx.results.map((r) => ({
      memoryId: r.memory.id, nodeId: r.node.id, statement: r.memory.statement, markers: r.memory.markers,
      eventTime: r.memory.eventTime, score: r.combinedScore, sourceRef: r.evidence.sourceRef,
      chainId: r.chainId, chainPosition: r.chainPosition, chainType: r.chainType, chainMemberships: r.chainMemberships,
    }));
    const { lines } = projectMemoryContext(memories, true, new Map(), "idtime");
    const text = lines.join("\n");
    // idtime: temporal chains render no block; the shared member surfaces in
    // the logical chain's flowchart and on its own tagged line.
    assert.doesNotMatch(text, /\[temporal chain/, "temporal chain renders no block in idtime");
    assert.match(text, /\[logical chain: 预算依赖链\]/);
    assert.match(text, /flowchart LR/);
    const sharedLine = memories.find((mm) => mm.memoryId === hit!.memory.id)!;
    assert.ok(
      lines.some((l) => l.includes("[2024-01-01]") && /<[A-Z]+:[0-9a-f]{8}>/.test(l)),
      "shared member keeps a tagged [time] line",
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multiple chains of the same type render with distinguishable topics", () => {
  const root = mkdtempSync(join(tmpdir(), "mtopic-"));
  try {
    const store = new NmgStore(join(root, "nmg.sqlite"));
    const mk = (name: string, stmt: string, et: string) =>
      store.remember({ nodeName: name, nodeKind: "topic", nodeSummary: name, statement: stmt, sessionId: "s1", sourceActor: "user", eventTime: et });
    const b1 = mk("预算", "2023预算6500万", "2023-01-01");
    const b2 = mk("预算", "2024预算8000万", "2024-01-01");
    const A = store.createMemoryChain({ chainType: "logical", topic: "预算年度演进", ownerSessionId: "s1" });
    store.addMemoryToChain({ chainId: A.id, memoryId: b1.memory.id, position: 0 });
    store.addMemoryToChain({ chainId: A.id, memoryId: b2.memory.id, position: 1 });
    const e1 = mk("事故", "故障凌晨发生", "2024-03-01");
    const e2 = mk("事故", "故障次日恢复", "2024-03-02");
    const C = store.createMemoryChain({ chainType: "logical", topic: "事故时间线", ownerSessionId: "s1" });
    store.addMemoryToChain({ chainId: C.id, memoryId: e1.memory.id, position: 0 });
    store.addMemoryToChain({ chainId: C.id, memoryId: e2.memory.id, position: 1 });

    const ctx = store.searchContext("2024年 故障时间", { sessionId: "s1", limit: 8, expandChains: true });
    const memories = ctx.results.map((r) => ({
      memoryId: r.memory.id, nodeId: r.node.id, statement: r.memory.statement, markers: r.memory.markers,
      eventTime: r.memory.eventTime, score: r.combinedScore, sourceRef: r.evidence.sourceRef,
      chainId: r.chainId, chainPosition: r.chainPosition, chainType: r.chainType, chainMemberships: r.chainMemberships,
    }));
    const { lines } = projectMemoryContext(memories, true, new Map(), "idtime");
    const text = lines.join("\n");
    assert.match(text, /\[logical chain: 预算年度演进\]/);
    assert.match(text, /\[logical chain: 事故时间线\]/);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chainInjection=both links same-session memories into temporal and logical chains", async () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-omni-chaininj-"));
  const bridge = new OmniMemEvalBridge(root, {
    chainInjection: "both",
    embeddingClient: {
      indexId: "chaininj@v1",
      async embedDocuments(inputs) {
        return inputs.map((input) =>
          /服务器|监控|磁盘/i.test(input) ? [1, 0] : [0, 1],
        );
      },
      async embedQueries() {
        return [[1, 0]];
      },
    },
  });
  try {
    await bridge.handle({
      id: 1,
      op: "add",
      userId: "alice",
      messages: [
        { role: "user", content: "我在2024年3月买了台服务器", chat_time: "2024-03-01T00:00:00+00:00" },
        { role: "user", content: "6月部署了监控", chat_time: "2024-06-01T00:00:00+00:00" },
        { role: "user", content: "9月升级了磁盘", chat_time: "2024-09-01T00:00:00+00:00" },
      ],
    });
    const result = (await bridge.handle({
      id: 2,
      op: "search",
      userId: "alice",
      query: "服务器监控",
      topK: 5,
    })) as {
      text: string;
      memories: Array<{ statement: string; chainMemberships?: Array<{ chainType?: string }> }>;
    };
    const temporal = result.memories.find((m) =>
      m.chainMemberships?.some((c) => c.chainType === "temporal"),
    );
    const logical = result.memories.find((m) =>
      m.chainMemberships?.some((c) => c.chainType === "logical"),
    );
    assert.ok(temporal, "temporal chain surfaced via expandChains");
    assert.ok(logical, "logical chain surfaced via expandChains");
    assert.match(result.text, /\[logical chain/);
    assert.match(result.text, /flowchart LR/);
    assert.doesNotMatch(result.text, /timeline/, "idtime renders no timeline block");
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});
