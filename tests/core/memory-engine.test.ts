import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openMemoryBackend } from "../../src/core/memory/open.ts";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

test("SQLite hybrid search scores both sides of the union within the read scope", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-hybrid-union-"));
  const backend = await openMemoryBackend({
    kind: "sqlite",
    path: join(directory, "memory.sqlite"),
    namespace: "test",
  });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(directory);
  });
  const engine = new MemoryEngine(backend);
  const lexical = await engine.remember({ statement: "orchid", nodeName: "Plants" });
  const vector = await engine.remember({
    statement:
      "orchid with exceptionally long inflorescences that flower in the middle of the season",
    nodeName: "Plants",
  });
  const privateRecord = await engine.remember({
    statement: "orchid in the private collection",
    nodeName: "Plants",
    residence: "stg",
    sessionId: "private",
  });
  const semantic = { indexId: "test-model", vector: [1, 0], mode: "hybrid" } as const;
  const vectors = new Map([
    [lexical.memory.id, [0.6, 0.8]],
    [vector.memory.id, [1, 0]],
    [privateRecord.memory.id, [1, 0]],
  ]);
  const documents = backend.vectorIndex!.pending(semantic.indexId, 3);
  assert.equal(documents.length, 3);
  backend.vectorIndex!.save(
    semantic.indexId,
    documents,
    documents.map(({ id }) => vectors.get(id)!),
  );

  const view = await backend.openRead();
  try {
    const query = { kind: "memory", text: "orchid", limit: 1 } as const;
    const page = backend.hybridCandidates!(view, query, semantic);
    const expanded = backend.hybridCandidates!(view, { ...query, limit: 3 }, semantic);
    assert.deepEqual(page.lexicalIds, [lexical.memory.id]);
    assert.deepEqual(page.vectorIds, [vector.memory.id]);
    const actual = new Map(
      page.candidates.map(({ entity, bm25, recordScore }) => [
        entity.value.id,
        [bm25, recordScore],
      ]),
    );
    assert.equal(actual.size, 2);
    for (const { entity, bm25, recordScore } of expanded.candidates) {
      assert.ok(bm25 > 0 && recordScore > 0);
      assert.deepEqual(actual.get(entity.value.id), [bm25, recordScore]);
    }
  } finally {
    await backend.closeRead(view);
  }

  const result = await engine.search("orchid", { limit: 2 }, semantic);
  assert.deepEqual(
    result.results.map(({ memory }) => memory.id),
    [vector.memory.id, lexical.memory.id],
  );
  assert.ok(result.results[0]!.combinedScore > result.results[1]!.combinedScore);
  assert.equal(result.results[0]!.evidence.id, vector.history.id);
});

for (const kind of ["sqlite", "lancedb"] as const) {
  test(`${kind}: engine preserves evidence, replacement, graph access, privacy and replay`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `nmg-engine-${kind}-`));
    const backend = await openMemoryBackend(
      kind === "sqlite"
        ? { kind, path: join(directory, "memory.sqlite"), namespace: "tenant" }
        : { kind, uri: join(directory, "objects"), namespace: "tenant" },
    );
    const engine = new MemoryEngine(backend);
    try {
      assert.equal((await engine.search("nothing yet")).results.length, 0);
      const input = {
        statement: "Atlas deployment region is eu-west",
        nodeName: "Atlas",
        memoryType: "state" as const,
        stateKey: "region",
        scope: { project: "atlas" },
        evidence: "The deployment uses eu-west.",
      };
      const first = await engine.remember(input, "first");
      const replay = await engine.remember(input, "first");
      assert.equal(replay.memory.id, first.memory.id);
      await assert.rejects(
        engine.remember({ ...input, statement: "different" }, "first"),
        /different content/,
      );
      const duplicate = await engine.remember(input, "duplicate");
      assert.equal(duplicate.memory.id, first.memory.id);
      const supplied = {
        actor: "user",
        sourceMessageId: "source-1",
        content: "Original excerpt",
      } as const;
      const capture = (statement: string, content = supplied.content as string) =>
        engine.remember({
          statement,
          nodeName: "Attribution",
          evidenceSource: { ...supplied, content },
        });
      const captured = await capture("Atlas publishes build artifacts");
      const recaptured = await capture("Atlas retains build artifacts for 90 days");
      assert.equal(recaptured.history.id, captured.history.id);
      await assert.rejects(
        capture("Atlas archives build artifacts", "Different excerpt"),
        /different content/,
      );
      const next = await engine.remember(
        { ...input, statement: "Atlas deployment region is us-east" },
        "next",
      );
      assert.equal(next.memory.supersedesId, first.memory.id);
      assert.equal((await engine.get([first.memory.id])).results.length, 0);
      assert.equal(
        (await engine.get([next.memory.id])).results[0]?.evidence.content,
        input.evidence,
      );
      assert.equal((await engine.search("deployment")).results.length, 1);
      const other = await engine.remember(
        { statement: "Operational backup policy", nodeName: "Operations" },
        "other",
      );
      await engine.linkNodes(
        { sourceNodeId: next.node.id, targetNodeId: other.node.id, type: "related_to" },
        "edge",
      );
      assert.equal((await engine.search("deployment", { graphHops: 1 })).results.length, 2);
      await engine.remember(
        {
          statement: "Private rollout note",
          nodeName: "Private",
          residence: "stg",
          sessionId: "owner",
        },
        "private",
      );
      assert.equal((await engine.search("Private")).results.length, 0);
      assert.equal((await engine.search("Private", { sessionId: "other" })).results.length, 0);
      assert.equal((await engine.search("Private", { sessionId: "owner" })).results.length, 1);
      await engine.withdraw(next.memory.id, "withdraw");
      assert.equal((await engine.search("deployment")).results.length, 0);
      await assert.rejects(
        engine.remember({ ...input, statement: "Atlas deployment region is us-east" }, "next"),
        /withdrawn|unavailable/,
      );
      const privateInput = {
        statement: "Private receipt payload",
        nodeName: "Atlas",
        residence: "stg" as const,
        sessionId: "owner",
      };
      const privateMemory = await engine.remember(privateInput, "private-receipt");
      assert.notEqual(privateMemory.node.id, first.node.id);
      const derived = await engine.remember({
        statement: "The projected capacity is ten",
        nodeName: "Capacity",
        memoryType: "derived",
        sessionId: "owner",
      });
      assert.equal(derived.memory.residence, "stg");
      assert.equal(derived.history.sessionId, "owner");
      assert.equal((await engine.get([derived.memory.id])).results.length, 0);
      assert.equal(
        (await engine.get([derived.memory.id], { sessionId: "owner" })).results.length,
        1,
      );
      await assert.rejects(
        engine.remember({
          statement: "Builds use pinned dependencies",
          nodeName: "Build",
          evidenceSource: {
            actor: "assistant",
            sourceMessageId: "m1",
            content: "Pinned dependencies",
          },
        }),
        /does not match sourceActor/,
      );
      await assert.rejects(
        engine.remember({
          statement: "Public evidence reuse",
          nodeName: "Public",
          sessionId: "owner",
          evidenceHistoryId: privateMemory.history.id,
        }),
        /Evidence/,
      );
      await assert.rejects(
        engine.linkNodes({
          sourceNodeId: next.node.id,
          targetNodeId: other.node.id,
          type: "related_to",
          evidenceIds: [privateMemory.history.id],
        }),
        /evidence/,
      );
      await engine.withdraw(privateMemory.memory.id, "private-withdraw", "owner");
      await assert.rejects(engine.remember(privateInput, "private-receipt"), /unavailable/);
      await assert.rejects(
        engine.remember({ statement: "api_key=supersecretvalue", nodeName: "Secrets" }, "secret"),
        /secret/,
      );
      await assert.rejects(
        engine.remember({ statement: "api_key=supersecretvalue", nodeName: "Secrets" }, "secret"),
        /secret/,
      );
      const auditReader = await backend.openRead();
      try {
        const audit = await backend.scan(auditReader, { kind: "writeEvent" });
        assert.equal(
          audit.filter(
            (entity) => entity.kind === "writeEvent" && entity.value.decision === "rejected",
          ).length,
          1,
        );
        assert.ok(
          audit.some(
            (entity) => entity.kind === "writeEvent" && entity.value.memoryId === first.memory.id,
          ),
        );
        assert.doesNotMatch(JSON.stringify(audit), /supersecretvalue/);
      } finally {
        await backend.closeRead(auditReader);
      }
      await assert.rejects(
        engine.rememberMany(
          [
            { statement: "Must not land", nodeName: "Atomic" },
            { statement: "Invalid state", nodeName: "Atomic", memoryType: "state" },
          ],
          "invalid-batch",
        ),
        /stateKey/,
      );
      assert.equal((await engine.search("land")).results.length, 0);
    } finally {
      await backend.close();
      removeTempDirectory(directory);
    }
  });
}

test("SQLite search uses caller now for today windows, due-today reminders, and Top-1 zero-overlap neighbors", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-engine-temporal-now-"));
  const backend = await openMemoryBackend({
    kind: "sqlite",
    path: join(directory, "memory.sqlite"),
    namespace: "temporal-test",
  });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(directory);
  });

  const engine = new MemoryEngine(backend);
  // 1) Today window: exact literal "韩阿姨今天" in old turn vs today's event without "今天"
  const oldLiteral = await engine.remember({
    statement: "小满，中午好。韩阿姨今天回来了，一进门我就闻见腌萝卜味儿",
    nodeName: "Chat Oct 15",
    eventTime: "2026-10-15T04:00:00.000Z",
    evidenceSource: {
      actor: "user",
      sourceMessageId: "10",
      content: "韩阿姨今天回来了",
    },
    sessionId: "s1",
    residence: "stg",
  });
  const todayTurn = await engine.remember({
    statement: "韩阿姨上午打扫时悄悄预支了工钱",
    nodeName: "Chat Oct 30",
    eventTime: "2026-10-30T03:00:00.000Z",
    evidenceSource: {
      actor: "user",
      sourceMessageId: "20",
      content: "韩阿姨上午打扫时悄悄预支了工钱",
    },
    sessionId: "s1",
    residence: "stg",
  });
  const nextZeroOverlap = await engine.remember({
    statement: "四千八百元刚好给儿子办婚事",
    nodeName: "Chat Oct 30 follow",
    sourceActor: "assistant",
    eventTime: "2026-10-30T03:05:00.000Z",
    evidenceSource: {
      actor: "assistant",
      sourceMessageId: "21",
      content: "四千八百元刚好给儿子办婚事",
    },
    sessionId: "s1",
    residence: "stg",
  });

  // 2) Due today: 10-03 promise due on 10-06 (Tuesday)
  const duePromise = await engine.remember({
    statement: "约好下周二去老周修车摊换黄铜车铃",
    nodeName: "Errand Oct 03",
    eventTime: "2026-10-03T02:00:00.000Z",
  });
  const filler = await engine.rememberMany(
    Array.from({ length: 12 }, (_, index) => ({
      statement: `阳台日常记录编号 ${index}`,
      nodeName: `Filler ${index}`,
      eventTime: "2026-10-05T02:00:00.000Z",
    })),
  );

  // Without caller `now` for Oct 30, lexical literal match ranks Oct 15 first.
  const withoutNow = await engine.search("我想把韩阿姨今天跟我说的事记进备忘录", {
    sessionId: "s1",
    now: "2026-11-22T12:00:00+08:00",
  });
  assert.equal(withoutNow.results[0]?.memory.id, oldLiteral.memory.id);

  // With `now = 2026-10-30T13:39:00+08:00`, Oct 30 event takes Top-1.
  const withNow = await engine.search("我想把韩阿姨今天跟我说的事记进备忘录", {
    sessionId: "s1",
    now: "2026-10-30T13:39:00+08:00",
  });
  assert.equal(withNow.results[0]?.memory.id, todayTurn.memory.id);

  // Hybrid mode with expandSourceContext + limit >= 10 appends Top-1's zero-overlap next turn.
  const allDocs = backend.vectorIndex!.pending("stub", 32);
  backend.vectorIndex!.save(
    "stub",
    allDocs,
    allDocs.map((doc) => {
      if (doc.id === todayTurn.memory.id) return [1, 0];
      if (doc.id === nextZeroOverlap.memory.id) return [0, 1];
      if (doc.id === duePromise.memory.id) return [0, 1];
      return filler.some((item) => item.memory.id === doc.id) ? [0.2, 0.9] : [0.5, 0.5];
    }),
  );
  const neighborExpanded = await engine.search(
    "我想把韩阿姨今天跟我说的事记进备忘录",
    {
      sessionId: "s1",
      now: "2026-10-30T13:39:00+08:00",
      limit: 10,
      expandSourceContext: true,
    },
    { indexId: "stub", vector: [1, 0], mode: "hybrid" },
  );
  assert.equal(neighborExpanded.results[0]?.memory.id, todayTurn.memory.id);
  const appendedZeroOverlap = neighborExpanded.results.find(
    (item) => item.memory.id === nextZeroOverlap.memory.id,
  );
  assert.equal(appendedZeroOverlap?.neighborhood, "next_turn");

  // Due-today scan surfaces Oct 03's "下周二" commitment when now is Oct 06, even with unrelated query.
  const dueFound = await engine.search("昨晚雨下得久", {
    now: "2026-10-06T08:00:00+08:00",
    dueReminders: true,
  });
  const dueHit = dueFound.results.find((item) => item.memory.id === duePromise.memory.id);
  assert.equal(dueHit?.neighborhood, "due_today");

  const dueDisabled = await engine.search("昨晚雨下得久", {
    now: "2026-10-06T08:00:00+08:00",
  });
  assert.ok(!dueDisabled.results.some((item) => item.memory.id === duePromise.memory.id));
});
