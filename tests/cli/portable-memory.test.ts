import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NmgService } from "../../src/cli/service.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

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
        service.invoke("search", { query: "Atlas", includeHistorical: true }),
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
