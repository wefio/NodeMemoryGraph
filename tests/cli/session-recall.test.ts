import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgService } from "../../src/cli/service.ts";
import { NmgStore } from "../../src/core/store.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

async function fixture(run: (service: NmgService, directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "nmg-session-recall-rpc-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    await run(service, directory);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function enable(service: NmgService, sessionId = "trial") {
  return service.invoke("lab", {
    action: "enable",
    capability: "recall_gate",
    sessionId,
    requester: "agent:fixture",
    reason: "session-only pilot",
    ttlSeconds: 60,
  });
}

async function prepare(service: NmgService, projectDir: string, prompt = "Apply palette 老规矩") {
  const result = await service.invoke("sessionActiveGraph", {
    action: "beginDisclosureTurn",
    sessionId: "trial",
    recall: { prompt, projectDir, scheduled: false },
  });
  assert.equal(result.action, "beginDisclosureTurn");
  if (result.action !== "beginDisclosureTurn") throw new Error("expected turn preparation");
  return result.sessionRecall;
}

async function correct(service: NmgService, revision: number) {
  return service.invoke("lab", {
    action: "invoke",
    capability: "recall_gate",
    sessionId: "trial",
    operation: "correct",
    input: {
      revision,
      phrase: "老规矩",
      reason: "The current query needs a past palette preference.",
    },
  });
}

// Contract: an explicit session lease, not a new resident model or permanent rule store.
test("session recall pilot is discoverable and self-service only within a session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-session-recall-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const result = await service.invoke("lab", { action: "list" });
    assert.equal(result.action, "list");
    if (result.action !== "list") throw new Error("expected Lab discovery");
    const capability = result.capabilities.find((item) => String(item.id) === "recall_gate");
    assert.ok(capability, "session recall pilot must have an explicit discoverable lease");
    assert.equal(capability.agentMayEnable, true);
    assert.deepEqual(capability.supportedScopes, ["session"]);
    assert.deepEqual(capability.operations, ["prepare", "correct", "list", "remove", "clear"]);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit lexical rescue and intent correction affect only later trial entry decisions", async () => {
  await fixture(async (service, directory) => {
    const store = new NmgStore(join(directory, "nmg.sqlite"));
    const saved = store.remember({
      statement: "Fixture palette prefers azure",
      nodeName: "fixture-palette",
      memoryType: "preference",
      tier: 0,
      recallTriggers: ["老规矩"],
      sourceActor: "assistant",
      truthStatus: "unverified",
    });
    store.close();
    assert.equal(await prepare(service, directory), undefined, "off by default");
    await assert.rejects(correct(service, 1), /not enabled/u);
    await enable(service);
    const initial = await prepare(service, directory);
    assert.equal(initial?.status, "skipped");
    const rescue = await service.invoke("search", {
      query: "palette azure",
      projectDir: directory,
      sessionId: "trial",
      retrievalMode: "fts5",
      persistTrace: false,
      limit: 5,
      graphHops: 0,
    });
    assert.ok(rescue.results.some((result) => result.memory.id === saved.memory.id));
    await correct(service, initial!.revision);
    const next = await prepare(service, directory, "Use palette 老规矩");
    assert.equal(next?.status, "hint");
    assert.equal(next?.decision.limit, 5);
    assert.equal(next?.decision.graphHops, 0);
    const learned = await service.invoke("lab", {
      action: "invoke",
      capability: "recall_gate",
      sessionId: "trial",
      operation: "list",
    });
    assert.equal(learned.action, "invoke");
    if (learned.action === "invoke") assert.equal((learned.output as unknown[]).length, 1);
    await service.invoke("lab", {
      action: "invoke",
      capability: "recall_gate",
      sessionId: "trial",
      operation: "remove",
      input: { phrase: "老规矩" },
    });
    assert.equal((await prepare(service, directory))?.status, "skipped");
  });
});

test("disabled, renewed and released sessions cannot inherit cached rules; hints create no database", async () => {
  await fixture(async (service, directory) => {
    await enable(service);
    await correct(service, (await prepare(service, directory))!.revision);
    await service.invoke("lab", {
      action: "disable",
      capability: "recall_gate",
      sessionId: "trial",
    });
    assert.equal(await prepare(service, directory), undefined);
    await enable(service);
    assert.equal((await prepare(service, directory))?.status, "skipped");
    await correct(service, (await prepare(service, directory))!.revision);
    await enable(service);
    assert.equal((await prepare(service, directory))?.status, "skipped", "renewal starts empty");
    await correct(service, (await prepare(service, directory))!.revision);
    await service.invoke("sessionActiveGraph", { action: "release", sessionId: "trial" });
    assert.equal(await prepare(service, directory), undefined);
    await enable(service);
    assert.equal((await prepare(service, directory))?.status, "skipped");
    assert.equal(existsSync(join(directory, "nmg.sqlite")), false);
  });
});

test("lease expiry rejects correction and reactivation starts without old cues", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await fixture(async (service, directory) => {
    await enable(service);
    const captured = (await prepare(service, directory))!;
    await correct(service, captured.revision);
    t.mock.timers.tick(60_001);
    await assert.rejects(correct(service, captured.revision), /not enabled/u);
    assert.equal(await prepare(service, directory), undefined);
    await enable(service);
    assert.equal((await prepare(service, directory))?.status, "skipped");
  });
});

test("the lifecycle-neutral prepare operation is shared by RPC tool clients", async () => {
  await fixture(async (service, directory) => {
    const observe = () =>
      service.invoke("sessionActiveGraph", {
        action: "beginDisclosureTurn",
        sessionId: "trial",
      });
    assert.equal("recallGateActive" in (await observe()), false);
    await enable(service);
    const handshake = await observe();
    if (handshake.action !== "beginDisclosureTurn") throw new Error("expected turn");
    assert.equal(handshake.recallGateActive, true);
    assert.equal(handshake.sessionRecall, undefined);
    await assert.rejects(correct(service, 1), /revision/u);
    const result = await service.invoke("lab", {
      action: "invoke",
      capability: "recall_gate",
      sessionId: "trial",
      operation: "prepare",
      input: { prompt: "Apply palette 老规矩", projectDir: directory },
    });
    if (result.action !== "invoke") throw new Error("expected prepare output");
    const captured = result.output as { revision: number; status: string };
    assert.equal(captured.status, "skipped");
    await correct(service, captured.revision);
    assert.equal((await prepare(service, directory))?.status, "hint");
  });
});
