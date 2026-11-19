import { openLocalMemory } from "../../src/cli/local-memory-migration.ts";
import { hasLegacyMemoryTables } from "../../src/core/memory/sqlite-legacy-retirement.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { NmgService } from "../../src/cli/service.ts";
import { runCli } from "../../src/cli/main.ts";
import { httpHandler, serveHttp } from "../../src/cli/http-server.ts";
import { httpCall } from "../../src/cli/http-client.ts";
import type { ServerState } from "../../src/cli/lifecycle.ts";
import { LegacySqliteFixture } from "../helpers/legacy-sqlite-fixture.ts";
import { stgStorePath } from "../../src/core/stg-projection.ts";
import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { PortableMemoryService } from "../../src/cli/portable-memory.ts";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { SqliteMemoryBackend } from "../../src/core/memory/sqlite-backend.ts";
import { activatedLocalMemory } from "../../src/core/memory/sqlite-backend.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

test(
  "the daemon drains whole provider batches before starting its idle countdown",
  { timeout: 5000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "nmg-vector-backlog-"));
    const path = join(directory, "memory.sqlite");
    const requests: number[] = [];
    const fetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      if (!url.startsWith("https://embedding.test/")) return fetch(url, init);
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      requests.push(input.length);
      await delay(450);
      return Response.json({
        data: input.map((_, index) => ({ index, embedding: [1, 1] })),
      });
    });
    const options = {
      databasePath: path,
      environment: {
        NMG_EMBED_PROVIDER: "openai",
        NMG_EMBED_API_KEY: "fixture-only",
        NMG_EMBED_BASE_URL: "https://embedding.test/v1",
        NMG_EMBED_BATCH_SIZE: "10",
      },
    };
    const service = new NmgService(options);
    t.after(async () => {
      await service.close();
      removeTempDirectory(directory);
    });
    let publishState!: (state: Partial<ServerState>) => void;
    const ready = new Promise<Partial<ServerState>>((resolve) => {
      publishState = resolve;
    });
    const stopped = serveHttp(
      service,
      { statePath: "unused", update: publishState, release() {} },
      { idleTimeoutMs: 300 },
    );
    const state = (await ready) as ServerState;
    await httpCall(state, "rememberBatch", {
      operationId: "one-backlog",
      items: Array.from({ length: 67 }, (_, i) => ({
        statement: `The verification archive includes entry ${i}`,
        nodeName: "Archive",
      })),
    });
    await stopped;
    assert.deepEqual(requests, [10, 10, 10, 10, 10, 10, 7]);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM nmg_memory_vectors").get()?.n, 67);
    } finally {
      db.close();
    }
  },
);

test("default service migrates an old SQLite file before serving memory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-default-migration-"));
  const databasePath = join(directory, "nmg.sqlite");
  const legacy = new LegacySqliteFixture(databasePath);
  const { memory } = legacy.insertMemory({
    statement: "The signed inventory is stored in the original warehouse",
    nodeName: "Original warehouse",
  });
  const retained = legacy.insertMemory({
    statement: "The retained inventory references the retired warehouse",
    nodeName: "Retired warehouse",
  }).memory;
  legacy.db
    .prepare("UPDATE memory_records SET storage_state='dormant' WHERE id=?")
    .run(retained.id);
  legacy.close();
  const service = new NmgService({ databasePath, environment: {} });
  try {
    assert.ok((await service.invoke("hello")).capabilities.includes("portable-memory"));
    assert.equal(
      (await service.invoke("get", { memoryIds: [memory.id] })).results[0]?.memory.id,
      memory.id,
    );
    assert.equal(
      (await service.invoke("get", { memoryIds: [retained.id] })).results[0]?.memory.storageState,
      "dormant",
    );
    const matches = await service.invoke("search", {
      query: "inventory warehouse",
      includeHistorical: true,
    });
    assert.deepEqual(
      matches.results.map(({ memory }) => memory.id),
      [memory.id],
    );
    assert.ok(activatedLocalMemory(databasePath));
    const backup = readdirSync(directory).find((name) =>
      name.startsWith("nmg.sqlite.before-unified-"),
    );
    assert.ok(backup);
    const source = new DatabaseSync(join(directory, backup), { readOnly: true });
    try {
      assert.ok(source.prepare("SELECT id FROM memory_records WHERE id=?").get(memory.id));
      assert.equal(activatedLocalMemory(join(directory, backup)), undefined);
    } finally {
      source.close();
    }
    const current = new DatabaseSync(databasePath);
    try {
      assert.equal(hasLegacyMemoryTables(current), false);
      assert.equal(hasLegacyMemoryTables(current), false);
    } finally {
      current.close();
    }
  } finally {
    await service.close();
    removeTempDirectory(directory);
  }
});

test("legacy retirement rolls back if a retained table references a retired table", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-retire-reference-"));
  const path = join(directory, "nmg.sqlite");
  try {
    const legacy = new LegacySqliteFixture(path);
    const { memory } = legacy.insertMemory({
      statement: "An archived record still supports the external report.",
      nodeName: "Archived record",
    });
    legacy.close();
    const db = new DatabaseSync(path);
    try {
      db.exec(
        "CREATE TABLE report (memory_id TEXT REFERENCES memory_records(id) ON DELETE CASCADE)",
      );
      db.prepare("INSERT INTO report VALUES (?)").run(memory.id);
    } finally {
      db.close();
    }

    await assert.rejects(openLocalMemory(path, "rollback"), /memory_records: referenced by report/);
    assert.equal(activatedLocalMemory(path), undefined);
    const restored = new DatabaseSync(path, { readOnly: true });
    try {
      assert.ok(restored.prepare("SELECT 1 FROM memory_records WHERE id=?").get(memory.id));
      assert.equal(restored.prepare("SELECT memory_id FROM report").get()?.memory_id, memory.id);
      assert.equal(restored.prepare("SELECT count(*) AS n FROM nmg_memory_entities").get()?.n, 0);
    } finally {
      restored.close();
    }
  } finally {
    removeTempDirectory(directory);
  }
});

test("one daemon migrate command backs up and activates the main and selected projects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-migrate-projects-"));
  const main = join(directory, "nmg.sqlite");
  const project = join(directory, "project");
  const stg = stgStorePath(project);
  const missing = join(directory, "missing");
  try {
    for (const path of [main, stg]) {
      const fixture = new LegacySqliteFixture(path);
      fixture.insertMemory({
        statement: "Archive checkpoint stored in SQLite",
        nodeName: "Checkpoint",
      });
      fixture.close();
    }
    const argv = [
      "daemon",
      "migrate",
      "--db",
      main,
      "--project-dir",
      project,
      "--project-dir",
      missing,
      "--project-dir",
      project,
      "--json",
    ];
    let output = "";
    const io = {
      stdout: {
        write: (text: string) => {
          output += text;
          return true;
        },
      },
      stderr: {
        write: (text: string) => {
          assert.fail(text);
        },
      },
    };
    assert.equal(await runCli(argv, io), 0);
    const receipt = JSON.parse(output);
    assert.ok(existsSync(receipt.backupPath));
    assert.equal(receipt.projectDatabases.length, 1);
    assert.equal(receipt.projectDatabases[0].databasePath, stg);
    assert.ok(existsSync(receipt.projectDatabases[0].backupPath));
    assert.equal(activatedLocalMemory(stg), receipt.namespace);
    assert.equal(existsSync(stgStorePath(missing)), false);
    output = "";
    assert.equal(await runCli(argv, io), 0);
    assert.equal(JSON.parse(output).backupPath, undefined);
    assert.equal(JSON.parse(output).projectDatabases[0].backupPath, undefined);
  } finally {
    removeTempDirectory(directory);
  }
});

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

test("unified automatic search uses the admitted turn's nearby context before retrieval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-nearby-context-"));
  const local = new NmgService({
    databasePath: join(directory, "memory.sqlite"),
    environment: {},
    memoryBackend: { kind: "sqlite", namespace: "nearby-context", local: true },
  });
  const projectDir = join(directory, "project");
  const sessionId = "session-a";
  const query = "这次呢？";
  try {
    const { memory } = await local.invoke("remember", {
      statement: "HarborAtlasMarker restores the SQLite backup in the maintenance window",
      nodeName: "HarborAtlasMarker",
    });
    for (const prompt of ["请测试 HarborAtlasMarker 的 SQLite 备份恢复工作", query]) {
      await local.invoke("sessionActiveGraph", {
        action: "beginDisclosureTurn",
        sessionId,
        projectDir,
        prompt,
      });
    }
    const options = {
      query,
      projectDir,
      sessionId,
      retrievalMode: "fts5",
      autoRecall: true,
      persistTrace: false,
    } as const;
    const recalled = await local.invoke("search", options);
    assert.equal(recalled.results[0]?.memory.id, memory.id);
    assert.equal(recalled.activeGraph?.query, query);
    for (const variation of [
      { autoRecall: false },
      { sessionId: "session-b" },
      { projectDir: join(directory, "another-project") },
    ]) {
      const separate = await local.invoke("search", { ...options, ...variation });
      assert.equal(
        separate.results.some((entry) => entry.memory.id === memory.id),
        false,
      );
    }
  } finally {
    await local.close();
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
  const legacy = new LegacySqliteFixture(databasePath);
  const original = legacy.insertMemory({
    statement: "The atlas depot uses the old receiver",
    nodeName: "Old receiver",
  });
  const vote = {
    memoryId: original.memory.id,
    outcome: "supported" as const,
    source: "task" as const,
    sourceLineage: "operator-1",
  };
  const timestamp = new Date().toISOString();
  legacy.db
    .prepare(
      "INSERT INTO claim_outcome_events (id,memory_id,claim_index,semantic_task_id,source,source_lineage,outcome,weight,created_at) VALUES (?,?,0,?,?,?,?,1,?)",
    )
    .run(
      "legacy-vote",
      vote.memoryId,
      "previous-inspection",
      vote.source,
      vote.sourceLineage,
      vote.outcome,
      timestamp,
    );
  legacy.db
    .prepare(
      "INSERT INTO claim_posteriors (memory_id,claim_index,claim_text,prior_confidence,alpha,beta,independent_vote_count,updated_at) VALUES (?,0,?,0.5,2,1,1,?)",
    )
    .run(vote.memoryId, "The atlas depot uses the old receiver", timestamp);
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

test("default local search can finish exact anchor lookups without calling embeddings", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-exact-lookup-"));
  const options = {
    kind: "sqlite",
    path: join(directory, "memory.sqlite"),
    namespace: "lookup",
  } as const;
  const backend = new SqliteMemoryBackend(options.path, options.namespace);
  backend.activateLocal();
  const [direct, prefix] = await new MemoryEngine(backend).rememberMany([
    {
      statement: "Investigated ERR_SQL_BUSY due to write contention.",
      nodeName: "SQLite",
      scope: { project: "atlas" },
    },
    {
      statement: "Investigated ERR_SQL_BUSY_RETRY and v1.2.3 due to lock contention.",
      nodeName: "SQLite",
      scope: { project: "boreal" },
    },
  ]);
  const records = [direct!, prefix!].map(({ memory }) => ({
    id: memory.id,
    statement: memory.statement,
    text: memory.statement,
  }));
  backend.vectorIndex.save("fixture", records, [
    [1, 0],
    [1, 0],
  ]);
  await backend.close();
  const embedded: string[] = [];
  const embed = async (queries: string[]) => queries.map(() => [1, 0]);
  const service = new PortableMemoryService(options, true, () => ({
    indexId: "fixture",
    model: "fixture",
    profile: "fixture",
    embed,
    embedDocuments: embed,
    async embedQueries(queries) {
      embedded.push(...queries);
      return embed(queries);
    },
  }));
  t.after(async () => {
    await service.close();
    removeTempDirectory(directory);
  });
  for (const query of ["ERR_SQL_BUSY", '"write contention"']) {
    const exact = await service.search({ query });
    assert.deepEqual(exact.retrieval, { mode: "lexical", degraded: false });
    assert.deepEqual(
      exact.results.map(({ memory }) => memory.id),
      [direct!.memory.id],
    );
  }
  assert.deepEqual(embedded, []);
  const cases = [
    { query: "ERR_SQL_BUSY", scope: { project: "boreal" } },
    { query: '"v1.2"' },
    { query: "why ERR_SQL_BUSY" },
    { query: "ERR_SQL_BUSY", retrievalMode: "hybrid" as const },
    { query: "ERR_SQL_BUSY", autoRecall: true },
    { query: "ERR_SQL_BUSY", queries: ["write contention"] },
  ];
  for (const params of cases) {
    const fallback = await service.search(params);
    assert.equal(fallback.retrieval?.mode, "hybrid");
  }
  assert.deepEqual(embedded, [...cases.map(({ query }) => query), "write contention"]);
});

test("activated SQLite uses legacy vectors and indexes new writes across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-portable-vector-"));
  const path = join(directory, "memory.sqlite");
  let documentCalls = 0;
  let slowQueries = false;
  const queryBatches: number[] = [];
  let watchQuery: ((response: import("node:http").ServerResponse) => void) | undefined;
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    const { requests } = JSON.parse(Buffer.concat(parts).toString()) as {
      requests: Array<{ taskType: string }>;
    };
    documentCalls += requests.filter((item) => item.taskType === "RETRIEVAL_DOCUMENT").length;
    if (requests.some((item) => item.taskType === "RETRIEVAL_QUERY"))
      queryBatches.push(requests.length);
    if (slowQueries && requests.some((item) => item.taskType === "RETRIEVAL_QUERY")) {
      watchQuery?.(response);
      await delay(120);
    }
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
  const legacy = new LegacySqliteFixture(path);
  const original = legacy.insertMemory({
    statement: "The logistics depot is in Oslo",
    nodeName: "Depot",
  });
  legacy.insertVector("record", indexId, original.memory.id, [1, 0]);
  legacy.insertVector("node", indexId, original.node.id, [1, 0]);
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
    const migrated = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(hasLegacyMemoryTables(migrated), false);
      assert.equal(
        migrated
          .prepare("SELECT id FROM nmg_memory_route_vectors WHERE model=? AND kind='node'")
          .get(indexId)?.id,
        original.node.id,
      );
    } finally {
      migrated.close();
    }
    assert.equal(documentCalls, 0);
    const hybrid = await service.invoke("search", {
      query: "logistics depot",
      retrievalMode: "hybrid",
    });
    assert.equal(hybrid.retrieval?.mode, "hybrid");
    assert.ok(hybrid.results[0]!.lexicalScore > 0);
    const multi = await service.invoke("search", {
      query: "logistics depot",
      queries: ["logistics depot", "warehouse location", "shipping address"],
      retrievalMode: "hybrid",
    });
    assert.equal(multi.retrieval?.mode, "hybrid");
    assert.equal(queryBatches.at(-1), 3);
    slowQueries = true;
    const fallback = await service.invoke("search", {
      query: "logistics depot",
      retrievalMode: "hybrid",
      autoRecall: true,
      autoRecallBudgetMs: 20,
    });
    assert.deepEqual(fallback.retrieval, {
      mode: "lexical",
      degraded: true,
      reason: "automatic_recall_embedding_deadline",
    });
    assert.equal(fallback.results[0]?.memory.id, original.memory.id);
    const explicit = await service.invoke("search", {
      query: "logistics depot",
      retrievalMode: "hybrid",
    });
    assert.equal(explicit.retrieval?.mode, "hybrid");
    assert.equal(explicit.results[0]?.vectorScore, 1);
    let queryStarted!: () => void;
    let queryClosed!: (aborted: boolean) => void;
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    const closed = new Promise<boolean>((resolve) => {
      queryClosed = resolve;
    });
    watchQuery = (response) => {
      response.once("close", () => queryClosed(!response.writableFinished));
      queryStarted();
    };
    const rpc = createServer(httpHandler(service, "fixture-token"));
    await new Promise<void>((ready) => rpc.listen(0, "127.0.0.1", ready));
    try {
      const endpoint = rpc.address();
      assert.ok(endpoint && typeof endpoint === "object");
      const controller = new AbortController();
      const response = fetch(`http://127.0.0.1:${endpoint.port}/`, {
        method: "POST",
        headers: { authorization: "Bearer fixture-token" },
        body: JSON.stringify({
          method: "search",
          params: { query: "explicit cancellation", retrievalMode: "hybrid" },
        }),
        signal: controller.signal,
      });
      const rejected = assert.rejects(response, { name: "AbortError" });
      await started;
      controller.abort();
      await rejected;
      assert.equal(await closed, true);
    } finally {
      await new Promise<void>((ready) => {
        rpc.close(() => ready());
        rpc.closeAllConnections();
      });
    }
    slowQueries = false;
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
