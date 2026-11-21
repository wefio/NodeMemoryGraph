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
import {
  prepareAutomaticRecallSurface,
  renderEvidenceSurface,
} from "../../src/integration/agent-surface.ts";
import { createSearchTool } from "../../src/integration/search-tool.ts";
import type { AdapterToolSession } from "../../src/integration/adapter-tool-session.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

test("a complete profile joins every statement to its exact evidence and keeps current backlinks", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-profile-provenance-"));
  const service = new NmgService({ dataDirectory: dir, environment: {} });
  t.after(async () => {
    await service.close();
    removeTempDirectory(dir);
  });
  const scope = { profile: "user" };
  const evidenceSource = {
    actor: "user",
    sourceMessageId: "fixture:user:weekend",
    content: "On weekends, I want time to finish a walk before we plan the rest of the day.",
  } as const;
  const profileStatement =
    "Give me time for a walk on weekends, then discuss the schedule. ".repeat(8) +
    "Keep the morning flexible.";
  const {
    results: [source, profile, constraint],
  } = await service.invoke("rememberBatch", {
    items: [
      {
        nodeName: "Weekend conversation",
        statement: "The user discussed weekends.",
        evidenceSource,
      },
      {
        statement: profileStatement,
        nodeName: "Weekend preference",
        scope,
        memoryType: "preference",
        sourceActor: "user",
        evidenceSource,
      },
      {
        statement: "Keep overnight trips out of weekday itineraries.",
        nodeName: "Travel constraint",
        scope,
        memoryType: "constraint",
        sourceActor: "user",
        tier: 3,
      },
      ...Array.from({ length: 22 }, (_, index) => ({
        statement: `I prefer edition ${index} of the fixture reading list.`,
        nodeName: `Reading preference ${index}`,
        scope,
        memoryType: "preference" as const,
        sourceActor: "user" as const,
      })),
    ],
  });
  assert.ok(source && profile && constraint);
  assert.equal(source.history.id, profile.history.id);

  const listing = { query: "*", scope, limit: 2, sessionId: "profile-review" };
  const view = await service.invoke("search", listing);
  assert.equal(view.userProfile?.length, 24);
  assert.equal(compactSearchContext(view).userProfile?.length, 24);
  const named = view.userProfile?.find(({ memoryId }) => memoryId === profile.memory.id);
  assert.ok(named);
  assert.equal(named.statement, profileStatement);
  assert.deepEqual(named.evidenceIds, [source.history.id]);
  const get = (memoryId: string) => service.invoke("get", { memoryIds: [memoryId] });
  const resolved = await get(named.memoryId);
  assert.equal(resolved.results[0]?.evidence.content, evidenceSource.content);
  const original = await get(source.memory.id);
  assert.deepEqual(original.results[0]?.profileEvidence, [
    { evidenceId: source.history.id, profileMemoryIds: [profile.memory.id] },
  ]);
  assert.match(renderEvidenceSurface(original), /\[profile evidence\]/u);

  const session = {
    sessionId: "profile-review",
    requester: "profile-review",
    invoke: async (method, params) => {
      assert.equal(method, "search");
      return service.invoke("search", params);
    },
    memory: {
      search: {
        defaultTier: 0,
        allocate: () => {
          throw new Error("profile catalog must not allocate a recall budget");
        },
        fold: () => {
          throw new Error("profile catalog must not fold entries");
        },
      },
    },
  } satisfies AdapterToolSession;
  const shown = await createSearchTool(true).execute({ query: "*", scope }, session);
  assert.match(shown.text, /Preferences/u);
  assert.match(shown.text, /Constraints/u);
  assert.ok(shown.text.includes(profileStatement));
  assert.ok(shown.text.includes(constraint.memory.statement));
  assert.ok(shown.text.includes(profile.memory.id));

  await service.invoke("deleteMemory", { memoryId: profile.memory.id });
  assert.equal((await get(source.memory.id)).results[0]?.profileEvidence, undefined);
  assert.equal((await service.invoke("search", listing)).userProfile?.length, 23);
});

test("the local user profile admits only current personal records and spends at most one automatic slot", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-user-profile-"));
  const service = new NmgService({ dataDirectory: dir, environment: {} });
  t.after(async () => {
    await service.close();
    removeTempDirectory(dir);
  });
  const scope = { profile: "user" };
  const common = { scope, memoryType: "preference", sourceActor: "user" } as const;
  const [first, second, manual, regular] = (
    await service.invoke("rememberBatch", {
      items: [
        {
          ...common,
          nodeName: "Weekend pace",
          statement: "On weekend plans, I prefer nature walks. " + "🌿".repeat(145),
          recallTriggers: ["weekend plans"],
        },
        {
          ...common,
          nodeName: "Rest time",
          statement: "For weekend plans I prefer a slow start.",
          recallTriggers: ["weekend"],
        },
        {
          ...common,
          nodeName: "Reading preference",
          statement: "I prefer hardcover books.",
        },
        {
          nodeName: "Nature trail map",
          statement: "The nature trail map is available each weekend.",
        },
        {
          ...common,
          nodeName: "Sensitive fixture",
          statement: "I prefer the orange mug during weekend plans.",
          markers: [{ kind: "sensitive" }],
          recallTriggers: ["weekend plans"],
        },
        {
          ...common,
          nodeName: "Assistant guess",
          statement: "The user probably prefers canoeing on weekend plans.",
          truthStatus: "inferred",
          recallTriggers: ["weekend plans"],
        },
        {
          ...common,
          nodeName: "Withdrawn fixture",
          statement: "I prefer the blue mug during weekend plans.",
          markers: [{ kind: "forget" }],
          recallTriggers: ["weekend plans"],
        },
      ],
    })
  ).results.map(({ memory }) => memory.id);
  const ids = ({ results }: Awaited<ReturnType<typeof listing>>) =>
    results.map(({ memory }) => memory.id);
  const listing = () => service.invoke("search", { query: "*", scope, sessionId: "profile-test" });
  const automatic = (query: string, extra = {}) =>
    service.invoke("search", {
      query,
      autoRecall: true,
      sessionId: "profile-test",
      retrievalMode: "fts5",
      ...extra,
    });
  assert.deepEqual(new Set(ids(await listing())), new Set([first, second, manual]));
  assert.ok(ids(await automatic("Show me the nature trail map")).includes(regular!));
  assert.ok(!ids(await automatic("Show me the nature trail map")).includes(first!));
  assert.ok(
    !ids(await automatic("Continue\nRecent task context:\nweekend plans")).includes(first!),
  );
  assert.ok(
    !ids(await automatic("weekend plans", { scope: { project: "test" } })).includes(first!),
  );
  const match = await automatic("Suggest some weekend plans", { limit: 2 });
  assert.equal(ids(match)[0], first);
  assert.ok(!ids(match).includes(second!));
  assert.ok(ids(match).length <= 2);
  assert.deepEqual(match.activeGraph?.memoryIds, ids(match));
  const full = await service.invoke("sessionActiveGraph", {
    action: "recallDisplay",
    sessionId: "profile-test",
    mode: "full",
  });
  assert.deepEqual(full, { action: "recallDisplay", mode: "full" });
  const fullCandidate = compactSearchContext(await automatic("weekend plans")).candidates[0]!;
  assert.equal(fullCandidate.id, first);
  assert.ok(Array.from(fullCandidate.preview).length <= 120);
  const rendered = prepareAutomaticRecallSurface(compactSearchContext(match), {
    maxCharacters: 600,
  });
  assert.match(rendered.text, /\[profile\]/u);
  assert.ok(rendered.text.length <= 600);
  const smaller = prepareAutomaticRecallSurface(compactSearchContext(match), {
    maxCharacters: 300,
  });
  assert.doesNotMatch(smaller.text, /\[profile\]/u);
  assert.ok(smaller.text.length <= 300);

  const { memory: updated } = await service.invoke("remember", {
    ...common,
    nodeName: "Weekend pace",
    statement: "On weekend plans, I prefer botanical gardens.",
    recallTriggers: ["weekend plans"],
    supersedesId: first,
  });
  assert.equal(ids(await automatic("weekend plans"))[0], updated.id);
  assert.ok(!ids(await listing()).includes(first!));
  await service.invoke("deleteMemory", { memoryId: updated.id });
  assert.deepEqual(new Set(ids(await listing())), new Set([second, manual]));
  assert.equal(ids(await automatic("weekend plans"))[0], second);
});

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

test("SQLite hybrid ordering is shared by explicit search and both automatic recall modes", async (t) => {
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
          [0.1, Math.sqrt(0.99)],
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
  const search = (extra: { autoRecall?: boolean; retrievalMode?: "fts5" | "hybrid" }) =>
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
  assert.deepEqual(ids(await search({ retrievalMode: "hybrid" })), [agreement, lexical]);
  assert.deepEqual(ids(await search({ autoRecall: true, retrievalMode: "fts5" })), [
    lexical,
    agreement,
  ]);

  await service.invoke("sessionActiveGraph", {
    action: "recallDisplay",
    sessionId: "s",
    mode: "full",
  });
  assert.deepEqual(ids(await search({ autoRecall: true })), [agreement, lexical]);
  assert.deepEqual(queryBatches, [1, 1, 1]);
});
