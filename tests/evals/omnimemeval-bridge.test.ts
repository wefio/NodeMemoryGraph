import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OmniMemEvalBridge } from "../../evals/omnimemeval/bridge.ts";

test("OmniMemEval bridge ingests and retrieves isolated user memories", () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-omni-"));
  const bridge = new OmniMemEvalBridge(root);
  try {
    const added = bridge.handle({
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
        { role: "assistant", content: "I will remember that." },
      ],
    }) as { added: number };
    assert.equal(added.added, 2);

    const alice = bridge.handle({
      id: 2,
      op: "search",
      userId: "alice",
      query: "What is my telescope named?",
      topK: 4,
    }) as { text: string };
    const bob = bridge.handle({
      id: 3,
      op: "search",
      userId: "bob",
      query: "What is my telescope named?",
      topK: 4,
    }) as { text: string };

    assert.match(alice.text, /Kepler/);
    assert.equal(bob.text, "");

    bridge.handle({ id: 4, op: "delete", userId: "alice" });
    const deleted = bridge.handle({
      id: 5,
      op: "search",
      userId: "alice",
      query: "Kepler telescope",
      topK: 4,
    }) as { text: string };
    assert.equal(deleted.text, "");
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});
