import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NmgService } from "../../src/cli/service.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

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
