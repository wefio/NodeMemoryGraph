import type { NmgMethod, NmgMethodResult, NmgSearchParams } from "../cli/protocol.ts";
import type {
  ActiveGraphBudget,
  EvidenceCollectionOrigin,
  MemoryActor,
  MemoryContext,
} from "../core/types.ts";
import { loadPrompts } from "../prompts/load.ts";
import type { AgentAttributionFlow } from "./agent-attribution.ts";
import type { SelectedEvidence } from "./evidence.ts";
import { memoryDisclosureEntries } from "./search-projection.ts";
import type { SessionRecallFlow } from "./session-recall-flow.ts";

export interface StateToolIdentity {
  id: string;
  agentName: string;
  saveName?: (name: string) => void;
}

export interface EvidenceLookup {
  memoryIds: string[];
  activeGraphId?: string;
}

export interface AdapterSearchBinding {
  defaultTier?: NmgSearchParams["maxTier"];
  beginDisclosureTurn?: boolean;
  defaultSecondPass?: boolean;
  bindRecallCue?: (
    phrase?: string,
    revision?: number,
  ) => Pick<NmgSearchParams, "recallCue" | "recallRevision" | "recallSource">;
  allocate?: (probe: () => Promise<MemoryContext>) => Promise<ActiveGraphBudget | undefined>;
  rank?: (result: MemoryContext) => Promise<MemoryContext>;
  fold?: (result: MemoryContext, explicitLimit: boolean) => Promise<MemoryContext>;
  onSuppressed?: (query: string) => void | Promise<void>;
  feedback?: (graphId: string | undefined) => string;
  onSearch?: (event: {
    query: string;
    ranked: MemoryContext;
    disclosed: MemoryContext;
    text: string;
  }) => void | Promise<void>;
}

export interface RememberFeedbackLabels {
  taskSuccess?: boolean;
  userCorrection?: boolean;
  evidenceSufficient?: boolean;
  expansionUseful?: boolean;
  excessiveNoise?: boolean;
  noMemoryNeeded?: boolean;
  memoryMisleading?: boolean;
  note?: string;
  semanticTaskId?: string;
}

export interface AdapterRememberBinding {
  provenance?: {
    provider: string;
    lookup(
      evidence: string | undefined,
      actor: MemoryActor,
    ):
      | {
          version: string;
          reason?: string;
          source?: SelectedEvidence;
        }
      | undefined;
    requireWitness?: boolean;
  };
  latestFeedback?: boolean;
  observeFeedback?: (
    graphId: string | undefined,
    labels: RememberFeedbackLabels,
  ) => Promise<{ recorded: boolean; activeGraphId?: string | null }>;
  onFeedback?: (result: NmgMethodResult["recordFeedback"]) => void;
  claimOrigin?: EvidenceCollectionOrigin;
  claimGraph?: (memoryId: string) => string | null | undefined;
  onVerifiedClaim?: (
    graphId: string | undefined,
    memoryId: string,
    outcome: "supported" | "contradicted",
  ) => Promise<void>;
}

export interface AdapterToolSession {
  sessionId: string;
  requester: string;
  invoke(
    method: NmgMethod,
    params: Record<string, unknown>,
    cliFallback?: string[],
  ): Promise<unknown>;
  boardIdentity?: () => StateToolIdentity | Promise<StateToolIdentity>;
  boardReads?: "receipt" | "project";
  legacyBoardVerbs?: boolean;
  invalidateRecallGate?: () => void;
  memory?: {
    projectDir?: string;
    recallFlow?: SessionRecallFlow;
    attribution?: AgentAttributionFlow;
    search?: AdapterSearchBinding;
    remember?: AdapterRememberBinding;
    retryForeignGraph?: boolean;
    onEvidenceLookup?: (request: EvidenceLookup, result: MemoryContext) => void | Promise<void>;
    onEvidenceDisclosed?: (request: EvidenceLookup, result: MemoryContext) => void | Promise<void>;
  };
}

export async function discloseMemoryContext<T extends MemoryContext>(
  context: T,
  session: AdapterToolSession,
  disclosure: "header" | "evidence",
  enabled: boolean,
  projectionId?: string,
): Promise<{ context: T; folded: string[] }> {
  if (!enabled || context.results.length === 0) return { context, folded: [] };
  const decision = (await session
    .invoke("sessionActiveGraph", {
      action: "disclose",
      sessionId: session.sessionId,
      projectionId: projectionId ?? context.activeGraph?.id,
      disclosure,
      entries: memoryDisclosureEntries(context, disclosure),
    })
    .catch(() => null)) as { freshMemoryIds?: string[]; foldedMemoryIds?: string[] } | null;
  if (!Array.isArray(decision?.freshMemoryIds)) return { context, folded: [] };
  const fresh = new Set(decision.freshMemoryIds);
  return {
    context: { ...context, results: context.results.filter(({ memory }) => fresh.has(memory.id)) },
    folded: Array.isArray(decision.foldedMemoryIds) ? decision.foldedMemoryIds : [],
  };
}

export function renderFoldedDisclosure(memoryIds: string[]): string {
  if (memoryIds.length === 0) return "";
  return [
    loadPrompts().in_context_title,
    ...memoryIds.map((id) => `- memory=${id}; already_in_context=true`),
  ].join("\n");
}
