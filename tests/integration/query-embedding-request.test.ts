import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NmgService } from "../../src/cli/service.ts";
import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();
import { NmgStore } from "../../src/core/store.ts";
import { requestQueryEmbeddingClient, searchMemoryContext } from "../../src/integration/search.ts";
import { RecallBudget } from "../../src/integration/recall-budget.ts";

function store() {
  const result = new NmgStore(":memory:");
  const saved = result.remember({
    statement: "Atlas uses SQLite for offline storage",
    nodeName: "Atlas",
  });
  result.beginEmbeddingIndex({
    indexId: "fixture",
    model: "fixture",
    profile: "test",
    targets: ["records"],
  });
  result.upsertExternalEmbeddings("fixture", [{ memoryId: saved.memory.id, vector: [1, 0] }]);
  result.completeEmbeddingIndex("fixture");
  return result;
}

test("one request reuses a query across stores while preserving ranked results and fresh reads", async () => {
  const stores = [store(), store()];
  let calls = 0;
  const client = {
    indexId: "fixture",
    async embedQueries() {
      calls++;
      return [[1, 0]];
    },
  };
  const options = { limit: 20, graphHops: 0, persistTrace: false };
  try {
    const baseline = await Promise.all(
      stores.map((s) => searchMemoryContext(s, client, "Atlas SQLite", options)),
    );
    assert.equal(calls, 2);
    calls = 0;
    const request = requestQueryEmbeddingClient(client);
    const actual = await Promise.all(
      stores.map((s) => searchMemoryContext(s, request, "Atlas SQLite", options)),
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      actual.map((c) => c.results),
      baseline.map((c) => c.results),
    );
    const id = actual[0].results[0].memory.id;
    stores[0].deleteMemory(id);
    assert.equal(
      (await searchMemoryContext(stores[0], request, "Atlas SQLite", options)).results.length,
      0,
    );
    await searchMemoryContext(
      stores[1],
      requestQueryEmbeddingClient(client),
      "Atlas SQLite",
      options,
    );
    assert.equal(calls, 2, "a new request gets its own preparation");
  } finally {
    for (const s of stores) s.close();
  }
});

test("request identity includes exact input batch; failed or empty results can retry; vectors cannot be mutated through reuse", async () => {
  let calls = 0;
  const request = requestQueryEmbeddingClient({
    indexId: "fixture",
    async embedQueries(texts) {
      calls++;
      if (calls === 1) throw new Error("offline");
      if (calls === 2) return [];
      return texts.map(() => [1, 0]);
    },
  })!;
  await assert.rejects(request.embedQueries(["Atlas"]), /offline/);
  assert.deepEqual(await request.embedQueries(["Atlas"]), []);
  const first = await request.embedQueries(["Atlas"]);
  first[0][0] = 9;
  assert.deepEqual(await request.embedQueries(["Atlas"]), [[1, 0]]);
  assert.equal(calls, 3);
  await request.embedQueries(["atlas"]);
  await request.embedQueries(["Atlas", "atlas"]);
  assert.equal(calls, 5);
  assert.equal(requestQueryEmbeddingClient(undefined), undefined);
});

test("a cached vector cannot bypass a cancelled automatic budget or lexical-only selection", async () => {
  const s = store();
  let calls = 0;
  const request = requestQueryEmbeddingClient({
    indexId: "fixture",
    async embedQueries() {
      calls++;
      return [[1, 0]];
    },
  });
  const parent = new AbortController();
  const budget = new RecallBudget(5000, parent.signal);
  try {
    await searchMemoryContext(s, request, "Atlas SQLite", { limit: 20 });
    parent.abort();
    const cancelled = await searchMemoryContext(
      s,
      request,
      "Atlas SQLite",
      { limit: 20 },
      undefined,
      budget,
    );
    assert.equal(cancelled.retrieval?.mode, "lexical");
    const lexical = await searchMemoryContext(s, request, "other", {
      limit: 20,
      retrievalMode: "fts5",
    });
    assert.equal(lexical.retrieval?.mode, "lexical");
    assert.equal(calls, 1);
  } finally {
    budget.close();
    s.close();
  }
});

test("daemon search shares repeated semantic clauses only inside one invocation over real HTTP", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const { input } = JSON.parse(body) as { input: string[] };
      calls += input.filter((text) => text === "Atlas SQLite").length;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = mkdtempSync(join(tmpdir(), "nmg-query-request-"));
  const databasePath = join(directory, "nmg.sqlite");
  const environment = {
    NMG_EMBED_PROVIDER: "openai",
    NMG_EMBED_PROFILE: "plain",
    NMG_EMBED_MODEL: "fixture",
    NMG_EMBED_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  };
  const indexId = createEmbeddingClientFromEnv(environment)!.indexId;
  const seed = new NmgStore(databasePath);
  try {
    const saved = seed.remember({ statement: "Atlas SQLite storage", nodeName: "Atlas" });
    seed.beginEmbeddingIndex({ indexId, model: "fixture", profile: "plain", targets: ["records"] });
    seed.upsertExternalEmbeddings(indexId, [{ memoryId: saved.memory.id, vector: [1, 0] }]);
    seed.completeEmbeddingIndex(indexId);
  } finally {
    seed.close();
  }
  const service = new NmgService({ databasePath, environment });
  try {
    for (let i = 1; i <= 2; i++) {
      const result = await service.invoke("search", {
        query: "Atlas SQLite",
        queries: ["Atlas SQLite"],
        limit: 20,
      });
      assert.equal(result.retrieval?.mode, "hybrid");
      assert.ok(result.results.length > 0);
      assert.equal(calls, i, "each invocation embeds its repeated clause once");
    }
  } finally {
    await service.drain();
    service.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    removeTempDirectory(directory);
  }
});
