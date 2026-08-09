import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import { retainEvidence } from "../../src/integration/evidence.ts";

test("agent-neutral evidence retention stores only the matching source message", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-integration-evidence-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    const evidenceId = retainEvidence(store, "must keep SQLite", "user", {
      sessionId: "session-1",
      sourceRef: "agent://session-1",
      messages: [
        { id: "assistant-1", actor: "assistant", content: "I can help with that." },
        {
          id: "user-1",
          actor: "user",
          content: "The Atlas project must keep SQLite for offline operation.",
        },
      ],
    });

    assert.ok(evidenceId);
    assert.equal(
      store.getHistoryBySourceMessage("session-1", "user-1")?.content,
      "must keep SQLite",
    );
    assert.equal(store.getHistoryBySourceMessage("session-1", "assistant-1"), null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("agent-neutral evidence retention rejects oversized or wrong-actor excerpts", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-integration-evidence-boundary-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    const history = {
      sessionId: "session-1",
      messages: [{ id: "user-1", actor: "user" as const, content: `prefix ${"x".repeat(5_000)}` }],
    };
    assert.equal(retainEvidence(store, "prefix", "assistant", history), undefined);
    assert.equal(retainEvidence(store, "x".repeat(5_000), "user", history), undefined);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("agent-neutral evidence retention is idempotent by session and message", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-integration-idempotent-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  const history = {
    sessionId: "session-1",
    messages: [{ id: "user-1", actor: "user" as const, content: "Use Chinese explanations." }],
  };
  try {
    const first = retainEvidence(store, "Chinese explanations", "user", history);
    const second = retainEvidence(store, "Chinese explanations", "user", history);
    assert.ok(first);
    assert.equal(second, first);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
