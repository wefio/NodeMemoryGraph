import type { MemoryType } from "./types.ts";

export interface MemoryWriteAssessment {
  allowed: boolean;
  reason: "allowed" | "secret" | "non_persistent_instruction";
}

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_ -]?key|access[_ -]?token|auth(?:orization)?[_ -]?token|password|passwd|secret)\b\s*[:=]\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:sk|pk)-(?:live|test|prod)-[A-Za-z0-9_-]{8,}\b/i,
  /\bsk-[A-Za-z0-9_-]{12,}\b/i,
];

const DO_NOT_RETAIN_PATTERNS = [
  /\b(?:do not|don't|never)\s+(?:retain|remember|store|save)\b/i,
  /(?:不要|别|请勿)(?:保存|记住|记录|留存)/u,
];

const TRANSIENT_PATTERNS = [
  /\b(?:for )?(?:this|the current) (?:response|reply|turn|task|session) only\b/i,
  // (?![.-]) keeps file names like "temporary-todo.md" from tripping the rule.
  /\btemporar(?:y|ily)\b(?![.-])/i,
  /(?:仅|只)(?:用于|在)?(?:本次|当前)(?:回复|回答|任务|会话)/u,
  /(?:临时|暂时)(?:要求|指令|使用)?/u,
];

/**
 * A small deterministic safety boundary around model-proposed writes.
 *
 * It intentionally rejects only high-confidence secrets and explicitly
 * non-persistent instructions. Semantic usefulness remains the model's job;
 * the harness owns the invariants that must not depend on model intelligence.
 *
 * Escape hatch (docs §3.6): `bypass` is the Rust-unsafe-style explicit
 * opt-out — a caller that states a genuinely persistent preference/decision
 * can pass bypass:true instead of rephrasing to dodge the transient-word
 * filter (rephrasing would be an accidental, undesigned bypass). Secrets are
 * never bypassable: the memory-safety invariant takes precedence over the
 * caller's explicit request, exactly as Rust's unsafe cannot break the
 * borrow-checker's guarantees it does not fully control.
 */
export function assessMemoryWrite(input: {
  statement: string;
  evidence?: string;
  memoryType?: MemoryType;
  bypass?: boolean;
}): MemoryWriteAssessment {
  const statementText = `${input.statement}`;
  const evidenceText = `${input.evidence ?? ""}`;
  const fullText = evidenceText ? `${statementText}\n${evidenceText}` : statementText;
  // Secret detection scans the full text (statement + evidence): credentials
  // can hide inside a quoted source excerpt, so evidence must never exempt
  // them.
  if (SECRET_PATTERNS.some((pattern) => pattern.test(fullText))) {
    return { allowed: false, reason: "secret" };
  }
  // The intent filters (explicit "do not retain" refusal, transient wording)
  // judge what the model is persisting — the statement — not the verbatim
  // quoted evidence. A user quote may legitimately contain transient wording
  // or a negative imperative; that is the source's wording, not a persist
  // instruction. Evidence is exempt from these two, exactly like secrets are
  // exempt from nothing.
  if (DO_NOT_RETAIN_PATTERNS.some((pattern) => pattern.test(statementText))) {
    return { allowed: false, reason: "non_persistent_instruction" };
  }
  // Transient-word matches are the wording-false-positive zone; the explicit
  // escape hatch may override these, never the two hard refusals above.
  if (
    !input.bypass &&
    input.memoryType !== "event" &&
    TRANSIENT_PATTERNS.some((pattern) => pattern.test(statementText))
  ) {
    return { allowed: false, reason: "non_persistent_instruction" };
  }
  return { allowed: true, reason: "allowed" };
}
