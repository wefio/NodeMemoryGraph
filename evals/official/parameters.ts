import {
  DEFAULT_INITIAL_EVIDENCE_TARGET,
  DEFAULT_QPP_THRESHOLD,
  STRONG_HIT_INITIAL_TARGET,
  STRONG_HIT_TOP_GAP,
} from "../../src/core/qpp.ts";
import { DEFAULT_EDGE_ACTIVATION } from "../../src/core/edge-activation.ts";
import { DEFAULT_HIERARCHICAL_ACTIVATION } from "../../src/core/hierarchical-activation.ts";
import { DEFAULT_ACTIVE_GRAPH_BUDGET } from "../../src/core/store/active-graph.ts";
import {
  DEFAULT_CONSOLIDATION_POLICY,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_TOPOLOGY_POLICY,
  MIN_WARM_DISCLOSURE_SIZE,
  NEAR_DUPLICATE_SCAN,
  NEAR_DUPLICATE_THRESHOLD,
  SUPERSEDE_CANDIDATE_MAX,
  SUPERSEDE_MIN_SHARED_TOKENS,
  SUPERSEDE_PREFILTER_MAX_TERMS,
  SUPERSEDE_SUCCESSOR_BOOST,
  TEMPORAL_ASOF_BOOST,
  TEMPORAL_ASOF_DECAY_DAYS,
} from "../../src/core/store/graph-policy.ts";
import { DEFAULT_HYBRID_WEIGHTS } from "../../src/core/store/search-ranking.ts";

export interface BenchmarkParameters {
  qpp: {
    qpp1Mode: "active" | "off" | "shadow";
    qpp2Mode: "active" | "off" | "shadow";
    qpp2RetainedMass: number;
    searchRecommendation: "advisory" | "guardrail" | "off";
    progressiveSecondPass: boolean;
    initialEvidenceTarget: number;
    strongHitTopGap: number;
    strongHitInitialTarget: number;
    threshold: number;
  };
  retrieval: {
    graphHopsOverride: number | null;
    hybridWeights: typeof DEFAULT_HYBRID_WEIGHTS;
    supersedeSuccessorBoost: number;
    temporalAsOfBoost: number;
    temporalAsOfDecayDays: number;
    minimumWarmDisclosureSize: number;
  };
  writes: {
    nearDuplicateThreshold: number;
    nearDuplicateScan: number;
    supersedeMinimumSharedTokens: number;
    supersedeCandidateMaximum: number;
    supersedePrefilterMaximumTerms: number;
  };
  graph: {
    edgeActivation: typeof DEFAULT_EDGE_ACTIVATION;
    consolidation: typeof DEFAULT_CONSOLIDATION_POLICY;
    topology: typeof DEFAULT_TOPOLOGY_POLICY;
  };
  activeGraph: typeof DEFAULT_ACTIVE_GRAPH_BUDGET;
  retention: typeof DEFAULT_RETENTION_POLICY;
  controller: typeof DEFAULT_HIERARCHICAL_ACTIVATION;
  embeddings: {
    enabled: boolean;
    provider: string | null;
    model: string | null;
    profile: string | null;
    dimensions: number | null;
    batchSize: number;
  };
}

/** Resolved, non-secret parameters shared by benchmark reports and score snapshots. */
export function benchmarkParametersFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): BenchmarkParameters {
  const embeddingProvider =
    environment.NMG_EMBED_PROVIDER?.trim() || (environment.NMG_EMBED_BASE_URL ? "openai" : null);
  return {
    qpp: {
      qpp1Mode: qpp1Mode(environment),
      qpp2Mode: mode(environment.NMG_QPP2_MODE, ["off", "shadow", "active"], "off"),
      qpp2RetainedMass: finiteNumber(environment.NMG_QPP2_RETAINED_MASS, 0.98),
      searchRecommendation: mode(
        environment.NMG_SEARCH_RECOMMENDATION,
        ["off", "advisory", "guardrail"],
        "off",
      ),
      progressiveSecondPass: environment.NMG_QPP_SECOND_PASS === "1",
      initialEvidenceTarget: finiteNumber(
        environment.NMG_QPP_INITIAL_EVIDENCE_TARGET,
        DEFAULT_INITIAL_EVIDENCE_TARGET,
      ),
      strongHitTopGap: finiteNumber(environment.NMG_QPP_STRONG_HIT_TOP_GAP, STRONG_HIT_TOP_GAP),
      strongHitInitialTarget: finiteNumber(
        environment.NMG_QPP_STRONG_HIT_INITIAL_TARGET,
        STRONG_HIT_INITIAL_TARGET,
      ),
      threshold: finiteNumber(environment.NMG_QPP_THRESHOLD, DEFAULT_QPP_THRESHOLD),
    },
    retrieval: {
      graphHopsOverride: optionalFiniteNumber(environment.NMG_GRAPH_HOPS),
      hybridWeights: { ...DEFAULT_HYBRID_WEIGHTS },
      supersedeSuccessorBoost: SUPERSEDE_SUCCESSOR_BOOST,
      temporalAsOfBoost: TEMPORAL_ASOF_BOOST,
      temporalAsOfDecayDays: TEMPORAL_ASOF_DECAY_DAYS,
      minimumWarmDisclosureSize: MIN_WARM_DISCLOSURE_SIZE,
    },
    writes: {
      nearDuplicateThreshold: NEAR_DUPLICATE_THRESHOLD,
      nearDuplicateScan: NEAR_DUPLICATE_SCAN,
      supersedeMinimumSharedTokens: SUPERSEDE_MIN_SHARED_TOKENS,
      supersedeCandidateMaximum: SUPERSEDE_CANDIDATE_MAX,
      supersedePrefilterMaximumTerms: SUPERSEDE_PREFILTER_MAX_TERMS,
    },
    graph: {
      edgeActivation: { ...DEFAULT_EDGE_ACTIVATION },
      consolidation: { ...DEFAULT_CONSOLIDATION_POLICY },
      topology: { ...DEFAULT_TOPOLOGY_POLICY },
    },
    activeGraph: { ...DEFAULT_ACTIVE_GRAPH_BUDGET },
    retention: { ...DEFAULT_RETENTION_POLICY },
    controller: { ...DEFAULT_HIERARCHICAL_ACTIVATION },
    embeddings: {
      enabled: embeddingProvider !== null,
      provider: embeddingProvider,
      model: environment.NMG_EMBED_MODEL?.trim() || defaultEmbeddingModel(embeddingProvider),
      profile: environment.NMG_EMBED_PROFILE?.trim() || defaultEmbeddingProfile(embeddingProvider),
      dimensions: optionalFiniteNumber(environment.NMG_EMBED_DIMENSIONS),
      batchSize: finiteNumber(environment.NMG_EMBED_BATCH_SIZE, 64),
    },
  };
}

function defaultEmbeddingModel(provider: string | null): string | null {
  if (provider === "cloudflare") return "@cf/baai/bge-m3";
  if (provider === "gemini") return "gemini-embedding-001";
  if (provider === "jina") return "jina-embeddings-v3";
  if (provider === "openai") return "Qwen/Qwen3-Embedding-0.6B";
  return null;
}

function defaultEmbeddingProfile(provider: string | null): string | null {
  if (provider === "gemini") return "gemini-retrieval";
  if (provider === "cloudflare" || provider === "jina") return "plain";
  if (provider === "openai") return "qwen3";
  return null;
}

function qpp1Mode(environment: NodeJS.ProcessEnv): "active" | "off" | "shadow" {
  const configured = mode(environment.NMG_QPP1_MODE, ["off", "shadow", "active"], null);
  if (configured) return configured;
  return environment.NMG_CONTROLLER_SEARCH === "1" ? "active" : "shadow";
}

function mode<const T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T;
function mode<const T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: null,
): T | null;
function mode<const T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T | null,
): T | null {
  const normalized = value?.trim().toLowerCase();
  return allowed.find((candidate) => candidate === normalized) ?? fallback;
}

function finiteNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) ? parsed : fallback;
}

function optionalFiniteNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
