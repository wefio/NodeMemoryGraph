/**
 * Chaos 3 — embedding service outage (unreachable NMG_EMBED_BASE_URL).
 *
 * The retrieval path runs on the local hashing embedder, so an unreachable
 * external embedding service must NOT take down remember/search. The sync
 * path must fail loudly: embedding_index_state flips to "failed" with
 * last_error (observable via status), and the SQLite work queue keeps the
 * un-indexed records for the next sync — recovery is built in, not silent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { NmgService } from "../../src/cli/service.ts";
import { NmgStore } from "../../src/core/store.ts";
import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { syncRecordEmbeddings } from "../../src/core/embedding-sync.ts";

const DEAD_EMBEDDING_ENV = {
  ...process.env,
  NMG_EMBED_PROVIDER: "openai",
  // Unreachable port: connection refused on every attempt.
  NMG_EMBED_BASE_URL: "http://127.0.0.1:1/v1/embeddings",
};

test("chaos embedding outage: remember/search still work (local hashing embedder)", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-chaos3-"));
  const service = new NmgService({ dataDirectory: directory, environment: DEAD_EMBEDDING_ENV });
  try {
    await service.invoke("remember", {
      statement: "chaos embedding outage probe",
      nodeName: "chaos-embed",
    });
    const r = (await service.invoke("search", { query: "chaos embedding outage" })) as {
      results?: unknown[];
    };
    assert.ok(
      Array.isArray(r.results) && r.results.length > 0,
      "search must still work with the embedding service down",
    );
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("chaos embedding outage: sync fails loudly (failed state + last_error)", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "nmg-chaos3-"));
  const service = new NmgService({ dataDirectory: directory, environment: DEAD_EMBEDDING_ENV });
  let store: NmgStore | undefined;
  try {
    await service.invoke("remember", {
      statement: "sync outage probe record",
      nodeName: "chaos-sync",
    });
    store = new NmgStore(join(directory, "nmg.sqlite"));
    const client = createEmbeddingClientFromEnv(DEAD_EMBEDDING_ENV);
    if (!client) throw new Error("expected an embedding client from env");
    await assert.rejects(syncRecordEmbeddings(store, client), "unreachable service must throw");
    const health = store.embeddingIndexHealth(client.indexId);
    assert.ok(health, "health record must exist after a failed sync");
    assert.equal(health.status, "failed", `sync failure must be recorded, got: ${health.status}`);
    assert.match(String(health.lastError ?? ""), /fetch|connect|ECONN|ENOTFOUND|refused/i);

    // SQLite work-queue semantics: the failed record stays selectable for the
    // next sync attempt — recovery is built in.
    const pending = store.embeddingDocuments("", 64, client.indexId);
    assert.ok(
      pending.some((document) => document.text.includes("sync outage probe")),
      "un-indexed records must remain in the sync queue",
    );
  } finally {
    store?.close();
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
