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
  /\btemporar(?:y|ily)\b/i,
  /(?:仅|只)(?:用于|在)?(?:本次|当前)(?:回复|回答|任务|会话)/u,
  /(?:临时|暂时)(?:要求|指令|使用)?/u,
];

/**
 * A small deterministic safety boundary around model-proposed writes.
 *
 * It intentionally rejects only high-confidence secrets and explicitly
 * non-persistent instructions. Semantic usefulness remains the model's job;
 * the harness owns the invariants that must not depend on model intelligence.
 */
export function assessMemoryWrite(input: {
  statement: string;
  evidence?: string;
  memoryType?: MemoryType;
}): MemoryWriteAssessment {
  const text = `${input.statement}\n${input.evidence ?? ""}`;
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    return { allowed: false, reason: "secret" };
  }
  if (DO_NOT_RETAIN_PATTERNS.some((pattern) => pattern.test(text))) {
    return { allowed: false, reason: "non_persistent_instruction" };
  }
  if (input.memoryType !== "event" &&
      TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return { allowed: false, reason: "non_persistent_instruction" };
  }
  return { allowed: true, reason: "allowed" };
}
