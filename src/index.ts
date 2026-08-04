export { NmgStore } from "./core/store.ts";
export { HashingVectorEmbedder } from "./core/vector.ts";
export { OpenAIEmbeddingClient } from "./core/openai-embedding.ts";
export { GeminiEmbeddingClient } from "./core/embedding-providers/gemini.ts";
export { configuredProvider, createEmbeddingClientFromEnv } from "./core/embedding-provider.ts";
export type { EmbeddingClient, EmbeddingProvider } from "./core/embedding-provider.ts";
export { syncRecordEmbeddings } from "./core/embedding-sync.ts";
export type { RecordEmbeddingClient, RecordEmbeddingSyncResult } from "./core/embedding-sync.ts";
export {
  configuredGraphHops,
  configuredQpp1Mode,
  configuredQpp2Mode,
  configuredQpp2RetainedMass,
  configuredSearchRecommendationMode,
} from "./integration/config.ts";
export type { QppActuationMode, SearchRecommendationMode } from "./integration/config.ts";
export { retainEvidence } from "./integration/evidence.ts";
export type { AgentHistoryMessage, AgentHistorySnapshot } from "./integration/evidence.ts";
export { searchMemoryContext } from "./integration/search.ts";
export type { QueryEmbeddingClient } from "./integration/search.ts";
export { UsearchAnnIndex } from "./core/ann.ts";
export { decideMemoryLoad } from "./core/gate.ts";
export { normalizeClaims } from "./core/claims.ts";
export type {
  ActivationSignal,
  ActiveGraph,
  ActiveGraphBudget,
  ActiveGraphBudgetUsage,
  ActiveGraphEdge,
  ConsolidationEvent,
  ConsolidationResult,
  EdgeStability,
  EmbeddingIndexHealth,
  HistoryRecord,
  EvidenceRole,
  DeriveMemoryInput,
  MemoryActor,
  MemoryClaim,
  MemoryContext,
  MemoryGateDecision,
  MemoryLoadMode,
  MemoryNode,
  MemoryNodeKind,
  NodeEmbeddingDocument,
  ExternalNodeEmbedding,
  ExternalLeafEmbedding,
  LeafBlock,
  LeafEmbeddingDocument,
  MemoryRecord,
  MemoryResidence,
  MemoryScope,
  MemorySearchResult,
  MemoryTier,
  MemoryType,
  NodeRoute,
  NodeTransform,
  NodeRelation,
  NodeRelationType,
  RememberInput,
  RememberResult,
  SearchOptions,
  SessionArchive,
  TruthStatus,
  RebalanceResult,
  RecallCue,
  RecallIndex,
  VectorEmbedder,
} from "./core/types.ts";
