import {
  ComputeRegistry,
  INPUT_NODE_ID,
  executeComputeGraph,
  type ComputeGraphSpec,
  type ComputeMemoCache,
} from "../compute-graph.ts";
import type { MemoryRecord } from "../types.ts";
import {
  buildGraphProjection,
  type GraphProjectionDimension,
  type MemoryGraphProjection,
} from "./graph-projection.ts";
import { rankLocalLogOdds } from "./local-log-odds.ts";
import {
  DEFAULT_PIECEWISE_RERANK_GRAPH,
  rerankCandidatesWithGraph,
  type RerankCandidate,
} from "./piecewise-rerank.ts";

export interface RecallCandidateItem {
  readonly memory: MemoryRecord;
  readonly bm25?: number;
  readonly vectorScore?: number;
}

export interface RetrievalPipelineInput {
  readonly queryText: string;
  readonly limit: number;
}

export interface RetrievalPipelineContext {
  readonly lexicalRecall: (queryText: string, limit: number) => Promise<RecallCandidateItem[]>;
  readonly vectorRecall: (queryText: string, limit: number) => Promise<RecallCandidateItem[]>;
}

export interface RetrievalPipelineOutput {
  readonly ranked: Array<RerankCandidate & { memory: MemoryRecord }>;
  readonly projection: MemoryGraphProjection;
}

function mergeRecallChannels(
  lexical: readonly RecallCandidateItem[],
  vector: readonly RecallCandidateItem[],
): Array<RerankCandidate & { memory: MemoryRecord }> {
  const byId = new Map<string, { memory: MemoryRecord; bm25: number; vectorScore: number }>();
  for (const item of lexical) {
    byId.set(item.memory.id, {
      memory: item.memory,
      bm25: item.bm25 ?? 0,
      vectorScore: item.vectorScore ?? 0,
    });
  }
  for (const item of vector) {
    const existing = byId.get(item.memory.id);
    if (existing) {
      existing.vectorScore = Math.max(existing.vectorScore, item.vectorScore ?? 0);
      if (item.bm25 && !existing.bm25) existing.bm25 = item.bm25;
    } else {
      byId.set(item.memory.id, {
        memory: item.memory,
        bm25: item.bm25 ?? 0,
        vectorScore: item.vectorScore ?? 0,
      });
    }
  }
  const fused = rankLocalLogOdds([...byId.values()], (row) => ({
    id: row.memory.id,
    bm25: row.bm25,
    vectorScore: row.vectorScore,
  }));
  return fused.map(({ candidate, score }) => ({
    memory: candidate.memory,
    id: candidate.memory.id,
    statement: candidate.memory.statement,
    combinedScore: score,
    eventTime: candidate.memory.eventTime,
    createdAt: candidate.memory.createdAt,
    sessionId: candidate.memory.sourceSessionId ?? candidate.memory.sessionId ?? null,
    nodeId: candidate.memory.nodeId,
    evidenceId: candidate.memory.evidenceId,
    markers: candidate.memory.markers,
    stateKey: candidate.memory.stateKey,
    predicateKey: candidate.memory.predicateKey,
    supersedesId: candidate.memory.supersedesId,
    relatedMemoryIds: candidate.memory.relatedMemoryIds,
  }));
}

function buildRetrievalRegistry(): ComputeRegistry<RetrievalPipelineContext> {
  const registry = new ComputeRegistry<RetrievalPipelineContext>();

  registry.register(
    "lexical_recall",
    async (inputs, ctx, params) => {
      const req = inputs.default as RetrievalPipelineInput;
      const limit = typeof params.limit === "number" ? params.limit : req.limit * 3;
      return ctx.lexicalRecall(req.queryText, limit);
    },
    { version: "1.0.0" },
  );

  registry.register(
    "vector_recall",
    async (inputs, ctx, params) => {
      const req = inputs.default as RetrievalPipelineInput;
      const limit = typeof params.limit === "number" ? params.limit : req.limit * 3;
      return ctx.vectorRecall(req.queryText, limit);
    },
    { version: "1.0.0" },
  );

  registry.register(
    "log_odds_fusion",
    (inputs) => {
      const lexical = (inputs.lexical as readonly RecallCandidateItem[] | undefined) ?? [];
      const vector = (inputs.vector as readonly RecallCandidateItem[] | undefined) ?? [];
      return mergeRecallChannels(lexical, vector);
    },
    { version: "1.0.0" },
  );

  registry.register(
    "piecewise_rerank",
    (inputs, _ctx, params) => {
      const req = inputs.request as RetrievalPipelineInput | undefined;
      const candidates =
        (inputs.candidates as Array<RerankCandidate & { memory: MemoryRecord }> | undefined) ?? [];
      if (params.enabled === false) return candidates;
      const graph =
        (params.graph as ComputeGraphSpec | undefined) ?? DEFAULT_PIECEWISE_RERANK_GRAPH;
      return rerankCandidatesWithGraph(candidates, req?.queryText ?? "", graph);
    },
    { version: "1.0.0" },
  );

  registry.register(
    "pivot_graph_projection",
    (inputs, _ctx, params): RetrievalPipelineOutput => {
      const req = inputs.request as RetrievalPipelineInput | undefined;
      const candidates =
        (inputs.default as Array<RerankCandidate & { memory: MemoryRecord }> | undefined) ?? [];
      const ranked = req ? candidates.slice(0, req.limit) : candidates;
      const dimensions = params.dimensions as readonly GraphProjectionDimension[] | undefined;
      const projection = buildGraphProjection({
        memories: ranked.map((c) => c.memory),
        dimensions,
      });
      return { ranked, projection };
    },
    { version: "1.0.0" },
  );

  return registry;
}

export const RETRIEVAL_COMPUTE_REGISTRY = buildRetrievalRegistry();

/** Storage-decoupled retrieval, rerank, and on-demand pivot projection ComputeGraphSpec. */
export function createRetrievalAndProjectionGraph(
  options: {
    id?: string;
    dimensions?: readonly GraphProjectionDimension[];
    rerankEnabled?: boolean;
    rerankGraph?: ComputeGraphSpec;
  } = {},
): ComputeGraphSpec {
  return {
    id: options.id ?? "retrieval-hybrid-rerank-project",
    nodes: [
      { id: "lexical", op: "lexical_recall" },
      { id: "vector", op: "vector_recall" },
      { id: "fuse", op: "log_odds_fusion" },
      {
        id: "rerank",
        op: "piecewise_rerank",
        params: {
          enabled: options.rerankEnabled ?? true,
          ...(options.rerankGraph ? { graph: options.rerankGraph } : {}),
        },
      },
      {
        id: "project",
        op: "pivot_graph_projection",
        params: { ...(options.dimensions ? { dimensions: options.dimensions } : {}) },
      },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "lexical" },
      { from: INPUT_NODE_ID, to: "vector" },
      { from: "lexical", to: "fuse", port: "lexical" },
      { from: "vector", to: "fuse", port: "vector" },
      { from: "fuse", to: "rerank", port: "candidates" },
      { from: INPUT_NODE_ID, to: "rerank", port: "request" },
      { from: "rerank", to: "project" },
      { from: INPUT_NODE_ID, to: "project", port: "request" },
    ],
    output: "project",
  };
}

/** Run the decoupled retrieval-to-projection compute graph over any provider callbacks. */
export function runDecoupledRetrievalGraph(
  input: RetrievalPipelineInput,
  context: RetrievalPipelineContext,
  spec: ComputeGraphSpec = createRetrievalAndProjectionGraph(),
  memo?: ComputeMemoCache,
): Promise<RetrievalPipelineOutput> {
  return executeComputeGraph<
    RetrievalPipelineInput,
    RetrievalPipelineOutput,
    RetrievalPipelineContext
  >(spec, RETRIEVAL_COMPUTE_REGISTRY, input, context, memo);
}
