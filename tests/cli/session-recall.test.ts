import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgService } from "../../src/cli/service.ts";
import { NmgStore } from "../../src/core/store.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

async function nativeTurn(service: NmgService, projectDir: string, sessionId = "trial") {
  const result = await service.invoke("sessionActiveGraph", {
    action: "beginDisclosureTurn",
    sessionId,
    projectDir,
  });
  assert.ok(result.action === "beginDisclosureTurn");
  return result.recallGate;
}

// Admission-fence tests inspect learned entries; seed membership is checked separately below.
async function inspectPool(
  service: NmgService,
  operation: "list" | "events" = "list",
  includeSeeds = false,
) {
  const result = await service.invoke("lab", {
    action: "invoke",
    capability: "recall_gate",
    sessionId: "trial",
    operation,
  });
  assert.ok(result.action === "invoke");
  const rows = result.output as Array<{
    phrase: string;
    kind?: string;
    sourceTurn?: number;
    origin?: string;
  }>;
  return includeSeeds ? rows : rows.filter((row) => row.origin !== "seed");
}

// Contract/safety: admission is a weak proposal on an actual search, not an outcome label.
test("native turn returns a small pool snapshot; a normal search piggybacks one literal proposal", async () => {
  await fixture(async (service, directory) => {
    assert.equal(await nativeTurn(service, directory), undefined);
    await enable(service);
    const gate = (await nativeTurn(service, directory))!;
    assert.deepEqual(gate.phrases, []);
    assert.ok(gate.generation > 0 && gate.turn > 0);
    const source = { prompt: "Apply palette 老规矩", generation: gate.generation, turn: gate.turn };
    const result = await service.invoke("search", {
      query: "palette azure",
      sessionId: "trial",
      projectDir: directory,
      retrievalMode: "fts5",
      recallCue: "老规矩",
      recallSource: source,
    });
    assert.doesNotMatch(
      JSON.stringify(result),
      /Apply palette/u,
      "native observation must not enter the retrieval result",
    );
    assert.deepEqual(
      (await inspectPool(service)).map((cue) => cue.phrase),
      ["老规矩"],
    );
    assert.equal((await inspectPool(service, "events"))[0]?.sourceTurn, gate.turn);
    await service.invoke("search", {
      query: "palette",
      sessionId: "trial",
      projectDir: directory,
      retrievalMode: "fts5",
      recallCue: "老规矩",
      recallSource: source,
    });
    assert.equal(
      (await inspectPool(service, "events")).length,
      1,
      "a consumed fence cannot renew a cue",
    );
    assert.deepEqual((await nativeTurn(service, directory))!.phrases, ["老规矩"]);
    assert.equal((await prepare(service, directory))?.status, "hint");
  });
});

test("automatic searches, probes, absent fences and invalid proposals leave normal search usable", async () => {
  await fixture(async (service, directory) => {
    await enable(service);
    const variants = [
      { autoRecall: true },
      { persistTrace: false },
      { recallSource: undefined },
      { sessionId: "other" },
      { recallCue: "not in the source" },
      { recallCue: 12 },
      { recallSource: { prompt: "Apply 老规矩", generation: -1, turn: 1 } },
    ];
    for (const variant of variants) {
      const gate = (await nativeTurn(service, directory))!;
      await service.invoke("search", {
        query: "palette",
        sessionId: "trial",
        projectDir: directory,
        retrievalMode: "fts5",
        recallCue: "老规矩",
        recallSource: { prompt: "Apply 老规矩", generation: gate.generation, turn: gate.turn },
        ...variant,
      });
      assert.deepEqual(await inspectPool(service), []);
    }
    for (const prompt of [
      'Output "老规矩"',
      "翻译老规矩",
      "不用记忆照老规矩",
      "Apply 老规矩 password=fixture-only",
      "你记得老规矩吗？",
    ]) {
      const gate = (await nativeTurn(service, directory))!;
      await service.invoke("search", {
        query: "palette",
        sessionId: "trial",
        projectDir: directory,
        retrievalMode: "fts5",
        recallCue: "老规矩",
        recallSource: { prompt, generation: gate.generation, turn: gate.turn },
      });
      assert.deepEqual(await inspectPool(service), [], prompt);
    }
    assert.deepEqual(await inspectPool(service, "events"), []);
  });
});

test("turn, removal, clear, project and lease generations reject late proposals", async () => {
  await fixture(async (service, directory) => {
    await enable(service);
    const first = (await nativeTurn(service, directory))!;
    const offer = (gate: NonNullable<typeof first>, projectDir = directory) =>
      service.invoke("search", {
        query: "palette",
        sessionId: "trial",
        projectDir,
        retrievalMode: "fts5",
        recallCue: "老规矩",
        recallSource: { prompt: "Apply 老规矩", generation: gate.generation, turn: gate.turn },
      });
    await service.invoke("sessionActiveGraph", { action: "clearDisclosures", sessionId: "trial" });
    const second = (await nativeTurn(service, directory))!;
    assert.notEqual(
      second.turn,
      first.turn,
      "proposal fences do not reuse the reset disclosure clock",
    );
    await offer(first);
    assert.deepEqual(await inspectPool(service), []);
    await offer(second);
    const beforeRemoval = (await nativeTurn(service, directory))!;
    await service.invoke("lab", {
      action: "invoke",
      capability: "recall_gate",
      sessionId: "trial",
      operation: "remove",
      input: { phrase: "老规矩" },
    });
    await offer(beforeRemoval);
    assert.deepEqual(await inspectPool(service), []);
    await offer((await nativeTurn(service, directory))!);
    assert.deepEqual(
      (await inspectPool(service, "events")).map((event) => event.kind),
      ["admitted", "removed", "reintroduced"],
    );
    const beforeClear = (await nativeTurn(service, directory))!;
    await service.invoke("lab", {
      action: "invoke",
      capability: "recall_gate",
      sessionId: "trial",
      operation: "clear",
    });
    await offer(beforeClear);
    assert.deepEqual(await inspectPool(service), []);
    const beforeProject = (await nativeTurn(service, directory))!;
    await offer(beforeProject, join(directory, "other-project"));
    assert.deepEqual(await inspectPool(service), []);
    const beforeRenewal = (await nativeTurn(service, directory))!;
    await enable(service);
    await offer(beforeRenewal);
    assert.deepEqual(await inspectPool(service), []);
    await service.invoke("lab", {
      action: "disable",
      capability: "recall_gate",
      sessionId: "trial",
    });
    await offer(beforeRenewal);
    assert.equal(await nativeTurn(service, directory), undefined);
  });
});

test("explicit clients can piggyback the current preparation revision, but cannot reuse it", async () => {
  await fixture(async (service, directory) => {
    await enable(service);
    const prepared = (await prepare(service, directory))!;
    const params = {
      query: "palette",
      sessionId: "trial",
      projectDir: directory,
      retrievalMode: "fts5",
      recallCue: "老规矩",
      recallRevision: prepared.revision,
    };
    await service.invoke("search", params);
    await service.invoke("search", params);
    assert.equal((await inspectPool(service, "events")).length, 1);
    await service.invoke("lab", {
      action: "invoke",
      capability: "recall_gate",
      sessionId: "trial",
      operation: "clear",
    });
    const otherProject = (await prepare(service, directory))!;
    await service.invoke("search", {
      ...params,
      projectDir: join(directory, "other-project"),
      recallRevision: otherProject.revision,
    });
    assert.deepEqual(
      await inspectPool(service),
      [],
      "a prepared proposal cannot cross a reported project change",
    );
    const stale = (await prepare(service, directory))!;
    await nativeTurn(service, directory);
    await service.invoke("search", { ...params, recallRevision: stale.revision });
    assert.deepEqual(await inspectPool(service), []);
  });
});

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
    assert.deepEqual(capability.operations, [
      "prepare",
      "correct",
      "list",
      "events",
      "remove",
      "clear",
    ]);
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
    if (learned.action === "invoke")
      assert.equal(
        (learned.output as Array<{ origin: string }>).filter((entry) => entry.origin === "learned")
          .length,
        1,
      );
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
    const gate = (await nativeTurn(service, directory))!;
    t.mock.timers.tick(60_001);
    await service.invoke("search", {
      query: "palette",
      sessionId: "trial",
      projectDir: directory,
      retrievalMode: "fts5",
      recallCue: "老规矩",
      recallSource: { prompt: "Apply 老规矩", generation: gate.generation, turn: gate.turn },
    });
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
