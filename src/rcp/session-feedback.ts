import type { MemoryProvider } from "./providers.ts";
import { validateReceipt } from "./receipt.ts";
import type { RepositoryReceipt } from "./types.ts";

export interface SessionFeedbackTarget {
  sessionId: string;
  taskFrameId: string;
  contractId: string;
  contractDigest: string;
}

/** Narrow outbound client port, not an import of the daemon or its protocol. */
interface Observation {
  action: "observe";
  sessionId: string;
  taskFrameId: string;
  kind: "tool_observation";
  sourceId: string;
  statement: string;
}

/** RCP -> optional NMG client boundary. The caller supplies an explicit target;
 * a Contract id is not a session identity. Receipts remain the source of truth.
 * No task completion label, training update, board entry or durable memory is
 * inferred from this temporary, bounded feedback projection.
 */
export class SessionFeedbackProvider implements MemoryProvider {
  readonly descriptor = {
    id: "rcp-session-feedback",
    version: "1",
    capabilities: ["optional-session-observation"],
    operations: ["notify"],
    authority: [] as [],
  };
  readonly #target: Readonly<SessionFeedbackTarget>;
  readonly #observe: (observation: Observation) => Promise<unknown>;

  constructor(
    target: SessionFeedbackTarget,
    observe: (observation: Observation) => Promise<unknown>,
  ) {
    if (Object.values(target).some((value) => !value.trim())) {
      throw new Error(
        "session feedback requires explicit session, task frame, and contract identity",
      );
    }
    this.#target = Object.freeze({ ...target });
    this.#observe = observe;
  }

  async notify({ receipt }: { receipt: RepositoryReceipt }): Promise<void> {
    const validation = validateReceipt(receipt);
    if (!validation.valid)
      throw new Error(`invalid feedback receipt: ${validation.errors.join("; ")}`);
    if (
      receipt.contractId !== this.#target.contractId ||
      receipt.contractDigest !== this.#target.contractDigest
    ) {
      throw new Error("feedback receipt belongs to another contract revision");
    }
    await this.#observe({
      action: "observe",
      sessionId: this.#target.sessionId,
      taskFrameId: this.#target.taskFrameId,
      kind: "tool_observation",
      sourceId: `rcp-receipt:${receipt.receiptId}`,
      statement: renderFeedback(receipt),
    });
  }
}

function renderFeedback(receipt: RepositoryReceipt): string {
  const checks = receipt.checks.slice(0, 8).map((check) => ({
    name: check.name.slice(0, 160),
    status: check.status,
    reason: check.reason?.slice(0, 400),
    evidence: check.evidence?.slice(0, 400),
  }));
  const event = {
    kind: "repository-verification-feedback",
    receiptId: receipt.receiptId,
    contractId: receipt.contractId.slice(0, 160),
    contractDigest: receipt.contractDigest,
    observedRevision: receipt.observedRevisionAfter,
    decision: receipt.decision,
    scopeMatched: receipt.scope.matched,
    checks,
    omittedChecks: Math.max(0, receipt.checks.length - checks.length),
    diagnostics: receipt.diagnostics.slice(0, 4).map((value) => value.slice(0, 400)),
    interpretation:
      "Scoped verification observation, not proof of overall task completion. Consult the original receipt for full evidence.",
  };
  let statement = JSON.stringify(event);
  while (statement.length > 12_000 && (event.diagnostics.length || event.checks.length)) {
    if (event.diagnostics.length) event.diagnostics.pop();
    else {
      event.checks.pop();
      event.omittedChecks += 1;
    }
    statement = JSON.stringify(event);
  }
  if (statement.length > 12_000)
    throw new Error("feedback receipt identity exceeds observation budget");
  return statement;
}
