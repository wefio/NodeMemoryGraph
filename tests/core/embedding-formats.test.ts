import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { localEmbeddingFormatStore } from "../../src/cli/embedding-format-store.ts";
import { NmgService } from "../../src/cli/service.ts";
import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import type {
  EmbeddingFormatRecord,
  EmbeddingFormatStore,
} from "../../src/core/embedding-providers/formats.ts";
import { activatedLocalMemory } from "../../src/core/memory/sqlite-backend.ts";
import { OpenAIEmbeddingClient } from "../../src/core/openai-embedding.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

const floats = [0.1, -0.25];
const base64 = "zczMPQAAgL4=";

function fixtureStore() {
  const records = new Map<string, EmbeddingFormatRecord>();
  const store: EmbeddingFormatStore = {
    read: (key) => records.get(key),
    write: (key, record) => {
      records.set(key, record);
    },
  };
  return { records, store };
}

function reply(embedding: number[] | string) {
  return Response.json({ data: [{ index: 0, embedding }] });
}

test("Base64 confirmation is scoped to endpoint, raw model and query or document semantics", async (t) => {
  const { records, store } = fixtureStore();
  const calls: (string | undefined)[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, request: RequestInit) => {
    const { encoding_format } = JSON.parse(String(request.body)) as { encoding_format?: string };
    calls.push(encoding_format);
    return reply(encoding_format ? base64 : floats);
  });
  const options = {
    baseUrl: "https://formats.test/v1",
    model: "BAAI/test",
    profile: "plain" as const,
  };
  const client = new OpenAIEmbeddingClient({ ...options, formatStore: store });
  assert.equal(client.indexId, new OpenAIEmbeddingClient(options).indexId);
  assert.deepEqual(await client.embedQueries(["search"], { probeEncoding: false }), [floats]);
  assert.equal(records.size, 0);
  assert.deepEqual(await client.embedDocumentsForStorage(["document"]), [
    Float32Array.from(floats),
  ]);
  assert.deepEqual(await client.embedQueries(["search"]), [floats]);
  assert.deepEqual(
    [...records.values()].map(({ purpose, format, reason }) => [purpose, format, reason]),
    [
      ["document", "base64-f32le", "verified"],
      ["query", "json", "different-vectors"],
    ],
  );
  assert.deepEqual(calls, [undefined, "base64", undefined, "base64", undefined]);
  const reopened = new OpenAIEmbeddingClient({ ...options, formatStore: store });
  await reopened.embedDocumentsForStorage(["another document"]);
  await reopened.embedQueries(["another query"]);
  assert.deepEqual(calls.slice(-2), ["base64", undefined]);
  for (const changed of [{ model: "test" }, { baseUrl: "https://formats.test/another/v1" }]) {
    const other = new OpenAIEmbeddingClient({ ...options, ...changed, formatStore: store });
    await other.embedDocumentsForStorage(["new scope"]);
    assert.deepEqual(calls.slice(-2), ["base64", undefined]);
  }
  assert.equal(records.size, 4);
});

test("an explicit format rejection falls back once and remembers ordinary JSON", async (t) => {
  const { records, store } = fixtureStore();
  const calls: (string | undefined)[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, request: RequestInit) => {
    const { encoding_format } = JSON.parse(String(request.body)) as { encoding_format?: string };
    calls.push(encoding_format);
    return encoding_format
      ? Response.json({ error: "Unknown parameter encoding_format" }, { status: 400 })
      : reply(floats);
  });
  const client = new OpenAIEmbeddingClient({
    baseUrl: "https://format-rejection.test",
    formatStore: store,
  });
  assert.deepEqual(await client.embedDocuments(["first"]), [floats]);
  assert.deepEqual(await client.embedDocuments(["second"]), [floats]);
  assert.deepEqual(calls, ["base64", undefined, undefined]);
  assert.equal([...records.values()][0]?.reason, "field-rejected");
});

test("verified Base64 still rejects a batch with the wrong dimensions", async (t) => {
  const { records, store } = fixtureStore();
  let encoded = base64;
  t.mock.method(globalThis, "fetch", async (_url: string, request: RequestInit) =>
    reply(JSON.parse(String(request.body)).encoding_format ? encoded : floats),
  );
  const client = new OpenAIEmbeddingClient({
    baseUrl: "https://format-dimensions.test",
    formatStore: store,
  });
  assert.deepEqual(await client.embedDocumentsForStorage(["first"]), [Float32Array.from(floats)]);
  encoded = "AACAPw==";
  assert.deepEqual(await client.embedDocumentsForStorage(["second"]), [floats]);
  assert.equal([...records.values()][0]?.reason, "invalid-base64");
});

for (const failure of ["rate limit", "timeout"] as const) {
  test(`a format probe ${failure} leaves the capability unknown`, async (t) => {
    const { records, store } = fixtureStore();
    let failing = true;
    const calls: (string | undefined)[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, request: RequestInit) => {
      const { encoding_format } = JSON.parse(String(request.body)) as { encoding_format?: string };
      calls.push(encoding_format);
      if (!failing) return reply(encoding_format ? base64 : floats);
      if (failure === "rate limit")
        return new Response("encoding_format unsupported-looking rate-limit message", {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      await delay(1_000, undefined, { signal: request.signal ?? undefined });
      return reply(floats);
    });
    const client = new OpenAIEmbeddingClient({
      baseUrl: failure === "timeout" ? "https://format-timeout.test" : "https://format-rate.test",
      timeoutMs: 80,
      formatStore: store,
    });
    await assert.rejects(
      client.embedDocuments(["first"]),
      failure === "timeout" ? /timeout/i : /429/u,
    );
    assert.equal(records.size, 0);
    assert.deepEqual(calls, ["base64"]);
    if (failure === "timeout") {
      failing = false;
      await client.embedDocuments(["retry"]);
      assert.deepEqual(calls, ["base64", "base64", undefined]);
      const [verified] = records.values();
      assert.equal(verified?.format, "base64-f32le");
      failing = true;
      await assert.rejects(client.embedDocuments(["later timeout"]), /timeout/i);
      assert.deepEqual([...records.values()], [verified]);
    }
  });
}

test("local daemon reuses document format after reopening SQLite with the same index identity", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-embedding-formats-"));
  const databasePath = join(directory, "memory.sqlite");
  const environment = {
    NMG_EMBED_PROVIDER: "openai",
    NMG_EMBED_BASE_URL: "https://format-storage.test/v1",
    NMG_EMBED_API_KEY: "fixture-not-for-disk",
  };
  const indexId = createEmbeddingClientFromEnv(environment)!.indexId;
  const calls: (string | undefined)[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, request: RequestInit) => {
    const { encoding_format } = JSON.parse(String(request.body)) as { encoding_format?: string };
    calls.push(encoding_format);
    return reply(encoding_format ? base64 : floats);
  });
  t.after(() => removeTempDirectory(directory));
  const original = new NmgService({ databasePath, environment: {} });
  let originalId: string;
  try {
    const { memory } = await original.invoke("remember", {
      statement: "The historical archive already has a stored vector.",
      nodeName: "Archive",
    });
    originalId = memory.id;
  } finally {
    await original.close();
  }
  const namespace = activatedLocalMemory(databasePath);
  assert.ok(namespace);
  const existing = new DatabaseSync(databasePath);
  try {
    existing
      .prepare("INSERT INTO nmg_memory_vectors VALUES (?, ?, ?, ?, ?)")
      .run(namespace, indexId, originalId, floats.length, Buffer.from(base64, "base64"));
  } finally {
    existing.close();
  }
  for (const city of ["Oslo", "Bergen"]) {
    const service = new NmgService({ databasePath, environment });
    try {
      await service.invoke("remember", {
        statement: `The archive has a depot in ${city}.`,
        nodeName: "Archive",
      });
    } finally {
      await service.close();
    }
  }
  assert.deepEqual(calls, ["base64", undefined, "base64"]);
  const files = readdirSync(join(directory, "embedding-formats"));
  assert.equal(files.length, 1);
  const raw = readFileSync(join(directory, "embedding-formats", files[0]!), "utf8");
  assert.doesNotMatch(raw, /fixture-not-for-disk|Oslo|Bergen/u);
  const key = files[0]!.replace(/\.json$/u, "");
  assert.equal(localEmbeddingFormatStore(directory).read(key)?.reason, "verified");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, model, hex(vector) AS bytes FROM nmg_memory_vectors").all();
    assert.equal(rows.length, 3);
    assert.ok(rows.some((row) => row.id === originalId));
    for (const row of rows) {
      assert.equal(row.model, indexId);
      assert.equal(row.bytes, "CDCCCC3D000080BE");
    }
  } finally {
    db.close();
  }
});

test("Gemini records native JSON without changing its document task or index key", async (t) => {
  const { records, store } = fixtureStore();
  const environment = { NMG_EMBED_PROVIDER: "gemini", GEMINI_API_KEY: "fixture" };
  t.mock.method(globalThis, "fetch", async (url: string, request: RequestInit) => {
    assert.match(url, /:batchEmbedContents$/u);
    const body = JSON.parse(String(request.body));
    assert.equal(body.requests[0].taskType, "RETRIEVAL_DOCUMENT");
    assert.ok(!("encoding_format" in body) && !("encoding_format" in body.requests[0]));
    return Response.json({ embeddings: [{ values: floats }] });
  });
  const client = createEmbeddingClientFromEnv(environment, { formatStore: store })!;
  assert.equal(client.indexId, createEmbeddingClientFromEnv(environment)!.indexId);
  assert.deepEqual(await client.embedDocuments(["document"]), [floats]);
  const [record] = records.values();
  assert.equal(record?.purpose, "document");
  assert.equal(record?.reason, "native-json");
});
