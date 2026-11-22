import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EmbeddingClient } from "../../src/core/embedding-provider.ts";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { openMemoryBackend } from "../../src/core/memory/open.ts";
import { sourceHttpMessageId } from "../../src/integration/memory-http-protocol.ts";
import { HttpMemoryService } from "../../src/integration/memory-http-service.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

function createStubEmbeddingClient(): EmbeddingClient {
  const vectorFor = (text: string): number[] => {
    if (/\bquartz\b/iu.test(text) && !/\b(?:earlier|later|detail|unrelated)\b/iu.test(text)) {
      return [1, 0];
    }
    if (/\b(?:earlier|later|unrelated)\b/iu.test(text)) return [0, 1];
    return [0.8, 0.6];
  };
  return {
    indexId: "stub-v1",
    model: "stub-embed",
    profile: "default",
    async embed(inputs) {
      return inputs.map(vectorFor);
    },
    async embedDocuments(inputs) {
      return inputs.map(vectorFor);
    },
    async embedQueries(inputs) {
      return inputs.map(vectorFor);
    },
  };
}

test("HttpMemoryService retrieves cross-chunk session neighbors in hybrid mode without score inversion", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-http-service-neighbors-"));
  const backend = await openMemoryBackend({
    kind: "sqlite",
    path: join(directory, "memory.sqlite"),
    namespace: "http:u1",
  });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(directory);
  });

  const engine = new MemoryEngine(backend, () => "2026-11-22T00:00:00.000Z");
  const client = createStubEmbeddingClient();
  const hybrid = new HttpMemoryService(engine, client);

  await hybrid.rememberBatch("u1", "sample:0", "req-chunk-0", [
    {
      role: "user",
      content: "Quartz earlier context " + "filler ".repeat(70),
      source_message_id: sourceHttpMessageId("hash0", 0),
    },
  ]);
  await hybrid.rememberBatch("u1", "sample:other", "req-other", [
    {
      role: "user",
      content: "Quartz unrelated session " + "filler ".repeat(70),
      source_message_id: sourceHttpMessageId("hashother", 0),
    },
  ]);
  await hybrid.rememberBatch("u1", "sample:0", "req-chunk-1", [
    {
      role: "user",
      content: "Quartz",
      source_message_id: sourceHttpMessageId("hash1", 0),
    },
  ]);
  await hybrid.rememberBatch("u1", "sample:0", "req-chunk-2", [
    {
      role: "user",
      content: "Quartz later followup " + "filler ".repeat(70),
      source_message_id: sourceHttpMessageId("hash2", 0),
    },
  ]);
  await hybrid.rememberBatch(
    "u1",
    "sample:details",
    "req-details",
    Array.from({ length: 21 }, (_, index) => ({
      role: "user" as const,
      content: `Quartz detail number ${index}`,
      source_message_id: sourceHttpMessageId("hashdetails", index),
    })),
  );

  // Hybrid search at limit >= 10 pulls the matching previous/next chunks to the tail.
  const expanded = await hybrid.search(["quartz"], 10);
  assert.equal(expanded.retrievalMode, "records");
  assert.equal(expanded.memories.length, 10);
  assert.equal(expanded.memories[0]?.raw_content, "Quartz");

  const tailContents = expanded.memories.slice(8).map((row) => row.raw_content);
  assert.ok(
    tailContents.some((text) => text.startsWith("Quartz earlier context")),
    "expected previous chunk turn in tail neighbors",
  );
  assert.ok(
    tailContents.some((text) => text.startsWith("Quartz later followup")),
    "expected next chunk turn in tail neighbors",
  );
  assert.ok(
    !expanded.memories.some((row) => row.raw_content.startsWith("Quartz unrelated session")),
    "different session_id should never be pulled as adjacent source",
  );
  for (let i = 0; i < expanded.memories.length - 1; i += 1) {
    assert.ok(
      expanded.memories[i]!.score >= expanded.memories[i + 1]!.score,
      `expected monotonic score at index ${i}: ${expanded.memories[i]!.score} < ${expanded.memories[i + 1]!.score}`,
    );
  }

  // Hybrid search below limit 10 keeps the existing limit >= 10 gate.
  const smallPage = await hybrid.search(["quartz"], 5);
  assert.equal(smallPage.memories.length, 5);
  assert.ok(
    !smallPage.memories.some((row) => row.raw_content.startsWith("Quartz earlier context")),
  );
  assert.ok(!smallPage.memories.some((row) => row.raw_content.startsWith("Quartz later followup")));

  // Lexical-only service keeps the hybrid gate disabled.
  const lexical = new HttpMemoryService(engine);
  const lexicalPage = await lexical.search(["quartz"], 10);
  assert.equal(lexicalPage.retrievalMode, "lexical");
  assert.ok(
    !lexicalPage.memories.some((row) => row.raw_content.startsWith("Quartz earlier context")),
  );
  assert.ok(
    !lexicalPage.memories.some((row) => row.raw_content.startsWith("Quartz later followup")),
  );
});
