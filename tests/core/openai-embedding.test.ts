import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { OpenAIEmbeddingClient } from "../../src/core/openai-embedding.ts";

test("OpenAI embedding client preserves server result order", async () => {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const payload = JSON.parse(body) as { input: string[]; model: string };
      assert.equal(request.url, "/v1/embeddings");
      assert.equal(payload.model, "Qwen/Qwen3-Embedding-0.6B");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: payload.input.map((_text, index) => ({
            index: payload.input.length - index - 1,
            embedding: [payload.input.length - index - 1],
          })),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new OpenAIEmbeddingClient({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    });
    assert.deepEqual(await client.embed(["first", "second"]), [[0], [1]]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("Qwen query embedding adds a retrieval instruction", async () => {
  let received = "";
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const payload = JSON.parse(body) as { input: string[] };
      received = payload.input[0]!;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new OpenAIEmbeddingClient({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      queryInstruction: "Retrieve agent memories",
    });
    await client.embedQueries(["What did I choose?"]);
    assert.equal(received, "Instruct: Retrieve agent memories\nQuery:What did I choose?");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("English BGE query embedding uses the model's retrieval prefix", async () => {
  let received = "";
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received = (JSON.parse(body) as { input: string[] }).input[0]!;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new OpenAIEmbeddingClient({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "BAAI/bge-small-en-v1.5",
      profile: "bge-en",
    });
    await client.embedQueries(["What did Caroline research?"]);
    assert.equal(
      received,
      "Represent this sentence for searching relevant passages: What did Caroline research?",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("document and query templates are explicit and independent of model names", async () => {
  const received: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const inputs = (JSON.parse(body) as { input: string[] }).input;
      received.push(...inputs);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ data: inputs.map((_input, index) => ({ index, embedding: [index] })) }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new OpenAIEmbeddingClient({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "a-model-name-with-no-client-meaning",
      queryTemplate: "Q::{text}",
      documentTemplate: "D::{text}",
    });
    await client.embedQueries(["question"]);
    await client.embedDocuments(["passage"]);
    assert.deepEqual(received, ["Q::question", "D::passage"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("embedding templates require a text placeholder", () => {
  assert.throws(
    () => new OpenAIEmbeddingClient({ queryTemplate: "missing placeholder" }),
    /must include "\{text\}"/,
  );
});

test("BAAI-prefixed and bare BGE model names share one index identity", () => {
  const prefixed = new OpenAIEmbeddingClient({ model: "BAAI/bge-small-en-v1.5", profile: "bge-en" });
  const bare = new OpenAIEmbeddingClient({ model: "bge-small-en-v1.5", profile: "bge-en" });
  // Same model, two spellings → same normalized identity (one embedding index).
  assert.equal(prefixed.indexId, bare.indexId);
  assert.equal(prefixed.model, "bge-small-en-v1.5");
  assert.equal(bare.model, "bge-small-en-v1.5");
  assert.match(prefixed.indexId, /^bge-small-en-v1\.5@[0-9a-f]{12}$/);
});

test("API request still sends the raw configured model name", async () => {
  let sentModel = "";
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      sentModel = (JSON.parse(body) as { model: string }).model;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new OpenAIEmbeddingClient({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "BAAI/bge-small-en-v1.5",
      profile: "bge-en",
    });
    await client.embedQueries(["query"]);
    // Normalization only affects the index identity; the endpoint still
    // receives the exact configured model name.
    assert.equal(sentModel, "BAAI/bge-small-en-v1.5");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("embedding index identity includes the preprocessing contract", () => {
  const qwen = new OpenAIEmbeddingClient({ model: "shared-model", profile: "qwen3" });
  const plain = new OpenAIEmbeddingClient({ model: "shared-model", profile: "plain" });
  const repeated = new OpenAIEmbeddingClient({ model: "shared-model", profile: "qwen3" });
  assert.notEqual(qwen.indexId, plain.indexId);
  assert.equal(qwen.indexId, repeated.indexId);
  assert.match(qwen.indexId, /^shared-model@[0-9a-f]{12}$/);
});

test("embedding requests stop at the configured timeout", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new OpenAIEmbeddingClient({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      timeoutMs: 20,
    });
    await assert.rejects(client.embedQueries(["timeout test"]));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
