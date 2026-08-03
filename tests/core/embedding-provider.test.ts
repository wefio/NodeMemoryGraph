import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  configuredProvider,
  createEmbeddingClientFromEnv,
} from "../../src/core/embedding-provider.ts";

test("provider registry preserves legacy OpenAI-compatible configuration", () => {
  const environment = {
    NMG_EMBED_BASE_URL: "https://embedding.example/v1",
    NMG_EMBED_MODEL: "custom/model",
  };
  assert.equal(configuredProvider(environment), "openai");
  assert.equal(createEmbeddingClientFromEnv(environment)?.model, "custom/model");
});

test("BGE models default to the bge-en prompt profile", () => {
  const environment = {
    NMG_EMBED_BASE_URL: "https://embedding.example/v1",
    NMG_EMBED_MODEL: "BAAI/bge-small-en-v1.5",
  };
  const client = createEmbeddingClientFromEnv(environment)!;
  assert.equal(client.profile, "bge-en");
  // explicit NMG_EMBED_PROFILE still wins over the model-derived default
  const pinned = createEmbeddingClientFromEnv({
    ...environment,
    NMG_EMBED_PROFILE: "qwen3",
  })!;
  assert.equal(pinned.profile, "qwen3");
  // non-BGE models keep the qwen3 default
  const qwen = createEmbeddingClientFromEnv({
    NMG_EMBED_BASE_URL: "https://embedding.example/v1",
    NMG_EMBED_MODEL: "Qwen/Qwen3-Embedding-0.6B",
  })!;
  assert.equal(qwen.profile, "qwen3");
  assert.notEqual(client.indexId, qwen.indexId);
});

test("Cloudflare and Jina presets own their defaults and index namespaces", () => {
  const cloudflare = createEmbeddingClientFromEnv({
    NMG_EMBED_PROVIDER: "cloudflare",
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_API_TOKEN: "secret",
  })!;
  assert.equal(cloudflare.model, "@cf/baai/bge-m3");
  assert.match(cloudflare.indexId, /^@cf\/baai\/bge-m3@/u);

  const jina = createEmbeddingClientFromEnv({
    NMG_EMBED_PROVIDER: "jina",
    JINA_API_KEY: "secret",
  })!;
  assert.equal(jina.model, "jina-embeddings-v3");
  assert.notEqual(jina.indexId, cloudflare.indexId);
});

test("Gemini provider batches inputs and distinguishes query from document tasks", async () => {
  const requests: Array<{ taskType: string; apiKey: string | undefined }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const payload = JSON.parse(body) as {
        requests: Array<{ taskType: string }>;
      };
      requests.push({
        taskType: payload.requests[0]!.taskType,
        apiKey: request.headers["x-goog-api-key"] as string | undefined,
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          embeddings: payload.requests.map((_item, index) => ({ values: [index, 1] })),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const client = createEmbeddingClientFromEnv({
      NMG_EMBED_PROVIDER: "gemini",
      GEMINI_API_KEY: "secret",
      NMG_EMBED_BASE_URL: `http://127.0.0.1:${address.port}`,
    })!;
    assert.deepEqual(await client.embedQueries(["q"]), [[0, 1]]);
    assert.deepEqual(await client.embedDocuments(["a", "b"]), [
      [0, 1],
      [1, 1],
    ]);
    assert.deepEqual(requests, [
      { taskType: "RETRIEVAL_QUERY", apiKey: "secret" },
      { taskType: "RETRIEVAL_DOCUMENT", apiKey: "secret" },
    ]);
  } finally {
    server.close();
  }
});

test("provider configuration reports missing credentials without exposing secrets", () => {
  assert.throws(
    () => createEmbeddingClientFromEnv({ NMG_EMBED_PROVIDER: "cloudflare" }),
    /Cloudflare account ID is required/u,
  );
  assert.throws(
    () => createEmbeddingClientFromEnv({ NMG_EMBED_PROVIDER: "unknown" }),
    /unknown embedding provider/u,
  );
});
