import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import {
  MEMORY_EMBEDDING_REPRESENTATION,
  memoryEmbeddingModelId,
} from "../../src/core/store/search-ranking.ts";

/** The store's handle, so the test can write the history a capture would. */
class InspectableStore extends NmgStore {
  database(): DatabaseSync {
    return this.db;
  }

  embedderModel(): string {
    return this.embedder.model;
  }
}

test("re-embedding writes the contextualised text under a versioned identity", () => {
  const store = new InspectableStore(":memory:");
  try {
    const saved = store.remember({
      statement: "I stopped going.",
      nodeName: "Alice",
      sourceActor: "user",
      eventTime: "2023-05-12T09:00:00+00:00",
    });
    const db = store.database();
    const now = new Date().toISOString();
    const insertHistory = db.prepare(
      `INSERT INTO history_records (id, session_id, source_message_id, role, content, source_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertHistory.run("h1", "s1", "1", "user", "So you still swim every week?", "ref:1", now);
    insertHistory.run("h2", "s1", "2", "assistant", "I stopped going.", "ref:2", now);
    db.prepare("INSERT INTO memory_evidence_links (memory_id, history_id) VALUES (?, ?)").run(
      saved.memory.id,
      "h2",
    );

    store.refreshEmbeddings([saved.memory.id]);

    const [document] = store.embeddingDocuments();
    assert.ok(document, "the memory is a pending embedding document");
    // The date comes from the record, the previous turn from history_records.
    assert.match(document.text, /^2023-05-12 I stopped going\./u);
    assert.match(document.text, /previous: So you still swim every week\?/u);

    const stored = db
      .prepare("SELECT model FROM memory_embeddings WHERE memory_id = ?")
      .all(saved.memory.id) as Array<{ model: string }>;
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.model, memoryEmbeddingModelId(store.embedderModel()));
    assert.match(stored[0]!.model, new RegExp(`@${MEMORY_EMBEDDING_REPRESENTATION}$`, "u"));

    // Read and write identities must agree: the search join looks for exactly
    // this model id, so a mismatch would silently empty the vector channel.
    const results = store.search("stopped going swimming");
    assert.equal(
      results.some((result) => result.memory.id === saved.memory.id),
      true,
      "search still reaches the memory after the representation change",
    );
  } finally {
    store.close();
  }
});

test("a record with no event time and no predecessor keeps the plain text", () => {
  const store = new InspectableStore(":memory:");
  try {
    const saved = store.remember({
      statement: "The deploy region is Europe.",
      nodeName: "deployment region",
      sourceActor: "user",
    });
    store.refreshEmbeddings([saved.memory.id]);
    const [document] = store.embeddingDocuments();
    assert.ok(document);
    assert.equal(document.text, "The deploy region is Europe.");
  } finally {
    store.close();
  }
});
