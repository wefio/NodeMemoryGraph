import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgService } from "../../src/cli/service.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

test("recordFeedback is exposed on the RPC catalog", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-context-online-catalog-"));
  const service = new NmgService({
    databasePath: join(directory, "nmg.sqlite"),
    dataDirectory: directory,
    environment: {},
  });
  try {
    const hello = await service.invoke("hello");
    assert.ok(hello.methods.includes("recordFeedback"));
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("only autoRecall searches stage; recordFeedback trains and persists the shared learner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-context-online-rpc-"));
  const service = new NmgService({
    databasePath: join(directory, "nmg.sqlite"),
    dataDirectory: directory,
    environment: {},
  });
  try {
    await service.invoke("remember", {
      statement: "Lazy dev prefers the standard library over new dependencies",
      nodeName: "lazy rule",
      sourceActor: "user",
    });

    // A plain (explicit nmg_search-style) search is NOT an auto-recall decision:
    // its graph must not be staged, so feedback on it cannot train.
    const plain = await service.invoke("search", { query: "lazy stdlib" });
    const plainId = plain.activeGraph?.id;
    assert.ok(plainId);
    const plainFb = await service.invoke("recordFeedback", {
      activeGraphId: plainId,
      evidenceSufficient: true,
    });
    assert.equal(plainFb.trained, false);

    // An autoRecall search stages its injected graph in the daemon learner.
    const auto = await service.invoke("search", {
      query: "lazy stdlib",
      sessionId: "session-online",
      autoRecall: true,
    });
    const graphId = auto.activeGraph?.id;
    assert.ok(graphId);

    // Feedback for a foreign/unknown graph is best-effort and never throws.
    const foreign = await service.invoke("recordFeedback", {
      activeGraphId: "not-a-staged-graph",
      evidenceSufficient: true,
    });
    assert.equal(foreign.trained, false);

    // A usable label on the staged graph trains one observed-action update.
    const trained = await service.invoke("recordFeedback", {
      activeGraphId: graphId,
      evidenceSufficient: true,
    });
    assert.equal(trained.trained, true);
    assert.equal(trained.reward, 0.6);
    assert.ok(trained.loss !== undefined);
    assert.ok(existsSync(join(directory, "context-router-online.json")));

    // Without an explicit activeGraphId the daemon resolves the session's most
    // recently staged decision (natural-feedback semantics, server-side).
    const auto2 = await service.invoke("search", {
      query: "lazy stdlib",
      sessionId: "session-online",
      autoRecall: true,
    });
    assert.ok(auto2.activeGraph?.id);
    const bySession = await service.invoke("recordFeedback", {
      sessionId: "session-online",
      noMemoryNeeded: true,
    });
    assert.equal(bySession.trained, true);
    assert.equal(bySession.activeGraphId, auto2.activeGraph?.id);
    assert.equal(bySession.reward, -0.2);
    const unresolved = await service.invoke("recordFeedback", {
      sessionId: "session-unknown",
      evidenceSufficient: true,
    });
    assert.equal(unresolved.trained, false);
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("recordFeedback obeys the NMG_CONTEXT_ONLINE_LEARNING=0 opt-out", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-context-online-off-"));
  const service = new NmgService({
    databasePath: join(directory, "nmg.sqlite"),
    dataDirectory: directory,
    environment: { NMG_CONTEXT_ONLINE_LEARNING: "0" },
  });
  try {
    await service.invoke("remember", {
      statement: "Lazy dev prefers the standard library",
      nodeName: "lazy rule",
      sourceActor: "user",
    });
    const auto = await service.invoke("search", {
      query: "lazy stdlib",
      sessionId: "session-off",
      autoRecall: true,
    });
    const graphId = auto.activeGraph?.id;
    assert.ok(graphId);
    const trained = await service.invoke("recordFeedback", {
      activeGraphId: graphId,
      evidenceSufficient: true,
    });
    assert.equal(trained.trained, false);
    assert.equal(existsSync(join(directory, "context-router-online.json")), false);
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});
