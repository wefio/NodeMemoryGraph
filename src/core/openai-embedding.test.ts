import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { OpenAIEmbeddingClient } from "./openai-embedding.ts";

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
