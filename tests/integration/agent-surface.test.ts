import assert from "node:assert/strict";
import test from "node:test";

import { searchResultFixture } from "../helpers/search-result.ts";
import type { MemoryContext } from "../../src/core/types.ts";
import { SessionActiveGraphRuntime } from "../../src/core/session-active-graph.ts";
import { compactSearchContext } from "../../src/integration/search-projection.ts";
import { loadPrompts, renderDisclosure } from "../../src/prompts/load.ts";
import {
  prepareSessionActiveGraphSurface,
  prepareTaskBoardSurface,
  renderCompactSearchSurface,
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
    disclosedProjectionIds: [],
    disclosureTurn: 0,
    disclosures: [],
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

test("AG output exposes typed source binding without repeating a long header", () => {
  const runtime = new SessionActiveGraphRuntime();
  runtime.observe({
    sessionId: "owner-a",
    taskFrameId: "parser",
    statement: "Check parser.",
  });
  const output = prepareSessionActiveGraphSurface(runtime.activateTemporaryProjection("owner-a"));

  assert.equal(output.text, "[temporary] Check parser.");
  assert.equal(output.included[0]?.source.kind, "ag");
  assert.equal(output.views[0]?.body, "Check parser.");
  assert.deepEqual(runtime.snapshot("owner-a")?.disclosures, []);
});

test("temporary working content retains exact constraints beyond a short preview", () => {
  const runtime = new SessionActiveGraphRuntime();
  const statement = `${"Inspect the parser boundary. ".repeat(24)}Public API must not change.`;
  runtime.observe({ sessionId: "exact-working-state", statement });
  const snapshot = runtime.activateTemporaryProjection("exact-working-state");

  assert.ok(renderSessionActiveGraphSurface(snapshot, 2_000).includes(statement));
});

function context(): MemoryContext {
  const chainId = "chain-atlas";
  const result = (
    id: string,
    statement: string,
    position: number,
  ): MemoryContext["results"][number] => {
    const fixture = searchResultFixture(id, statement);
    return {
      ...fixture,
      memory: { ...fixture.memory, eventTime: "2026-08-20T12:00:00.000Z" },
      node: { ...fixture.node, canonicalName: "Atlas" },
      evidence: {
        ...fixture.evidence,
        content: `Exact source detail for ${id}.`,
      },
      evidenceRecords: [{ ...fixture.evidence, content: `Exact source detail for ${id}.` }],
      recallReason: "vector_match",
      lexicalScore: 0,
      vectorScore: 1,
      chainMemberships: [{ chainId, chainType: "logical", topic: "Atlas flow", position }],
    };
  };
  return {
    results: [
      result("memory-a", "Atlas receives input.", 0),
      result("memory-b", "Atlas emits output.", 1),
    ],
    relations: [],
    chainEdges: [
      {
        chainId,
        sourceMemoryId: "memory-a",
        targetMemoryId: "memory-b",
        edgeType: "order",
      },
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

test("shared disclosure wrappers preserve the complete surface and its protected values", () => {
  const memory = context();
  const first = memory.results[0].memory;
  first.statement = `${"约束必须保留 scope=atlas 且 limit=13。 ".repeat(18)}End value: 27:12.`;
  first.expiresAt = "2026-12-31T23:59:59.000Z";
  first.resolution = "reopened";
  first.truthStatus = "unverified";
  first.markers = [
    {
      kind: "external_source",
      attributes: {
        source: "web:https://example.org/atlas",
        retrievedAt: "2026-10-10",
      },
    },
  ];
  memory.retrieval = {
    mode: "lexical",
    degraded: true,
    reason: "embedding_unavailable",
  };
  const original = structuredClone(memory);
  const prompts = loadPrompts();
  const searchBody = renderSearchSurface(memory);
  const evidenceBody = renderEvidenceSurface(memory);
  const headers = renderSearchSurface(memory, {
    preamble: renderDisclosure(prompts.search_disclosure, {}),
    postamble: renderDisclosure(prompts.search_disclosure_metadata, {
      count: "2",
      next_step: prompts.get_hint,
      forget_hint: "",
    }),
  });
  const evidence = renderEvidenceSurface(memory, {
    preamble: renderDisclosure(prompts.get_disclosure, {}),
    postamble: renderDisclosure(prompts.get_disclosure_metadata, {
      count: "2",
      next_step: "",
      forget_hint: "",
    }),
  });

  assert.ok(headers.includes(searchBody), "wrapping must not replace or clip candidate data");
  assert.ok(evidence.includes(evidenceBody), "wrapping must not replace or clip evidence data");
  assert.deepEqual(memory, original, "rendering must not change the canonical result");
  assert.match(headers, /\[external\] \[open\]/u);
  assert.match(headers, /expires=2026-12-31/u);
  assert.match(headers, /mode=lexical; reason=embedding_unavailable/u);
  assert.match(headers, /activeGraphId=ag-atlas/u);
  assert.match(headers, /logical_chains=1/u);
  assert.match(headers, /selected IDs and activeGraphId/u);
  assert.equal(compactSearchContext(memory).candidates[0].preview.length, 320);
  assert.ok(evidence.includes(first.statement), "exact statements are not shortened");
  assert.match(evidence, /truth=unverified; scope=\{"project":"atlas"\}/u);
  assert.match(evidence, /time=2026-08-20T12:00:00.000Z/u);
  assert.match(
    evidence,
    /EXTERNAL_SOURCE=web:https:\/\/example.org\/atlas; retrievedAt=2026-10-10/u,
  );
  assert.match(evidence, /SOURCE=Exact source detail for memory-a/u);
  assert.match(evidence, /<nmg_logical_chains>/u);
  assert.match(headers, /\ncount=2\n/u);
  assert.match(evidence, /\ncount=2$/u);
});

test("shared disclosure keeps withdrawn content redacted in previews and evidence", () => {
  const memory = context();
  memory.results[0].memory.markers = [{ kind: "forget", attributes: {} }];
  const prompts = loadPrompts();
  const footer = renderDisclosure(prompts.search_disclosure_metadata, {
    count: "2",
    next_step: prompts.get_hint,
    forget_hint: prompts.forget_hint,
  });
  for (const rendered of [
    renderSearchSurface(memory, { postamble: footer }),
    renderEvidenceSurface(memory, { postamble: footer }),
  ]) {
    assert.match(rendered, /\[forget\] \(content withdrawn\)/u);
    assert.match(rendered, /do not rely on it/u);
    assert.doesNotMatch(rendered, /Atlas receives input\.|Exact source detail for memory-a/u);
    assert.match(rendered, /memory=memory-a/u);
    assert.match(rendered, /Atlas emits output\./u);
  }
});

test("degraded search keeps its cause code without injecting the provider response", () => {
  const memory = context();
  const reason = `embedding server returned 429: ${JSON.stringify({
    error: {
      message: "provider-diagnostic-content ".repeat(200),
      details: ["QuotaFailure"],
    },
  })}`;
  memory.retrieval = Object.freeze({ mode: "lexical", degraded: true, reason });
  const projected = compactSearchContext(memory);
  const rendered = renderSearchSurface(memory);

  assert.equal(projected.retrieval?.reason, "embedding_http_429");
  assert.match(rendered, /mode=lexical; reason=embedding_http_429/u);
  assert.match(rendered, /results are lexical-only/u);
  assert.match(rendered, /memory=memory-a/u);
  assert.doesNotMatch(rendered, /provider-diagnostic-content|QuotaFailure/u);
  assert.equal(memory.retrieval.reason, reason, "the owning diagnostic remains intact");
  assert.notEqual(projected.retrieval, memory.retrieval);
});

test("empty degraded search retains the fallback signal but not provider diagnostics", () => {
  const memory: MemoryContext = {
    results: [],
    relations: [],
    retrieval: {
      mode: "lexical",
      degraded: true,
      reason: "embedding server returned 429: provider-diagnostic-content",
    },
  };
  const rendered = renderSearchSurface(memory, { emptyText: "No candidates." });
  assert.match(rendered, /mode=lexical; reason=embedding_http_429/u);
  assert.match(rendered, /No candidates\./u);
  assert.doesNotMatch(rendered, /provider-diagnostic-content/u);
  assert.equal(
    renderSearchSurface({ results: [], relations: [] }),
    "No matching NMG memory found.",
  );
});

test("compact rendering also protects consumers of older raw diagnostic DTOs", () => {
  const projected = compactSearchContext(context());
  projected.retrieval = {
    mode: "lexical",
    degraded: true,
    reason: "embedding server returned 503: upstream diagnostic\nbackend-only-detail",
  };
  const rendered = renderCompactSearchSurface(projected);
  assert.match(rendered, /reason=embedding_http_503/u);
  assert.doesNotMatch(rendered, /upstream diagnostic|backend-only-detail/u);
});

test("degraded reason codes are stable and arbitrary provider prose stays private", () => {
  for (const [reason, expected] of [
    ["embedding_unavailable", "embedding_unavailable"],
    ["embedding_index_not_ready", "embedding_index_not_ready"],
    ["embedding_index_missing_targets", "embedding_index_missing_targets"],
    ["embedding_http_429", "embedding_http_429"],
    ["request failed: provider-only-detail", "unknown"],
    [undefined, "unknown"],
  ]) {
    const memory = context();
    memory.retrieval = { mode: "lexical", degraded: true, reason };
    assert.match(renderSearchSurface(memory), new RegExp(`reason=${expected}\\]`, "u"));
  }
  const healthy = context();
  healthy.retrieval = { mode: "hybrid", degraded: false };
  assert.doesNotMatch(renderSearchSurface(healthy), /degraded retrieval/u);
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
    { taskId: "ooo-probe:agent-surface", includeConventions: true },
  );

  assert.match(rendered, /\[claimed by worker-7\]/u);
  assert.match(
    rendered,
    /\[delivered by worker-7 24fb32103aafae2bc963a7e7deecaf1bc36702d697bc7abd8e1f67af01b525b1\]/u,
  );
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

          kind: "question",
          status: "open",
          agentId: "agent-a",
          content: "Who owns the adapter migration?",
          ackedBy: ["agent-b"],
        },
      ],
      nextCursor: "7",
    },
    { taskId: "adapter-migration" },
  );

  assert.match(rendered, /Who owns the adapter migration/u);
  assert.match(rendered, /nextCursor=7/u);
  assert.match(rendered, /Temporary coordination only/u);
  assert.doesNotMatch(rendered, /Board conventions/u);
  assert.doesNotMatch(rendered, /lease-based/u);
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

test("shared board views preserve actual channel, routing and complete artifact identity", () => {
  const digest = "24fb32103aafae2bc963a7e7deecaf1bc36702d697bc7abd8e1f67af01b525b1";
  const output = prepareTaskBoardSurface(
    {
      action: "readInbox",
      entries: [
        {
          id: "e1",
          taskId: "actual-channel",
          kind: "handoff",
          status: "open",
          agentId: "sender",
          content: "Review parser.",
          to: "reviewer",
          serialState: "pending",
          deliveredBy: "worker",
          deliverableDigest: digest,
          verdict: "undecidable",
          judgedBy: "reviewer",
        },
      ],
    },
    { taskId: "default" },
  );
  assert.match(output.text, /channel=actual-channel/u);
  assert.match(output.text, /to=reviewer/u);
  assert.match(output.text, /pending/u);
  assert.ok(output.text.includes(digest));
  assert.match(output.text, /verdict undecidable/u);
  assert.deepEqual(output.included[0]?.source, {
    kind: "board",
    taskId: "actual-channel",
    entryId: "e1",
  });
});

test("board display budget withholds a transport cursor that would skip unseen entries", () => {
  const output = prepareTaskBoardSurface(
    {
      action: "read",
      nextCursor: "e2",
      entries: ["e1", "e2"].map((id) => ({
        id,
        kind: "note",
        status: "open",
        agentId: "sender",
        content: "x".repeat(80),
      })),
    },
    { taskId: "parser", maxCharacters: 180 },
  );
  assert.equal(output.included.length, 1);
  assert.equal(
    output.omitted.some((view) => view.source?.kind === "board"),
    true,
  );
  assert.doesNotMatch(output.text, /nextCursor=/u);
  assert.match(output.text, /omitted=/u);
  assert.ok(output.text.length <= 180);
});

test("AG output excludes foreign frames and preserves hypothesis labeling", () => {
  const runtime = new SessionActiveGraphRuntime();
  runtime.observe({
    sessionId: "owner-a",
    taskFrameId: "parser",
    statement: "Possible boundary issue.",
    kind: "reasoning_artifact",
  });
  const parser = runtime.activateTemporaryProjection("owner-a");
  runtime.observe({
    sessionId: "owner-a",
    taskFrameId: "other",
    statement: "Do not mix tasks.",
  });
  const other = runtime.activateTemporaryProjection("owner-a");
  const output = prepareSessionActiveGraphSurface({
    ...parser,
    items: [...parser.items, ...other.items],
  });
  assert.match(output.text, /\[hypothesis\] Possible boundary issue/u);
  assert.doesNotMatch(output.text, /Do not mix tasks/u);
  assert.equal(output.included.length, 1);
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
