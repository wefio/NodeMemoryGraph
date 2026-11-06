import assert from "node:assert/strict";
import test from "node:test";
import { openMemoryBackend } from "../../src/core/memory/open.ts";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { startObjectServer } from "../helpers/s3-object-server.ts";

test(
  "native Lance S3 driver persists graph and receipts through object HTTP",
  { timeout: 120_000 },
  async () => {
    const server = await startObjectServer();
    const options = {
      kind: "lancedb" as const,
      uri: "s3://nmg-test/memory",
      namespace: "s3-contract",
      storageOptions: {
        aws_endpoint: server.endpoint,
        aws_allow_http: "true",
        aws_access_key_id: "test",
        aws_secret_access_key: "test",
        aws_region: "us-east-1",
        aws_virtual_hosted_style_request: "false",
      },
    };
    let backend;
    try {
      backend = await openMemoryBackend(options);
      const engine = new MemoryEngine(backend);
      const input = { statement: "Object storage retains Atlas graph", nodeName: "Atlas" };
      const result = await engine.remember(input, "s3-write");
      assert.equal((await engine.search("Atlas")).results[0]?.memory.id, result.memory.id);
      await backend.close();
      backend = await openMemoryBackend(options);
      assert.equal(
        (await new MemoryEngine(backend).remember(input, "s3-write")).memory.id,
        result.memory.id,
      );
      const rival = await openMemoryBackend(options);
      try {
        await Promise.all([
          new MemoryEngine(backend).remember(
            { statement: "Concurrent left survives", nodeName: "Left" },
            "left",
          ),
          new MemoryEngine(rival).remember(
            { statement: "Concurrent right survives", nodeName: "Right" },
            "right",
          ),
        ]);
        assert.equal((await new MemoryEngine(backend).search("Concurrent")).results.length, 2);
      } finally {
        await rival.close();
      }
      server.fault.rejectWrites = true;
      await assert.rejects(
        new MemoryEngine(backend).remember(
          { statement: "Unpublished mutation", nodeName: "Failed" },
          "failure",
        ),
      );
      server.fault.rejectWrites = false;
      assert.equal((await new MemoryEngine(backend).search("Unpublished")).results.length, 0);
      assert.equal((await new MemoryEngine(backend).search("Concurrent")).results.length, 2);
      assert.ok(server.fault.conditionalWrites > 0);
      assert.ok(server.objects.size > 0);
      assert.ok(server.requests.some((request) => request.startsWith("PUT ")));
      assert.ok(server.requests.some((request) => request.startsWith("GET ")));
      assert.ok([...server.objects.keys()].every((key) => !/sqlite|\.db$/.test(key)));
    } finally {
      await backend?.close();
      await server.close();
    }
  },
);
