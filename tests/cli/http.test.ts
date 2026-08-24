import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { httpCall } from "../../src/cli/http-client.ts";
import { httpHandler } from "../../src/cli/http-server.ts";
import type { ServerState } from "../../src/cli/lifecycle.ts";
import { NMG_PROTOCOL_VERSION } from "../../src/cli/protocol.ts";
import { NmgService } from "../../src/cli/service.ts";

type EphemeralServer = { state: ServerState };

function startServer(service: NmgService, token: string): Promise<EphemeralServer & { server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer(httpHandler(service, token));
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        server,
        state: {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          transport: "http",
          host: "127.0.0.1",
          port: address.port,
          token,
        },
      });
    });
  });
}

function withServer(
  fn: (state: EphemeralServer["state"]) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "nmg-http-"));
  const token = "test-token";
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite") });
  return startServer(service, token)
    .then(async ({ server, state }) => {
      try {
        await fn(state);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        service.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
}

test("JSON-RPC over HTTP round-trips hello, remember, search, and get", async () => {
  await withServer(async (state) => {
    const hello = (await httpCall(state, "hello")) as { protocol: string };
    assert.equal(hello.protocol, NMG_PROTOCOL_VERSION);

    const remembered = (await httpCall(state, "remember", {
      statement: "Atlas must use SQLite for offline operation.",
      nodeName: "Atlas storage",
      memoryType: "constraint",
      evidence: "Atlas must use SQLite for offline operation.",
    })) as { memory: { id: string } };

    const searched = (await httpCall(state, "search", {
      query: "Atlas offline",
    })) as { results: Array<{ memory: { id: string } }> };
    assert.equal(searched.results[0]?.memory.id, remembered.memory.id);

    const got = (await httpCall(state, "get", {
      memoryIds: [remembered.memory.id, "missing"],
    })) as { results: unknown[]; missingMemoryIds: string[] };
    assert.equal(got.missingMemoryIds.length, 1);
  });
});

test("JSON-RPC arrays survive the wire without wrapping", async () => {
  await withServer(async (state) => {
    await httpCall(state, "remember", {
      statement: "perf probe",
      nodeName: "perf",
    });
    // A search leaves a trace row; perfAggregates must surface it.
    await httpCall(state, "search", { query: "perf" });
    const aggregates = (await httpCall(state, "perfAggregates")) as Array<{
      section: string;
      count: number;
    }>;
    assert.ok(Array.isArray(aggregates), "perfAggregates returns a plain JSON array");
    assert.ok(
      aggregates.some((entry) => entry.section === "search.direct" && entry.count >= 1),
      `aggregates include search.direct (${aggregates.map((a) => a.section).join(", ")})`,
    );
  });
});

test("concurrent HTTP turns share one daemon writer without losing writes", async () => {
  await withServer(async (state) => {
    const writes = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        httpCall(state, "remember", {
          statement: `Concurrent daemon fact ${index}.`,
          nodeName: "Concurrent daemon writes",
          memoryType: "fact",
          evidence: `Concurrent daemon fact ${index}.`,
        }) as Promise<{ memory: { id: string } }>,
      ),
    );
    assert.equal(new Set(writes.map((result) => result.memory.id)).size, 32);

    const exported = (await httpCall(state, "exportMemories", {})) as {
      items: Array<{ memory: { statement: string } }>;
    };
    const retained = exported.items.filter((entry) =>
      entry.memory.statement.startsWith("Concurrent daemon fact "),
    );
    assert.equal(retained.length, 32, "the daemon serializes all SQLite write phases");
  });
});

test("JSON-RPC over HTTP rejects unauthenticated requests", async () => {
  await withServer(async (state) => {
    await assert.rejects(
      httpCall({ ...state, token: "wrong-token" }, "hello"),
      /unauthenticated/,
    );
  });
});

test("JSON-RPC over HTTP rejects unknown methods", async () => {
  await withServer(async (state) => {
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      httpCall(state, "doesNotExist" as any, {}),
      /method not found/,
    );
  });
});

test("JSON-RPC over HTTP surfaces protocol validation errors", async () => {
  await withServer(async (state) => {
    await assert.rejects(
      httpCall(state, "remember", { statement: "no node name" }),
      /nodeName is required/,
    );
  });
});

test("JSON-RPC over HTTP rejects oversized request bodies", async () => {
  await withServer(async (state) => {
    await assert.rejects(
      httpCall(state, "hello", { payload: "x".repeat(1_048_576) }),
      /request too large/,
    );
  });
});
