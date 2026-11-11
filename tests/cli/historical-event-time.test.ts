import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NMG_CLI_COMMANDS } from "../../src/cli/commands.ts";
import { invokeDaemon } from "../../src/cli/daemon-client.ts";
import { NMG_CAPABILITIES } from "../../src/cli/protocol.ts";
import { NmgService } from "../../src/cli/service.ts";
import { rpcCall } from "../../src/integration/lease-transport.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

test("old daemon owners refuse source clocks before receiving single or batch writes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-old-clock-owner-"));
  const sent: string[] = [];
  const capabilities = NMG_CAPABILITIES.filter(
    (capability) => capability !== "event-time-reference",
  );
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { method: string };
    sent.push(request.method);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: request.method === "hello" ? { capabilities } : "legacy-write",
      }),
    );
  });
  const state = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    transport: "http" as const,
    host: "127.0.0.1",
    port: 12345,
    token: "private-clock-fixture-token",
  };
  const connection = {
    state,
    databasePath: join(directory, "memory.sqlite"),
    startedByCaller: false,
    capabilities: new Set<string>(capabilities),
  };
  const item = {
    statement: "car",
    nodeName: "history",
    eventTime: "昨天",
    referenceTime: "2025-05-10T12:00:00Z",
  };
  try {
    for (const method of ["remember", "rememberBatch"] as const) {
      const params = method === "remember" ? item : { items: [item] };
      await assert.rejects(invokeDaemon(connection, method, params), /event-time-reference/);
      assert.deepEqual(sent, []);
      await assert.rejects(rpcCall(state, method, params), /event-time-reference/);
      assert.deepEqual(sent.splice(0), ["hello"]);
    }
    assert.equal(
      await invokeDaemon(connection, "remember", { statement: "ordinary", nodeName: "history" }),
      "legacy-write",
    );
    assert.deepEqual(sent, ["remember"]);
  } finally {
    removeTempDirectory(directory);
  }
});

for (const portable of [false, true]) {
  test(`${portable ? "portable" : "store"}: remember and batches preserve per-message source clocks across reopen`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "nmg-history-clock-"));
    const options = {
      dataDirectory: directory,
      environment: {},
      ...(portable ? { memoryBackend: { kind: "sqlite" as const, namespace: "history" } } : {}),
    };
    let service = new NmgService(options);
    try {
      const command = NMG_CLI_COMMANDS.find((spec) => spec.words.join(" ") === "remember")!;
      const params = command.buildParams({
        flags: new Set(),
        positionals: ["ReplayCarMarker 我昨天买了辆车"],
        options: new Map([
          ["node", ["历史"]],
          ["event-time", ["昨天"]],
          ["reference-time", ["2025-05-10T00:30:00+08:00"]],
          ["time-zone", ["Asia/Shanghai"]],
        ]),
      });
      const before = Date.now();
      const first = await service.invoke("remember", params);
      assert.equal(first.memory.eventTime, "2025-05-09T00:00:00.000Z");
      assert.ok(Date.parse(first.memory.createdAt) >= before);
      assert.ok(Date.parse(first.history.createdAt) >= before);
      const batch = await service.invoke("rememberBatch", {
        items: [
          {
            statement: "HistoricFlightMarker",
            nodeName: "历史",
            eventTime: "昨天",
            referenceTime: "2024-01-01T00:30:00+09:00",
          },
          {
            statement: "HistoricBoatMarker",
            nodeName: "历史",
            eventTime: "昨天",
            referenceTime: "2025-05-10T00:30:00Z",
            timeZone: "America/Los_Angeles",
          },
        ],
      });
      assert.deepEqual(
        batch.results.map((row) => row.memory.eventTime),
        ["2023-12-31T00:00:00.000Z", "2025-05-08T00:00:00.000Z"],
      );
      for (const patch of [
        { referenceTime: "昨天" },
        { referenceTime: "2025-05-10" },
        { timeZone: "Invalid/Zone" },
      ]) {
        await assert.rejects(service.invoke("remember", { ...(params as object), ...patch }), {
          code: "INVALID_PARAMS",
        });
      }
      await service.close();
      service = new NmgService(options);
      const result = await service.invoke("get", {
        memoryIds: [first.memory.id, ...batch.results.map((row) => row.memory.id)],
      });
      assert.deepEqual(
        new Set(result.results.map((row) => row.memory.eventTime)),
        new Set([
          "2025-05-09T00:00:00.000Z",
          "2023-12-31T00:00:00.000Z",
          "2025-05-08T00:00:00.000Z",
        ]),
      );
      assert.equal(
        result.results.find((row) => row.memory.id === first.memory.id)?.evidence.content,
        "ReplayCarMarker 我昨天买了辆车",
      );
    } finally {
      await service.close();
      removeTempDirectory(directory);
    }
  });
}
