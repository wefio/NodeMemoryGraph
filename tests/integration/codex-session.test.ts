import assert from "node:assert/strict";
import test from "node:test";
import { codexHookBinding, codexMcpBinding } from "../../codex-plugin/session.ts";

const a = "00000000-0000-7000-8000-000000000001";
const b = "00000000-0000-7000-8000-000000000002";
const turn = "00000000-0000-7000-8000-000000000003";
const metadata = (id: string) => ({
  "x-codex-turn-metadata": { thread_id: id, session_id: id, turn_id: turn },
  threadId: id,
  sessionId: id,
});

test("Codex native transport and hook identifiers map to the same durable session", () => {
  assert.equal(
    codexMcpBinding(metadata(a)).sessionId,
    codexHookBinding({ session_id: a, turn_id: turn }).sessionId,
  );
  assert.equal(codexMcpBinding(metadata(a)).sessionId, `codex-${a}`);
  assert.notEqual(codexMcpBinding(metadata(a)).sessionId, codexMcpBinding(metadata(b)).sessionId);
});

test("Codex rejects missing, contradictory and path-like host identity", () => {
  assert.throws(() => codexMcpBinding({}), /metadata/);
  assert.throws(() => codexMcpBinding({ ...metadata(a), threadId: b }), /conflict/);
  assert.throws(() => codexMcpBinding(metadata("../other")), /identifier/);
  assert.throws(() => codexHookBinding({ session_id: "", turn_id: turn }), /identifier/);
});

test("Codex ignores process identity overrides and keeps forks separate", () => {
  const previous = process.env.NMG_SESSION_ID;
  process.env.NMG_SESSION_ID = "shared-wrong-identity";
  try {
    assert.notEqual(codexMcpBinding(metadata(a)).sessionId, codexMcpBinding(metadata(b)).sessionId);
    assert.equal(codexMcpBinding(metadata(a)).turnId, turn);
  } finally {
    if (previous === undefined) delete process.env.NMG_SESSION_ID;
    else process.env.NMG_SESSION_ID = previous;
  }
});
