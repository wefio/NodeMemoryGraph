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
