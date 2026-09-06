import { CONTEXT_ACTIONS, type ContextAction } from "./context-router.ts";

/** Research input, not a verified receipt. The harness owns evidence validation.
 * Preserve origin and whole-task identity when assembling train/held-out splits.
 * Feature semantics are separately versioned; v1 here versions only the envelope.
 */
export interface ContextIntervention {
  schemaVersion: 1;
  decisionId: string;
  taskId: string;
  sessionId: string;
  taskFrameId: string;
  acceptanceVersion: string;
  featureVersion: string;
  policyVersion: string;
  origin: "natural" | "benchmark" | "synthetic";
  mode: "executed" | "shadow";
  decidedAt: number;
  features: number[];
  allowed: ContextAction[];
  selected: ContextAction;
  probability: number;
  execution?: {
    action: ContextAction;
    startedAt: number;
    endedAt: number;
    status: "completed" | "cancelled" | "timeout";
    /** Fingerprint of generated context, not proof of actual model exposure. */
    result?: {
      contentHash: string;
      evidenceIds: string[];
      characters: number;
      toolCalls: number;
    };
  };
  outcome?: {
    taskId: string;
    acceptanceVersion: string;
    windowStart: number;
    windowEnd: number;
    recordedAt: number;
    status: "observed" | "missing" | "reopened";
    reward: number;
    evidenceRefs: string[];
    costs: { tokens: number; toolCalls: number; latencyMs: number };
  };
}

export interface ContextInterventionAdmission {
  reason:
    "admitted" | "invalid-decision" | "not-executed" | "invalid-outcome" | "unverified-evidence";
  sample?: ContextIntervention;
}

const named = (value: string): boolean => typeof value === "string" && value.trim().length > 0;
const nonnegative = (value: number): boolean => Number.isFinite(value) && value >= 0;

/** Pure admission boundary for typed, in-process samples; not a JSON parser or
 * evidence authenticator. A verifier must check references, reward, acceptance,
 * and the complete window against an independent source. Passing `() => true`
 * establishes no truth. No automatic training, persistence or actuation occurs.
 * Dataset builders must deduplicate decision IDs and re-evaluate reopened rows.
 */
export function admitContextIntervention(
  input: ContextIntervention,
  verifyEvidence: (sample: Readonly<ContextIntervention>) => boolean,
): ContextInterventionAdmission {
  if (!isContextDecisionValid(input)) return { reason: "invalid-decision" };
  if (!validExecution(input)) return { reason: "not-executed" };
  if (!validOutcome(input)) return { reason: "invalid-outcome" };
  // Neither caller mutation nor verifier mutation may change the admitted row.
  const snapshot = structuredClone(input);
  try {
    if (verifyEvidence(structuredClone(snapshot)) !== true) {
      return { reason: "unverified-evidence" };
    }
  } catch {
    return { reason: "unverified-evidence" };
  }
  return { reason: "admitted", sample: snapshot };
}

export function isContextDecisionValid(input: ContextIntervention): boolean {
  if (
    input.schemaVersion !== 1 ||
    ![
      input.decisionId,
      input.taskId,
      input.sessionId,
      input.taskFrameId,
      input.acceptanceVersion,
      input.featureVersion,
      input.policyVersion,
    ].every(named) ||
    !["natural", "benchmark", "synthetic"].includes(input.origin) ||
    !nonnegative(input.decidedAt) ||
    input.features.length !== 32 ||
    !input.features.every((value) => Number.isFinite(value) && Math.abs(value) <= 1) ||
    !input.allowed.length ||
    new Set(input.allowed).size !== input.allowed.length ||
    !input.allowed.every((action) => CONTEXT_ACTIONS.includes(action)) ||
    !input.allowed.includes(input.selected) ||
    !Number.isFinite(input.probability) ||
    input.probability <= 0 ||
    input.probability > 1
  ) {
    return false;
  }
  return true;
}

function validExecution(input: ContextIntervention): boolean {
  const execution = input.execution;
  if (
    input.mode !== "executed" ||
    !execution ||
    execution.status !== "completed" ||
    execution.action !== input.selected ||
    !nonnegative(execution.startedAt) ||
    !nonnegative(execution.endedAt) ||
    execution.startedAt < input.decidedAt ||
    execution.endedAt < execution.startedAt
  ) {
    return false;
  }
  return true;
}

function validWindow(
  execution: NonNullable<ContextIntervention["execution"]>,
  outcome: NonNullable<ContextIntervention["outcome"]>,
): boolean {
  return (
    [outcome.windowStart, outcome.windowEnd, outcome.recordedAt].every(nonnegative) &&
    outcome.windowStart === execution.startedAt &&
    outcome.windowEnd >= execution.endedAt &&
    outcome.recordedAt >= outcome.windowEnd
  );
}

function validExecutionCosts(
  execution: NonNullable<ContextIntervention["execution"]>,
  outcome: NonNullable<ContextIntervention["outcome"]>,
): boolean {
  if (!execution.result) return true; // Historical v1 rows need external verification.
  return (
    /^[a-f0-9]{64}$/u.test(execution.result.contentHash) &&
    execution.result.evidenceIds.every(named) &&
    Number.isSafeInteger(execution.result.characters) &&
    execution.result.characters >= 0 &&
    Number.isSafeInteger(execution.result.toolCalls) &&
    execution.result.toolCalls >= 0 &&
    outcome.costs.toolCalls >= execution.result.toolCalls
  );
}

function validOutcome(input: ContextIntervention): boolean {
  const execution = input.execution;
  const outcome = input.outcome;
  if (!execution) return false;
  if (
    !outcome ||
    outcome.status !== "observed" ||
    outcome.taskId !== input.taskId ||
    outcome.acceptanceVersion !== input.acceptanceVersion ||
    !validWindow(execution, outcome) ||
    !validExecutionCosts(execution, outcome) ||
    !Number.isFinite(outcome.reward) ||
    Math.abs(outcome.reward) > 1 ||
    !outcome.evidenceRefs.length ||
    !outcome.evidenceRefs.every(named) ||
    ![outcome.costs.tokens, outcome.costs.toolCalls, outcome.costs.latencyMs].every(nonnegative)
  ) {
    return false;
  }
  return true;
}
