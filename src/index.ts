export { NmgStore } from "./core/store.ts";
export type {
  CoordinationEvent,
  CoordinationEventChange,
  CoordinationMutation,
  CoordinationChannel,
  CoordinationEffect,
  CreateCoordinationEvent,
  UpdateCoordinationEvent,
  AgentWorkStatus,
} from "./core/coordination-events.ts";
export type {
  BoardNotificationRequest,
  BoardNotificationScope,
  BoardMessageInput,
  BoardNoticeMetadata,
} from "./core/board-notifications.ts";
export { HashingVectorEmbedder } from "./core/vector.ts";
export { OpenAIEmbeddingClient } from "./core/openai-embedding.ts";
export { GeminiEmbeddingClient } from "./core/embedding-providers/gemini.ts";
export { configuredProvider, createEmbeddingClientFromEnv } from "./core/embedding-provider.ts";
export type { EmbeddingClient, EmbeddingProvider } from "./core/embedding-provider.ts";
export {
  syncLeafEmbeddings,
  syncNodeEmbeddings,
  syncRecordEmbeddings,
} from "./core/embedding-sync.ts";
export type { RecordEmbeddingClient, RecordEmbeddingSyncResult } from "./core/embedding-sync.ts";
export {
  configuredGraphHops,
  configuredQpp1Mode,
  configuredQpp2Mode,
  configuredQpp2RetainedMass,
  configuredSearchRecommendationMode,
} from "./integration/config.ts";
export type { QppActuationMode, SearchRecommendationMode } from "./integration/config.ts";
export {
  prepareSessionActiveGraphSurface,
  prepareTaskBoardSurface,
  renderEvidenceSurface,
  renderRememberSurface,
  renderSearchSurface,
  renderSessionActiveGraphSurface,
  searchInformationViews,
  renderTaskBoardSurface,
  TASK_BOARD_CONVENTIONS,
} from "./integration/agent-surface.ts";
export type {
  EvidenceSurfaceOptions,
  SearchSurfaceOptions,
  SessionActiveGraphSurfaceOptions,
  TaskBoardDirectoryEntry,
  TaskBoardSurfaceEntry,
  TaskBoardSurfaceOptions,
  TaskBoardSurfaceResult,
} from "./integration/agent-surface.ts";
export {
  prepareInformationOutput,
  confirmInformationOutput,
} from "./integration/information-output.ts";
export type { InformationOutputOptions } from "./integration/information-output.ts";
export { DEFAULT_CONTEXT_OUTPUT_CHARACTERS } from "./core/information-view.ts";
export {
  contextStateViews,
  contextNotice,
  checkpointInformationViews,
  contextBoardEntries,
} from "./integration/context-information.ts";
export type {
  InformationPurpose,
  InformationSource,
  InformationView,
  InformationOutputEntry,
  InformationOutputReceipt,
  PreparedInformationOutput,
} from "./core/information-view.ts";
export {
  prepareWorkingStateInput,
  PI_WORKING_STATE_INPUT_CAPABILITY,
} from "./integration/working-state-input.ts";
export type { WorkingStateInput } from "./integration/working-state-input.ts";
export { retainEvidence } from "./integration/evidence.ts";
export type { AgentHistoryMessage, AgentHistorySnapshot } from "./integration/evidence.ts";
export { searchMemoryContext } from "./integration/search.ts";
export { renderTemporalEvidence } from "./integration/temporal-evidence.ts";
export { projectAmlMemory, projectAmlMultimodalMemory } from "./integration/aml-projection.ts";
export type { AmlMemoryRow, AmlMultimodalMemoryRow } from "./integration/aml-projection.ts";
export {
  normalizeContent,
  describeContent,
  contentText,
  contentHasImages,
  ContentValidationError,
} from "./integration/multimodal-content.ts";
export type {
  AmlContent,
  ContentPart,
  ContentLimits,
  ImageDescriber,
} from "./integration/multimodal-content.ts";
export {
  captureMemoryReferenceTargets,
  createMemoryReferences,
  isMemoryReference,
  MemoryReferenceError,
  resolveMemoryReferences,
} from "./integration/memory-reference.ts";
export type { MemoryReferenceTarget } from "./integration/memory-reference.ts";
export type { QueryEmbeddingClient } from "./integration/search.ts";
export {
  createLeafSummaryProviderFromEnv,
  drainLeafSummaries,
  LEAF_SUMMARY_PROMPT_VERSION,
  OpenAiLeafSummaryProvider,
} from "./integration/leaf-summarizer.ts";
export type { LeafSummaryDrainResult } from "./integration/leaf-summarizer.ts";
export { UsearchAnnIndex } from "./core/ann.ts";
export { decideMemoryLoad } from "./core/gate.ts";
export { SessionActiveGraphRuntime } from "./core/session-active-graph.ts";
export type {
  SessionActiveGraphItem,
  SessionActiveGraphItemKind,
  SessionActiveGraphProjection,
  SessionActiveGraphSnapshot,
  WorkingStateBinding,
} from "./core/session-active-graph.ts";
export { captureWorkingStateInvocation, renderLabOutput } from "./integration/lab-capabilities.ts";
export {
  captureStateInvocation,
  renderStateOutput,
  stateOperation,
  STATE_AG_READ_OPERATIONS,
  STATE_AG_WRITE_OPERATIONS,
  STATE_BOARD_READ_OPERATIONS,
  STATE_BOARD_WRITE_OPERATIONS,
  STATE_OPERATIONS,
} from "./integration/state.ts";
export type { NmgStateResult } from "./cli/protocol.ts";
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
  LeafSummaryProvider,
  LeafSummaryTask,
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
  MaintenanceBatchResult,
  SemanticMaintenanceResult,
  RecallCue,
  RecallIndex,
  VectorEmbedder,
} from "./core/types.ts";
