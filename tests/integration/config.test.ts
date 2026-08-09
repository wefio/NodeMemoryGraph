import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAINTENANCE_POLICY,
  DEFAULT_STG_CONSOLIDATION_POLICY,
  configuredMaintenancePolicy,
  configuredStgConsolidationPolicy,
} from "../../src/integration/config.ts";

test("maintenance policy owns defaults and validates environment overrides", () => {
  assert.deepEqual(configuredMaintenancePolicy({}), DEFAULT_MAINTENANCE_POLICY);
  assert.deepEqual(
    configuredMaintenancePolicy({
      NMG_MAINTENANCE_WRITE_THRESHOLD: "8",
      NMG_MAINTENANCE_ACCESS_THRESHOLD: "12",
      NMG_MAINTENANCE_NODE_LIMIT: "1000",
    }),
    {
      ...DEFAULT_MAINTENANCE_POLICY,
      writeThreshold: 8,
      accessThreshold: 12,
      nodeLimit: 64,
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
