import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NmgService } from "../../src/cli/service.ts";
import { HarnessConnection } from "../../src/integration/harness-connection.ts";
import type { HarnessEndpoint } from "../../src/integration/harness-connection.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

test("shared Harness binding fences generations, retries writes, and refuses cloud coordination", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-harness-"));
  const service = new NmgService({
    databasePath: join(directory, "local.sqlite"),
    environment: {},
    memoryBackend: { kind: "sqlite", path: join(directory, "memory.sqlite"), namespace: "tenant" },
  });
  const endpoint: HarnessEndpoint = {
    location: "cloud",
    call: (method, params) => service.invoke(method, params),
  };
  const identity = { sessionId: "conversation", generation: "one" };
  const connection = await HarnessConnection.open(endpoint, identity);
  try {
    const input = {
      statement: "Private integration decision",
      nodeName: "Integration",
      residence: "stg",
      sessionId: "model-selected",
    };
    const invocation = { id: "invocation", slot: "remember" };
    const first = await connection.memory("remember", input, invocation);
    connection.close();
    const resumed = await HarnessConnection.open(endpoint, identity);
    assert.equal((await resumed.memory("remember", input, invocation)).memory.id, first.memory.id);
    const fork = await HarnessConnection.open(endpoint, { ...identity, generation: "two" });
    assert.equal(
      (
        await fork.memory("get", {
          memoryIds: [first.memory.id],
          sessionId: first.memory.sessionId,
        })
      ).results.length,
      0,
    );
    await assert.rejects(resumed.coordination("taskBoard", {}), /local endpoint/);
    await assert.rejects(resumed.memory("remember", input), /invocation/);
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await assert.rejects(
      resumed.memory("search", { query: "Private" }, undefined, abort.signal),
      /cancelled/,
    );
    resumed.close();
    fork.close();
    await assert.rejects(connection.memory("search", { query: "Private" }), /closed/);
    assert.equal((await service.invoke("hello")).service, "node-memory-graph");
  } finally {
    await service.close();
    removeTempDirectory(directory);
  }
});
