import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredProvider,
  createEmbeddingClientFromEnv,
} from "../../src/core/embedding-provider.ts";
import type { EmbeddingAttempt } from "../../src/core/embedding-providers/types.ts";

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

const query = "查什么？";
const documents = ["第一条", "第二条"];
const dimensions = 2;
const key = "fixture-only";
const geminiModel = "models/gemini-embedding-001";

function geminiBody(inputs: string[], taskType: string) {
  return {
    requests: inputs.map((text) => ({
      model: geminiModel,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: dimensions,
    })),
  };
}

const requestContracts = {
  openai: {
    environment: {
      NMG_EMBED_BASE_URL: "https://embedding.example/v1/",
      NMG_EMBED_MODEL: "example/text-embedding",
      NMG_EMBED_QUERY_TEMPLATE: "Q>{text}",
    },
    url: "https://embedding.example/v1/embeddings",
    queryBody: { model: "example/text-embedding", input: [`Q>${query}`], dimensions },
    documentBody: { model: "example/text-embedding", input: documents, dimensions },
  },
  cloudflare: {
    environment: { CLOUDFLARE_ACCOUNT_ID: "fixture-account" },
    url: "https://api.cloudflare.com/client/v4/accounts/fixture-account/ai/v1/embeddings",
    queryBody: { model: "@cf/baai/bge-m3", input: [query], dimensions },
    documentBody: { model: "@cf/baai/bge-m3", input: documents, dimensions },
  },
  jina: {
    environment: {},
    url: "https://api.jina.ai/v1/embeddings",
    queryBody: {
      model: "jina-embeddings-v3",
      input: [query],
      task: "retrieval.query",
      dimensions,
    },
    documentBody: {
      model: "jina-embeddings-v3",
      input: documents,
      task: "retrieval.passage",
      dimensions,
    },
  },
  gemini: {
    environment: { NMG_EMBED_MODEL: geminiModel },
    url: `https://generativelanguage.googleapis.com/v1beta/${geminiModel}:batchEmbedContents`,
    queryBody: geminiBody([query], "RETRIEVAL_QUERY"),
    documentBody: geminiBody(documents, "RETRIEVAL_DOCUMENT"),
  },
};

for (const [provider, contract] of Object.entries(requestContracts)) {
  test(`${provider} embedding request contract runs without external fetch`, async (t) => {
    const bodies: unknown[] = [];
    const observations: Array<{ provider: string; attempt: EmbeddingAttempt }> = [];
    const gemini = provider === "gemini";
    const captureRequest: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, contract.url);
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("content-type"), "application/json");
      assert.equal(request.headers.get("authorization"), gemini ? null : `Bearer ${key}`);
      assert.equal(request.headers.get("x-goog-api-key"), gemini ? key : null);
      bodies.push(await request.json());
      const vectors =
        bodies.length === 1
          ? [[0, 1]]
          : [
              [0, 1],
              [1, 1],
            ];
      return Response.json(
        gemini
          ? { embeddings: vectors.map((values) => ({ values })) }
          : { data: vectors.map((embedding, index) => ({ index, embedding })) },
      );
    };
    const fetch = t.mock.method(globalThis, "fetch", captureRequest);
    const client = createEmbeddingClientFromEnv(
      {
        ...contract.environment,
        NMG_EMBED_PROVIDER: provider,
        NMG_EMBED_API_KEY: key,
        NMG_EMBED_DIMENSIONS: String(dimensions),
      },
      { observeAttempt: (provider, attempt) => observations.push({ provider, attempt }) },
    )!;
    assert.deepEqual(await client.embedQueries([]), []);
    await assert.rejects(client.embedQueries([query], { signal: AbortSignal.abort() }), {
      name: "AbortError",
    });
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(await client.embedQueries([query]), [[0, 1]]);
    assert.deepEqual(await client.embedDocuments(documents), [
      [0, 1],
      [1, 1],
    ]);
    assert.deepEqual(bodies, [contract.queryBody, contract.documentBody]);
    const model = "model" in contract.queryBody ? contract.queryBody.model : geminiModel;
    assert.equal(observations.length, 2);
    for (const { provider: actual, attempt } of observations) {
      assert.equal(actual, provider);
      assert.equal(attempt.model, model);
      assert.equal(attempt.outcome, "success");
      assert.ok(Number.isFinite(attempt.durationMs) && attempt.durationMs >= 0);
    }
  });
}

test("Gemini HTTP refusals can be reproduced with synthetic responses", async (t) => {
  const client = createEmbeddingClientFromEnv({
    NMG_EMBED_PROVIDER: "gemini",
    NMG_EMBED_API_KEY: key,
  })!;
  let status = 403;
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { message: "fixture provider diagnostic" } }, { status }),
  );
  for (const code of [403, 429]) {
    status = code;
    await assert.rejects(
      client.embedQueries([query]),
      new RegExp(`^Error: embedding server returned ${code}:`, "u"),
    );
  }
  assert.equal(fetch.mock.callCount(), 2);
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
