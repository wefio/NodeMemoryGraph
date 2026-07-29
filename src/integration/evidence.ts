import type { NmgStore } from "../core/store.ts";
import type { MemoryActor } from "../core/types.ts";

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

/** Retain one admitted source message without copying the whole transcript. */
export function retainEvidence(
  store: NmgStore,
  evidence: string | undefined,
  sourceActor: MemoryActor,
  history: AgentHistorySnapshot,
): string | undefined {
  const exactEvidence = evidence?.trim();
  if (!exactEvidence) return undefined;

  for (let index = history.messages.length - 1; index >= 0; index -= 1) {
    const message = history.messages[index];
    if (message.actor !== sourceActor) continue;
    const evidenceOffset = indexOfEvidence(message.content, exactEvidence);
    if (evidenceOffset < 0) continue;
    const existing = store.getHistoryBySourceMessage(history.sessionId, message.id);
    if (existing) return existing.id;
    return store.appendHistory({
      content: retainedEvidenceContent(message.content, evidenceOffset, exactEvidence.length),
      role: sourceActor,
      sessionId: history.sessionId,
      sourceMessageId: message.id,
      sourceRef: history.sourceRef,
    }).id;
  }
  return undefined;
}

function indexOfEvidence(content: string, evidence: string): number {
  const exact = content.indexOf(evidence);
  return exact >= 0 ? exact : content.toLocaleLowerCase().indexOf(evidence.toLocaleLowerCase());
}

function retainedEvidenceContent(
  content: string,
  evidenceOffset: number,
  evidenceLength: number,
): string {
  const maxCharacters = 8_192;
  if (content.length <= maxCharacters) return content;
  if (evidenceLength >= maxCharacters) {
    return content.slice(evidenceOffset, evidenceOffset + maxCharacters);
  }
  const contextCharacters = Math.floor((maxCharacters - evidenceLength) / 2);
  const start = Math.max(
    0,
    Math.min(evidenceOffset - contextCharacters, content.length - maxCharacters),
  );
  return content.slice(start, start + maxCharacters);
}
