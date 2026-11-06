import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openMemoryBackend } from "../../src/core/memory/open.ts";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

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
