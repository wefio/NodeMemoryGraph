import assert from "node:assert/strict";
import { existsSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NmgService } from "../../src/cli/service.ts";
import { httpHandler } from "../../src/cli/http-server.ts";
import { NmgStore } from "../../src/core/store.ts";
import { stgStorePath } from "../../src/core/stg.ts";
import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

test("activated daemon uses the project file's existing namespace for scoped memory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-project-namespace-"));
  const projectDir = join(directory, "project");
  const project = new NmgService({
    databasePath: stgStorePath(projectDir),
    environment: {},
    memoryBackend: { kind: "sqlite", namespace: "project-origin", local: true },
  });
  const service = new NmgService({
    databasePath: join(directory, "nmg.sqlite"),
    environment: {},
    memoryBackend: { kind: "sqlite", namespace: "main-origin", local: true },
  });
  try {
    const existing = await project.invoke("remember", {
      statement: "The project keeps the calibration fixture on site",
      nodeName: "Calibration",
      residence: "stg",
      sessionId: "owner",
    });
    await project.close();
    const scoped = { projectDir, sessionId: "owner" };
    const shared = await service.invoke("remember", {
      statement: "Calibration documents use common terminology",
      nodeName: "Calibration glossary",
    });
    const recalled = await service.invoke("search", { ...scoped, query: "calibration" });
    assert.deepEqual(
      new Set(recalled.results.map(({ memory }) => memory.id)),
      new Set([existing.memory.id, shared.memory.id]),
    );
    assert.equal(
      (await service.invoke("get", { ...scoped, memoryIds: [existing.memory.id] })).results[0]
        ?.memory.id,
      existing.memory.id,
    );
    assert.deepEqual(
      (
        await service.invoke("get", {
          ...scoped,
          sessionId: "foreign",
          memoryIds: [existing.memory.id],
        })
      ).results,
      [],
    );
    const created = await service.invoke("remember", {
      ...scoped,
      statement: "A calibration label belongs to this project",
      nodeName: "Label",
      residence: "stg",
    });
    assert.equal(
      (await service.invoke("get", { ...scoped, memoryIds: [created.memory.id] })).results[0]
        ?.memory.id,
      created.memory.id,
    );
    const db = new DatabaseSync(stgStorePath(projectDir), { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT namespace FROM nmg_local_memory").get()?.namespace,
        "project-origin",
      );
      assert.equal(db.prepare("SELECT count(*) AS n FROM nmg_memory_head").get()?.n, 1);
    } finally {
      db.close();
    }
  } finally {
    await project.close();
    await service.close();
    removeTempDirectory(directory);
  }
});

test("activated daemon accepts the Pi automatic recall envelope and enforces MCP event bounds", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-adapter-recall-"));
  const service = new NmgService({
    databasePath: join(directory, "nmg.sqlite"),
    environment: {},
    memoryBackend: { kind: "sqlite", namespace: "adapter-recall", local: true },
  });
  try {
    const early = await service.invoke("remember", {
      statement: "The depot inspection happened in Oslo",
      nodeName: "Oslo",
      eventTime: "2025-06-01",
    });
    const late = await service.invoke("remember", {
      statement: "The depot inspection happened in Bergen",
      nodeName: "Bergen",
      eventTime: "2025-07-01",
    });
    const automatic = {
      query: "depot inspection",
      autoRecallBudgetMs: 2500,
      projectDir: directory,
      sessionId: "pi-fixture",
      maxTier: 1,
      limit: 8,
      initialEvidenceTarget: 2,
      strongHitTopGap: 1,
      strongHitInitialTarget: 1,
      secondPass: false,
      graphHops: 0,
      tieredDisclosure: true,
      autoRecall: true,
    };
    const first = await service.invoke("search", automatic);
    assert.deepEqual(
      new Set(first.activeGraph?.memoryIds),
      new Set([early.memory.id, late.memory.id]),
    );
    assert.equal(first.activeGraph?.qpp?.expansion, undefined);
    const expanded = await service.invoke("search", { ...automatic, secondPass: true });
    assert.equal(expanded.activeGraph?.qpp?.expansion?.stages[0]?.targetEvidence, 2);
    const explicit = await service.invoke("search", {
      query: "depot inspection",
      sessionId: "mcp-fixture",
      projectDir: directory,
      limit: 1,
      eventTimeFrom: "2025-07-01",
      eventTimeTo: "2025-07-01",
      recallCue: "upcoming depot inspection",
      recallRevision: 1,
      progressiveWarmDisclosure: false,
    });
    assert.deepEqual(
      explicit.results.map(({ memory }) => memory.id),
      [late.memory.id],
    );
  } finally {
    await service.close();
    removeTempDirectory(directory);
  }
});

test("daemon keeps aggregate compatibility rejections across restart without request content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-rpc-rejections-"));
  const options = {
    databasePath: join(directory, "nmg.sqlite"),
    environment: {},
    memoryBackend: { kind: "sqlite" as const, namespace: "rejections" },
  };
  let service = new NmgService(options);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        service.invoke("search", {
          query: "private prompt",
          retrievalMode: "qwen3",
        }),
        /does not support retrievalMode/,
      );
    }
    await assert.rejects(service.invoke("lab", { sessionId: "private session" }), /not supported/);
    const server = createServer(httpHandler(service, "token"));
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const url = `http://127.0.0.1:${address.port}`;
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "private-unknown-method" });
      assert.equal((await fetch(url, { method: "POST", body })).status, 401);
      assert.equal(
        (
          await fetch(url, {
            method: "POST",
            body,
            headers: { authorization: "Bearer token" },
          })
        ).status,
        400,
      );
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
    await service.close();
    service = new NmgService(options);
    const status = await service.invoke("status");
    const rows = status.rpcRejections ?? [];
    assert.deepEqual(
      rows.map(({ method, code, parameter, count }) => [method, code, parameter, count]),
      [
        ["search", "INVALID_PARAMS", "retrievalMode", 2],
        ["(unknown)", "METHOD_NOT_FOUND", undefined, 1],
        ["lab", "METHOD_NOT_FOUND", undefined, 1],
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(rows),
      /private prompt|private session|private-unknown-method/,
    );
  } finally {
    await service.close();
    removeTempDirectory(directory);
  }
});

test("unified SQLite searches and relocates a new bookmark independently of its memory text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-unified-tessera-"));
  const file = join(directory, "notes.txt");
  writeFileSync(file, "Opening line\nThe source fragment\n");
  const service = new NmgService({
    databasePath: join(directory, "nmg.sqlite"),
    environment: {},
    memoryBackend: { kind: "sqlite", namespace: "tessera-contract", local: true },
  });
  try {
    const saved = await service.invoke("remember", {
      nodeName: "Atlas depot",
      statement: "The Atlas depot uses a nightly inventory report",
      projectDir: directory,
      tesserae: [
        { path: "notes.txt", label: "BibliographyMarker", snippet: "The source fragment" },
      ],
    });
    const query = {
      query: "BibliographyMarker",
      projectDir: directory,
      sessionId: "tessera-owner",
    };
    const hit = await service.invoke("search", query);
    assert.deepEqual(hit.results, []);
    assert.equal(hit.tesserae?.[0]?.memoryId, saved.memory.id);
    assert.equal(hit.tesserae?.[0]?.line, 2);
    truncateSync(file, 2 * 1024 * 1024);
    assert.equal((await service.invoke("search", query)).tesserae?.[0]?.stale, true);
    const automatic = await service.invoke("search", {
      ...query,
      query: "Atlas depot",
      autoRecall: true,
      secondPass: false,
    });
    assert.equal(automatic.results[0]?.memory.id, saved.memory.id);
    assert.equal(automatic.tesserae?.[0]?.line, undefined);
    assert.equal(automatic.tesserae?.[0]?.stale, undefined);
  } finally {
    await service.close();
    removeTempDirectory(directory);
  }
});

test("unified lifecycle and claim receipts preserve legacy vote counters through restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-lifecycle-contract-"));
  const databasePath = join(directory, "nmg.sqlite");
  const legacy = new NmgStore(databasePath);
  const original = legacy.remember({
    statement: "The atlas depot uses the old receiver",
    nodeName: "Old receiver",
  });
  const vote = {
    memoryId: original.memory.id,
    outcome: "supported" as const,
    source: "task" as const,
    sourceLineage: "operator-1",
  };
  legacy.recordClaimOutcomes({ semanticTaskId: "previous-inspection", votes: [vote] });
  legacy.close();
  let service = new NmgService({
    databasePath,
    environment: { NMG_CONTEXT_ONLINE_LEARNING: "0" },
    memoryBackend: { kind: "sqlite", namespace: "lifecycle-contract", local: true },
  });
  try {
    const sessionId = "owner";
    const first = await service.invoke("search", { query: "atlas depot", sessionId });
    assert.ok(first.activeGraph);
    const reference = first.memoryReferences?.[original.memory.id];
    assert.ok(reference?.startsWith("ref:"));
    const exact = await service.invoke("get", {
      memoryIds: [reference],
      activeGraphId: first.activeGraph.id,
      sessionId,
    });
    assert.equal(exact.results[0]?.memory.id, original.memory.id);
    const request = {
      activeGraphId: first.activeGraph.id,
      semanticTaskId: "next-inspection",
      sessionId,
      votes: [vote],
    };
    await assert.rejects(
      service.invoke("recordClaimOutcomes", { ...request, sessionId: "foreign" }),
      /absent|another session/u,
    );
    const saved = await service.invoke("recordClaimOutcomes", request);
    assert.equal(saved.events.length, 1);
    assert.equal(saved.posteriors[0]?.independentVoteCount, 2);
    const historicalRetry = await service.invoke("recordClaimOutcomes", {
      ...request,
      semanticTaskId: "previous-inspection",
    });
    assert.equal(historicalRetry.events.length, 0);
    const replacement = await service.invoke("remember", {
      statement: "The atlas depot uses the replacement receiver",
      nodeName: "Replacement receiver",
      sessionId,
    });
    const newer = replacement.memory.id;
    const pair = {
      newMemoryId: newer,
      relatedMemoryId: original.memory.id,
      relationJudgement: "related",
      sessionId,
    };
    const proposed = await service.invoke("resolveRemember", { action: "relate", ...pair });
    assert.ok(proposed.action === "relate" && proposed.proposal.observations === 1);
    const reopened = await service.invoke("resolveRemember", {
      action: "reopen",
      memoryId: newer,
      relatedMemoryIds: [original.memory.id],
      sessionId,
    });
    assert.ok(reopened.action === "reopen" && reopened.resolution === "reopened");
    await service.invoke("resolveRemember", { action: "resolve", memoryId: newer, sessionId });
    const replaced = await service.invoke("resolveRemember", {
      action: "supersede",
      newMemoryId: newer,
      supersededMemoryId: original.memory.id,
      sessionId,
    });
    assert.ok(replaced.action === "supersede" && replaced.applied);
    await service.close();
    service = new NmgService({ databasePath, environment: {} });
    assert.equal((await service.invoke("recordClaimOutcomes", request)).events.length, 0);
    const repeated = await service.invoke("resolveRemember", { action: "relate", ...pair });
    assert.ok(repeated.action === "relate" && repeated.proposal.observations === 2);
    assert.equal(repeated.proposal.id, proposed.proposal.id);
    const visible = await service.invoke("get", {
      memoryIds: [original.memory.id, newer],
      sessionId,
    });
    assert.deepEqual(
      visible.results.map(({ memory }) => memory.id),
      [newer],
    );
    assert.equal(visible.results[0]?.memory.resolution, "resolved");
    await service.invoke("resolveRemember", { action: "forget", memoryId: newer, sessionId });
    assert.equal(
      (await service.invoke("get", { memoryIds: [newer], sessionId })).results.length,
      0,
    );
  } finally {
    await service.close();
    removeTempDirectory(directory);
  }
});

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
