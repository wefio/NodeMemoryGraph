import assert from "node:assert/strict";
import test from "node:test";

import { buildSnapshot, normalizeByMode } from "../../../evals/official/snapshot.ts";
import { benchmarkParametersFromEnvironment } from "../../../evals/official/parameters.ts";

test("normalizeByMode accepts the official scorer shape", () => {
  const result = normalizeByMode({
    "nmg-graph": { score: 0.75, count: 8, byCategory: { multi_hop: 0.5 } },
  });
  assert.deepEqual(result["nmg-graph"], {
    score: 0.75,
    count: 8,
    byCategory: { multi_hop: 0.5 },
  });
});

test("normalizeByMode accepts the longmemeval accuracy/total shape", () => {
  const result = normalizeByMode({ "flat-hybrid": { accuracy: 0.5, total: 14 } });
  assert.deepEqual(result["flat-hybrid"], { score: 0.5, count: 14 });
});

test("normalizeByMode reports NaN for a missing score rather than defaulting to zero", () => {
  // A zero default would be indistinguishable from a genuine score of 0.0 and
  // would silently corrupt trend comparisons.
  const result = normalizeByMode({ broken: { count: 3 } });
  assert.ok(Number.isNaN(result.broken!.score));
  assert.equal(result.broken!.count, 3);
});

test("buildSnapshot records provenance and never claims leaderboard comparability", () => {
  const snapshot = buildSnapshot({
    benchmark: "locomo",
    protocol: "official-protocol/deterministic",
    judgeModel: null,
    upstream: { commit: "abc123" },
    byMode: { "nmg-auto": { score: 0.6, count: 5 } },
    codeRevision: "deadbeefcafe1234",
    sampleFingerprint: "fp-1",
    parameters: { qpp: { qpp1Mode: "shadow" } },
  });

  assert.equal(snapshot.benchmark, "locomo");
  assert.equal(snapshot.codeRevision, "deadbeefcafe1234");
  assert.equal(snapshot.sampleFingerprint, "fp-1");
  assert.equal(snapshot.leaderboardComparable, false);
  assert.deepEqual(snapshot.byMode["nmg-auto"], { score: 0.6, count: 5 });
  assert.deepEqual(snapshot.parameters, { qpp: { qpp1Mode: "shadow" } });
  assert.ok(!Number.isNaN(Date.parse(snapshot.recordedAt)));
});

test("buildSnapshot tolerates missing provenance", () => {
  const snapshot = buildSnapshot({
    benchmark: "beam",
    protocol: "official-protocol/deepseek-judge",
    judgeModel: "deepseek/deepseek-v4-flash",
    upstream: null,
    byMode: {},
  });
  assert.equal(snapshot.codeRevision, null);
  assert.equal(snapshot.sampleFingerprint, null);
  assert.equal(snapshot.parameters, null);
});

test("benchmark parameters record resolved QPP and embedding values without secrets", () => {
  const parameters = benchmarkParametersFromEnvironment({
    NMG_QPP1_MODE: "active",
    NMG_QPP2_MODE: "shadow",
    NMG_QPP2_RETAINED_MASS: "0.95",
    NMG_SEARCH_RECOMMENDATION: "guardrail",
    NMG_QPP_SECOND_PASS: "1",
    NMG_QPP_INITIAL_EVIDENCE_TARGET: "13",
    NMG_QPP_STRONG_HIT_TOP_GAP: "0.08",
    NMG_QPP_STRONG_HIT_INITIAL_TARGET: "5",
    NMG_QPP_THRESHOLD: "0.4",
    NMG_GRAPH_HOPS: "2",
    NMG_EMBED_BASE_URL: "http://localhost:8000/v1",
    NMG_EMBED_API_KEY: "must-not-appear",
    NMG_EMBED_MODEL: "BAAI/bge-small-en-v1.5",
    NMG_EMBED_PROFILE: "bge-en",
    NMG_EMBED_DIMENSIONS: "384",
    NMG_EMBED_BATCH_SIZE: "128",
  });

  assert.deepEqual(parameters, {
    qpp: {
      qpp1Mode: "active",
      qpp2Mode: "shadow",
      qpp2RetainedMass: 0.95,
      searchRecommendation: "guardrail",
      progressiveSecondPass: true,
      initialEvidenceTarget: 13,
      strongHitTopGap: 0.08,
      strongHitInitialTarget: 5,
      threshold: 0.4,
    },
    retrieval: {
      graphHopsOverride: 2,
      hybridWeights: { lexical: 0.5, vector: 0.35, route: 0.15 },
      supersedeSuccessorBoost: 0.3,
      temporalAsOfBoost: 0.25,
      temporalAsOfDecayDays: 730,
      minimumWarmDisclosureSize: 5,
    },
    writes: {
      nearDuplicateThreshold: 0.7,
      nearDuplicateScan: 50,
      supersedeMinimumSharedTokens: 1,
      supersedeCandidateMaximum: 10,
    },
    graph: {
      edgeActivation: { maxHops: 1, decay: 0.7, threshold: 0.02, learningRate: 0.05 },
      consolidation: {
        minIndependentTasks: 3,
        promoteThreshold: 0.75,
        demoteThreshold: 0.45,
        cooldownMs: 604800000,
      },
      topology: { minObservations: 3, minGain: 0.6, cooldownMs: 604800000 },
    },
    activeGraph: {
      maxNodes: 8,
      maxEdges: 12,
      maxEvidence: 8,
      maxTokens: 2000,
      maxGraphHops: 1,
      maxLocalTier: 1,
      maxTierBudget: 3,
      maxLatencyMs: 250,
    },
    retention: {
      dormantAfterDays: 365,
      quarantineAfterDays: 365,
      maximumImportance: 0.25,
      maximumAccessCount: 1,
    },
    controller: { temporalAlpha: 0.3, reasoningBeta: 0.5 },
    embeddings: {
      enabled: true,
      provider: "openai",
      model: "BAAI/bge-small-en-v1.5",
      profile: "bge-en",
      dimensions: 384,
      batchSize: 128,
    },
  });
  assert.doesNotMatch(JSON.stringify(parameters), /must-not-appear/);
});

test("benchmark parameters include runtime defaults when no overrides are supplied", () => {
  assert.deepEqual(benchmarkParametersFromEnvironment({}), {
    qpp: {
      qpp1Mode: "shadow",
      qpp2Mode: "off",
      qpp2RetainedMass: 0.98,
      searchRecommendation: "off",
      progressiveSecondPass: false,
      initialEvidenceTarget: 13,
      strongHitTopGap: 0.05,
      strongHitInitialTarget: 3,
      threshold: 0.55,
    },
    retrieval: {
      graphHopsOverride: null,
      hybridWeights: { lexical: 0.5, vector: 0.35, route: 0.15 },
      supersedeSuccessorBoost: 0.3,
      temporalAsOfBoost: 0.25,
      temporalAsOfDecayDays: 730,
      minimumWarmDisclosureSize: 5,
    },
    writes: {
      nearDuplicateThreshold: 0.7,
      nearDuplicateScan: 50,
      supersedeMinimumSharedTokens: 1,
      supersedeCandidateMaximum: 10,
    },
    graph: {
      edgeActivation: { maxHops: 1, decay: 0.7, threshold: 0.02, learningRate: 0.05 },
      consolidation: {
        minIndependentTasks: 3,
        promoteThreshold: 0.75,
        demoteThreshold: 0.45,
        cooldownMs: 604800000,
      },
      topology: { minObservations: 3, minGain: 0.6, cooldownMs: 604800000 },
    },
    activeGraph: {
      maxNodes: 8,
      maxEdges: 12,
      maxEvidence: 8,
      maxTokens: 2000,
      maxGraphHops: 1,
      maxLocalTier: 1,
      maxTierBudget: 3,
      maxLatencyMs: 250,
    },
    retention: {
      dormantAfterDays: 365,
      quarantineAfterDays: 365,
      maximumImportance: 0.25,
      maximumAccessCount: 1,
    },
    controller: { temporalAlpha: 0.3, reasoningBeta: 0.5 },
    embeddings: {
      enabled: false,
      provider: null,
      model: null,
      profile: null,
      dimensions: null,
      batchSize: 64,
    },
  });
});

test("benchmark parameters resolve hosted provider defaults without recording keys", () => {
  const parameters = benchmarkParametersFromEnvironment({
    NMG_EMBED_PROVIDER: "gemini",
    GEMINI_API_KEY: "must-not-appear",
  });
  assert.deepEqual(parameters.embeddings, {
    enabled: true,
    provider: "gemini",
    model: "gemini-embedding-001",
    profile: "gemini-retrieval",
    dimensions: null,
    batchSize: 64,
  });
  assert.doesNotMatch(JSON.stringify(parameters), /must-not-appear/u);
});
