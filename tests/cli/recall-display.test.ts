import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NmgService } from "../../src/cli/service.ts";
import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { SqliteMemoryBackend } from "../../src/core/memory/sqlite-backend.ts";
import { compactSearchContext } from "../../src/integration/search-projection.ts";
import { prepareAutomaticRecallSurface } from "../../src/integration/agent-surface.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();
test("lexical automatic recall keeps candidate membership across display modes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-recall-display-"));
  const service = new NmgService({ dataDirectory: dir, environment: {} });
  try {
    await service.invoke("remember", {
      statement: "philosophy freedom responsibility ".repeat(30),
      nodeName: "Philosophy",
      sourceActor: "user",
    });
    await service.invoke("sessionActiveGraph", {
      action: "beginDisclosureTurn",
      sessionId: "s",
      projectDir: dir,
      prompt: "Discuss philosophy and freedom",
    });
    const params = {
      query: "philosophy freedom",
      sessionId: "s",
      projectDir: dir,
      limit: 20,
      retrievalMode: "fts5",
      persistTrace: false,
    };
    const brief = await service.invoke("search", { ...params, autoRecall: true });
    assert.equal(brief.recallDisplayMode, "compact");
    assert.ok(brief.results.length > 0);
    assert.deepEqual(
      await service.invoke("sessionActiveGraph", {
        action: "recallDisplay",
        sessionId: "s",
        mode: "full",
      }),
      { action: "recallDisplay", mode: "full" },
    );
    const full = await service.invoke("search", { ...params, autoRecall: true });
    assert.equal(full.recallDisplayMode, "full");
    assert.deepEqual(
      full.results.map((r) => r.memory.id),
      brief.results.map((r) => r.memory.id),
    );
    assert.ok(
      prepareAutomaticRecallSurface(compactSearchContext(full)).text.length >
        prepareAutomaticRecallSurface(compactSearchContext(brief)).text.length,
    );
    assert.equal((await service.invoke("search", params)).recallDisplayMode, undefined);
    await assert.rejects(
      service.invoke("sessionActiveGraph", {
        action: "recallDisplay",
        sessionId: "s",
        mode: "invalid",
      }),
      /mode/,
    );
    await service.invoke("sessionActiveGraph", { action: "release", sessionId: "s" });
    assert.deepEqual(
      await service.invoke("sessionActiveGraph", { action: "recallDisplay", sessionId: "s" }),
      { action: "recallDisplay", mode: "compact" },
    );
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compact automatic recall returns the fused order through the shared daemon search", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-economy-ranking-"));
  const path = join(dir, "nmg.sqlite");
  const namespace = "economy-ranking";
  const environment = {
    NMG_EMBED_PROVIDER: "gemini",
    NMG_EMBED_API_KEY: "fixture-only",
    NMG_EMBED_BASE_URL: "https://economy-ranking.test/v1beta",
  };
  const queryBatches: number[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    assert.ok(url.startsWith("https://economy-ranking.test/"));
    const { requests } = JSON.parse(String(init?.body)) as {
      requests: Array<{ taskType: string }>;
    };
    if (requests.every(({ taskType }) => taskType === "RETRIEVAL_QUERY")) {
      queryBatches.push(requests.length);
    }
    return Response.json({ embeddings: requests.map(() => ({ values: [1, 0] })) });
  });
  const scope = { project: "atlas" };
  const backend = new SqliteMemoryBackend(path, namespace);
  const [lexical, agreement] = await (async () => {
    try {
      backend.activateLocal();
      const records = await new MemoryEngine(backend).rememberMany([
        { statement: "The raven cobalt label is temporary.", nodeName: "Labels", scope },
        { statement: "The cobalt samples are stored securely.", nodeName: "Samples", scope },
        {
          statement: "The raven cobalt answer is in a different project.",
          nodeName: "Other project",
          scope: { project: "boreal" },
        },
      ]);
      const indexId = createEmbeddingClientFromEnv(environment)!.indexId;
      backend.vectorIndex.save(
        indexId,
        records.map(({ memory }) => ({
          id: memory.id,
          statement: memory.statement,
          text: memory.statement,
        })),
        [
          [0, 1],
          [0.4, Math.sqrt(0.84)],
          [1, 0],
        ],
      );
      return records.map(({ memory }) => memory.id);
    } finally {
      await backend.close();
    }
  })();
  const service = new NmgService({
    databasePath: path,
    environment,
    memoryBackend: { kind: "sqlite", namespace, local: true },
  });
  t.after(async () => {
    await service.close();
    removeTempDirectory(dir);
  });

  const params = {
    query: "raven cobalt",
    sessionId: "s",
    scope,
    limit: 2,
    graphHops: 0,
    persistTrace: false,
  };
  const ids = (response: Awaited<ReturnType<typeof search>>) =>
    response.results.map(({ memory }) => memory.id);
  const search = (extra: { autoRecall?: boolean; retrievalMode?: "fts5" }) =>
    service.invoke("search", { ...params, ...extra });
  const compact = await search({ autoRecall: true });
  assert.equal(compact.recallDisplayMode, "compact");
  assert.equal(compact.retrieval?.mode, "hybrid");
  assert.deepEqual(ids(compact), [agreement, lexical]);
  assert.deepEqual(compact.activeGraph?.memoryIds, [agreement, lexical]);
  assert.deepEqual(
    prepareAutomaticRecallSurface(compactSearchContext(compact)).included.map(({ source }) =>
      source.kind === "memory" ? source.memoryId : undefined,
    ),
    [agreement, lexical],
  );
  assert.deepEqual(ids(await search({})), [lexical, agreement]);
  assert.deepEqual(ids(await search({ autoRecall: true, retrievalMode: "fts5" })), [
    lexical,
    agreement,
  ]);

  await service.invoke("sessionActiveGraph", {
    action: "recallDisplay",
    sessionId: "s",
    mode: "full",
  });
  assert.deepEqual(ids(await search({ autoRecall: true })), [lexical, agreement]);
  assert.deepEqual(queryBatches, [1, 1, 1]);
});
