import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NmgService } from "../../src/cli/service.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

const fixtureBaseUrl = "https://embedding.invalid/v1";
const environment = {
  NMG_EMBED_PROVIDER: "openai",
  NMG_EMBED_BASE_URL: fixtureBaseUrl,
  NMG_EMBED_API_KEY: "fixture-only",
  NMG_EMBED_DIMENSIONS: "2",
};

test("an embedding outage preserves lexical recall and pending vectors recover after restart", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-chaos-embeddings-"));
  let unavailable = false;
  let failedRequests = 0;
  t.mock.method(globalThis, "fetch", async (url: URL | string, init: RequestInit) => {
    assert.equal(String(url), `${fixtureBaseUrl}/embeddings`);
    if (unavailable) {
      failedRequests += 1;
      return new Response("fixture outage", { status: 503 });
    }
    const request = JSON.parse(String(init.body)) as { input: string[] };
    return Response.json({
      data: request.input.map((_text, index) => ({ index, embedding: [1, 0] })),
    });
  });

  const options = { dataDirectory: directory, environment };
  let service = new NmgService(options);
  try {
    await service.invoke("remember", {
      statement: "The primary inventory uses a violet label",
      nodeName: "Inventory",
    });
    await service.close();
    service = new NmgService(options);
    unavailable = true;

    const { memory } = await service.invoke("remember", {
      statement: "The reserve inventory uses a crimson label",
      nodeName: "Reserve inventory",
    });
    const query = { query: "reserve inventory crimson", retrievalMode: "hybrid" } as const;
    const fallback = await service.invoke("search", query);
    assert.ok(failedRequests > 0);
    assert.deepEqual(fallback.retrieval, {
      mode: "lexical",
      degraded: true,
      reason: "embedding_unavailable",
    });
    assert.ok(fallback.results.some((result) => result.memory.id === memory.id));
    const outage = (await service.invoke("status")).embedding;
    assert.deepEqual(outage.health, {
      indexId: outage.indexId,
      targets: ["records"],
      indexed: { records: 1 },
      pending: { records: 1 },
      status: "running",
    });

    await service.close();
    unavailable = false;
    service = new NmgService(options);
    await service.invoke("search", query);
    await service.close();

    service = new NmgService(options);
    const recovered = await service.invoke("search", query);
    assert.equal(recovered.retrieval?.mode, "hybrid");
    assert.equal(
      recovered.results.find((result) => result.memory.id === memory.id)?.vectorScore,
      1,
    );
    const { embedding } = await service.invoke("status");
    assert.deepEqual(embedding.health, {
      indexId: embedding.indexId,
      targets: ["records"],
      indexed: { records: 2 },
      pending: { records: 0 },
      status: "ready",
    });
  } finally {
    await service.close();
    removeTempDirectory(directory);
  }
});
