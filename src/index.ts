export { NmgStore } from "./core/store.ts";
export { HashingVectorEmbedder } from "./core/vector.ts";
export { OpenAIEmbeddingClient } from "./core/openai-embedding.ts";
export { UsearchAnnIndex } from "./core/ann.ts";
export { decideMemoryLoad } from "./core/gate.ts";
export { Tensor, gradientStep } from "./core/autodiff.ts";
export {
  CONTROLLER_BUDGET_DIMENSIONS,
  DifferentiableController,
} from "./core/differentiable-controller.ts";
export type {
  BinaryRouteExample,
  ControllerAction,
  ControllerBudgetDimension,
  ControllerTrainingExample,
  ControllerTrainingResult,
  DifferentiableControllerState,
} from "./core/differentiable-controller.ts";
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
