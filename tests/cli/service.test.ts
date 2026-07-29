import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NMG_PROTOCOL_VERSION } from "../../src/cli/protocol.ts";
import { NmgService } from "../../src/cli/service.ts";
import { handleLine } from "../../src/cli/stdio.ts";

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

test("protocol reports structured parse, version, method, and parameter errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-errors-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const malformed = await handleLine(service, "{");
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.error.code, "PARSE_ERROR");

    const mismatch = await service.dispatch({
      protocol: "nmg/0" as typeof NMG_PROTOCOL_VERSION,
      id: 1,
      method: "hello",
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.code, "PROTOCOL_MISMATCH");

    const unknown = await service.dispatch({
      protocol: NMG_PROTOCOL_VERSION,
      id: 2,
      method: "unknown" as "hello",
    });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error.code, "METHOD_NOT_FOUND");

    const invalid = await service.dispatch({
      protocol: NMG_PROTOCOL_VERSION,
      id: 3,
      method: "get",
      params: { memoryIds: [] },
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.code, "INVALID_PARAMS");

    const invalidState = await service.dispatch({
      protocol: NMG_PROTOCOL_VERSION,
      id: 4,
      method: "remember",
      params: {
        statement: "The current version is 2.",
        nodeName: "Current version",
        memoryType: "state",
      },
    });
    assert.equal(invalidState.ok, false);
    if (!invalidState.ok) assert.equal(invalidState.error.code, "INVALID_PARAMS");
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI writes pass through the governed memory admission policy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-write-policy-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const response = await service.dispatch({
      protocol: NMG_PROTOCOL_VERSION,
      id: 1,
      method: "remember",
      params: {
        statement: "The API key is sk-secret-value-that-must-not-be-stored.",
        nodeName: "Credentials",
        memoryType: "fact",
      },
    });
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, "WRITE_REJECTED");
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
