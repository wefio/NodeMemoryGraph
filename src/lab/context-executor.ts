import { type ContextAction } from "./context-router.ts";

export const CONTEXT_EXECUTOR_VERSION = "context-executor-v1";
export const CONTEXT_CUE =
  "Check the current task against its acceptance criteria and available evidence.";
export interface ContextEvidence {
  id: string;
  text: string;
}
export interface ContextExecutionInput {
  action: ContextAction;
  authorized: boolean;
  maxChars: number;
  remainingToolCalls: number;
  evidence: readonly ContextEvidence[];
  signal: AbortSignal;
  /** Fixed retrieval procedure owned by the harness; no query generation here.
   * It must honor the signal and maxChars, and stay within one tool invocation.
   */
  retrieve: (signal: AbortSignal, maxChars: number) => Promise<readonly ContextEvidence[]>;
}
export interface ContextExecutionResult {
  action: ContextAction;
  text: string;
  evidenceIds: string[];
  toolCalls: number;
}

/** Budget/authorization decisions live outside the learned head. This adapter
 * returns content; only its host can actually expose it to the main model.
 * Mandatory verification is never suppressed by selecting none.
 */
export async function executeContextAction(
  input: ContextExecutionInput,
): Promise<ContextExecutionResult> {
  input.signal.throwIfAborted();
  validateBudget(input.maxChars);
  validateBudget(input.remainingToolCalls);
  if (input.action === "none") {
    return { action: "none", text: "", evidenceIds: [], toolCalls: 0 };
  }
  if (!input.authorized) throw new Error("context intervention not authorized");
  if (input.action === "cue") {
    if (CONTEXT_CUE.length > input.maxChars) throw new Error("cue exceeds context budget");
    return { action: "cue", text: CONTEXT_CUE, evidenceIds: [], toolCalls: 0 };
  }
  if (input.action === "resurface") return renderEvidence(input, input.evidence, 0);
  if (input.action !== "retrieve") throw new Error("unknown context action");
  if (input.remainingToolCalls < 1) throw new Error("retrieval exceeds tool budget");
  const evidence = await input.retrieve(input.signal, input.maxChars);
  input.signal.throwIfAborted();
  return renderEvidence(input, evidence, 1);
}

function validateBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid context budget");
}

function renderEvidence(
  input: ContextExecutionInput,
  evidence: readonly ContextEvidence[],
  toolCalls: number,
): ContextExecutionResult {
  const parts: string[] = [];
  const evidenceIds: string[] = [];
  let used = 0;
  for (const item of evidence) {
    if (!item.id.trim() || !item.text.trim()) continue;
    if (evidenceIds.includes(item.id)) continue;
    const size = item.text.length + Number(parts.length > 0);
    if (used + size > input.maxChars) continue;
    parts.push(item.text);
    evidenceIds.push(item.id);
    used += size;
  }
  return { action: input.action, text: parts.join("\n"), evidenceIds, toolCalls };
}
