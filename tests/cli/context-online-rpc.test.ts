import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgService } from "../../src/cli/service.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

// In-process NmgService inherits process.env; keep recall lexical (test-env.ts).
stripProviderEnv();

test("recordFeedback is exposed on the RPC catalog", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-context-online-catalog-"));
  const service = new NmgService({
    databasePath: join(directory, "nmg.sqlite"),
    dataDirectory: directory,
    environment: {},
  });
  try {
    const hello = await service.invoke("hello");
    assert.ok(hello.methods?.includes("recordFeedback"));
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});

test("any disclosure search stages; internal probes do not; feedback trains only the graph it names", async () => {
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

    // An explicit (model-invoked nmg_search-style) search surfaced a disclosure
    // graph, so it IS stageable: the ask is allowed on every recall, and its
    // feedback names the graph that was actually shown.
    const plain = await service.invoke("search", { query: "lazy stdlib" });
    const plainId = plain.activeGraph?.id;
    assert.ok(plainId);
    const plainFb = await service.invoke("recordFeedback", {
      activeGraphId: plainId,
      evidenceSufficient: true,
    });
    assert.equal(plainFb.trained, true);
    assert.equal(plainFb.reward, 0.6);
    assert.ok(existsSync(join(directory, "context-router-online.json")));

    // An internal probe opts out via persistTrace:false; its graph must not be
    // staged, so feedback on it cannot train.
    const probe = await service.invoke("search", {
      query: "lazy stdlib",
      persistTrace: false,
    });
    const probeId = probe.activeGraph?.id;
    assert.ok(probeId);
    const probeFb = await service.invoke("recordFeedback", {
      activeGraphId: probeId,
      evidenceSufficient: true,
    });
    assert.equal(probeFb.trained, false);

    // Feedback for a foreign/unknown graph is best-effort and never throws.
    const foreign = await service.invoke("recordFeedback", {
      activeGraphId: "not-a-staged-graph",
      evidenceSufficient: true,
    });
    assert.equal(foreign.trained, false);

    // No latest-staged fallback: feedback without an explicit activeGraphId is
    // skipped rather than bound to whatever was staged most recently.
    const unresolved = await service.invoke("recordFeedback", {
      sessionId: "session-online",
      noMemoryNeeded: true,
    });
    assert.equal(unresolved.trained, false);
    assert.equal(unresolved.activeGraphId, null);
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
