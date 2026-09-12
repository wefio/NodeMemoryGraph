import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryContext } from "../../src/core/types.ts";
import {
  renderEvidenceSurface,
  renderRememberSurface,
  renderSearchSurface,
  renderSessionActiveGraphSurface,
  renderTaskBoardSurface,
} from "../../src/integration/agent-surface.ts";

test("session Active Graph surface renders only projected temporary items", () => {
  const rendered = renderSessionActiveGraphSurface({
    agId: "ag-a",
    sessionId: "session-a",
    activeTaskFrameId: "task-a",
    projectionSequence: 1,
    latestProjectionId: "projection-a",
    temporaryProjectionActive: true,
    items: [
      {
        id: "memory:a",
        kind: "semantic_memory",
        statement: "memory:a",
        sourceId: "a",
        nodeId: "node-a",
        taskFrameId: "task-a",
        createdAt: "2026-08-29T00:00:00.000Z",
        lastActivatedAt: "2026-08-29T00:00:00.000Z",
        activation: 1,
        temporary: false,
      },
      {
        id: "tool:a",
        kind: "tool_observation",
        statement: "Tests passed.",
        sourceId: "bash",
        nodeId: "tool:bash",
        taskFrameId: "task-a",
        createdAt: "2026-08-29T00:00:00.000Z",
        lastActivatedAt: "2026-08-29T00:00:00.000Z",
        activation: 0.8,
        temporary: true,
      },
    ],
    edges: [],
  });
  assert.match(rendered, /Tests passed/u);
  assert.doesNotMatch(rendered, /memory:a/u);
});

function context(): MemoryContext {
  const chainId = "chain-atlas";
  const result = (id: string, statement: string, position: number) =>
    ({
      memory: {
        id,
        statement,
        memoryType: "fact",
        tier: 1,
        truthStatus: "asserted",
        scope: { project: "atlas" },
        eventTime: "2026-08-20T12:00:00.000Z",
      },
      node: { canonicalName: "Atlas" },
      evidence: { content: `Exact source detail for ${id}.` },
      recallReason: "vector_match",
      chainMemberships: [{ chainId, chainType: "logical", topic: "Atlas flow", position }],
    }) as MemoryContext["results"][number];
  return {
    results: [
      result("memory-a", "Atlas receives input.", 0),
      result("memory-b", "Atlas emits output.", 1),
    ],
    relations: [],
    chainEdges: [
      { chainId, sourceMemoryId: "memory-a", targetMemoryId: "memory-b", edgeType: "order" },
    ],
    activeGraph: { id: "ag-atlas" } as MemoryContext["activeGraph"],
  };
}

test("shared agent surface keeps search compact and evidence exact", () => {
  const memory = context();
  const search = renderSearchSurface(memory, {
    preamble: 'NMG MEMORY CANDIDATES\nformat: one candidate per line; fields separated by "; ".',
    postamble: "NMG search metadata: count=2",
  });
  const evidence = renderEvidenceSurface(memory, {
    preamble: "NMG selected evidence:",
    postamble: "NMG evidence metadata: count=2",
  });

  assert.match(search, /memory=memory-a/u);
  assert.match(search, /chains=Atlas flow/u);
  assert.match(search, /activeGraphId=ag-atlas/u);
  assert.match(search, /fields separated by "; "/u);
  assert.doesNotMatch(search, /tier=L\d/u);
  assert.doesNotMatch(search, /matches=/u);
  assert.doesNotMatch(search, /Exact source detail/u);
  assert.match(evidence, /Exact source detail/u);
  assert.match(evidence, /time=2026-08-20/u);
  assert.match(evidence, /<nmg_logical_chains>/u);
  assert.equal(evidence.split("Atlas receives input.").length - 1, 1);
  assert.ok(search.indexOf("NMG MEMORY CANDIDATES") < search.indexOf("memory=memory-a"));
  assert.ok(search.indexOf("memory=memory-b") < search.indexOf("NMG search metadata: count=2"));
  assert.ok(evidence.indexOf("NMG selected evidence:") < evidence.indexOf("Atlas receives input."));
  assert.ok(
    evidence.indexOf("Atlas emits output.") < evidence.indexOf("NMG evidence metadata: count=2"),
  );
});

test("shared remember surface bounds semantic follow-up candidates", () => {
  const rendered = renderRememberSurface({
    memory: { id: "memory-new" } as never,
    supersedeCandidates: Array.from({ length: 5 }, (_, index) => ({
      memoryId: `old-${index}`,
      nodeId: "node-atlas",
      statement: `Old value ${index}`,
      eventTime: null,
      similarity: 0.8,
    })),
    duplicates: [],
  });

  assert.match(rendered, /Saved memory-new/u);
  assert.match(rendered, /old-2/u);
  assert.doesNotMatch(rendered, /old-3/u);
  assert.match(rendered, /decide semantically/u);
});

test("a delivered and judged entry renders its deliverable and verdict, not just its claim", () => {
  const rendered = renderTaskBoardSurface(
    {
      action: "read",
      entries: [
        {
          id: "entry-2",
          kind: "handoff",
          status: "open",
          agentId: "coordinator",
          content: "Run the suites and hand in the raw output.",
          claimedBy: "worker-7",
          ackedBy: [],
          deliveredBy: "worker-7",
          deliverableDigest: "24fb32103aafae2bc963a7e7deecaf1bc36702d697bc7abd8e1f67af01b525b1",
          verdict: "accepted",
          judgedBy: "coordinator",
        },
      ],
    },
    { taskId: "ooo-process-probe" },
  );

  assert.match(rendered, /\[claimed by worker-7\]/u);
  assert.match(rendered, /\[delivered by worker-7 24fb32103aaf\]/u);
  assert.match(rendered, /\[verdict accepted by coordinator\]/u);
  assert.match(rendered, /a self-report is not an acceptance/u);
});

test("shared task-board surface renders coordination without promoting it to memory", () => {
  const rendered = renderTaskBoardSurface(
    {
      action: "read",
      entries: [
        {
          id: "entry-1",
          sequence: 7,
          kind: "question",
          status: "open",
          agentId: "agent-a",
          content: "Who owns the adapter migration?",
          ackedBy: ["agent-b"],
        },
      ],
      nextCursor: 7,
    },
    { taskId: "adapter-migration" },
  );

  assert.match(rendered, /Who owns the adapter migration/u);
  assert.match(rendered, /nextCursor=7/u);
  assert.match(rendered, /Temporary coordination only/u);
  assert.match(rendered, /nmg_remember/u);
});

test("task-board readPreviews renders a compact view without full bodies", () => {
  const longBody = "A very long body that never rides on the wire ".repeat(40).trim();
  const rendered = renderTaskBoardSurface(
    {
      action: "readPreviews",
      previews: [
        {
          id: "e1",
          kind: "question",
          status: "open",
          agentId: "agent-a",
          claimedBy: null,
          ackCount: 2,
          preview: longBody,
        },
        {
          id: "e2",
          kind: "handoff",
          status: "open",
          agentId: "agent-b",
          claimedBy: null,
          preview: "memory=abc123",
        },
      ],
      nextCursor: "e2",
    },
    { taskId: "ch-x" },
  );
  assert.match(rendered, /Compact view/u);
  assert.match(rendered, /\[question\/open\]/u);
  assert.match(rendered, /memory=abc123/u);
  // The long body was collapsed to a bounded preview, not echoed in full.
  assert.doesNotMatch(rendered, /A very long body that never rides the wire A very long body/u);
  assert.match(rendered, /nextCursor=e2/u);
});

test("task-board readInbox labels the actionable-for-me view", () => {
  const rendered = renderTaskBoardSurface(
    {
      action: "readInbox",
      entries: [
        {
          id: "e1",
          kind: "handoff",
          status: "open",
          agentId: "sender",
          content: "Review the staged handoff for correctness.",
        },
      ],
    },
    { taskId: "ch-y" },
  );
  assert.match(rendered, /Actionable for me/u);
  assert.match(rendered, /Review the staged handoff/u);
});
