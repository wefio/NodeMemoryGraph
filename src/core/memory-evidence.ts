import { MAX_EVIDENCE_SOURCE_CHARACTERS } from "./types.ts";
import type { MemoryResidence, RememberInput } from "./types.ts";
import { defaultResidence } from "./memory-residence.ts";

export function validateEvidenceSource(
  input: RememberInput,
  residence: MemoryResidence = input.residence ?? defaultResidence(input),
): void {
  const source = input.evidenceSource;
  if (!source) return;
  if (residence === "stg" && !input.sessionId?.trim()) {
    throw new Error("evidenceSource requires sessionId");
  }
  validateEvidenceExcerpt(source);
  const actor = input.sourceActor ?? "user";
  if (source.actor !== actor) {
    throw new Error(`evidenceSource actor ${source.actor} does not match sourceActor ${actor}`);
  }
  const claimed = input.evidence?.trim();
  if (claimed && source.content.toLocaleLowerCase() !== claimed.toLocaleLowerCase()) {
    throw new Error("evidenceSource content must be the exact excerpt supplied as evidence");
  }
}

function validateEvidenceExcerpt(source: NonNullable<RememberInput["evidenceSource"]>): void {
  if (!source.sourceMessageId?.trim()) {
    throw new Error("evidenceSource requires sourceMessageId");
  }
  if (!source.content?.trim()) throw new Error("evidenceSource content must not be empty");
  if (source.content.length > MAX_EVIDENCE_SOURCE_CHARACTERS) {
    throw new Error(
      `evidenceSource exceeds ${MAX_EVIDENCE_SOURCE_CHARACTERS} characters; retain an exact excerpt or external artifact reference`,
    );
  }
}
