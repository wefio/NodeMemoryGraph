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
    // projectMemoryContext renders numbered lines ("N. [forget] ...") and
    // dedupes control markers, so exactly one numbered [forget] line appears.
    assert.equal(result.text.match(/^\d+\. \[forget\]/gm)?.length, 1);
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("chain members render as numbered lines plus an independent chain block", () => {
  const root = mkdtempSync(join(tmpdir(), "chainrender-"));
  try {
    const store = new NmgStore(join(root, "nmg.sqlite"));
    const cm: string[] = [];
    for (const s of ["脚本误操作", "写入阻塞", "服务不可用"]) {
      const m = store.remember({ nodeName: "事故", nodeKind: "topic", nodeSummary: "事故", statement: s, sessionId: "s1", sourceActor: "user" });
      cm.push(m.memory.id);
    }
    const lc = store.createMemoryChain({ chainType: "logical", topic: "事故因果", ownerSessionId: "s1" });
    cm.forEach((m, i) => store.addMemoryToChain({ chainId: lc.id, memoryId: m, position: i }));
    const ctx = store.searchContext("脚本误操作", { sessionId: "s1", limit: 8, expandChains: true });
    const memories = ctx.results.map((r) => ({
      memoryId: r.memory.id, nodeId: r.node.id, statement: r.memory.statement,
      markers: r.memory.markers, eventTime: r.memory.eventTime, score: r.combinedScore,
      sourceRef: r.evidence.sourceRef, chainId: r.chainId, chainPosition: r.chainPosition, chainType: r.chainType,
    }));
    const { lines } = projectMemoryContext(memories, false, new Map());
    const text = lines.join("\n");
    // Numbered lines: every rendered memory is prefixed with a 1-based index.
    assert.ok(/^\d+\. /.test(lines[0]!), "first line is numbered");
    // Chain block: independent section referencing members by index in order.
    const block = lines[lines.length - 1]!;
    assert.match(block, /^\[logical chain\]/);
    const refs = [...block.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(refs, [1, 2, 3], "chain block references member line numbers in order");
    store.close();
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle-lock noise */ }
  }
});

test("id render mode tags lines with <short-uuid> and renders the chain as a Mermaid flowchart", () => {
  const root = mkdtempSync(join(tmpdir(), "chainrender-id-"));
  try {
    const store = new NmgStore(join(root, "nmg.sqlite"));
    const cm: string[] = [];
    for (const s of ["脚本误操作", "写入阻塞", "服务不可用"]) {
      const m = store.remember({ nodeName: "事故", nodeKind: "topic", nodeSummary: "事故", statement: s, sessionId: "s1", sourceActor: "user" });
      cm.push(m.memory.id);
    }
    const lc = store.createMemoryChain({ chainType: "logical", topic: "事故因果", ownerSessionId: "s1" });
    cm.forEach((m, i) => store.addMemoryToChain({ chainId: lc.id, memoryId: m, position: i }));
    const ctx = store.searchContext("脚本误操作", { sessionId: "s1", limit: 8, expandChains: true });
    const memories = ctx.results.map((r) => ({
      memoryId: r.memory.id, nodeId: r.node.id, statement: r.memory.statement,
      markers: r.memory.markers, eventTime: r.memory.eventTime, score: r.combinedScore,
      sourceRef: r.evidence.sourceRef, chainId: r.chainId, chainPosition: r.chainPosition, chainType: r.chainType,
    }));
    const { lines } = projectMemoryContext(memories, false, new Map(), "id");
    // Lines are tagged [<short-uuid>] — not numeric, not a bare identifier.
    assert.match(lines[0]!, /^<[0-9a-f]{8}> /, "first line is short-uuid-tagged");
    assert.ok(!/^\d+\. /.test(lines[0]!), "no numeric prefix in id mode");
    // Chain block is a Mermaid flowchart referencing the same short ids.
    const text = lines.join("\n");
    assert.match(text, /flowchart LR/, "chain block uses Mermaid flowchart");
    const edges = [...text.matchAll(/^\s+([0-9a-f]{8}) --> ([0-9a-f]{8})$/gm)].map((m) => [m[1], m[2]]);
    assert.equal(edges.length, 2, "two edges for three members");
    // Edges follow chain position order and reference ids that appear in lines.
    assert.equal(edges[0]![1], edges[1]![0], "adjacent members share the connecting id");
    const tagged = [...text.matchAll(/^<([0-9a-f]{8})>/gm)].map((m) => m[1]);
    for (const [a] of edges) assert.ok(tagged.includes(a), "edge source id appears in the tagged lines");
    store.close();
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle-lock noise */ }
  }
});

test("id render mode extends the prefix on collision until unique", () => {
  // Two ids sharing the first segment: the renderer must extend to the second
  // segment so each <tag> stays unique within the rendered set.
  const mk = (memoryId: string, statement: string) => ({
    memoryId,
    nodeId: "n",
    statement,
    markers: [],
    eventTime: null,
    score: 1,
    sourceRef: null,
    chainMemberships: [{ chainId: "c1", position: 0, chainType: "logical" }],
  });
  const memories = [
    mk("aaaa1111-1111-0000-0000-000000000001", "第一个事故"),
    mk("aaaa1111-2222-0000-0000-000000000002", "第二个事故"),
    mk("bbbb2222-0000-0000-0000-000000000003", "第三个事故"),
  ];
  const { lines } = projectMemoryContext(memories, false, new Map(), "id");
  assert.match(lines[0]!, /^<aaaa1111-1111> /, "colliding id extended to second segment");
  assert.match(lines[1]!, /^<aaaa1111-2222> /, "colliding id extended to second segment");
  assert.match(lines[2]!, /^<bbbb2222> /, "unique id keeps shortest prefix");
  const tags = [...lines.join("\n").matchAll(/<([0-9a-f-]+)>/g)].map((m) => m[1]);
  assert.equal(new Set(tags).size, tags.length, "all rendered id tags are unique");
});

test("id render mode renders temporal chains as a Mermaid timeline", () => {
  const root = mkdtempSync(join(tmpdir(), "chainrender-timeline-"));
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
    const memories = ctx.results.map((r) => ({ memoryId: r.memory.id, nodeId: r.node.id, statement: r.memory.statement, markers: r.memory.markers, eventTime: r.memory.eventTime, score: r.combinedScore, sourceRef: r.evidence.sourceRef, chainId: r.chainId, chainPosition: r.chainPosition, chainType: r.chainType }));
    const { lines } = projectMemoryContext(memories, true, new Map(), "id");
    const text = lines.join("\n");
    assert.match(text, /timeline/, "temporal chain renders as a Mermaid timeline");
    const tls = [...text.matchAll(/^\s+(\S+) : ([0-9a-f]{8})$/gm)].map((m) => [m[1], m[2]]);
    assert.equal(tls.length, 3, "three timeline entries");
    assert.deepEqual(tls.map((t) => t[0]), ["2024-03-15", "2024-03-16", "2024-03-17"], "timeline in event-time order");
    store.close();
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle-lock noise */ }
  }
});

test("none render mode renders bare lines and drops the chain block", () => {
  const root = mkdtempSync(join(tmpdir(), "chainrender-none-"));
  try {
    const store = new NmgStore(join(root, "nmg.sqlite"));
    const cm: string[] = [];
    for (const s of ["脚本误操作", "写入阻塞", "服务不可用"]) {
      const m = store.remember({ nodeName: "事故", nodeKind: "topic", nodeSummary: "事故", statement: s, sessionId: "s1", sourceActor: "user" });
      cm.push(m.memory.id);
    }
    const lc = store.createMemoryChain({ chainType: "logical", topic: "事故因果", ownerSessionId: "s1" });
    cm.forEach((m, i) => store.addMemoryToChain({ chainId: lc.id, memoryId: m, position: i }));
    const ctx = store.searchContext("脚本误操作", { sessionId: "s1", limit: 8, expandChains: true });
    const memories = ctx.results.map((r) => ({
      memoryId: r.memory.id, nodeId: r.node.id, statement: r.memory.statement,
      markers: r.memory.markers, eventTime: r.memory.eventTime, score: r.combinedScore,
      sourceRef: r.evidence.sourceRef, chainId: r.chainId, chainPosition: r.chainPosition, chainType: r.chainType,
    }));
    const { lines } = projectMemoryContext(memories, false, new Map(), "none");
    // Bare lines: no numeric/letter prefix.
    assert.ok(!/^[0-9A-Z]\. /.test(lines[0]!), "no prefix in none mode");
    // Chain block is dropped (no per-line label to reference).
    const text = lines.join("\n");
    assert.ok(!/\[.* chain\]/.test(text), "no chain block in none mode");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    const { lines } = projectMemoryContext(memories, true, new Map());
    const text = lines.join("\n");
    const temporal = text.match(/\[temporal chain:[^\]]*\] ([^\n]*)/)?.[1] ?? "";
    const logical = text.match(/\[logical chain:[^\]]*\] ([^\n]*)/)?.[1] ?? "";
    const temporalRefs = [...temporal.matchAll(/#(\d+)/g)].map((x) => Number(x[1]));
    const logicalRefs = [...logical.matchAll(/#(\d+)/g)].map((x) => Number(x[1]));
    // The shared memory's line number appears in both chain blocks.
    const sharedLine = memories.findIndex((mm) => mm.memoryId === hit!.memory.id) + 1;
    assert.ok(temporalRefs.includes(sharedLine), "shared member in temporal chain block");
    assert.ok(logicalRefs.includes(sharedLine), "shared member in logical chain block");
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
    const A = store.createMemoryChain({ chainType: "temporal", topic: "预算年度演进", ownerSessionId: "s1" });
    store.addMemoryToChain({ chainId: A.id, memoryId: b1.memory.id, position: 0 });
    store.addMemoryToChain({ chainId: A.id, memoryId: b2.memory.id, position: 1 });
    const e1 = mk("事故", "故障凌晨发生", "2024-03-01");
    const e2 = mk("事故", "故障次日恢复", "2024-03-02");
    const C = store.createMemoryChain({ chainType: "temporal", topic: "事故时间线", ownerSessionId: "s1" });
    store.addMemoryToChain({ chainId: C.id, memoryId: e1.memory.id, position: 0 });
    store.addMemoryToChain({ chainId: C.id, memoryId: e2.memory.id, position: 1 });

    const ctx = store.searchContext("2024年 故障时间", { sessionId: "s1", limit: 8, expandChains: true });
    const memories = ctx.results.map((r) => ({
      memoryId: r.memory.id, nodeId: r.node.id, statement: r.memory.statement, markers: r.memory.markers,
      eventTime: r.memory.eventTime, score: r.combinedScore, sourceRef: r.evidence.sourceRef,
      chainId: r.chainId, chainPosition: r.chainPosition, chainType: r.chainType, chainMemberships: r.chainMemberships,
    }));
    const { lines } = projectMemoryContext(memories, true, new Map());
    const text = lines.join("\n");
    assert.match(text, /\[temporal chain: 预算年度演进\]/);
    assert.match(text, /\[temporal chain: 事故时间线\]/);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
