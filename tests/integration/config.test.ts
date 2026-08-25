import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAINTENANCE_POLICY,
  DEFAULT_STG_CONSOLIDATION_POLICY,
  DEFAULT_STG_SYNC_POLICY,
  configuredControllerRerankMode,
  configuredControllerRuntimeMode,
  configuredGraphHops,
  configuredMaintenancePolicy,
  configuredQpp1Mode,
  configuredQpp2Mode,
  configuredQpp2RetainedMass,
  configuredSearchRecommendationMode,
  configuredStgConsolidationPolicy,
  configuredStgSyncPolicy,
} from "../../src/integration/config.ts";

test("maintenance policy owns defaults and validates environment overrides", () => {
  assert.deepEqual(configuredMaintenancePolicy({}), DEFAULT_MAINTENANCE_POLICY);
  assert.deepEqual(
    configuredMaintenancePolicy({
      NMG_MAINTENANCE_WRITE_THRESHOLD: "8",
      NMG_MAINTENANCE_ACCESS_THRESHOLD: "12",
      NMG_MAINTENANCE_NODE_LIMIT: "1000",
      NMG_TOPOLOGY_AUTO_MERGE: "1",
      NMG_TOPOLOGY_AUTO_MERGE_LIMIT: "99",
    }),
    {
      ...DEFAULT_MAINTENANCE_POLICY,
      writeThreshold: 8,
      accessThreshold: 12,
      nodeLimit: 64,
      autoMergeEnabled: true,
      autoMergeLimit: 4,
    },
  );
  assert.deepEqual(
    configuredMaintenancePolicy({
      NMG_MAINTENANCE_WRITE_THRESHOLD: "bad",
      NMG_MAINTENANCE_ACCESS_THRESHOLD: "0",
      NMG_MAINTENANCE_NODE_LIMIT: "-2",
    }),
    DEFAULT_MAINTENANCE_POLICY,
  );
});

test("QPP controls resolve from the supplied daemon environment", () => {
  assert.equal(configuredQpp1Mode({}), "shadow");
  assert.equal(configuredQpp1Mode({ NMG_CONTROLLER_SEARCH: "1" }), "active");
  assert.equal(configuredQpp1Mode({ NMG_CONTROLLER_SEARCH: "1", NMG_QPP1_MODE: "off" }), "off");
  assert.equal(configuredQpp2Mode({ NMG_QPP2_MODE: "active" }), "active");
  assert.equal(configuredQpp2Mode({ NMG_QPP2_MODE: "invalid" }), "off");
  assert.equal(configuredControllerRerankMode({}), "off");
  assert.equal(configuredControllerRerankMode({ NMG_CONTROLLER_RERANK: "active" }), "active");
  assert.equal(configuredControllerRuntimeMode({}), "shadow");
  assert.equal(
    configuredControllerRuntimeMode({ NMG_CONTROLLER_RUNTIME_MODE: "active" }),
    "active",
  );
  assert.equal(
    configuredControllerRuntimeMode({ NMG_CONTROLLER_RUNTIME_MODE: "invalid" }),
    "shadow",
  );
  assert.equal(configuredQpp2RetainedMass({ NMG_QPP2_RETAINED_MASS: "1.5" }), 1);
  assert.equal(configuredQpp2RetainedMass({ NMG_QPP2_RETAINED_MASS: "bad" }), 0.98);
  assert.equal(
    configuredSearchRecommendationMode({ NMG_SEARCH_RECOMMENDATION: "guardrail" }),
    "guardrail",
  );
});

test("graph hop defaults resolve from the supplied daemon environment", () => {
  assert.equal(configuredGraphHops(1, {}), 1);
  assert.equal(configuredGraphHops(1, { NMG_GRAPH_HOPS: "0" }), 0);
  assert.equal(configuredGraphHops(1, { NMG_GRAPH_HOPS: "9" }), 3);
  assert.equal(configuredGraphHops(2, { NMG_GRAPH_HOPS: "invalid" }), 2);
});

test("STG retention hysteresis cannot be stricter than its promotion gate", () => {
  assert.deepEqual(configuredStgConsolidationPolicy({}), DEFAULT_STG_CONSOLIDATION_POLICY);
  assert.deepEqual(
    configuredStgConsolidationPolicy({
      NMG_STG_AUTO_CONSOLIDATE: "1",
      NMG_STG_CONSOLIDATE_MIN_MEAN: "0.6",
      NMG_STG_CONSOLIDATE_MIN_LOWER_BOUND: "0.2",
      NMG_STG_RETAIN_MIN_MEAN: "0.9",
      NMG_STG_RETAIN_MIN_LOWER_BOUND: "0.8",
    }),
    {
      ...DEFAULT_STG_CONSOLIDATION_POLICY,
      enabled: true,
      minimumPosteriorMean: 0.6,
      minimumConservativeLowerBound: 0.2,
      minimumRetainedPosteriorMean: 0.6,
      minimumRetainedConservativeLowerBound: 0.2,
    },
  );
});

test("STG automatic sync is opt-in, bounded, and cooldown-controlled", () => {
  assert.deepEqual(configuredStgSyncPolicy({}), DEFAULT_STG_SYNC_POLICY);
  assert.deepEqual(
    configuredStgSyncPolicy({
      NMG_STG_AUTO_SYNC: "1",
      NMG_STG_AUTO_SYNC_LIMIT: "999",
      NMG_STG_AUTO_SYNC_INTERVAL_SECONDS: "30",
    }),
    { enabled: true, limit: 200, minimumIntervalMs: 30_000 },
  );
});
