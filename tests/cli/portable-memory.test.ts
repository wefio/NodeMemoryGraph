import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NmgService } from "../../src/cli/service.ts";
import { NmgStore } from "../../src/core/store.ts";
import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

test("activated SQLite uses legacy vectors and indexes new writes across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-portable-vector-"));
  const path = join(directory, "memory.sqlite");
  let documentCalls = 0;
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    const { requests } = JSON.parse(Buffer.concat(parts).toString()) as {
      requests: Array<{ taskType: string }>;
    };
    documentCalls += requests.filter((item) => item.taskType === "RETRIEVAL_DOCUMENT").length;
    response.end(JSON.stringify({ embeddings: requests.map(() => ({ values: [1, 0] })) }));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const environment = {
    NMG_EMBED_PROVIDER: "gemini",
    NMG_EMBED_API_KEY: "fixture-only",
    NMG_EMBED_BASE_URL: `http://127.0.0.1:${address.port}/v1beta`,
  };
  const indexId = createEmbeddingClientFromEnv(environment)!.indexId;
  const legacy = new NmgStore(path);
  const original = legacy.remember({
    statement: "The logistics depot is in Oslo",
    nodeName: "Depot",
  });
  legacy.upsertExternalEmbeddings(indexId, [{ memoryId: original.memory.id, vector: [1, 0] }]);
  legacy.close();
  let service = new NmgService({
    databasePath: path,
    environment,
    memoryBackend: { kind: "sqlite", namespace: "vector-test", local: true },
  });
  try {
    const pure = await service.invoke("search", {
      query: "semantic-only query",
      retrievalMode: "qwen3",
    });
    assert.equal(pure.results[0]?.memory.id, original.memory.id);
    assert.equal(pure.results[0]?.vectorScore, 1);
    assert.equal(documentCalls, 0);
    const hybrid = await service.invoke("search", {
      query: "logistics depot",
      retrievalMode: "hybrid",
    });
    assert.equal(hybrid.retrieval?.mode, "hybrid");
    assert.ok(hybrid.results[0]!.lexicalScore > 0);
    const next = await service.invoke("remember", {
      statement: "The freight terminal is in Bergen",
      nodeName: "Terminal",
      operationId: "portable-vector-index-restart",
    });
    await service.close();
    service = new NmgService({ databasePath: path, environment });
    const restored = await service.invoke("search", {
      query: "semantic-only query",
      retrievalMode: "hybrid",
    });
    assert.ok(
      restored.results.some((item) => item.memory.id === next.memory.id && item.vectorScore === 1),
    );
    assert.equal(documentCalls, 1);
  } finally {
    await service.close();
    await new Promise<void>((done) => server.close(() => done()));
    removeTempDirectory(directory);
  }
});

for (const first of ["memory", "coordination"] as const) {
  test(`local SQLite shares one file with independent memory and board tables (${first} first)`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "nmg-shared-sqlite-"));
    const databasePath = join(directory, "nmg.sqlite");
    const options = {
      databasePath,
      environment: {},
      memoryBackend: { kind: "sqlite" as const, namespace: "owner" },
    };
    let service = new NmgService(options);
    const post = () =>
      service.invoke("taskBoard", {
        action: "put",
        taskId: "local",
        agentId: "test",
        content: "CoordinationOnlyMarker",
        ttlSeconds: 600,
      });
    try {
      if (first === "coordination") await post();
      const remembered = await service.invoke("remember", {
        statement: "Atlas uses one local database",
        nodeName: "Atlas",
      });
      if (first === "memory") await post();
      assert.equal((await service.invoke("status")).storage.databasePath, service.databasePath);
      assert.equal(
        (await service.invoke("search", { query: "CoordinationOnlyMarker" })).results.length,
        0,
      );
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.equal(
          database
            .prepare("SELECT count(*) AS n FROM nmg_memory_entities WHERE kind='memory'")
            .get()?.n,
          1,
        );
        assert.equal(
          database
            .prepare(
              "SELECT count(*) AS n FROM task_board_entries WHERE content='CoordinationOnlyMarker'",
            )
            .get()?.n,
          1,
        );
      } finally {
        database.close();
      }
      await service.close();
      service = new NmgService(options);
      assert.equal(
        (await service.invoke("get", { memoryIds: [remembered.memory.id] })).results.length,
        1,
      );
      const board = await service.invoke("taskBoard", {
        action: "read",
        taskId: "local",
        agentId: "test",
      });
      assert.ok(board.action === "read");
      assert.equal(board.entries[0]?.content, "CoordinationOnlyMarker");
    } finally {
      await service.close();
      removeTempDirectory(directory);
    }
  });
}

for (const kind of ["sqlite", "lancedb"] as const) {
  test(`${kind}: service routes memory through the backend and keeps coordination local`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "nmg-portable-service-"));
    const coordinationPath = join(directory, "coordination.sqlite");
    const service = new NmgService({
      databasePath: coordinationPath,
      environment: {},
      memoryBackend:
        kind === "sqlite"
          ? { kind, path: join(directory, "memory.sqlite"), namespace: "owner" }
          : { kind, uri: join(directory, "native-objects"), namespace: "owner" },
    });
    try {
      const hello = await service.invoke("hello");
      assert.ok(hello.capabilities.includes("portable-memory"));
      assert.ok(!hello.methods?.includes("sessionActiveGraph"));
      assert.equal(existsSync(coordinationPath), false);
      const input = {
        statement: "Atlas uses native object memory",
        nodeName: "Atlas",
        operationId: "stable-write",
      };
      await assert.rejects(
        service.invoke("remember", {
          ...input,
          evidenceSource: { actor: "user", content: "api_key=fake-example", sourceMessageId: "m1" },
          unsafe: true,
        }),
        { code: "WRITE_REJECTED", message: /secret/u },
      );
      const first = await service.invoke("remember", input);
      assert.equal((await service.invoke("remember", input)).memory.id, first.memory.id);
      assert.equal((await service.invoke("search", { query: "Atlas" })).results.length, 1);
      assert.equal(
        (await service.invoke("get", { memoryIds: [first.memory.id] })).results[0]?.memory.id,
        first.memory.id,
      );
      assert.equal(
        existsSync(coordinationPath),
        false,
        "memory operations must not open coordination SQLite",
      );
      await assert.rejects(
        service.invoke("search", { query: "Atlas", retrievalMode: "qwen3" }),
        /does not support/,
      );
      await assert.rejects(service.invoke("chainList", {}), /not supported/);
      await service.invoke("taskBoard", {
        action: "put",
        taskId: "local",
        agentId: "test",
        content: "Local coordination",
        ttlSeconds: 600,
      });
      assert.equal(existsSync(coordinationPath), true);
      await service.invoke("deleteMemory", { memoryId: first.memory.id });
      assert.equal(
        (await service.invoke("get", { memoryIds: [first.memory.id] })).results.length,
        0,
      );
    } finally {
      await service.close();
      removeTempDirectory(directory);
    }
  });
}
