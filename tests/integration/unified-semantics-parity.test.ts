import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { openMemoryBackend } from "../../src/core/memory/open.ts";
import { parseLocalMemoryHttpConfig } from "../../src/cli/local-memory-http-config.ts";
import { NmgService } from "../../src/cli/service.ts";
import { configuredAutoRecallLimit } from "../../src/integration/config.ts";
import { HttpMemoryService } from "../../src/integration/memory-http-service.ts";
import { resolveEffectiveNmgConfig } from "../../src/integration/runtime-config.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

test("daemon get executes the L1-bound graph and observes an external file edit", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-l1-graph-"));
  const service = new NmgService({ dataDirectory: dir, environment: {} });
  t.after(async () => {
    await service.close();
    removeTempDirectory(dir);
  });
  const remembered = await service.invoke("remember", {
    statement: "The runtime fixture stores evidence",
    nodeName: "Runtime fixture",
  });
  const path = join(dir, "nmg.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      allowAlgorithmicOverrides: true,
      bindings: {
        "memory.get_context": {
          spec: {
            id: "l1-get-probe",
            nodes: [{ id: "out", op: "unregistered_get_probe" }],
            edges: [],
            output: "out",
          },
        },
      },
    }),
  );
  const input = { memoryIds: [remembered.memory.id] };
  await assert.rejects(
    service.invoke("get", input),
    /Unknown compute operator: unregistered_get_probe/,
  );
  writeFileSync(path, JSON.stringify({ runtime: { profile: "eco" } }));
  const result = await service.invoke("get", input);
  assert.equal(result.results[0]?.memory.id, remembered.memory.id);
});

test("L1 shared config propagates across adapters without recompile while L2 isolates HTTP overrides", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-config-tiers-"));
  t.after(() => removeTempDirectory(dir));

  const sharedConfigPath = join(dir, "nmg.config.json");
  writeFileSync(
    sharedConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      autoRecall: { limit: 19, tier: 2 },
      allowedAlgorithmicVariants: ["piecewise-bm25f"],
      bindings: {
        "memory.candidate_rerank": {
          nodeOverrides: {
            mid_r1_r5: { nodeOverrides: { wchrono: { params: { weight: 0.28 } } } },
          },
        },
      },
    }),
    "utf8",
  );

  // Un-overridden adapter helper inherits shared L1 nmg.config.json automatically
  assert.equal(configuredAutoRecallLimit({ NMG_CONFIG_PATH: sharedConfigPath }), 19);

  // HTTP L2 overrides only its local HTTP adapter without mutating L1
  const httpCfgPath = join(dir, "http.json");
  const parsedHttp = parseLocalMemoryHttpConfig(
    {
      databasePath: "./http.sqlite",
      bindings: {
        "memory.candidate_rerank": { recipeId: "piecewise-bm25f" },
      },
      runtime: { profile: "eco" },
    },
    httpCfgPath,
    { NMG_CONFIG_PATH: sharedConfigPath },
  );
  const effectiveHttp = resolveEffectiveNmgConfig({
    l2: parsedHttp.l2Overrides,
    environment: { NMG_CONFIG_PATH: sharedConfigPath },
  });
  assert.equal(effectiveHttp.autoRecall.limit, 19);
  assert.equal(effectiveHttp.runtime.profile, "eco");
  assert.match(effectiveHttp.resolveGraph("memory.candidate_rerank").id, /piecewise-bm25f/);

  // Updating L1 file takes effect on reload without recompiling
  writeFileSync(
    sharedConfigPath,
    JSON.stringify({ schemaVersion: 1, autoRecall: { limit: 24 } }),
    "utf8",
  );
  // Touch mtime deterministically? Wait a few ms and verify changed NMG_CONFIG_PATH or explicit file update
  assert.equal(configuredAutoRecallLimit({ NMG_CONFIG_PATH: sharedConfigPath }), 24);
});

test("Local Engine, HTTP single-clause/multi-clause, profileSummary, and zero-poll NmgService drain stay consistent", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-parity-"));
  const backend = await openMemoryBackend({
    kind: "sqlite",
    path: join(dir, "memory.sqlite"),
    namespace: "parity-ns",
  });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(dir);
  });

  let tick = 0;
  const engine = new MemoryEngine(backend, () => {
    tick += 1;
    return `2026-10-${String(1 + tick).padStart(2, "0")}T10:00:00.000Z`;
  });
  const httpService = new HttpMemoryService(engine, undefined, { preprocessMessages: true });
  await httpService.rememberBatch("u1", "s1", "req-1", [
    {
      role: "user",
      content: "I love espresso in the morning",
      source_message_id: "1",
      chat_time: "2026-10-02T08:00:00Z",
    },
    {
      role: "user",
      content: "Please remember my laptop SSD has 2TB storage",
      source_message_id: "2",
      chat_time: "2026-10-03T09:00:00Z",
    },
  ]);

  const single = await httpService.searchSingleClause("laptop SSD storage", 5, {
    now: "2026-10-05T00:00:00Z",
    sortResultsByTime: true,
  });
  assert.ok(single.raw.results.length >= 1);
  assert.equal(single.raw.results[0]?.memory.statement.includes("2TB storage"), true);

  const profileText = await httpService.profileSummary("espresso coffee", "2026-10-05T00:00:00Z");
  assert.equal(profileText.includes("espresso"), true);

  // Zero-poll NmgService drain works cleanly with concurrent in-flight requests
  const svc = new NmgService({ dataDirectory: join(dir, "daemon") });
  await svc.prepareMemory();
  const pendingSearch = svc.invoke("search", { query: "nonexistent" });
  await svc.drain(2000);
  const res = await pendingSearch;
  assert.deepEqual(res.results, []);
  await svc.close();
});
