import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NMG_PROTOCOL_VERSION } from "../../src/cli/protocol.ts";
import { NmgService } from "../../src/cli/service.ts";

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
