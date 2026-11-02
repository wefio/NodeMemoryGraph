import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NmgService } from "../../src/cli/service.ts";
import { compactSearchContext } from "../../src/integration/search-projection.ts";
import { prepareAutomaticRecallSurface } from "../../src/integration/agent-surface.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();
test("daemon-local mode changes presentation but neither explicit search nor candidate membership", async () => {
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
