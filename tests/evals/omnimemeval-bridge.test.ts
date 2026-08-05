import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OmniMemEvalBridge } from "../../evals/omnimemeval/bridge.ts";

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
    })) as { added: number };
    assert.equal(added.added, 2);

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
    assert.equal(result.text.match(/^\[forget\]/gm)?.length, 1);
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});
