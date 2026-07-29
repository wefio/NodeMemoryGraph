export { NmgStore } from "./core/store.ts";
export { HashingVectorEmbedder } from "./core/vector.ts";
export { OpenAIEmbeddingClient } from "./core/openai-embedding.ts";
export { GeminiEmbeddingClient } from "./core/embedding-providers/gemini.ts";
export { configuredProvider, createEmbeddingClientFromEnv } from "./core/embedding-provider.ts";
export type { EmbeddingClient, EmbeddingProvider } from "./core/embedding-provider.ts";
export { syncRecordEmbeddings } from "./core/embedding-sync.ts";
export type { RecordEmbeddingClient, RecordEmbeddingSyncResult } from "./core/embedding-sync.ts";
export { UsearchAnnIndex } from "./core/ann.ts";
export { decideMemoryLoad } from "./core/gate.ts";
export { normalizeClaims } from "./core/claims.ts";
export { Tensor, gradientStep } from "./core/autodiff.ts";
export { ControllerRuntime } from "./core/controller-runtime.ts";
export {
  REASONING_EDGE_KINDS,
  REASONING_NODE_KINDS,
  REASONING_STATUSES,
  ReasoningWorkspace,
} from "./core/reasoning-workspace.ts";
export {
  CONTROLLER_BUDGET_DIMENSIONS,
  DifferentiableController,
} from "./core/differentiable-controller.ts";
export {
  CONTROLLER_FEATURE_COUNT,
  CONTROLLER_FEATURE_NAMES,
  CONTROLLER_FEATURE_PROTOCOL_VERSION,
  controllerSampleFromTrace,
} from "./core/controller-protocol.ts";
export type {
  BinaryRouteExample,
  ControllerAction,
  ControllerBudgetDimension,
  ControllerTrainingExample,
  ControllerTrainingResult,
  DifferentiableControllerState,
} from "./core/differentiable-controller.ts";
export type { ControllerProtocolSample } from "./core/controller-protocol.ts";
export type {
  AddReasoningNodeInput,
  ReasoningCheckpoint,
  ReasoningEdge,
  ReasoningEdgeKind,
  ReasoningNode,
  ReasoningNodeKind,
  ReasoningStatus,
  ReasoningWorkspaceState,
} from "./core/reasoning-workspace.ts";
export type {
  ControllerRuntimeState,
  ControllerShadowDecision,
} from "./core/controller-runtime.ts";
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
