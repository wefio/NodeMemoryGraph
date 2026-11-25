import {
  materializeBoundGraph,
  type ConfigLayer,
  type SubgraphOverrideSpec,
} from "../core/capability-config.ts";
import type { ComputeGraphSpec } from "../core/compute-graph.ts";
import type { MemoryEngineGraphOptions } from "../core/memory/engine.ts";
import {
  DEFAULT_PIECEWISE_RERANK_GRAPH,
  HEAD_BM25F_R3_SUBGRAPH,
  HEAD_QTF_R3_SUBGRAPH,
  MID_DEDUP_RECENCY_SUBGRAPH,
  TAIL_SESSION_TEMPORAL_SUBGRAPH,
  createPiecewiseRerankGraph,
} from "../core/memory/piecewise-rerank.ts";
import { DEFAULT_ENGINE_SEARCH_GRAPH } from "../core/memory/search-compute-graph.ts";
import {
  DEFAULT_GET_CONTEXT_GRAPH,
  DEFAULT_NEIGHBORHOOD_GRAPH,
  DEFAULT_PROJECT_GRAPH,
  DEFAULT_USER_PROFILE_GRAPH,
} from "../core/memory/view-compute-graphs.ts";
import {
  DEFAULT_LIFECYCLE_PLAN_GRAPH,
  DEFAULT_REMEMBER_PLAN_GRAPH,
} from "../core/memory/write-compute-graphs.ts";
import { DEFAULT_HTTP_PROFILE_GRAPH } from "./http-profile-view.ts";
import { DEFAULT_HTTP_SEARCH_GRAPH } from "./http-search-graph.ts";
import { DEFAULT_HTTP_WRITE_PREPROCESS_GRAPH } from "./http-write-preprocess.ts";
import {
  loadSharedL1Config,
  resolveParameterBundle,
  resolveParameterConfig,
  type EffectiveAutoRecallPolicy,
  type EffectiveParameterConfig,
  type EffectiveRuntimePolicy,
  type ResolveParameterConfigOptions,
} from "./parameter-config.ts";

export {
  loadSharedL1Config,
  resolveParameterConfig,
  type EffectiveAutoRecallPolicy,
  type EffectiveParameterConfig,
  type EffectiveRuntimePolicy,
  type ResolveParameterConfigOptions,
};

export interface EffectiveNmgConfig extends EffectiveParameterConfig {
  resolveGraph(contractId: string, override?: SubgraphOverrideSpec): ComputeGraphSpec;
  inspect(): {
    readonly effective: Record<string, unknown>;
    readonly resultIdentityHash: string;
    readonly provenance: Record<
      string,
      import("../core/capability-config.ts").ConfigProvenanceEntry
    >;
    readonly boundContracts: Record<
      string,
      { graphId: string; layer: ConfigLayer; source: string }
    >;
  };
}

export const NMG_L0_CONTRACT_GRAPHS: Readonly<Record<string, ComputeGraphSpec>> = {
  "memory.search": DEFAULT_ENGINE_SEARCH_GRAPH,
  "memory.candidate_rerank": DEFAULT_PIECEWISE_RERANK_GRAPH,
  "memory.get_context": DEFAULT_GET_CONTEXT_GRAPH,
  "memory.neighborhood": DEFAULT_NEIGHBORHOOD_GRAPH,
  "memory.graph_projection": DEFAULT_PROJECT_GRAPH,
  "memory.user_profile": DEFAULT_USER_PROFILE_GRAPH,
  "memory.write_plan": DEFAULT_REMEMBER_PLAN_GRAPH,
  "memory.lifecycle_plan": DEFAULT_LIFECYCLE_PLAN_GRAPH,
  "memory.http_clause_fusion": DEFAULT_HTTP_SEARCH_GRAPH,
  "memory.write_preprocess": DEFAULT_HTTP_WRITE_PREPROCESS_GRAPH,
  "memory.http_profile": DEFAULT_HTTP_PROFILE_GRAPH,
};

export const NMG_NAMED_RECIPES: Readonly<Record<string, ComputeGraphSpec>> = {
  "piecewise-qtf-default": DEFAULT_PIECEWISE_RERANK_GRAPH,
  "piecewise-bm25f": createPiecewiseRerankGraph({ id: "piecewise-bm25f", bm25fWeight: 0.1 }),
  "head-qtf-r3": HEAD_QTF_R3_SUBGRAPH,
  "head-bm25f-r3": HEAD_BM25F_R3_SUBGRAPH,
  "mid-dedup-recency": MID_DEDUP_RECENCY_SUBGRAPH,
  "tail-session-temporal": TAIL_SESSION_TEMPORAL_SUBGRAPH,
};

export function bindMemoryEngineConfig(config: EffectiveNmgConfig): MemoryEngineGraphOptions {
  return {
    searchGraph: config.resolveGraph("memory.search"),
    rerankGraph: config.resolveGraph("memory.candidate_rerank"),
    getGraph: config.resolveGraph("memory.get_context"),
    neighborhoodGraph: config.resolveGraph("memory.neighborhood"),
    projectGraph: config.resolveGraph("memory.graph_projection"),
    userProfileGraph: config.resolveGraph("memory.user_profile"),
    rememberPlanGraph: config.resolveGraph("memory.write_plan"),
    lifecyclePlanGraph: config.resolveGraph("memory.lifecycle_plan"),
    configIdentity: config.resultIdentityHash,
    runtime: config.runtime,
  };
}

/** Resolve unified L0 -> L1 -> L2 configuration with provenance and bound ComputeGraphSpec access. */
export function resolveEffectiveNmgConfig(
  options: ResolveParameterConfigOptions = {},
): EffectiveNmgConfig {
  const { bundle, parameters } = resolveParameterBundle(options);
  for (const contractId of bundle.bindingProvenance.keys()) {
    if (!Object.hasOwn(NMG_L0_CONTRACT_GRAPHS, contractId)) {
      throw new Error(`No L0 graph catalog entry for contract '${contractId}'`);
    }
  }

  const policy = {
    allowAlgorithmicOverrides: bundle.allowAlgorithmicOverrides,
    allowedAlgorithmicVariants: bundle.allowedAlgorithmicVariants,
  };

  const resolveGraph = (contractId: string, override?: SubgraphOverrideSpec): ComputeGraphSpec => {
    const base = NMG_L0_CONTRACT_GRAPHS[contractId];
    if (!Object.hasOwn(NMG_L0_CONTRACT_GRAPHS, contractId))
      throw new Error(`No L0 graph catalog entry for contract '${contractId}'`);
    const effectiveOverride = override ?? bundle.bindings[contractId];
    return materializeBoundGraph(contractId, base, effectiveOverride, NMG_NAMED_RECIPES, policy);
  };

  const inspect = () => {
    const boundContracts: Record<string, { graphId: string; layer: ConfigLayer; source: string }> =
      {};
    for (const contractId of Object.keys(NMG_L0_CONTRACT_GRAPHS)) {
      const resolved = resolveGraph(contractId);
      const prov = bundle.bindingProvenance.get(contractId) ?? {
        layer: "L0" as const,
        source: "builtin",
      };
      boundContracts[contractId] = { graphId: resolved.id, ...prov };
    }
    return {
      effective: bundle.values,
      resultIdentityHash: bundle.resultIdentityHash,
      provenance: Object.fromEntries(bundle.provenance),
      boundContracts,
    };
  };

  return {
    ...parameters,
    resolveGraph,
    inspect,
  };
}
