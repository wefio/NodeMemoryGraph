import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NMG_PROTOCOL_VERSION } from "../../src/cli/protocol.ts";
import { NmgService } from "../../src/cli/service.ts";
import { NmgStore } from "../../src/core/store.ts";
import { stgStorePath } from "../../src/core/stg.ts";

test("status and hello do not create or open the database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-status-"));
  const databasePath = join(directory, "nmg.sqlite");
  const service = new NmgService({ databasePath, environment: {} });
  try {
    const hello = await service.invoke("hello");
    const status = await service.invoke("status");
    assert.equal(hello.protocol, NMG_PROTOCOL_VERSION);
    assert.ok(hello.capabilities.includes("search"));
    assert.equal(status.storage.exists, false);
    assert.equal(status.storage.loaded, false);
    assert.equal(existsSync(databasePath), false);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resident service remembers, searches, and expands exact evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-roundtrip-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const remembered = await service.invoke("remember", {
      statement: "The Atlas project must remain offline-first.",
      nodeName: "Atlas architecture",
      memoryType: "constraint",
      evidence: "The Atlas project must remain offline-first.",
      scope: { project: "atlas" },
    });
    const searched = await service.invoke("search", {
      query: "Atlas offline first",
      scope: { project: "atlas" },
    });
    assert.equal(searched.results[0]?.memory.id, remembered.memory.id);

    const expanded = await service.invoke("get", {
      memoryIds: [remembered.memory.id, "missing-memory"],
    });
    assert.equal(expanded.results[0]?.evidence.content, remembered.history.content);
    assert.deepEqual(expanded.missingMemoryIds, ["missing-memory"]);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resident service isolates project STG while retaining LTG fallback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-stg-"));
  const projectA = join(directory, "project-a");
  const projectB = join(directory, "project-b");
  const service = new NmgService({ databasePath: join(directory, "ltg.sqlite"), environment: {} });
  try {
    const local = await service.invoke("remember", {
      statement: "Project A session branch is blue.",
      nodeName: "Session branch",
      residence: "stg",
      projectDir: projectA,
    });
    const durable = await service.invoke("remember", {
      statement: "The user prefers concise explanations.",
      nodeName: "Response preference",
      memoryType: "preference",
    });

    const inA = await service.invoke("search", {
      query: "session branch blue",
      projectDir: projectA,
    });
    assert.ok(inA.results.some((result) => result.memory.id === local.memory.id));
    const inB = await service.invoke("search", {
      query: "session branch blue",
      projectDir: projectB,
    });
    assert.ok(!inB.results.some((result) => result.memory.id === local.memory.id));

    const fallback = await service.invoke("search", {
      query: "concise explanations",
      projectDir: projectA,
    });
    assert.ok(fallback.results.some((result) => result.memory.id === durable.memory.id));
    const expanded = await service.invoke("get", {
      memoryIds: [local.memory.id],
      projectDir: projectA,
    });
    assert.equal(expanded.results[0]?.memory.id, local.memory.id);
    assert.deepEqual(expanded.missingMemoryIds, []);
    assert.ok(existsSync(stgStorePath(projectA, "cli")));
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resident service keeps mixed STG/LTG evidence in one AG and attributes both parts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-mixed-ag-"));
  const projectDir = join(directory, "project");
  const databasePath = join(directory, "ltg.sqlite");
  const service = new NmgService({ databasePath, environment: {} });
  try {
    const local = await service.invoke("remember", {
      statement: "Atlas session branch uses the cobalt deployment lane.",
      nodeName: "Atlas session lane",
      residence: "stg",
      projectDir,
      sessionId: "session-alpha",
    });
    const durable = await service.invoke("remember", {
      statement: "Atlas deployments require concise release notes.",
      nodeName: "Atlas release constraint",
      memoryType: "constraint",
      sessionId: "session-alpha",
    });

    const searched = await service.invoke("search", {
      query: "Which cobalt deployment lane and concise release-note constraint apply to Atlas?",
      projectDir,
      sessionId: "session-alpha",
      secondPass: true,
    });
    assert.ok(searched.results.some((result) => result.memory.id === local.memory.id));
    assert.ok(searched.results.some((result) => result.memory.id === durable.memory.id));
    assert.deepEqual(
      new Set(searched.activeGraph?.memoryIds),
      new Set(searched.results.map((result) => result.memory.id)),
    );

    await service.invoke("get", {
      memoryIds: [local.memory.id, durable.memory.id],
      activeGraphId: searched.activeGraph!.id,
      projectDir,
      sessionId: "session-alpha",
    });

    const ltg = new NmgStore(databasePath);
    const stg = new NmgStore(stgStorePath(projectDir, "session-alpha"));
    try {
      assert.ok(ltg.getContext([durable.memory.id]).results[0]!.memory.accessCount > 0);
      assert.ok(stg.getContext([local.memory.id]).results[0]!.memory.accessCount > 0);
    } finally {
      ltg.close();
      stg.close();
    }
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resident service isolates STG by session inside one project", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-session-stg-"));
  const projectDir = join(directory, "project");
  const service = new NmgService({ databasePath: join(directory, "ltg.sqlite"), environment: {} });
  try {
    const local = await service.invoke("remember", {
      statement: "Session alpha scratch fact is cobalt.",
      nodeName: "Session scratch",
      residence: "stg",
      projectDir,
      sessionId: "session-alpha",
    });
    const alpha = await service.invoke("search", {
      query: "scratch fact cobalt",
      projectDir,
      sessionId: "session-alpha",
    });
    const beta = await service.invoke("search", {
      query: "scratch fact cobalt",
      projectDir,
      sessionId: "session-beta",
    });
    assert.ok(alpha.results.some((result) => result.memory.id === local.memory.id));
    assert.ok(!beta.results.some((result) => result.memory.id === local.memory.id));
    assert.notEqual(
      stgStorePath(projectDir, "session-alpha"),
      stgStorePath(projectDir, "session-beta"),
    );
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resident service attributes nmg_get use only to the owning session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-owned-ag-"));
  const service = new NmgService({ databasePath: join(directory, "ltg.sqlite"), environment: {} });
  try {
    const remembered = await service.invoke("remember", {
      statement: "Atlas uses a session-owned memory trace.",
      nodeName: "Atlas trace",
    });
    const searched = await service.invoke("search", {
      query: "Atlas session owned trace",
      sessionId: "session-alpha",
    });
    const activeGraphId = searched.activeGraph!.id;
    await assert.rejects(
      service.invoke("get", {
        memoryIds: [remembered.memory.id],
        activeGraphId,
        sessionId: "session-beta",
      }),
      /belongs to another session/,
    );
    await service.invoke("get", {
      memoryIds: [remembered.memory.id],
      activeGraphId,
      sessionId: "session-alpha",
    });
    const reader = new NmgStore(join(directory, "ltg.sqlite"));
    try {
      assert.deepEqual(reader.retrievalTrace(activeGraphId, "session-alpha")?.usefulMemoryIds, [
        remembered.memory.id,
      ]);
    } finally {
      reader.close();
    }
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resident service syncs a scoped LTG working set into project STG idempotently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-stg-sync-"));
  const projectDir = join(directory, "project");
  const service = new NmgService({ databasePath: join(directory, "ltg.sqlite"), environment: {} });
  try {
    await service.invoke("remember", {
      statement: "Project atlas uses SQLite.",
      nodeName: "Atlas storage",
      scope: { project: "atlas" },
    });
    const first = await service.invoke("syncStg", {
      projectDir,
      scope: { project: "atlas" },
      limit: 10,
    });
    const second = await service.invoke("syncStg", {
      projectDir,
      scope: { project: "atlas" },
      limit: 10,
    });
    assert.equal(first.copied, 1);
    assert.equal(second.copied, 0);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resident service exposes explicit retention and deletion maintenance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-maintenance-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const remembered = await service.invoke("remember", {
      statement: "A disposable historical observation.",
      nodeName: "Disposable observations",
      memoryType: "event",
      importance: 0.1,
    });
    const archived = await service.invoke("setStorageState", {
      memoryId: remembered.memory.id,
      storageState: "dormant",
    });
    assert.equal(archived.storageState, "dormant");
    assert.equal(
      (await service.invoke("search", { query: "disposable historical" })).results.length,
      0,
    );

    await service.invoke("setStorageState", {
      memoryId: remembered.memory.id,
      storageState: "indexed",
    });
    assert.equal(
      (await service.invoke("search", { query: "disposable historical" })).results.length,
      1,
    );

    const deleted = await service.invoke("deleteMemory", { memoryId: remembered.memory.id });
    assert.equal(deleted.deleted, true);
    assert.equal(
      (await service.invoke("search", { query: "disposable historical" })).results.length,
      0,
    );
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service validates method parameters", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-errors-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    await assert.rejects(service.invoke("get", { memoryIds: [] }), {
      code: "INVALID_PARAMS",
    });
    await assert.rejects(
      service.invoke("remember", {
        statement: "The current version is 2.",
        nodeName: "Current version",
        memoryType: "state",
      }),
      { code: "INVALID_PARAMS" },
    );
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("external source markers persist and default trust to unverified", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-external-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const remembered = await service.invoke("remember", {
      statement: "The project documentation names SQLite as its storage engine.",
      nodeName: "Project storage",
      markers: [
        {
          kind: "external_source",
          attributes: {
            source: "file:README.md",
            retrievedAt: "2026-08-01T00:00:00.000Z",
            hash: "sha256:test",
          },
        },
      ],
    });
    assert.equal(remembered.memory.truthStatus, "unverified");
    assert.equal(remembered.memory.markers[0]?.kind, "external_source");
    assert.equal(remembered.memory.markers[0]?.attributes?.source, "file:README.md");

    await assert.rejects(
      service.invoke("remember", {
        statement: "Malformed marker",
        nodeName: "Malformed",
        markers: [{ kind: "external_source", attributes: { nested: {} } }],
      } as never),
      { code: "INVALID_PARAMS" },
    );
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI writes pass through the governed memory admission policy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-write-policy-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    await assert.rejects(
      service.invoke("remember", {
        statement: "The API key is sk-secret-value-that-must-not-be-stored.",
        nodeName: "Credentials",
        memoryType: "fact",
      }),
      { code: "WRITE_REJECTED" },
    );
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unbuilt optional embedding index degrades without blocking lexical search", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-degraded-"));
  const service = new NmgService({
    databasePath: join(directory, "nmg.sqlite"),
    environment: { NMG_EMBED_PROVIDER: "openai" },
  });
  try {
    await service.invoke("remember", {
      statement: "User prefers Chinese explanations.",
      nodeName: "Language preference",
      memoryType: "preference",
    });
    const status = await service.invoke("status");
    assert.equal(status.embedding.configured, true);
    assert.equal(status.embedding.provider, "openai");

    const searched = await service.invoke("search", { query: "Chinese explanations" });
    assert.equal(searched.results.length, 1);
    assert.equal(searched.retrieval?.mode, "lexical");
    assert.equal(searched.retrieval?.reason, "embedding_index_not_ready");
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
