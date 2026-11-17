import { MAX_EVIDENCE_SOURCE_CHARACTERS, type MemoryActor } from "../core/types.ts";

export interface AgentHistoryMessage {
  id: string;
  actor: MemoryActor;
  content: string;
}

export interface AgentHistorySnapshot {
  sessionId: string;
  sourceRef?: string;
  messages: readonly AgentHistoryMessage[];
}

export interface SelectedEvidence {
  actor: MemoryActor;
  content: string;
  sourceMessageId: string;
  sourceRef?: string;
}

/** Select the exact source slice named by the semantic writer. */
export function selectEvidence(
  evidence: string | undefined,
  sourceActor: MemoryActor,
  history: AgentHistorySnapshot,
): SelectedEvidence | undefined {
  const exactEvidence = evidence?.trim();
  if (!exactEvidence || exactEvidence.length > MAX_EVIDENCE_SOURCE_CHARACTERS) return undefined;

  for (let index = history.messages.length - 1; index >= 0; index -= 1) {
    const message = history.messages[index];
    if (message.actor !== sourceActor) continue;
    const evidenceOffset = indexOfEvidence(message.content, exactEvidence);
    if (evidenceOffset < 0) continue;
    return {
      actor: sourceActor,
      content: message.content.slice(evidenceOffset, evidenceOffset + exactEvidence.length),
      sourceMessageId: message.id,
      sourceRef: history.sourceRef,
    };
  }
  return undefined;
}

function indexOfEvidence(content: string, evidence: string): number {
  const exact = content.indexOf(evidence);
  return exact >= 0 ? exact : content.toLocaleLowerCase().indexOf(evidence.toLocaleLowerCase());
}
