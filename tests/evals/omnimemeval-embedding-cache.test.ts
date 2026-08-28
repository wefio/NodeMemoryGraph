import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CachedOmniEmbeddingClient } from "../../evals/omnimemeval/embedding-cache.ts";

test("shared embedding cache joins concurrent misses within one worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-embedding-cache-"));
  let documentCalls = 0;
  const delegate = {
    indexId: "test-index",
    async embedQueries(inputs: string[]): Promise<number[][]> {
      return inputs.map(() => [0, 1]);
    },
    async embedDocuments(inputs: string[]): Promise<number[][]> {
      documentCalls += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return inputs.map((input) => [input.length, 1]);
    },
  };
  const client = new CachedOmniEmbeddingClient(join(directory, "cache.sqlite"), delegate);
  try {
    const [left, right] = await Promise.all([
      client.embedDocuments(["same content"]),
      client.embedDocuments(["same content"]),
    ]);
    assert.deepEqual(left, [[12, 1]]);
    assert.deepEqual(right, left);
    assert.equal(documentCalls, 1);
  } finally {
    client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared embedding cache releases a failed in-flight miss for retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-embedding-cache-retry-"));
  let documentCalls = 0;
  const delegate = {
    indexId: "test-index",
    async embedQueries(inputs: string[]): Promise<number[][]> {
      return inputs.map(() => [0, 1]);
    },
    async embedDocuments(inputs: string[]): Promise<number[][]> {
      documentCalls += 1;
      if (documentCalls === 1) throw new Error("temporary provider failure");
      return inputs.map((input) => [input.length, 1]);
    },
  };
  const client = new CachedOmniEmbeddingClient(join(directory, "cache.sqlite"), delegate);
  try {
    await assert.rejects(client.embedDocuments(["retry me"]), /temporary provider failure/);
    assert.deepEqual(await client.embedDocuments(["retry me"]), [[8, 1]]);
    assert.equal(documentCalls, 2);
  } finally {
    client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
