import { stripProviderEnv } from "../helpers/test-env.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { NmgService } from "../../src/cli/service.ts";
import { NmgStore } from "../../src/core/store.ts";
import { answerAttributionReferences } from "../../src/core/feedback.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

stripProviderEnv();

test("versioned native answer attribution enforces owner and statement version without evidence promotion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-versioned-answer-"));
  const path = join(directory, "nmg.sqlite");
  const service = new NmgService({ databasePath: path, environment: {} });
  try {
    const saved = await service.invoke("remember", {
      statement: "Atlas archival backups use cobalt mirrors.",
      nodeName: "Atlas",
    });
    const context = await service.invoke("search", {
      query: "Atlas archival backups",
      sessionId: "owner",
    });
    const params = {
      activeGraphId: context.activeGraph!.id,
      sessionId: "owner",
      attributedMemoryIds: [],
      answerText: "The backup strategy relies on cobalt mirrors.",
      memoryVersions: answerAttributionReferences(context.results),
    };
    const result = await service.invoke("recordActiveGraphAttribution", params);
    assert.deepEqual(result.attributedMemoryIds, [saved.memory.id]);
    const store = new NmgStore(path);
    try {
      const trace = store.retrievalTrace(context.activeGraph!.traceIds![0]!, "owner")!;
      assert.deepEqual(trace.attributedMemoryIds, [saved.memory.id]);
      assert.deepEqual(trace.usefulMemoryIds, []);
      assert.deepEqual(trace.contradictedMemoryIds, []);
    } finally {
      store.close();
    }
    await assert.rejects(
      service.invoke("recordActiveGraphAttribution", { ...params, sessionId: "other" }),
      /projection|session/,
    );
    const stale = await service.invoke("recordActiveGraphAttribution", {
      ...params,
      memoryVersions: [{ memoryId: saved.memory.id, statementHash: "0".repeat(64) }],
    });
    assert.deepEqual(stale.attributedMemoryIds, []);
    await assert.rejects(
      service.invoke("recordActiveGraphAttribution", { ...params, memoryVersions: undefined }),
      /memoryVersions/,
    );
    await assert.rejects(
      service.invoke("recordActiveGraphAttribution", {
        ...params,
        attributedMemoryIds: [saved.memory.id],
      }),
      /empty/,
    );
  } finally {
    await service.close();
    removeTempDirectory(directory);
  }
});
