import type { MemoryType } from "./types.ts";

export interface MemoryWriteAssessment {
  allowed: boolean;
  reason: "allowed" | "secret" | "non_persistent_instruction" | "coordination_state";
}

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_ -]?key|access[_ -]?token|auth(?:orization)?[_ -]?token|password|passwd|secret)\b\s*[:=]\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:sk|pk)-(?:live|test|prod)-[A-Za-z0-9_-]{8,}\b/i,
  /\bsk-[A-Za-z0-9_-]{12,}\b/i,
];

/** Shared secret boundary; temporary state does not use persistent-intent filters. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

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
 * Coordination state: the current position of an ongoing process — a queue, a
 * branch, a handoff — which the next ordinary event silently invalidates.
 *
 * The distinction from the transient wording above is not the word "temporary":
 * it is whether the claim keeps its meaning once the work moves. "Pushed 16
 * commits, waiting for the PR" is true today and false tomorrow, with nothing in
 * the record saying so. A caller may still record such a position by stating
 * when it stops being true (`expiresAt`); the harness will not invent an
 * unbounded lifetime for it.
 *
 * Kept deliberately narrow: process nouns that are unambiguous in the present
 * tense (pending, unpushed, next step) and their Chinese counterparts. Statements
 * about durable rules — "merges require a green gate", "the release order is X
 * then Y" — must stay allowed, so no pattern keys on a bare verb.
 */
const COORDINATION_STATE_PATTERNS = [
  /\b(?:unpushed|unmerged|uncommitted|not yet (?:pushed|committed|merged|deployed))\b/i,
  /\b(?:still )?pending (?:review|merge|push|approval|confirmation)\b/i,
  /\b(?:the )?next step\b/i,
  /\b\d+ commits? ahead (?:of )?(?:origin|upstream|main|the remote)\b/i,
  /\b(?:waiting|blocked) (?:on|for) [^.]{0,40}\b(?:to land|to merge|to push|to confirm|to review)\b/i,
  /(?:尚未|还没有|还没)(?:推送|提交|合并|部署|落地)/u,
  /未(?:推送|提交|合并|部署)/u,
  /待(?:办|定|审|确认|复核)/u,
  /下一步/u,
  /领先\s{0,2}(?:origin|远端|main)/iu,
  /(?:等|待)[^。；;.]{0,20}(?:落地|合入|合并|再)(?:后|之)/u,
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
 *
 * Coordination state is refused for a different reason than the wording
 * filters: the claim is well formed, it just has no stable truth value. Its
 * escape hatch is `expiresAt`, not `bypass` — a caller that names when the
 * position stops being true has told the harness how to age it, which is the
 * information an unbounded record lacks. `bypass` still overrides, because the
 * unconditional escape hatch must stay unconditional to remain auditable.
 */
export function assessMemoryWrite(input: {
  statement: string;
  evidence?: string;
  memoryType?: MemoryType;
  bypass?: boolean;
  expiresAt?: string;
}): MemoryWriteAssessment {
  const statementText = `${input.statement}`;
  const evidenceText = `${input.evidence ?? ""}`;
  const fullText = evidenceText ? `${statementText}\n${evidenceText}` : statementText;
  // Secret detection scans the full text (statement + evidence): credentials
  // can hide inside a quoted source excerpt, so evidence must never exempt
  // them.
  if (containsSecret(fullText)) {
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
  // Coordination state: allowed only when the caller says when it expires. An
  // event is exempt because it records a dated occurrence rather than a live
  // position; the transient rules above already treat events the same way.
  if (
    !input.bypass &&
    input.memoryType !== "event" &&
    !input.expiresAt &&
    COORDINATION_STATE_PATTERNS.some((pattern) => pattern.test(statementText))
  ) {
    return { allowed: false, reason: "coordination_state" };
  }
  return { allowed: true, reason: "allowed" };
}
