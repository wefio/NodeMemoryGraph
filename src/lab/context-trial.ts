import { createHash } from "node:crypto";
import {
  admitContextIntervention,
  isContextDecisionValid,
  type ContextIntervention,
  type ContextInterventionAdmission,
} from "./context-intervention.ts";
import {
  executeContextAction,
  type ContextExecutionInput,
  type ContextExecutionResult,
} from "./context-executor.ts";

export interface ContextTrialEvent {
  phase: "decision" | "execution" | "outcome" | "error";
  sample: ContextIntervention;
}

/** Explicit experimental harness entry, not an automatic recall policy.
 * The sink must durably record the decision before any side effect; throwing
 * from it aborts the trial. The host owns a unique decision ID, serial execution,
 * fixed evaluation window, model exposure, and cancellation of its own tools.
 */
export async function runContextTrial(options: {
  decision: ContextIntervention;
  executor: Omit<ContextExecutionInput, "action">;
  sink: (event: ContextTrialEvent) => void | Promise<void>;
  evaluate: (
    result: ContextExecutionResult,
    startedAt: number,
  ) => Promise<NonNullable<ContextIntervention["outcome"]>>;
  verifyEvidence: (
    sample: Readonly<ContextIntervention>,
    result: Readonly<ContextExecutionResult>,
  ) => boolean;
  clock?: () => number;
}): Promise<ContextInterventionAdmission> {
  const clock = options.clock ?? Date.now;
  const sample = structuredClone(options.decision);
  if (sample.execution || sample.outcome) throw new Error("trial requires a fresh decision");
  if (!isContextDecisionValid(sample)) throw new Error("invalid trial decision");
  if (sample.mode !== "executed") throw new Error("shadow decisions cannot execute a trial");
  await options.sink({ phase: "decision", sample: structuredClone(sample) });
  const startedAt = clock();
  let result: ContextExecutionResult;
  try {
    result = await executeContextAction({ ...options.executor, action: sample.selected });
  } catch (error) {
    sample.execution = {
      action: sample.selected,
      startedAt,
      endedAt: clock(),
      status: options.executor.signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled",
    };
    await options.sink({ phase: "error", sample: structuredClone(sample) });
    throw error;
  }
  sample.execution = {
    action: sample.selected,
    startedAt,
    endedAt: clock(),
    status: "completed",
    result: {
      contentHash: createHash("sha256").update(result.text).digest("hex"),
      evidenceIds: [...result.evidenceIds],
      characters: result.text.length,
      toolCalls: result.toolCalls,
    },
  };
  await options.sink({ phase: "execution", sample: structuredClone(sample) });
  const actualResult = structuredClone(result);
  try {
    options.executor.signal.throwIfAborted();
    sample.outcome = await options.evaluate(structuredClone(actualResult), startedAt);
    options.executor.signal.throwIfAborted();
  } catch (error) {
    // The intervention completed, but its outcome is unknown, not reward zero.
    await options.sink({ phase: "error", sample: structuredClone(sample) });
    throw error;
  }
  await options.sink({ phase: "outcome", sample: structuredClone(sample) });
  return admitContextIntervention(sample, (candidate) =>
    options.verifyEvidence(candidate, structuredClone(actualResult)),
  );
}
