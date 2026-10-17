import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { httpCall } from "../../src/cli/http-client.ts";
import { httpHandler } from "../../src/cli/http-server.ts";
import type { ServerState } from "../../src/cli/lifecycle.ts";
import type { NmgMethodResult } from "../../src/cli/protocol.ts";
import { NmgService } from "../../src/cli/service.ts";
import { NmgStore } from "../../src/core/store.ts";
import { renderSearchSurface } from "../../src/integration/agent-surface.ts";
import {
  captureMemoryReferenceTargets,
  createMemoryReferences,
  resolveMemoryReferences,
} from "../../src/integration/memory-reference.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

async function withService(
  fn: (service: NmgService, directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "nmg-compound-reference-"));
  const service = new NmgService({
    databasePath: join(directory, "nmg.sqlite"),
    environment: {},
  });
  try {
    await fn(service, directory);
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
}

function stable(value: NmgMethodResult["get"]): NmgMethodResult["get"] {
  return {
    ...value,
    results: value.results.map((result) => ({
      ...result,
      memory: { ...result.memory, accessCount: 0, lastAccessedAt: null },
    })),
  };
}

// Contract: use only the existing RPC inputs, not a host alias resolver.
test("shared search displays a copied compound reference that exact get resolves", async () => {
  await withService(async (service, directory) => {
    const saved = await service.invoke("remember", {
      statement: "SQLite stores Atlas project data.",
      nodeName: "Atlas storage",
      memoryType: "fact",
    });
    const context = await service.invoke("search", {
      query: "SQLite Atlas",
      sessionId: "reference-reader",
      limit: 1,
    });
    assert.equal(context.results[0]?.memory.id, saved.memory.id);
    const key = /memory=([^;]+);/u.exec(renderSearchSurface(context))?.[1];
    assert.ok(key?.startsWith("ref:"), "search must generate a copyable reference");
    const params = {
      activeGraphId: context.activeGraph!.id,
      sessionId: "reference-reader",
    };
    const canonical = await service.invoke("get", {
      ...params,
      memoryIds: [saved.memory.id],
    });
    const copied = await service.invoke("get", { ...params, memoryIds: [key] });
    assert.equal(
      copied.results[0]!.memory.accessCount,
      canonical.results[0]!.memory.accessCount + 1,
    );
    assert.deepEqual(stable(copied), stable(canonical));
    const store = new NmgStore(join(directory, "nmg.sqlite"));
    try {
      const trace = store.retrievalTrace(context.activeGraph!.traceIds![0]!, "reference-reader")!;
      assert.deepEqual(trace.disclosedMemoryIds, [saved.memory.id]);
      assert.ok(!JSON.stringify(trace).includes("ref:"));
    } finally {
      store.close();
    }
  });
});

// Contract: count caller input entries, not successful reads or internal lookups.
test("status counts full-ID and compound-reference get attempts per service lifetime", async () => {
  await withService(async (service, directory) => {
    assert.deepEqual((await service.invoke("status")).getReferenceUsage, {
      fullIds: 0,
      compoundRefs: 0,
    });
    const saved = await service.invoke("remember", {
      statement: "SQLite stores Atlas project data.",
      nodeName: "Atlas storage",
    });
    const context = await service.invoke("search", {
      query: "SQLite Atlas",
      sessionId: "counter-reader",
      limit: 1,
    });
    const key = context.memoryReferences![saved.memory.id]!;
    assert.deepEqual((await service.invoke("status")).getReferenceUsage, {
      fullIds: 0,
      compoundRefs: 0,
    });
    const exact = await service.invoke("get", {
      memoryIds: [saved.memory.id, key, saved.memory.id, "missing-id"],
      activeGraphId: context.activeGraph!.id,
      sessionId: "counter-reader",
    });
    assert.deepEqual(
      exact.results.map((entry) => entry.memory.id),
      [saved.memory.id],
    );
    assert.deepEqual(exact.missingMemoryIds, ["missing-id"]);
    assert.deepEqual((await service.invoke("status")).getReferenceUsage, {
      fullIds: 3,
      compoundRefs: 1,
    });
    await assert.rejects(
      service.invoke("get", { memoryIds: [key] }),
      /require their activeGraphId/u,
    );
    await assert.rejects(service.invoke("get", { memoryIds: [] }), /memoryIds must contain/u);
    assert.deepEqual((await service.invoke("status")).getReferenceUsage, {
      fullIds: 3,
      compoundRefs: 2,
    });
    const snapshot = await service.invoke("status");
    snapshot.getReferenceUsage!.fullIds = 99;
    assert.equal((await service.invoke("status")).getReferenceUsage!.fullIds, 3);
    const fresh = new NmgService({
      databasePath: join(directory, "nmg.sqlite"),
      environment: {},
    });
    try {
      assert.deepEqual((await fresh.invoke("status")).getReferenceUsage, {
        fullIds: 0,
        compoundRefs: 0,
      });
    } finally {
      fresh.close();
    }
  });
});

test("references require their exact owned graph while canonical IDs need no graph", async () => {
  await withService(async (service) => {
    const saved = await service.invoke("remember", {
      statement: "SQLite stores Atlas project data.",
      nodeName: "Atlas storage",
    });
    const context = await service.invoke("search", {
      query: "SQLite Atlas",
      sessionId: "owner",
      limit: 1,
    });
    const key = context.memoryReferences![saved.memory.id]!;
    await assert.rejects(
      service.invoke("get", { memoryIds: [key] }),
      /require their activeGraphId/u,
    );
    for (const sessionId of ["foreign", undefined]) {
      await assert.rejects(
        service.invoke("get", {
          memoryIds: [key],
          activeGraphId: context.activeGraph!.id,
          sessionId,
        }),
        /absent or not owned/u,
      );
    }
    await assert.rejects(
      service.invoke("get", {
        memoryIds: [key],
        activeGraphId: "missing-graph",
        sessionId: "owner",
      }),
      /absent or not owned/u,
    );
    await assert.rejects(
      service.invoke("get", {
        memoryIds: [key.replace("SQLite", "Bogus!")],
        activeGraphId: context.activeGraph!.id,
        sessionId: "owner",
      }),
      /no match/u,
    );
    const canonical = await service.invoke("get", {
      memoryIds: [saved.memory.id],
    });
    assert.equal(canonical.results[0]?.memory.id, saved.memory.id);
  });
});

test("private project references do not resolve in another project or session", async () => {
  await withService(async (service, directory) => {
    const projectDir = join(directory, "project-a");
    const saved = await service.invoke("remember", {
      statement: "SQLite stores the private Atlas session branch.",
      nodeName: "Atlas branch",
      residence: "stg",
      projectDir,
      sessionId: "owner",
    });
    const context = await service.invoke("search", {
      query: "SQLite Atlas branch",
      projectDir,
      sessionId: "owner",
      limit: 1,
    });
    const key = context.memoryReferences![saved.memory.id]!;
    const params = {
      memoryIds: [key],
      activeGraphId: context.activeGraph!.id,
      projectDir,
      sessionId: "owner",
    };
    const copied = await service.invoke("get", params);
    assert.equal(copied.results[0]?.memory.id, saved.memory.id);
    await assert.rejects(
      service.invoke("get", {
        ...params,
        projectDir: join(directory, "project-b"),
      }),
      /absent or not owned|no match/u,
    );
    await assert.rejects(
      service.invoke("get", { ...params, sessionId: "foreign" }),
      /absent or not owned/u,
    );
    await assert.rejects(
      service.invoke("get", { ...params, projectDir: undefined }),
      /absent or not owned|no match/u,
    );
    const unavailable = await service.invoke("get", {
      memoryIds: [saved.memory.id],
      projectDir,
      sessionId: "foreign",
    });
    assert.deepEqual(unavailable.results, []);
  });
});

test("ordinary HTTP JSON-RPC accepts mixed canonical and copied references", async () => {
  await withService(async (service) => {
    const server = createServer(httpHandler(service, "fixture-token"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const state: ServerState = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      transport: "http",
      host: "127.0.0.1",
      port: address.port,
      token: "fixture-token",
    };
    try {
      const saved = (await httpCall(state, "remember", {
        statement: "SQLite stores Atlas project data.",
        nodeName: "Atlas storage",
      })) as NmgMethodResult["remember"];
      const context = (await httpCall(state, "search", {
        query: "SQLite Atlas",
        limit: 1,
      })) as NmgMethodResult["search"];
      const key = context.memoryReferences![saved.memory.id]!;
      const result = (await httpCall(state, "get", {
        memoryIds: [key, saved.memory.id, "missing-canonical-id"],
        activeGraphId: context.activeGraph!.id,
      })) as NmgMethodResult["get"];
      assert.deepEqual(
        result.results.map((r) => r.memory.id),
        [saved.memory.id],
      );
      assert.deepEqual(result.missingMemoryIds, ["missing-canonical-id"]);
      await assert.rejects(
        httpCall(state, "get", {
          memoryIds: ["ref:ffff|Bogus!"],
          activeGraphId: context.activeGraph!.id,
        }),
        /no match/u,
      );
      const status = (await httpCall(state, "status")) as NmgMethodResult["status"];
      assert.deepEqual(status.getReferenceUsage, {
        fullIds: 2,
        compoundRefs: 2,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

test("shared library helpers resolve a captured scope without a host-specific decoder", async () => {
  await withService(async (service, directory) => {
    const saved = await service.invoke("remember", {
      statement: "SQLite stores Atlas project data.",
      nodeName: "Atlas storage",
    });
    const store = new NmgStore(join(directory, "nmg.sqlite"));
    try {
      const context = store.searchContext("SQLite Atlas", {
        sessionId: "library-reader",
        limit: 1,
      });
      const snapshot = captureMemoryReferenceTargets(context.results);
      const key = createMemoryReferences(context, snapshot)[saved.memory.id]!;
      const current = store.getContext(context.activeGraph!.memoryIds).results;
      const ids = resolveMemoryReferences([key], snapshot, current);
      assert.deepEqual(ids, [saved.memory.id]);
      assert.equal(store.getContext(ids).results[0]?.memory.id, saved.memory.id);
      // A durable trace lacks the content witness of a live service projection.
      await assert.rejects(
        service.invoke("get", {
          memoryIds: [key],
          activeGraphId: context.activeGraph!.id,
          sessionId: "library-reader",
        }),
        /absent or not owned/u,
      );
    } finally {
      store.close();
    }
  });
});

test("expired private projections fail instead of rebinding a reference to the latest graph", async () => {
  await withService(async (service, directory) => {
    const saved = await service.invoke("remember", {
      statement: "SQLite stores Atlas project data.",
      nodeName: "Atlas storage",
    });
    const context = await service.invoke("search", {
      query: "SQLite Atlas",
      limit: 1,
    });
    const key = context.memoryReferences![saved.memory.id]!;
    service.close();
    const restarted = new NmgService({
      databasePath: join(directory, "nmg.sqlite"),
      environment: {},
    });
    try {
      await restarted.invoke("search", { query: "SQLite Atlas", limit: 1 });
      await assert.rejects(
        restarted.invoke("get", {
          memoryIds: [key],
          activeGraphId: context.activeGraph!.id,
        }),
        /absent or not owned/u,
      );
      const canonical = await restarted.invoke("get", {
        memoryIds: [saved.memory.id],
      });
      assert.equal(canonical.results[0]?.memory.id, saved.memory.id);
    } finally {
      restarted.close();
    }
  });
});
