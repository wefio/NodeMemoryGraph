import assert from "node:assert/strict";
import test from "node:test";

import { isBoardWakeCandidate, maybeBroadcastToWorld } from "../../src/integration/board-wake.ts";
import { SessionRecallFlow } from "../../src/integration/session-recall-flow.ts";
import { SessionTaskWindow } from "../../src/integration/session-task-window.ts";
import {
  isMemorableToolResult,
  isSuccessfulCommit,
  summarizeToolResult,
} from "../../src/integration/tool-observation.ts";

// Session-flow behaviour lives in the shared integration layer (every harness
// adapter forwards the same rules), so its tests track the module not a host.

test("session recall flow requires evidence progression after two searches", () => {
  const flow = new SessionRecallFlow();
  assert.equal(flow.beginTurn("session-a", "first request"), true);
  assert.equal(flow.allowSearch("session-a"), true);
  flow.recordSearch("session-a", ["memory-1"]);
  assert.equal(flow.allowSearch("session-a"), true);
  flow.recordSearch("session-a", ["memory-2"]);
  assert.equal(flow.allowSearch("session-a"), false);
  assert.equal(flow.searchBlockReason("session-a"), "evidence_progression_required");

  // Pi emits before_agent_start again after each tool result. The same user
  // prompt must not reset the guard during those internal agent loops.
  assert.equal(flow.beginTurn("session-a", "first request"), false);
  assert.equal(flow.allowSearch("session-a"), false);

  assert.equal(flow.allowGet("session-a"), true);
  flow.recordGet("session-a", ["memory-1"]);
  assert.equal(flow.allowSearch("session-a"), true);
  assert.equal(flow.beginTurn("session-a", "second request"), true);
  assert.equal(flow.allowSearch("session-a"), true);
});

test("session recall flow isolates and clears session state", () => {
  const flow = new SessionRecallFlow(1);
  flow.beginTurn("session-a", "request");
  flow.beginTurn("session-b", "request");
  assert.equal(flow.allowSearch("session-a"), true);
  assert.equal(flow.allowSearch("session-a"), false);
  assert.equal(flow.allowSearch("session-b"), true);

  flow.clear("session-a");
  assert.equal(flow.allowSearch("session-a"), true);
});

test("session recall flow stops repeated candidates and enforces a hard tool budget", () => {
  const noGain = new SessionRecallFlow(2, 5, 6, 2);
  noGain.beginTurn("session-a", "request");
  assert.equal(noGain.allowSearch("session-a"), true);
  noGain.recordSearch("session-a", ["memory-1"]);
  assert.equal(noGain.allowGet("session-a"), true);
  noGain.recordGet("session-a", ["memory-1"]);
  assert.equal(noGain.allowSearch("session-a"), true);
  noGain.recordSearch("session-a", ["memory-1"]);
  assert.equal(noGain.allowSearch("session-a"), true);
  noGain.recordSearch("session-a", ["memory-1"]);
  assert.equal(noGain.allowSearch("session-a"), false);
  assert.equal(noGain.searchBlockReason("session-a"), "no_new_evidence");

  const hardCap = new SessionRecallFlow(3, 4, 4, 4);
  hardCap.beginTurn("session-b", "request");
  assert.equal(hardCap.allowGet("session-b"), true);
  hardCap.recordGet("session-b", ["memory-1"]);
  assert.equal(hardCap.allowGet("session-b"), true);
  hardCap.recordGet("session-b", ["memory-2"]);
  assert.equal(hardCap.allowSearch("session-b"), true);
  hardCap.recordSearch("session-b", ["memory-3"]);
  assert.equal(hardCap.allowGet("session-b"), true);
  hardCap.recordGet("session-b", ["memory-3"]);
  assert.equal(hardCap.allowGet("session-b"), false);
  assert.equal(hardCap.searchBlockReason("session-b"), "recall_tool_budget_exhausted");
});

test("session task window carries bounded task context into terse continuations", () => {
  const window = new SessionTaskWindow();
  const first = window.prepare(
    "session-a",
    "Configure the pi-lsp extension to use the vendored language server implementation.",
  );
  assert.equal(first, null, "ordinary implementation work does not preload long-term memory");

  const continuation = window.prepare("session-a", "我 reload 了，你试试");
  assert.match(continuation!.query, /reload/u);
  assert.match(continuation!.query, /Recent task context:/u);
  assert.match(continuation!.query, /vendored language server/u);
  assert.equal(continuation!.reason, "task_continuation");

  const switched = window.prepare(
    "session-a",
    "Implement and test the unrelated billing export pipeline.",
  );
  assert.equal(switched, null);

  assert.equal(window.prepare("session-b", "好的"), null);
});

test("session task window keeps explicit recall and clears session context", () => {
  const window = new SessionTaskWindow();
  window.prepare("session-a", "Implement and test the Atlas SQLite storage adapter.");
  assert.match(
    window.prepare("session-a", "What did we decide last time?")!.query,
    /Atlas SQLite/u,
  );
  window.clear("session-a");
  assert.doesNotMatch(
    window.prepare("session-a", "What did we decide last time?")!.query,
    /Atlas/u,
  );
});

test("fresh session task windows forward Chinese recollection questions unchanged", () => {
  const window = new SessionTaskWindow();
  for (const [index, prompt] of [
    "你还记得之前我们精简AG内容的几步是什么吗？",
    "之前说好的 AG 精简步骤还有哪几步没做？",
  ].entries()) {
    const request = window.prepare(`recollection-${index}`, prompt);
    assert.ok(request, prompt);
    assert.equal(request.mode, "retrieve");
    assert.equal(request.reason, "explicit_recall");
    assert.equal(request.query, prompt);
  }
});

test("session task window applies the memory gate to ordinary, cue, and recall prompts", () => {
  const window = new SessionTaskWindow();
  assert.equal(window.prepare("session-a", "Explain how acquireFileLock works."), null);

  const cue = window.prepare("session-a", "How should we plan the next release?");
  assert.equal(cue?.mode, "cue");
  assert.equal(cue?.limit, 5);
  assert.equal(cue?.graphHops, 0);

  const recall = window.prepare("session-a", "What did we decide last time?");
  assert.equal(recall?.mode, "retrieve");
  assert.equal(recall?.limit, 12);
  assert.equal(recall?.graphHops, 1);
});

test("git commit nudge is success-aware on tool_result", () => {
  assert.equal(
    isSuccessfulCommit({
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "[main a1b2c3d] feat: wire SQLite" }],
      input: { command: "git commit -m 'feat' && git push" },
    }),
    true,
  );
  // Exit 0 but nothing actually committed: no nudge.
  assert.equal(
    isSuccessfulCommit({
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "nothing to commit, working tree clean" }],
      input: { command: "git commit -am x" },
    }),
    false,
  );
  // A failed commit is not a milestone.
  assert.equal(
    isSuccessfulCommit({
      toolName: "bash",
      isError: true,
      content: [],
      input: { command: "git commit -m x" },
    }),
    false,
  );
  // Non-commit commands never nudge.
  assert.equal(
    isSuccessfulCommit({
      toolName: "bash",
      isError: false,
      content: [],
      input: { command: "npm test" },
    }),
    false,
  );
});

test("tool result filter keeps only memorable outcomes", () => {
  assert.equal(
    isMemorableToolResult({
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "error: cannot find module" }],
      input: { command: "npm run build" },
    }),
    true,
  );
  assert.equal(
    isMemorableToolResult({
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "ok" }],
      input: { command: "ls" },
    }),
    false,
  );
  assert.equal(
    isMemorableToolResult({
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "1 passed, 0 failed" }],
      input: { command: "npm test" },
    }),
    true,
  );
  assert.equal(
    isMemorableToolResult({
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "lots of file content" }],
      input: { path: "src/a.ts" },
    }),
    false,
  );
  assert.equal(
    isMemorableToolResult({
      toolName: "edit",
      isError: false,
      content: [{ type: "text", text: "ok" }],
      input: { path: "src/a.ts" },
    }),
    true,
  );
  assert.equal(
    isMemorableToolResult({
      toolName: "grep",
      isError: false,
      content: [{ type: "text", text: "src/a.ts:1: match" }],
      input: { query: "x" },
    }),
    true,
  );
  assert.equal(
    isMemorableToolResult({
      toolName: "grep",
      isError: false,
      content: [{ type: "text", text: "" }],
      input: { query: "x" },
    }),
    false,
  );
});

test("tool trace statement carries the path and tool node", () => {
  const edit = summarizeToolResult({
    toolName: "edit",
    isError: false,
    content: [],
    input: { path: "src/a.ts" },
  });
  assert.equal(edit.nodeName, "src/a.ts");
  assert.match(edit.statement, /Edited src\/a\.ts/);
  const bash = summarizeToolResult({
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "fatal: boom" }],
    input: { command: "git commit" },
  });
  assert.equal(bash.nodeName, "tool:bash");
  assert.match(bash.statement, /\[error\]/);
});

test("world-channel pull broadcast posts once and dedups per entry", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let delivered = false;
  const mockInvoke = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (params.action === "deliveryCheck") {
      return {
        action: "deliveryCheck",
        delivered: delivered ? ["entry-1"] : [],
        suppressed: false,
      };
    }
    if (params.action === "put") {
      return { action: "put", entry: { id: "broadcast-1" } };
    }
    if (params.action === "recordDelivery") {
      delivered = true;
      return { action: "recordDelivery", recorded: true };
    }
    throw new Error(`unexpected invoke ${method} ${JSON.stringify(params)}`);
  };
  const entry = {
    id: "entry-1",
    sequence: 3,
    agentId: "other-agent",
    kind: "question",
    status: "open",
    content: "谁能帮忙？",
    createdAt: "2026-01-01T00:00:00.000Z",
    taskId: "task-x",
  };
  const posted = await maybeBroadcastToWorld({
    invoke: mockInvoke as (method: string, params: unknown) => Promise<unknown>,
    entry,
    agentId: "me",
    sessionId: "sess-1",
  });
  assert.equal(posted, true);
  const put = calls.find((call) => call.params.action === "put")!;
  assert.equal(put.params.kind, "handoff");
  assert.match(String(put.params.content), /协作广播/u);
  assert.equal(put.params.sourceSessionId, "sess-1");
  assert.equal(put.params.ttlSeconds, 86_400, "broadcast is transient (RAII TTL)");
  const recorded = calls.find((call) => call.params.action === "recordDelivery")!;
  assert.equal(recorded.params.sessionId, "world-broadcast");
  assert.equal(recorded.params.entryId, "entry-1");
  // Already broadcast (deliveryCheck reports the sentinel receipt) → no second post.
  const again = await maybeBroadcastToWorld({
    invoke: mockInvoke as (method: string, params: unknown) => Promise<unknown>,
    entry,
    agentId: "me",
    sessionId: "sess-1",
  });
  assert.equal(again, false);
  assert.equal(calls.filter((call) => call.params.action === "put").length, 1);
});

test("a broadcast entry is never re-broadcast (no broadcast storm)", async () => {
  let invoked = 0;
  const mockInvoke = async () => {
    invoked += 1;
    return { delivered: [] };
  };
  const broadcastEntry = {
    id: "broadcast-1",
    sequence: 12,
    agentId: "other-agent",
    kind: "handoff",
    status: "open",
    content: "[NMG board 协作广播] 频道 task-x 有 #1 未认领的交接（open）：…",
    createdAt: "2026-01-01T00:00:00.000Z",
    taskId: "default",
  };
  const posted = await maybeBroadcastToWorld({
    invoke: mockInvoke as (method: string, params: unknown) => Promise<unknown>,
    entry: broadcastEntry,
    agentId: "me",
    sessionId: "sess-1",
  });
  assert.equal(posted, false);
  assert.equal(invoked, 0, "no daemon calls for a broadcast entry");
});

test("isBoardWakeCandidate: live claim suppresses nudges, lapsed claim returns to pool (no starvation)", () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const base = {
    id: "entry-1",
    sequence: 1,
    agentId: "other",
    sourceSessionId: "other-sess",
    kind: "handoff",
    status: "open",
    content: "Any taker?",
  };
  const wake = (overrides: Record<string, unknown>) =>
    isBoardWakeCandidate({ ...base, ...overrides } as Parameters<typeof isBoardWakeCandidate>[0], {
      sessionId: "me-sess",
      agentId: "me",
      now,
    });
  // Unclaimed open entry from another session: wake.
  assert.equal(wake({}), true);
  // Notify-only kinds are silent: a note/result/decision/goal records a fact
  // and owes no reply — waking on it is the acknowledgement storm (four
  // agents confirming one fact each emit a note, and every note wakes every
  // subscriber). Read on demand, never pushed.
  for (const kind of ["note", "result", "decision", "goal"]) {
    assert.equal(wake({ kind }), false, `${kind} must be silent`);
  }
  // Actionable kinds wake: question/blocker/handoff ask for a response.
  for (const kind of ["question", "blocker", "handoff"]) {
    assert.equal(wake({ kind }), true, `${kind} must wake`);
  }
  // Own echo: never wake yourself.
  assert.equal(wake({ sourceSessionId: "me-sess" }), false);
  // Resolved: no wake.
  assert.equal(wake({ status: "resolved" }), false);
  // Broadcast pull announcement: meta, no wake (subscription-leak fix).
  assert.equal(
    wake({ content: "[NMG board 协作广播] 频道 x 有 #1 未认领的交接（open）：…" }),
    false,
  );
  // Live claim by someone else: they are working it — no nudge for anyone.
  assert.equal(wake({ claimedBy: "other", claimExpiresAt: "2026-08-13T13:00:00.000Z" }), false);
  // Live claim by THIS agent: holder knows, no self-nudge.
  assert.equal(wake({ claimedBy: "me", claimExpiresAt: "2026-08-13T13:00:00.000Z" }), false);
  // Lapsed claim by someone else: lease expired, entry returns to the pool — wake.
  assert.equal(wake({ claimedBy: "other", claimExpiresAt: "2026-08-13T11:00:00.000Z" }), true);
  // Lapsed claim by THIS agent (the starvation case from the audit): the holder
  // crashed/stopped and the lease lapsed; without liveness the entry would be
  // permanently hidden from its former holder until TTL. Must wake.
  assert.equal(wake({ claimedBy: "me", claimExpiresAt: "2026-08-13T11:00:00.000Z" }), true);
  // Legacy row with no claim expiry (claim fields absent): treat as unclaimed.
  assert.equal(wake({ claimedBy: "me", claimExpiresAt: null }), true);
  // Directed delivery (find→direct): addressed to another stable agent_name —
  // never wake me; I read-but-stay-silent.
  assert.equal(wake({ to: "other" }), false);
  // Directed to me: I am the addressee — wake.
  assert.equal(wake({ to: "me" }), true);
  // Reply-gated serial handoff: a pending actionable is queued behind the
  // outstanding one ("回复=接手" — it promotes on claim/resolve) — no wake.
  assert.equal(wake({ serialState: "pending" }), false);
  // The outstanding actionable is the serial slot being worked — wake.
  assert.equal(wake({ serialState: "outstanding" }), true);
  // Directed entries are exempt from serial queuing (serialState null) — wake
  // as ordinary actionable (point-to-point, parallel-safe).
  assert.equal(wake({ to: "me", serialState: null }), true);
});
